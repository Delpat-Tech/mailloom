import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/services/sessions.js';

const MIN = 60_000;
const DAY = 86_400_000;
const lifetimes = { idleMs: 30 * MIN, shortMaxMs: 12 * 60 * MIN, rememberMs: 30 * DAY };

function setup() {
  let now = 1_000_000_000_000;
  const store = new SessionStore(':memory:', 'x'.repeat(40), lifetimes, () => now);
  return { store, advance: (ms: number) => (now += ms), at: () => now };
}
const input = (remember: boolean) => ({ email: 'a@delpat.test', name: 'A', password: 'pw', isDemo: false, remember });

describe('remember-me sessions slide', () => {
  test('use extends expiry to now + remember window', () => {
    const { store, advance, at } = setup();
    const { sessionId } = store.create(input(true));
    advance(10 * DAY);
    const r = store.resolve(sessionId);
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(store.touch(r.session), true);
    assert.equal(r.session.expiresAt, at() + 30 * DAY);
    // 35 days after login but only 25 after last use: still valid.
    advance(25 * DAY);
    assert.equal(store.resolve(sessionId).status, 'ok');
  });

  test('no idle limit: a remember session unused for a day is still valid', () => {
    const { store, advance } = setup();
    const { sessionId } = store.create(input(true));
    advance(DAY);
    assert.equal(store.resolve(sessionId).status, 'ok');
  });

  test('an unused session still expires after the window', () => {
    const { store, advance } = setup();
    const { sessionId } = store.create(input(true));
    advance(30 * DAY + 1);
    assert.equal(store.resolve(sessionId).status, 'expired');
  });

  test('writes are throttled to once an hour', () => {
    const { store, advance } = setup();
    const { sessionId } = store.create(input(true));
    advance(30 * MIN);
    let r = store.resolve(sessionId);
    if (r.status !== 'ok') throw new Error('expired');
    assert.equal(store.touch(r.session), false);
    advance(31 * MIN);
    r = store.resolve(sessionId);
    if (r.status !== 'ok') throw new Error('expired');
    assert.equal(store.touch(r.session), true);
    assert.equal(store.touch(r.session), false);
  });
});

describe('non-remember sessions keep the idle limit', () => {
  test('idle for over the limit is refused', () => {
    const { store, advance } = setup();
    const { sessionId } = store.create(input(false));
    advance(31 * MIN);
    assert.equal(store.resolve(sessionId).status, 'expired');
  });
  test('activity slides the idle window but not past the absolute cap', () => {
    const { store, advance } = setup();
    const { sessionId } = store.create(input(false));
    advance(20 * MIN);
    const r = store.resolve(sessionId);
    if (r.status !== 'ok') throw new Error('expired');
    assert.equal(store.touch(r.session), true);
    advance(20 * MIN);
    assert.equal(store.resolve(sessionId).status, 'ok');
  });
});

describe('absolute cap for remember sessions', () => {
  const capped = { ...lifetimes, rememberMaxMs: 180 * DAY };
  function setupCapped() {
    let now = 1_000_000_000_000;
    const store = new SessionStore(':memory:', 'x'.repeat(40), capped, () => now);
    return { store, advance: (ms: number) => (now += ms), at: () => now };
  }
  test('daily use slides to the cap and then ends, 180 days from creation', () => {
    const { store, advance, at } = setupCapped();
    const { sessionId } = store.create(input(true));
    const created = at();
    for (let day = 1; day <= 179; day++) {
      advance(DAY);
      const r = store.resolve(sessionId);
      assert.equal(r.status, 'ok', `day ${day}`);
      if (r.status === 'ok') store.touch(r.session);
    }
    const r = store.resolve(sessionId);
    assert.equal(r.status === 'ok' && r.session.expiresAt, created + 180 * DAY, 'expiry clamped to the cap');
    advance(DAY);
    assert.equal(store.resolve(sessionId).status, 'expired');
  });
  test('default cap is 180 days when not configured', () => {
    let now = 1_000_000_000_000;
    const store = new SessionStore(':memory:', 'x'.repeat(40), lifetimes, () => now);
    const { sessionId } = store.create(input(true));
    for (let day = 1; day <= 180; day++) {
      now += DAY;
      const r = store.resolve(sessionId);
      if (day === 180) assert.equal(r.status, 'expired');
      else if (r.status === 'ok') store.touch(r.session);
      else assert.fail(`expired early on day ${day}`);
    }
  });
  test('short sessions are not affected by the remember cap', () => {
    const { store, advance } = setupCapped();
    const { sessionId } = store.create(input(false));
    advance(20 * MIN);
    assert.equal(store.resolve(sessionId).status, 'ok');
  });
});
