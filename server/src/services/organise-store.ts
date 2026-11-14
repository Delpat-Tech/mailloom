import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Per-mailbox organising data, in the same node:sqlite database as the sessions:
 *  - label definitions (the labels themselves are IMAP keywords on the messages);
 *  - snooze records (Message-ID + wake time; the message sits in the "Snoozed" folder);
 *  - a small conversation index (Message-ID and thread id per folder UID), updated by UID.
 * Every row is keyed by the lower-cased mailbox address, and every query names it.
 */

export const LABEL_COLOURS = ['mint', 'coral', 'lilac', 'marigold', 'blue'] as const;
export type LabelColour = (typeof LABEL_COLOURS)[number];

export interface LabelDef {
  id: string;
  name: string;
  colour: LabelColour;
  order: number;
}

export const DEFAULT_LABELS: Array<{ name: string; colour: LabelColour }> = [
  { name: 'Client', colour: 'mint' },
  { name: 'Finance', colour: 'marigold' },
  { name: 'Product', colour: 'lilac' },
  { name: 'People', colour: 'coral' },
  { name: 'Ops', colour: 'blue' }
];

export const MAX_LABELS = 50;
export const LABEL_ID_RE = /^[a-z0-9]{10}$/;

export interface SnoozeRow {
  email: string;
  messageId: string;
  until: number;
}

export interface ThreadRow {
  folder: string;
  uid: number;
  threadId: string;
}

const lc = (email: string) => email.trim().toLowerCase();

function newLabelId(): string {
  // ASCII only (IMAP keyword atom): 10 characters of [a-z0-9].
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export class OrganiseStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS labels (
        email TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        colour TEXT NOT NULL,
        ord INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (email, id)
      );
      CREATE TABLE IF NOT EXISTS label_seeded (
        email TEXT PRIMARY KEY,
        seeded_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snoozes (
        email TEXT NOT NULL,
        message_id TEXT NOT NULL,
        until INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (email, message_id)
      );
      CREATE INDEX IF NOT EXISTS snoozes_until ON snoozes (until);
      CREATE TABLE IF NOT EXISTS thread_index (
        email TEXT NOT NULL,
        folder TEXT NOT NULL,
        uid INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        PRIMARY KEY (email, folder, uid)
      );
      CREATE INDEX IF NOT EXISTS thread_index_thread ON thread_index (email, thread_id);
      CREATE TABLE IF NOT EXISTS thread_sync (
        email TEXT NOT NULL,
        folder TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        last_uid INTEGER NOT NULL,
        PRIMARY KEY (email, folder)
      );
    `);
  }

  // ---------------- labels ----------------

  /** The mailbox's labels in order. The defaults are created the first time a mailbox asks. */
  labels(email: string): LabelDef[] {
    const e = lc(email);
    const seeded = this.db.prepare('SELECT 1 FROM label_seeded WHERE email = ?').get(e);
    if (!seeded) {
      this.db.exec('BEGIN');
      try {
        if (!this.db.prepare('SELECT 1 FROM label_seeded WHERE email = ?').get(e)) {
          DEFAULT_LABELS.forEach((l, i) => this.insertLabel(e, l.name, l.colour, i));
          this.db.prepare('INSERT INTO label_seeded (email, seeded_at) VALUES (?, ?)').run(e, this.now());
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    const rows = this.db
      .prepare('SELECT id, name, colour, ord FROM labels WHERE email = ? ORDER BY ord, created_at')
      .all(e) as Array<{ id: string; name: string; colour: LabelColour; ord: number }>;
    return rows.map((r) => ({ id: r.id, name: r.name, colour: r.colour, order: r.ord }));
  }

  label(email: string, id: string): LabelDef | null {
    return this.labels(email).find((l) => l.id === id) ?? null;
  }

  private insertLabel(email: string, name: string, colour: LabelColour, ord: number): string {
    const id = newLabelId();
    this.db
      .prepare('INSERT INTO labels (email, id, name, colour, ord, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(email, id, name, colour, ord, this.now());
    return id;
  }

  createLabel(email: string, name: string, colour: LabelColour): LabelDef {
    const e = lc(email);
    const existing = this.labels(e);
    const ord = existing.reduce((m, l) => Math.max(m, l.order + 1), 0);
    const id = this.insertLabel(e, name, colour, ord);
    return { id, name, colour, order: ord };
  }

  updateLabel(email: string, id: string, patch: { name?: string; colour?: LabelColour; order?: number }): LabelDef | null {
    const e = lc(email);
    const current = this.label(e, id);
    if (!current) return null;
    const next: LabelDef = { ...current, name: patch.name ?? current.name, colour: patch.colour ?? current.colour };
    this.db.prepare('UPDATE labels SET name = ?, colour = ? WHERE email = ? AND id = ?').run(next.name, next.colour, e, id);
    if (patch.order !== undefined) {
      // order is a position: the label moves there and the others close up around it.
      const others = this.labels(e).filter((l) => l.id !== id);
      const at = Math.min(Math.max(0, patch.order), others.length);
      const sequence = [...others.slice(0, at).map((l) => l.id), id, ...others.slice(at).map((l) => l.id)];
      const set = this.db.prepare('UPDATE labels SET ord = ? WHERE email = ? AND id = ?');
      sequence.forEach((lid, i) => set.run(i, e, lid));
      next.order = at;
    }
    return next;
  }

  deleteLabel(email: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM labels WHERE email = ? AND id = ?').run(lc(email), id).changes) > 0;
  }

  // ---------------- snoozes ----------------

  /** Records (or moves) a snooze. Written before the message is moved, so a crash never strands mail unrecorded. */
  putSnooze(email: string, messageId: string, until: number): void {
    this.db
      .prepare(
        `INSERT INTO snoozes (email, message_id, until, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (email, message_id) DO UPDATE SET until = excluded.until`
      )
      .run(lc(email), messageId, until, this.now());
  }

  deleteSnooze(email: string, messageId: string): void {
    this.db.prepare('DELETE FROM snoozes WHERE email = ? AND message_id = ?').run(lc(email), messageId);
  }

  snoozes(email: string): SnoozeRow[] {
    const rows = this.db.prepare('SELECT email, message_id, until FROM snoozes WHERE email = ? ORDER BY until').all(lc(email)) as Array<{
      email: string;
      message_id: string;
      until: number;
    }>;
    return rows.map((r) => ({ email: r.email, messageId: r.message_id, until: r.until }));
  }

  dueSnoozes(email: string): SnoozeRow[] {
    const now = this.now();
    return this.snoozes(email).filter((r) => r.until <= now);
  }

  hasDue(email: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM snoozes WHERE email = ? AND until <= ? LIMIT 1').get(lc(email), this.now());
  }

  /** Mailboxes with at least one snooze that is due. */
  dueMailboxes(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT email FROM snoozes WHERE until <= ?').all(this.now()) as Array<{ email: string }>;
    return rows.map((r) => r.email);
  }

  // ---------------- conversation index ----------------

  syncState(email: string, folder: string): { uidValidity: string; lastUid: number } | null {
    const r = this.db.prepare('SELECT uid_validity, last_uid FROM thread_sync WHERE email = ? AND folder = ?').get(lc(email), folder) as
      | { uid_validity: string; last_uid: number }
      | undefined;
    return r ? { uidValidity: r.uid_validity, lastUid: Number(r.last_uid) } : null;
  }

  /** Forget a folder's index (UIDVALIDITY changed). */
  resetFolder(email: string, folder: string, uidValidity: string): void {
    const e = lc(email);
    this.db.prepare('DELETE FROM thread_index WHERE email = ? AND folder = ?').run(e, folder);
    this.db
      .prepare(
        `INSERT INTO thread_sync (email, folder, uid_validity, last_uid) VALUES (?, ?, ?, 0)
         ON CONFLICT (email, folder) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = 0`
      )
      .run(e, folder, uidValidity);
  }

  addToIndex(email: string, folder: string, rows: Array<{ uid: number; threadId: string }>, lastUid: number): void {
    const e = lc(email);
    const ins = this.db.prepare('INSERT OR REPLACE INTO thread_index (email, folder, uid, thread_id) VALUES (?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const r of rows) ins.run(e, folder, r.uid, r.threadId);
      this.db.prepare('UPDATE thread_sync SET last_uid = ? WHERE email = ? AND folder = ?').run(lastUid, e, folder);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  indexedUids(email: string, folder: string): number[] {
    const rows = this.db.prepare('SELECT uid FROM thread_index WHERE email = ? AND folder = ?').all(lc(email), folder) as Array<{ uid: number }>;
    return rows.map((r) => Number(r.uid));
  }

  removeFromIndex(email: string, folder: string, uids: number[]): void {
    const e = lc(email);
    const del = this.db.prepare('DELETE FROM thread_index WHERE email = ? AND folder = ? AND uid = ?');
    this.db.exec('BEGIN');
    try {
      for (const u of uids) del.run(e, folder, u);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Number of indexed messages per thread id, counting only the given folders. */
  threadCounts(email: string, folders: string[], threadIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (folders.length === 0 || threadIds.length === 0) return out;
    const unique = [...new Set(threadIds)];
    const sql = `SELECT thread_id, COUNT(*) AS n FROM thread_index WHERE email = ? AND folder IN (${folders.map(() => '?').join(',')})
                 AND thread_id IN (${unique.map(() => '?').join(',')}) GROUP BY thread_id`;
    const rows = this.db.prepare(sql).all(lc(email), ...folders, ...unique) as Array<{ thread_id: string; n: number }>;
    for (const r of rows) out.set(r.thread_id, Number(r.n));
    return out;
  }

  threadMembers(email: string, threadId: string, folders: string[]): ThreadRow[] {
    if (folders.length === 0) return [];
    const sql = `SELECT folder, uid, thread_id FROM thread_index WHERE email = ? AND thread_id = ? AND folder IN (${folders.map(() => '?').join(',')})`;
    const rows = this.db.prepare(sql).all(lc(email), threadId, ...folders) as Array<{ folder: string; uid: number; thread_id: string }>;
    return rows.map((r) => ({ folder: r.folder, uid: Number(r.uid), threadId: r.thread_id }));
  }
}
