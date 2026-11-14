import { describe, it, expect } from 'vitest';
import { LayerStack, type HistoryPort } from '../services/layers.js';

/** A tiny fake browser history: entries with depth tags, and an async back like the real thing. */
function fake() {
  const entries = [0];
  let idx = 0;
  const queue: number[] = [];
  const port: HistoryPort = {
    ensureBase: () => {},
    pushDepth: (d) => {
      entries.splice(idx + 1);
      entries.push(d);
      idx++;
    },
    back: () => queue.push(-1),
    go: (n) => queue.push(n)
  };
  const stack = new LayerStack(port);
  const flush = () => {
    while (queue.length) {
      const n = queue.shift() as number;
      idx = Math.max(0, Math.min(entries.length - 1, idx + n));
      stack.onPop(entries[idx]);
    }
  };
  const userBack = () => {
    queue.push(-1);
    flush();
  };
  return { stack, flush, userBack, pos: () => idx };
}

describe('LayerStack', () => {
  it('Back closes only the top layer, in order', () => {
    const f = fake();
    const closed: string[] = [];
    f.stack.open(() => closed.push('reader'));
    f.stack.open(() => closed.push('composer'));
    f.userBack();
    expect(closed).toEqual(['composer']);
    f.userBack();
    expect(closed).toEqual(['composer', 'reader']);
    expect(f.pos()).toBe(0);
  });

  it('closing a layer itself pops its entry (no stale entries)', () => {
    const f = fake();
    const a = f.stack.open(() => {});
    expect(f.pos()).toBe(1);
    f.stack.release(a);
    f.flush();
    expect(f.pos()).toBe(0);
    expect(f.stack.depth).toBe(0);
  });

  it('a layer closed below another keeps its entry until the top goes, then steps over it', () => {
    const f = fake();
    const a = f.stack.open(() => {});
    const b = f.stack.open(() => {});
    f.stack.release(a);
    f.flush();
    expect(f.pos()).toBe(2);
    f.stack.release(b);
    f.flush();
    expect(f.pos()).toBe(0);
    expect(f.stack.depth).toBe(0);
  });

  it('Back on the top layer steps over a dead one beneath it', () => {
    const f = fake();
    const closed: string[] = [];
    const a = f.stack.open(() => closed.push('a'));
    f.stack.open(() => closed.push('b'));
    f.stack.release(a);
    f.userBack();
    expect(closed).toEqual(['b']);
    expect(f.pos()).toBe(0);
  });

  it('a push straight after a close waits for the history step to finish', () => {
    const f = fake();
    const a = f.stack.open(() => {});
    f.stack.release(a);
    f.stack.open(() => {});
    f.flush();
    expect(f.stack.depth).toBe(1);
    expect(f.pos()).toBe(1);
  });

  it('tells the owner it was popped, so it can ask again', () => {
    const f = fake();
    let popped = 0;
    f.stack.open(
      () => {},
      () => popped++
    );
    f.userBack();
    expect(popped).toBe(1);
  });

  it('a forward onto a missing layer steps back', () => {
    const f = fake();
    f.stack.open(() => {});
    f.userBack();
    f.stack.onPop(1);
    f.flush();
    expect(f.pos()).toBe(0);
  });
});
