/** A small in-memory cache that forgets the oldest entries first. */
export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v); // most recent
    }
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  has(key: string): boolean {
    return this.map.has(key);
  }
}

/** Runs async jobs with at most `limit` at a time (prefetching must stay gentle). */
export class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        job()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.queue.shift()?.();
          });
      };
      if (this.active < this.limit) start();
      else this.queue.push(start);
    });
  }
}
