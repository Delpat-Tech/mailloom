import type { FastifyBaseLogger } from 'fastify';
import { deliverReport, type IntakeConfig, type SinkResult } from './feedback-sink.js';
import type { FeedbackStore } from './feedback-store.js';

/**
 * Background delivery of stored reports to Work OS: one attempt right after a report is saved, then a timer
 * picks up anything pending. Failures back off (30 s, 2 min, 10 min, 30 min, 2 h, then 6 h) and the report is
 * kept until Work OS has it. A config problem (401/503) waits at least 15 minutes. Logs carry the report id and
 * an error code only, never the token or any report text.
 */

const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000];
const CONFIG_WAIT_MS = 15 * 60_000;
const MAX_WAIT_MS = 6 * 3_600_000;

export class FeedbackDelivery {
  private timer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private store: FeedbackStore,
    private cfg: IntakeConfig,
    private log: FastifyBaseLogger,
    private now: () => number = Date.now,
    private fetchImpl?: typeof fetch,
    private tickMs = 30_000
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();
    void this.tick();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.idle();
  }

  /** Resolves when everything queued so far has been tried. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Tries one new report now, in the background. */
  kick(): void {
    this.chain = this.chain.then(() => this.run());
  }

  /** Tries everything that is due. */
  tick(): Promise<void> {
    this.chain = this.chain.then(() => this.run());
    return this.chain;
  }

  private async run(): Promise<void> {
    if (this.closed) return;
    try {
      this.store.prune();
      for (const r of this.store.due()) {
        if (this.closed) return;
        const result = await deliverReport(this.cfg, r, { fetch: this.fetchImpl, now: this.now });
        this.apply(r.id, r.attempts, result);
      }
    } catch (err) {
      this.log.warn({ errName: (err as { name?: string })?.name }, 'Report delivery run failed');
    }
  }

  private apply(id: string, attempts: number, r: SinkResult): void {
    if (r.kind === 'ok') {
      this.store.delivered(id, r.ref);
      this.log.info({ report: id }, 'Report delivered to Work OS');
    } else if (r.kind === 'permanent') {
      this.store.failed(id, r.code);
      this.log.error({ report: id, code: r.code }, 'Work OS refused a report for good; it is kept');
    } else {
      let wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!;
      if (r.configProblem) wait = Math.max(wait, CONFIG_WAIT_MS);
      if (r.afterMs !== undefined) wait = Math.min(Math.max(r.afterMs, 1000), MAX_WAIT_MS);
      this.store.retryAt(id, this.now() + wait, r.code);
      this.log.warn({ report: id, code: r.code, retryInMs: wait }, 'Report not delivered yet; will retry');
    }
  }
}
