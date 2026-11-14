/**
 * Counts failed sign-ins per (email, client IP). After `maxFailures` failures within
 * `windowMs`, further attempts for that pair are refused until the oldest failure
 * leaves the window. A successful sign-in clears the pair. In memory only: a restart
 * resets the counters, which is acceptable for a throttle.
 */
export class LoginThrottle {
  private failures = new Map<string, number[]>();

  constructor(
    private maxFailures: number,
    private windowMs: number,
    private now: () => number = Date.now
  ) {}

  private key(email: string, ip: string): string {
    return `${email.trim().toLowerCase()}|${ip}`;
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) || []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Milliseconds until another attempt is allowed; 0 when allowed now. */
  retryAfterMs(email: string, ip: string): number {
    const list = this.recent(this.key(email, ip));
    if (list.length < this.maxFailures) return 0;
    return Math.max(1000, list[list.length - this.maxFailures] + this.windowMs - this.now());
  }

  recordFailure(email: string, ip: string): void {
    const key = this.key(email, ip);
    const list = this.recent(key);
    list.push(this.now());
    this.failures.set(key, list);
    if (this.failures.size > 10_000) this.prune();
  }

  recordSuccess(email: string, ip: string): void {
    this.failures.delete(this.key(email, ip));
  }

  prune(): void {
    for (const key of [...this.failures.keys()]) this.recent(key);
  }
}
