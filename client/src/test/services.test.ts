import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { snoozePresets } from '../services/snooze.js';
import { threadSummary } from '../services/threads.js';
import { labelStates, colourOf } from '../services/labels.js';
import { parseViewPath, labelPath } from '../services/views.js';
import { clockTime } from '../services/time.js';
import { actionForKey, isTypingTarget, SHORTCUTS } from '../services/shortcuts.js';
import { PendingActions } from '../services/pendingActions.js';
import { LruCache, Limiter } from '../services/cache.js';

describe('snooze presets', () => {
  it('offers later today only before 18:00', () => {
    const morning = new Date(2026, 10, 11, 10, 0); // Wed 11 Nov 2026
    expect(snoozePresets(morning).map((p) => p.key)).toEqual(['later', 'tomorrow', 'weekend', 'nextweek']);
    const night = new Date(2026, 10, 11, 19, 0);
    expect(snoozePresets(night).map((p) => p.key)).toEqual(['tomorrow', 'weekend', 'nextweek']);
  });

  it('picks 18:00, tomorrow 09:00, Saturday 09:00 and Monday 09:00', () => {
    const p = Object.fromEntries(snoozePresets(new Date(2026, 10, 11, 10, 0)).map((x) => [x.key, x.at]));
    expect(p.later.getHours()).toBe(18);
    expect(p.tomorrow.getDate()).toBe(12);
    expect(p.tomorrow.getHours()).toBe(9);
    expect(p.weekend.getDay()).toBe(6);
    expect(p.weekend.getDate()).toBe(14);
    expect(p.nextweek.getDay()).toBe(1);
    expect(p.nextweek.getDate()).toBe(16);
  });

  it('on a Saturday afternoon "this weekend" is next Saturday; on Monday "next week" is a week ahead', () => {
    const sat = new Date(2026, 10, 14, 15, 0);
    expect(snoozePresets(sat).find((p) => p.key === 'weekend')!.at.getDate()).toBe(21);
    const mon = new Date(2026, 10, 16, 8, 0);
    expect(snoozePresets(mon).find((p) => p.key === 'nextweek')!.at.getDate()).toBe(23);
  });
});

describe('threads, labels, views, time', () => {
  it('summarises a conversation without the person themself', () => {
    const info = {
      subject: 'x',
      participants: [
        { name: 'Me', address: 'me@delpat.in' },
        { name: 'Ann', address: 'ann@x.test' },
        { name: 'Ben', address: 'ben@x.test' }
      ],
      messages: [1, 2, 3, 4].map((uid) => ({ mailbox: 'INBOX', uid, from: { name: '', address: '' }, date: '', snippet: '', isOwn: false }))
    };
    expect(threadSummary(info, 'me@delpat.in')).toBe('4 messages with Ann and Ben');
    expect(threadSummary({ ...info, messages: info.messages.slice(0, 1), participants: [info.participants[1]] })).toBe('1 message with Ann');
  });

  it('works out checked, unchecked and mixed labels', () => {
    const labels = [
      { id: 'a', name: 'A', colour: 'mint' as const, count: 0 },
      { id: 'b', name: 'B', colour: 'blue' as const, count: 0 },
      { id: 'c', name: 'C', colour: 'coral' as const, count: 0 }
    ];
    const s = labelStates(labels, [{ labels: ['a', 'b'] }, { labels: ['a'] }]);
    expect(s).toEqual({ a: 'on', b: 'mixed', c: 'off' });
    expect(colourOf({ colour: 'nonsense' })).toBe('blue');
  });

  it('reads virtual view paths', () => {
    expect(parseViewPath('@starred')).toEqual({ kind: 'starred' });
    expect(parseViewPath(labelPath('x1'))).toEqual({ kind: 'label', id: 'x1' });
    expect(parseViewPath('INBOX')).toBeNull();
  });

  it('formats the clock as HH:MM', () => {
    expect(clockTime(new Date(2026, 0, 1, 7, 5))).toBe('07:05');
  });
});

describe('keyboard shortcuts', () => {
  const press = (key: string, target: EventTarget | null = document.body, extra: Partial<KeyboardEvent> = {}) =>
    actionForKey({ key, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target, ...extra } as unknown as unknown as KeyboardEvent);

  it('maps every documented key', () => {
    const expected: Record<string, string> = {
      c: 'write', '/': 'search', e: 'archive', h: 'snooze', l: 'label', r: 'reply', a: 'replyAll', f: 'forward',
      j: 'next', k: 'prev', s: 'star', u: 'unread', '#': 'delete', Delete: 'delete', Escape: 'close', '?': 'help', ArrowDown: 'next', ArrowUp: 'prev', Enter: 'open'
    };
    for (const [k, a] of Object.entries(expected)) expect(press(k)).toBe(a);
    expect(SHORTCUTS.length).toBeGreaterThanOrEqual(16);
  });

  it('is case-insensitive for letters but ignores Ctrl, Alt and Meta', () => {
    expect(press('C')).toBe('write');
    expect(press('c', document.body, { ctrlKey: true })).toBeNull();
    expect(press('c', document.body, { metaKey: true })).toBeNull();
  });

  it('never fires while typing in an input, a textarea or the editor', () => {
    const input = document.createElement('input');
    input.type = 'text';
    const area = document.createElement('textarea');
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    editor.setAttribute('contenteditable', 'true');
    const inner = document.createElement('p');
    editor.appendChild(inner);
    document.body.append(input, area, editor);
    expect(isTypingTarget(input)).toBe(true);
    expect(press('c', input)).toBeNull();
    expect(press('e', area)).toBeNull();
    expect(press('j', inner)).toBeNull();
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(isTypingTarget(box)).toBe(false);
  });

  it('leaves Enter to a focused button, and arrows to the list', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    expect(press('Enter', btn)).toBeNull();
    const row = document.createElement('button');
    row.setAttribute('data-row-open', '1');
    document.body.appendChild(row);
    expect(press('ArrowDown', row)).toBeNull();
  });

  it('only Escape and ? work while a dialog is open', () => {
    const e = { key: 'c', ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target: document.body } as unknown as KeyboardEvent;
    expect(actionForKey(e, { blocked: true })).toBeNull();
    expect(actionForKey({ ...e, key: 'Escape' } as KeyboardEvent, { blocked: true })).toBe('close');
  });
});

describe('optimistic archive with undo', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (run: () => Promise<void>) => {
    const state = { rows: [1, 2, 3], errors: [] as unknown[], done: 0 };
    const q = new PendingActions(6000);
    const archive = (uid: number) =>
      q.schedule({
        label: 'Archived',
        apply: () => (state.rows = state.rows.filter((r) => r !== uid)),
        restore: () => (state.rows = [1, 2, 3]),
        run,
        onDone: () => state.done++,
        onFail: (e) => state.errors.push(e)
      });
    return { state, q, archive };
  };

  it('removes the row at once and calls the server after the undo window', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const { state, q, archive } = make(run);
    archive(2);
    expect(state.rows).toEqual([1, 3]);
    expect(q.latest?.label).toBe('Archived');
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(state.done).toBe(1);
    expect(q.latest).toBeNull();
  });

  it('Undo puts the row back and never calls the server', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const { state, q, archive } = make(run);
    archive(2);
    expect(q.undo()).toBe(true);
    expect(state.rows).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).not.toHaveBeenCalled();
    expect(q.undo()).toBe(false);
  });

  it('puts the row back and reports when the server fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('down'));
    const { state, q, archive } = make(run);
    archive(2);
    await vi.advanceTimersByTimeAsync(6000);
    expect(state.rows).toEqual([1, 2, 3]);
    expect(state.errors).toHaveLength(1);
    expect(state.done).toBe(0);
    expect(q.latest).toBeNull();
  });

  it('flush runs waiting actions straight away', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const { q, archive } = make(run);
    archive(1);
    await q.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('cache helpers', () => {
  it('forgets the least recently used entry', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(c.has('b')).toBe(false);
    expect(c.get('a')).toBe(1);
  });

  it('limits how many jobs run at once', async () => {
    const lim = new Limiter(2);
    let active = 0;
    let peak = 0;
    const job = () =>
      new Promise<void>((res) => {
        active++;
        peak = Math.max(peak, active);
        setTimeout(() => {
          active--;
          res();
        }, 5);
      });
    await Promise.all([1, 2, 3, 4, 5].map(() => lim.run(job)));
    expect(peak).toBe(2);
  });
});
