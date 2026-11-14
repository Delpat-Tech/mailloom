/**
 * Optimistic actions with Undo (archive, delete, snooze, move).
 *
 * The screen changes at once (`apply`). The server call (`run`) waits for the undo window (6 s).
 * Undo cancels the call and puts the screen back (`restore`), so there is nothing to reverse on
 * the server (a moved mail gets a new UID there, which makes "move it back" unreliable).
 * If `run` fails, the screen is put back too and `onFail` says why in plain words.
 * `flush` runs everything waiting now (used when the tab is hidden or closed).
 */
export interface PendingAction {
  label: string;
  /** Put the change on screen now (called by schedule). */
  apply: () => void;
  /** Put the screen back as it was. */
  restore: () => void;
  /** The real server call. */
  run: () => Promise<void>;
  /** After the server call worked. */
  onDone?: () => void;
  /** After the server call failed (the screen is already restored). */
  onFail: (err: unknown) => void;
}

interface Entry extends PendingAction {
  id: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export const UNDO_WINDOW_MS = 6000;

export class PendingActions {
  private entries: Entry[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();

  constructor(private readonly delay = UNDO_WINDOW_MS) {}

  /** The action Undo would reverse: the most recent one still waiting. */
  get latest(): { id: number; label: string } | null {
    const e = this.entries[this.entries.length - 1];
    return e ? { id: e.id, label: e.label } : null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  schedule(action: PendingAction): number {
    const entry: Entry = { ...action, id: this.nextId++, timer: undefined };
    entry.apply();
    entry.timer = setTimeout(() => void this.commit(entry), this.delay);
    this.entries.push(entry);
    this.emit();
    return entry.id;
  }

  /** Undo the latest action, or the one with this id. Returns false when it is already committed. */
  undo(id?: number): boolean {
    const i = id === undefined ? this.entries.length - 1 : this.entries.findIndex((e) => e.id === id);
    if (i < 0) return false;
    const [entry] = this.entries.splice(i, 1);
    clearTimeout(entry.timer);
    entry.restore();
    this.emit();
    return true;
  }

  private async commit(entry: Entry): Promise<void> {
    const i = this.entries.indexOf(entry);
    if (i < 0) return; // undone meanwhile
    this.entries.splice(i, 1);
    clearTimeout(entry.timer);
    this.emit();
    try {
      await entry.run();
      entry.onDone?.();
    } catch (err) {
      entry.restore();
      entry.onFail(err);
    }
  }

  /** Run everything that is waiting right now. */
  async flush(): Promise<void> {
    await Promise.all([...this.entries].map((e) => this.commit(e)));
  }
}
