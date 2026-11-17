import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CHECK_EVERY_MS, CHECK_MIN_GAP_MS, GUARD_KEY, IDLE_MS, Updater, decide, type UpdaterEnv } from '../services/updater.js';

function makeEnv(over: Partial<UpdaterEnv> & { server?: string | null } = {}) {
  let t = 1_000_000;
  let guard: string | null = null;
  const env = {
    t: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    reload: vi.fn(),
    fetchVersion: vi.fn(async () => (over.server === undefined ? 'bbb' : over.server)),
    updateWorker: vi.fn(async () => undefined),
    visible: true,
    busy: false,
    lastInput: t - 10 * IDLE_MS,
    guardSet: (v: string | null) => {
      guard = v;
    },
    guardGet: () => guard
  };
  const full: UpdaterEnv = {
    current: 'aaa',
    now: () => env.t(),
    isVisible: () => env.visible,
    fetchVersion: env.fetchVersion,
    updateWorker: env.updateWorker,
    isBusy: () => env.busy,
    lastInputAt: () => env.lastInput,
    guard: { get: env.guardGet, set: env.guardSet },
    reload: env.reload,
    ...over
  };
  return { env, full };
}

describe('decide', () => {
  const base = { latest: 'bbb', reloadedFor: null, visible: true, busy: false, idleMs: IDLE_MS };
  it('does nothing when the version matches', () => expect(decide({ ...base, latest: null })).toBe('none'));
  it('reloads when clean and idle', () => expect(decide(base)).toBe('reload'));
  it('waits while the user is active', () => expect(decide({ ...base, idleMs: IDLE_MS - 1 })).toBe('none'));
  it('shows the bar, no reload, when something is being edited', () => expect(decide({ ...base, busy: true })).toBe('bar'));
  it('stops looping: already reloaded for this version shows the bar', () =>
    expect(decide({ ...base, reloadedFor: 'bbb' })).toBe('bar'));
  it('a different new version after a reload may reload again', () => expect(decide({ ...base, reloadedFor: 'aaa' })).toBe('reload'));
  it('never reloads while hidden', () => expect(decide({ ...base, visible: false })).toBe('none'));
});

describe('Updater', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('idle and clean: flushes, then reloads and records the guard', async () => {
    const { env, full } = makeEnv();
    const u = new Updater(full);
    const order: string[] = [];
    u.registerBeforeReload(() => void order.push('flush'));
    env.reload.mockImplementation(() => order.push('reload'));
    await u.check();
    await vi.waitFor(() => expect(env.reload).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['flush', 'reload']);
    expect(env.guardGet()).toBe('bbb');
    expect(env.updateWorker).toHaveBeenCalled();
  });

  it('composer dirty: shows the bar, never reloads; Update saves the draft first and then reloads', async () => {
    const { env, full } = makeEnv();
    env.busy = true;
    const u = new Updater(full);
    const saved = vi.fn(async () => undefined);
    u.registerBeforeReload(saved);
    await u.check();
    expect(u.barVisible).toBe(true);
    expect(env.reload).not.toHaveBeenCalled();
    u.evaluate();
    expect(env.reload).not.toHaveBeenCalled();
    await u.apply();
    expect(saved).toHaveBeenCalledTimes(1);
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it('active user: waits, then reloads once idle', async () => {
    const { env, full } = makeEnv();
    env.lastInput = env.t();
    const u = new Updater(full);
    await u.check();
    expect(env.reload).not.toHaveBeenCalled();
    expect(u.barVisible).toBe(false);
    env.advance(IDLE_MS);
    u.evaluate();
    await vi.waitFor(() => expect(env.reload).toHaveBeenCalledTimes(1));
  });

  it('loop guard: after a reload that did not bring the new version, show the bar and do not reload', async () => {
    const { env, full } = makeEnv();
    env.guardSet('bbb'); // set by the previous page load
    const u = new Updater(full);
    await u.check();
    expect(env.reload).not.toHaveBeenCalled();
    expect(u.barVisible).toBe(true);
  });

  it('a reload that worked clears the guard', () => {
    const { env, full } = makeEnv({ current: 'bbb' });
    env.guardSet('bbb');
    new Updater(full);
    expect(env.guardGet()).toBeNull();
  });

  it('throttles: at most one check every 2 minutes, unless forced', async () => {
    const { env, full } = makeEnv({ server: 'aaa' });
    const u = new Updater(full);
    await u.check();
    await u.check();
    expect(env.fetchVersion).toHaveBeenCalledTimes(1);
    env.advance(CHECK_MIN_GAP_MS - 1);
    await u.check();
    expect(env.fetchVersion).toHaveBeenCalledTimes(1);
    env.advance(1);
    await u.check();
    expect(env.fetchVersion).toHaveBeenCalledTimes(2);
    await u.check(true);
    expect(env.fetchVersion).toHaveBeenCalledTimes(3);
  });

  it('hidden: no checks, no timers firing, and nothing reloads', async () => {
    const { env, full } = makeEnv();
    env.visible = false;
    const u = new Updater(full);
    await u.check();
    expect(env.fetchVersion).not.toHaveBeenCalled();
    u.startTimers();
    u.onHidden(); // hiding stops the timers
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(env.fetchVersion).not.toHaveBeenCalled();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it('visible: checks again every 30 minutes', async () => {
    const { env, full } = makeEnv({ server: 'aaa' });
    const u = new Updater(full);
    u.onResume();
    await vi.advanceTimersByTimeAsync(1);
    expect(env.fetchVersion).toHaveBeenCalledTimes(1);
    // The fake timers do not move the injected clock: move it with them.
    for (let i = 0; i < 2; i++) {
      env.advance(CHECK_EVERY_MS);
      await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    }
    expect(env.fetchVersion.mock.calls.length).toBeGreaterThanOrEqual(2);
    u.stopTimers();
  });

  it('a failed version read changes nothing', async () => {
    const { env, full } = makeEnv({ server: null });
    const u = new Updater(full);
    expect(await u.check()).toBe(false);
    expect(env.reload).not.toHaveBeenCalled();
  });

  it('uses a stable guard key', () => expect(GUARD_KEY).toBe('mailloom.update.reloadedFor'));
});
