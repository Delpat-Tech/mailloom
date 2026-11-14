// Small in-memory counter: how many operations a key (one signed-in account) has running right now.
const running = new Map<string, number>();

/** Take a slot for `key`; returns a release function, or null when `max` are already running. */
export function acquireSlot(key: string, max: number): (() => void) | null {
  const n = running.get(key) || 0;
  if (n >= max) return null;
  running.set(key, n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (running.get(key) || 1) - 1;
    if (left <= 0) running.delete(key);
    else running.set(key, left);
  };
}

export function runningCount(key: string): number {
  return running.get(key) || 0;
}
