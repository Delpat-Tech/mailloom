/**
 * The layer stack behind the phone Back button. Each "screen" a phone user thinks of (reader, composer,
 * search, drawer, sheets) is a layer with one history entry. Back closes the top layer only; closing a layer
 * by its own control removes its entry again, so there are no stale entries and no double-back.
 *
 * Entries are tagged with their depth ({ mlLayer: n }), so a popstate says exactly how many layers to close.
 */
export interface HistoryPort {
  /** Make sure the current entry is the depth-0 base. */
  ensureBase(): void;
  pushDepth(depth: number): void;
  back(): void;
  go(delta: number): void;
}

export interface LayerEntry {
  close: () => void;
  /** Called when Back (not the layer itself) closed it, so an owner that is still open can ask again. */
  onPopped?: () => void;
  dead: boolean;
}

export class LayerStack {
  private stack: LayerEntry[] = [];
  private deferred: LayerEntry[] = [];
  private waiting = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private based = false;

  constructor(private port: HistoryPort) {}

  get depth(): number {
    return this.stack.length;
  }

  open(close: () => void, onPopped?: () => void): LayerEntry {
    const entry: LayerEntry = { close, onPopped, dead: false };
    if (this.waiting) this.deferred.push(entry);
    else this.push(entry);
    return entry;
  }

  /** The layer closed by itself (or its owner unmounted). */
  release(entry: LayerEntry): void {
    const i = this.deferred.indexOf(entry);
    if (i >= 0) {
      this.deferred.splice(i, 1);
      entry.dead = true;
      return;
    }
    if (entry.dead) return;
    entry.dead = true;
    if (this.stack[this.stack.length - 1] === entry) this.goBack();
  }

  /** A popstate arrived; depth is the depth tag of the entry now showing (0 when untagged). */
  onPop(depth: number): void {
    this.settle();
    if (depth > this.stack.length) {
      // Forward onto an entry whose layer is gone: step back to the real depth.
      this.hold();
      this.port.go(this.stack.length - depth);
      return;
    }
    while (this.stack.length > depth) {
      const e = this.stack.pop() as LayerEntry;
      if (!e.dead) {
        e.dead = true;
        e.onPopped?.();
        e.close();
      }
    }
    const top = this.stack[this.stack.length - 1];
    if (top && top.dead) {
      this.goBack(); // a stale entry is now showing: step over it
      return;
    }
    this.flush();
  }

  private push(entry: LayerEntry): void {
    if (!this.based) {
      this.port.ensureBase();
      this.based = true;
    }
    this.stack.push(entry);
    this.port.pushDepth(this.stack.length);
  }

  private hold(): void {
    this.waiting = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.waiting = false;
      this.flush();
    }, 400);
  }

  private settle(): void {
    this.waiting = false;
    clearTimeout(this.timer);
  }

  private goBack(): void {
    this.hold();
    this.port.back();
  }

  private flush(): void {
    const pending = this.deferred.splice(0);
    for (const e of pending) if (!e.dead) this.push(e);
  }
}

export function browserPort(): HistoryPort {
  return {
    ensureBase: () => {
      const s = window.history.state as { mlLayer?: number } | null;
      if (s?.mlLayer !== 0) window.history.replaceState({ mlLayer: 0 }, '');
    },
    pushDepth: (d) => window.history.pushState({ mlLayer: d }, ''),
    back: () => window.history.back(),
    go: (n) => window.history.go(n)
  };
}
