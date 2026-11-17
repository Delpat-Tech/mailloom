import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

/**
 * "Report a problem" reports, kept in Mailloom's own sqlite until Work OS has them (status 'pending'), so
 * nothing is lost while Work OS is unreachable. Text only. 'failed' = Work OS refused it for good; it stays
 * for the administrator. Delivered rows are pruned after 30 days.
 */

export type FeedbackStatus = 'pending' | 'delivered' | 'failed';

export interface FeedbackRow {
  id: string;
  mailbox: string;
  created: number;
  text: string;
  expected: string;
  details: Record<string, unknown>;
  status: FeedbackStatus;
  ref: string | null;
  attempts: number;
  nextTry: number;
  lastCode: string | null;
}

const KEEP_DELIVERED_MS = 30 * 86_400_000;

export class FeedbackStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        mailbox TEXT NOT NULL,
        created INTEGER NOT NULL,
        text TEXT NOT NULL,
        expected TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL,
        ref TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_try INTEGER NOT NULL DEFAULT 0,
        last_code TEXT
      );
      CREATE INDEX IF NOT EXISTS feedback_due ON feedback (status, next_try);
    `);
  }

  add(input: { mailbox: string; text: string; expected: string; details: Record<string, unknown> }): string {
    const id = randomBytes(16).toString('hex');
    const t = this.now();
    this.db
      .prepare('INSERT INTO feedback (id, mailbox, created, text, expected, details, status, next_try) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.mailbox.toLowerCase(), t, input.text, input.expected, JSON.stringify(input.details), 'pending', t);
    return id;
  }

  private row(r: Record<string, unknown>): FeedbackRow {
    return {
      id: r.id as string,
      mailbox: r.mailbox as string,
      created: Number(r.created),
      text: r.text as string,
      expected: r.expected as string,
      details: JSON.parse(r.details as string) as Record<string, unknown>,
      status: r.status as FeedbackStatus,
      ref: (r.ref as string | null) ?? null,
      attempts: Number(r.attempts),
      nextTry: Number(r.next_try),
      lastCode: (r.last_code as string | null) ?? null
    };
  }

  get(id: string): FeedbackRow | undefined {
    const r = this.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.row(r) : undefined;
  }

  /** Pending reports whose time has come, oldest first. */
  due(limit = 10): FeedbackRow[] {
    return (
      this.db.prepare("SELECT * FROM feedback WHERE status = 'pending' AND next_try <= ? ORDER BY created LIMIT ?").all(this.now(), limit) as Array<Record<string, unknown>>
    ).map((r) => this.row(r));
  }

  pendingCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'pending'").get() as { n: number }).n);
  }

  delivered(id: string, ref: string): void {
    this.db.prepare("UPDATE feedback SET status = 'delivered', ref = ?, attempts = attempts + 1, last_code = NULL WHERE id = ?").run(ref, id);
  }

  failed(id: string, code: string): void {
    this.db.prepare("UPDATE feedback SET status = 'failed', attempts = attempts + 1, last_code = ? WHERE id = ?").run(code, id);
  }

  retryAt(id: string, at: number, code: string): void {
    this.db.prepare('UPDATE feedback SET next_try = ?, attempts = attempts + 1, last_code = ? WHERE id = ?').run(at, code, id);
  }

  prune(): void {
    this.db.prepare("DELETE FROM feedback WHERE status = 'delivered' AND created < ?").run(this.now() - KEEP_DELIVERED_MS);
  }
}
