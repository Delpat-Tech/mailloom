import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Per-mailbox organising data, in the same node:sqlite database as the sessions:
 *  - label definitions (the labels themselves are IMAP keywords on the messages);
 *  - snooze records (mailbox address + Message-ID + UID in Snoozed, and the wake time);
 *  - a small conversation index per folder UID (thread id, Message-ID, has-attachments), filled
 *    newest first in the background and topped up by UID above a stored high-water mark.
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
  /** UID in the Snoozed folder; 0 while the move is still in progress. */
  uid: number;
  until: number;
}

export interface ThreadRow {
  folder: string;
  uid: number;
  threadId: string;
}

export interface IndexRow {
  uid: number;
  threadId: string;
  messageId: string;
  hasAttachments: boolean;
}

export interface SyncState {
  uidValidity: string;
  /** Highest UID indexed: newer mail is fetched from highUid + 1. */
  highUid: number;
  /** Every UID below this one is still to be indexed (the backfill works downwards). */
  lowUid: number;
  /** Backfill finished: the folder's index is complete up to highUid. */
  complete: boolean;
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

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
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
      CREATE TABLE IF NOT EXISTS snooze_items (
        email TEXT NOT NULL,
        message_id TEXT NOT NULL,
        snoozed_uid INTEGER NOT NULL,
        until INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (email, message_id, snoozed_uid)
      );
      CREATE INDEX IF NOT EXISTS snooze_items_until ON snooze_items (until);
      CREATE TABLE IF NOT EXISTS conv_index (
        email TEXT NOT NULL,
        folder TEXT NOT NULL,
        uid INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        has_att INTEGER NOT NULL,
        PRIMARY KEY (email, folder, uid)
      );
      CREATE INDEX IF NOT EXISTS conv_index_thread ON conv_index (email, thread_id);
      CREATE INDEX IF NOT EXISTS conv_index_mid ON conv_index (email, folder, message_id);
      CREATE TABLE IF NOT EXISTS conv_sync (
        email TEXT NOT NULL,
        folder TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        high_uid INTEGER NOT NULL,
        low_uid INTEGER NOT NULL,
        complete INTEGER NOT NULL,
        PRIMARY KEY (email, folder)
      );
    `);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------------- labels ----------------

  /** The mailbox's labels in order. The defaults are created the first time a mailbox asks. */
  labels(email: string): LabelDef[] {
    const e = lc(email);
    if (!this.db.prepare('SELECT 1 FROM label_seeded WHERE email = ?').get(e)) {
      this.tx(() => {
        if (this.db.prepare('SELECT 1 FROM label_seeded WHERE email = ?').get(e)) return;
        DEFAULT_LABELS.forEach((l, i) => this.insertLabel(e, l.name, l.colour, i));
        this.db.prepare('INSERT INTO label_seeded (email, seeded_at) VALUES (?, ?)').run(e, this.now());
      });
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
    const ord = this.labels(e).reduce((m, l) => Math.max(m, l.order + 1), 0);
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
      this.tx(() => sequence.forEach((lid, i) => set.run(i, e, lid)));
      next.order = at;
    }
    return next;
  }

  deleteLabel(email: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM labels WHERE email = ? AND id = ?').run(lc(email), id).changes) > 0;
  }

  // ---------------- snoozes ----------------

  /** A record for a message about to move (uid 0) or already in Snoozed (its UID there). */
  putSnooze(email: string, messageId: string, uid: number, until: number): void {
    this.db
      .prepare(
        `INSERT INTO snooze_items (email, message_id, snoozed_uid, until, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (email, message_id, snoozed_uid) DO UPDATE SET until = excluded.until`
      )
      .run(lc(email), messageId, uid, until, this.now());
  }

  /** The move finished: the pending record (uid 0) becomes the record of the copy now in Snoozed. */
  settleSnooze(email: string, messageId: string, uid: number, until: number): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM snooze_items WHERE email = ? AND message_id = ? AND snoozed_uid = 0').run(lc(email), messageId);
      this.putSnooze(email, messageId, uid, until);
    });
  }

  deleteSnooze(email: string, messageId: string, uid: number): void {
    this.db.prepare('DELETE FROM snooze_items WHERE email = ? AND message_id = ? AND snoozed_uid = ?').run(lc(email), messageId, uid);
  }

  /** Re-snooze of a message already in Snoozed: only its wake time changes. */
  setSnoozeUntilByUid(email: string, uid: number, until: number): boolean {
    return Number(this.db.prepare('UPDATE snooze_items SET until = ? WHERE email = ? AND snoozed_uid = ?').run(until, lc(email), uid).changes) > 0;
  }

  snoozes(email: string): SnoozeRow[] {
    const rows = this.db
      .prepare('SELECT email, message_id, snoozed_uid, until FROM snooze_items WHERE email = ? ORDER BY until, snoozed_uid')
      .all(lc(email)) as Array<{ email: string; message_id: string; snoozed_uid: number; until: number }>;
    return rows.map((r) => ({ email: r.email, messageId: r.message_id, uid: Number(r.snoozed_uid), until: Number(r.until) }));
  }

  dueSnoozes(email: string): SnoozeRow[] {
    const now = this.now();
    return this.snoozes(email).filter((r) => r.until <= now);
  }

  hasDue(email: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM snooze_items WHERE email = ? AND until <= ? LIMIT 1').get(lc(email), this.now());
  }

  /** Mailboxes with at least one snooze that is due. */
  dueMailboxes(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT email FROM snooze_items WHERE until <= ?').all(this.now()) as Array<{ email: string }>;
    return rows.map((r) => r.email);
  }

  // ---------------- conversation index ----------------

  syncState(email: string, folder: string): SyncState | null {
    const r = this.db
      .prepare('SELECT uid_validity, high_uid, low_uid, complete FROM conv_sync WHERE email = ? AND folder = ?')
      .get(lc(email), folder) as { uid_validity: string; high_uid: number; low_uid: number; complete: number } | undefined;
    return r ? { uidValidity: r.uid_validity, highUid: Number(r.high_uid), lowUid: Number(r.low_uid), complete: r.complete === 1 } : null;
  }

  /**
   * Start (or restart, after UIDVALIDITY changed) a folder's index: nothing indexed, everything
   * below uidNext still to do, newest first.
   */
  resetFolder(email: string, folder: string, uidValidity: string, uidNext: number, empty: boolean): void {
    const e = lc(email);
    const high = Math.max(0, uidNext - 1);
    this.tx(() => {
      this.db.prepare('DELETE FROM conv_index WHERE email = ? AND folder = ?').run(e, folder);
      this.db
        .prepare(
          `INSERT INTO conv_sync (email, folder, uid_validity, high_uid, low_uid, complete) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (email, folder) DO UPDATE SET uid_validity = excluded.uid_validity, high_uid = excluded.high_uid,
             low_uid = excluded.low_uid, complete = excluded.complete`
        )
        .run(e, folder, uidValidity, high, high + 1, empty ? 1 : 0);
    });
  }

  /**
   * Saves one batch and moves the cursors in the same transaction, so an interrupted run resumes
   * where it stopped. `high` raises the high-water mark; `low` lowers the backfill cursor.
   */
  saveBatch(email: string, folder: string, rows: IndexRow[], cursor: { high?: number; low?: number; complete?: boolean }): void {
    const e = lc(email);
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO conv_index (email, folder, uid, thread_id, message_id, has_att) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this.tx(() => {
      for (const r of rows) ins.run(e, folder, r.uid, r.threadId, r.messageId, r.hasAttachments ? 1 : 0);
      if (cursor.high !== undefined) this.db.prepare('UPDATE conv_sync SET high_uid = MAX(high_uid, ?) WHERE email = ? AND folder = ?').run(cursor.high, e, folder);
      if (cursor.low !== undefined) this.db.prepare('UPDATE conv_sync SET low_uid = MIN(low_uid, ?) WHERE email = ? AND folder = ?').run(cursor.low, e, folder);
      if (cursor.complete) this.db.prepare('UPDATE conv_sync SET complete = 1 WHERE email = ? AND folder = ?').run(e, folder);
    });
  }

  countFolder(email: string, folder: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM conv_index WHERE email = ? AND folder = ?').get(lc(email), folder) as { n: number };
    return Number(r.n);
  }

  indexedUids(email: string, folder: string): number[] {
    const rows = this.db.prepare('SELECT uid FROM conv_index WHERE email = ? AND folder = ?').all(lc(email), folder) as Array<{ uid: number }>;
    return rows.map((r) => Number(r.uid));
  }

  removeFromIndex(email: string, folder: string, uids: number[]): void {
    const e = lc(email);
    const del = this.db.prepare('DELETE FROM conv_index WHERE email = ? AND folder = ? AND uid = ?');
    this.tx(() => {
      for (const u of uids) del.run(e, folder, u);
    });
  }

  /** Cached has-attachments for UIDs of a folder, only when the index is for this UIDVALIDITY. */
  attachmentFlags(email: string, folder: string, uidValidity: string, uids: number[]): Map<number, boolean> {
    const out = new Map<number, boolean>();
    const state = this.syncState(email, folder);
    if (!state || state.uidValidity !== uidValidity) return out;
    for (const part of chunks(uids, 500)) {
      const rows = this.db
        .prepare(`SELECT uid, has_att FROM conv_index WHERE email = ? AND folder = ? AND uid IN (${part.map(() => '?').join(',')})`)
        .all(lc(email), folder, ...part) as Array<{ uid: number; has_att: number }>;
      for (const r of rows) out.set(Number(r.uid), r.has_att === 1);
    }
    return out;
  }

  /** UID of a Message-ID in a folder, from the index. */
  uidByMessageId(email: string, folder: string, messageId: string): number | null {
    const r = this.db
      .prepare('SELECT uid FROM conv_index WHERE email = ? AND folder = ? AND message_id = ? ORDER BY uid DESC LIMIT 1')
      .get(lc(email), folder, messageId) as { uid: number } | undefined;
    return r ? Number(r.uid) : null;
  }

  /** Number of indexed messages per thread id, counting only the given folders. */
  threadCounts(email: string, folders: string[], threadIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (folders.length === 0 || threadIds.length === 0) return out;
    const unique = [...new Set(threadIds)];
    const sql = `SELECT thread_id, COUNT(*) AS n FROM conv_index WHERE email = ? AND folder IN (${folders.map(() => '?').join(',')})
                 AND thread_id IN (${unique.map(() => '?').join(',')}) GROUP BY thread_id`;
    const rows = this.db.prepare(sql).all(lc(email), ...folders, ...unique) as Array<{ thread_id: string; n: number }>;
    for (const r of rows) out.set(r.thread_id, Number(r.n));
    return out;
  }

  threadMembers(email: string, threadId: string, folders: string[]): ThreadRow[] {
    if (folders.length === 0) return [];
    const sql = `SELECT folder, uid, thread_id FROM conv_index WHERE email = ? AND thread_id = ? AND folder IN (${folders.map(() => '?').join(',')})`;
    const rows = this.db.prepare(sql).all(lc(email), threadId, ...folders) as Array<{ folder: string; uid: number; thread_id: string }>;
    return rows.map((r) => ({ folder: r.folder, uid: Number(r.uid), threadId: r.thread_id }));
  }
}
