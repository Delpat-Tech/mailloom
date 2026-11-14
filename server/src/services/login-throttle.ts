/**
 * Counts sign-in attempts in three sliding-window buckets:
 *   - email + client IP   (maxFailures, e.g. 5)
 *   - client IP           (ipMaxFailures, e.g. 20)  stops one source guessing across many mailboxes
 *   - email               (emailMaxFailures, e.g. 10) stops many sources guessing one mailbox
 * An attempt is counted BEFORE the mail server is asked (begin), so parallel requests cannot
 * slip past the limit. A successful sign-in takes its own attempt back (succeed), and also
 * clears the email+IP bucket. In memory only: a restart resets the counters.
 */
export class LoginThrottle {
  private buckets = new Map<string, number[]>();

  constructor(
    private maxFailures: number,
    private windowMs: number,
    private now: () => number = Date.now,
    private ipMaxFailures = 20,
    private emailMaxFailures = 10
  ) {}

  private keys(email: string, ip: string): { pair: string; ip: string; email: string } {
    const e = email.trim().toLowerCase();
    return { pair: `p|${e}|${ip}`, ip: `i|${ip}`, email: `e|${e}` };
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.buckets.get(key) || []).filter((t) => t > cutoff);
    if (list.length) this.buckets.set(key, list);
    else this.buckets.delete(key);
    return list;
  }

  private wait(key: string, limit: number): number {
    const list = this.recent(key);
    if (list.length < limit) return 0;
    return Math.max(1000, list[list.length - limit]! + this.windowMs - this.now());
  }

  /**
   * Call before checking the password. Returns 0 and counts the attempt when allowed;
   * otherwise returns the milliseconds to wait and counts nothing.
   */
  begin(email: string, ip: string): number {
    const k = this.keys(email, ip);
    const retry = Math.max(
      this.wait(k.pair, this.maxFailures),
      this.wait(k.ip, this.ipMaxFailures),
      this.wait(k.email, this.emailMaxFailures)
    );
    if (retry > 0) return retry;
    const t = this.now();
    for (const key of [k.pair, k.ip, k.email]) {
      const list = this.recent(key);
      list.push(t);
      this.buckets.set(key, list);
    }
    if (this.buckets.size > 30_000) this.prune();
    return 0;
  }

  private takeBack(key: string): void {
    const list = this.recent(key);
    list.pop();
    if (list.length) this.buckets.set(key, list);
    else this.buckets.delete(key);
  }

  /** The password was right: forget this attempt and the email+IP failures. */
  succeed(email: string, ip: string): void {
    const k = this.keys(email, ip);
    this.buckets.delete(k.pair);
    this.takeBack(k.ip);
    this.takeBack(k.email);
  }

  /** The attempt never reached a verdict (mail server down): do not count it. */
  refund(email: string, ip: string): void {
    const k = this.keys(email, ip);
    for (const key of [k.pair, k.ip, k.email]) this.takeBack(key);
  }

  prune(): void {
    for (const key of [...this.buckets.keys()]) this.recent(key);
  }
}
