import type { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTick } from 'node:timers/promises';
import type { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../types.js';
import { createImapClient } from './imap.js';
import { resolveFolders } from './folders.js';

/**
 * Recipient suggestions. For each mailbox the server counts, from message envelopes, who the user
 * writes to (Sent To/Cc/Bcc: weighs most) and who writes to the user (From in the Inbox). Built in
 * the background like the conversation index: a high-water UID per folder, batches, resumable.
 * Only addresses and display names are stored; never subjects or bodies.
 */

export interface ContactSuggestion {
  name: string;
  email: string;
  count: number;
  lastUsed: string;
}

interface ContactRow {
  addr: string;
  name: string;
  out_count: number;
  in_count: number;
  last_out: number;
  last_in: number;
  own: number;
}

type Seen = { addr: string; name: string; dir: 'out' | 'in' | 'own'; at: number };

const lc = (s: string) => s.trim().toLowerCase();
const DAY = 86_400_000;
const FETCH = { uid: true, envelope: true, internalDate: true };
const OUT_WEIGHT = 3;

export class ContactStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        email TEXT NOT NULL,
        addr TEXT NOT NULL,
        name TEXT NOT NULL,
        name_at INTEGER NOT NULL,
        out_count INTEGER NOT NULL,
        in_count INTEGER NOT NULL,
        last_out INTEGER NOT NULL,
        last_in INTEGER NOT NULL,
        own INTEGER NOT NULL,
        PRIMARY KEY (email, addr)
      );
      CREATE TABLE IF NOT EXISTS contact_sync (
        email TEXT NOT NULL,
        folder TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        high_uid INTEGER NOT NULL,
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

  sync(email: string, folder: string): { uidValidity: string; highUid: number } | null {
    const r = this.db.prepare('SELECT uid_validity, high_uid FROM contact_sync WHERE email = ? AND folder = ?').get(lc(email), folder) as
      | { uid_validity: string; high_uid: number }
      | undefined;
    return r ? { uidValidity: r.uid_validity, highUid: Number(r.high_uid) } : null;
  }

  hasAnySync(email: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM contact_sync WHERE email = ? LIMIT 1').get(lc(email));
  }

  /** UIDVALIDITY changed: counts cannot be attributed to folders, so the mailbox starts over. */
  reset(email: string): void {
    const e = lc(email);
    this.tx(() => {
      this.db.prepare('DELETE FROM contacts WHERE email = ?').run(e);
      this.db.prepare('DELETE FROM contact_sync WHERE email = ?').run(e);
    });
  }

  /** Adds one batch of observations and moves the folder's high-water mark in the same transaction. */
  saveBatch(email: string, folder: string, uidValidity: string, high: number, seen: Seen[]): void {
    const e = lc(email);
    const get = this.db.prepare('SELECT name, name_at FROM contacts WHERE email = ? AND addr = ?');
    const upsert = this.db.prepare(
      `INSERT INTO contacts (email, addr, name, name_at, out_count, in_count, last_out, last_in, own)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (email, addr) DO UPDATE SET
         out_count = out_count + excluded.out_count,
         in_count = in_count + excluded.in_count,
         last_out = MAX(last_out, excluded.last_out),
         last_in = MAX(last_in, excluded.last_in),
         own = MAX(own, excluded.own),
         name = excluded.name,
         name_at = excluded.name_at`
    );
    this.tx(() => {
      for (const s of seen) {
        const cur = get.get(e, s.addr) as { name: string; name_at: number } | undefined;
        // Keep the newest non-empty display name.
        const useNew = Boolean(s.name) && (!cur || !cur.name || s.at >= Number(cur.name_at));
        const name = useNew ? s.name : cur?.name || '';
        const nameAt = useNew ? s.at : Number(cur?.name_at ?? 0);
        upsert.run(
          e,
          s.addr,
          name,
          nameAt,
          s.dir === 'out' ? 1 : 0,
          s.dir === 'in' ? 1 : 0,
          s.dir === 'out' ? s.at : 0,
          s.dir === 'in' ? s.at : 0,
          s.dir === 'own' ? 1 : 0
        );
      }
      this.db
        .prepare(
          `INSERT INTO contact_sync (email, folder, uid_validity, high_uid) VALUES (?, ?, ?, ?)
           ON CONFLICT (email, folder) DO UPDATE SET uid_validity = excluded.uid_validity, high_uid = MAX(high_uid, excluded.high_uid)`
        )
        .run(e, folder, uidValidity, high);
    });
  }

  /** Ranked suggestions whose email or any name word starts with `prefix`. */
  suggest(email: string, prefix: string, limit: number, now: number): ContactSuggestion[] {
    const e = lc(email);
    const q = lc(prefix);
    if (!q) return [];
    const rows = this.db
      .prepare('SELECT addr, name, out_count, in_count, last_out, last_in, own FROM contacts WHERE email = ?')
      .all(e) as unknown as ContactRow[];
    const scored: Array<{ s: ContactSuggestion; score: number }> = [];
    for (const r of rows) {
      if (r.own || r.addr === e) continue;
      if (!matches(r.addr, r.name, q)) continue;
      const out = Number(r.out_count);
      const inn = Number(r.in_count);
      const last = Math.max(Number(r.last_out), Number(r.last_in));
      const ageDays = Math.max(0, (now - last) / DAY);
      // Frequency (writing to someone counts three times as much as hearing from them), scaled by a
      // recency factor that halves every 90 days (never below a quarter).
      const score = (OUT_WEIGHT * out + inn) * (0.25 + 0.75 * Math.pow(0.5, ageDays / 90)) + (out > 0 ? 0.5 : 0);
      scored.push({ s: { name: r.name, email: r.addr, count: out + inn, lastUsed: new Date(last).toISOString() }, score });
    }
    scored.sort((a, b) => b.score - a.score || Date.parse(b.s.lastUsed) - Date.parse(a.s.lastUsed) || a.s.email.localeCompare(b.s.email));
    return scored.slice(0, limit).map((x) => x.s);
  }
}

function matches(addr: string, name: string, q: string): boolean {
  if (addr.startsWith(q)) return true;
  const local = addr.split('@')[0] || '';
  const lname = name.toLowerCase();
  const tokens = [...lname.split(/[\s,.;"'()<>_-]+/), ...local.split(/[._+-]+/)];
  if (tokens.some((t) => t && t.startsWith(q))) return true;
  // A prefix of the whole display name ("jane do").
  return lname.startsWith(q);
}

export interface ContactIndexerOptions {
  batchSize?: number;
  /** Do not start a new refresh within this long of the last one unless forced (ms). */
  minIntervalMs?: number;
  log?: { warn: (o: object, m: string) => void };
  now?: () => number;
}

export class ContactIndexer {
  private jobs = new Map<string, Promise<void>>();
  private lastRun = new Map<string, number>();
  private pendingForce = new Map<string, AccountConfig>();
  private stopped = false;
  private batchSize: number;

  constructor(
    private store: ContactStore,
    private opts: ContactIndexerOptions = {}
  ) {
    this.batchSize = opts.batchSize ?? 500;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Starts a background refresh (unless one runs, or one finished very recently and !force). */
  kick(config: AccountConfig, force = false): void {
    const key = lc(config.email);
    if (this.stopped) return;
    if (this.jobs.has(key)) {
      if (force) this.pendingForce.set(key, config);
      return;
    }
    if (!force && this.now() - (this.lastRun.get(key) ?? 0) < (this.opts.minIntervalMs ?? 60_000)) return;
    const job = this.run({ ...config })
      .catch((err) => {
        this.opts.log?.warn({ code: 'CONTACT_INDEX_FAILED', errCode: (err as { code?: string })?.code }, 'Contact index paused; resumes later');
      })
      .finally(() => {
        this.lastRun.set(key, this.now());
        this.jobs.delete(key);
        // A send happened while this run was going: its Sent copy may have been missed.
        const again = this.pendingForce.get(key);
        this.pendingForce.delete(key);
        if (again) this.kick(again, true);
      });
    this.jobs.set(key, job);
  }

  async idle(email: string): Promise<void> {
    for (let p = this.jobs.get(lc(email)); p; p = this.jobs.get(lc(email))) await p;
  }

  /** Waits for a running refresh, at most `ms`. */
  async waitFor(email: string, ms: number): Promise<void> {
    const p = this.jobs.get(lc(email));
    if (p) await Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.jobs.values()]);
  }

  private async run(config: AccountConfig): Promise<void> {
    const client = createImapClient(config, { disableAutoIdle: true });
    client.on('error', () => undefined);
    await client.connect();
    try {
      const folders = await resolveFolders(client);
      if (folders.sent) await this.indexFolder(client, config.email, folders.sent, 'out');
      await this.indexFolder(client, config.email, folders.inbox, 'in');
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }
  }

  private async indexFolder(client: ImapFlow, email: string, folder: string, dir: 'out' | 'in'): Promise<void> {
    const mb = await client.mailboxOpen(folder, { readOnly: true });
    const uidValidity = String(mb.uidValidity ?? '');
    const uidNext = Number(mb.uidNext ?? 0);
    let state = this.store.sync(email, folder);
    if (state && state.uidValidity !== uidValidity) {
      this.store.reset(email);
      state = null;
    }
    const high = state?.highUid ?? 0;
    if (Number(mb.exists ?? 0) === 0 || uidNext - 1 <= high) {
      this.store.saveBatch(email, folder, uidValidity, Math.max(0, uidNext - 1), []);
      return;
    }
    const fresh = (((await client.search({ uid: `${high + 1}:*` }, { uid: true })) || []) as number[])
      .filter((u) => u > high)
      .sort((a, b) => a - b);
    const own = lc(email);
    for (let i = 0; i < fresh.length; i += this.batchSize) {
      const part = fresh.slice(i, i + this.batchSize);
      const seen: Seen[] = [];
      for await (const msg of client.fetch(part, FETCH, { uid: true })) {
        const env = msg.envelope;
        const at = Date.parse(String(env?.date ?? '')) || Date.parse(String(msg.internalDate ?? '')) || this.now();
        const add = (list: Array<{ name?: string; address?: string }> | undefined, d: 'out' | 'in') => {
          for (const a of list || []) {
            const addr = lc(a.address || '');
            if (!addr.includes('@')) continue;
            seen.push({ addr, name: (a.name || '').trim(), dir: addr === own ? 'own' : d, at });
          }
        };
        if (dir === 'out') {
          // From in Sent is the user (maybe an alias): remember it so it is never suggested.
          for (const a of env?.from || []) if (a.address) seen.push({ addr: lc(a.address), name: '', dir: 'own', at });
          add(env?.to, 'out');
          add(env?.cc, 'out');
          add(env?.bcc, 'out');
        } else {
          add(env?.from, 'in');
        }
      }
      this.store.saveBatch(email, folder, uidValidity, part[part.length - 1]!, seen);
      await nextTick();
      if (this.stopped) throw Object.assign(new Error('Server is shutting down'), { code: 'SHUTDOWN' });
    }
    this.store.saveBatch(email, folder, uidValidity, uidNext - 1, []);
  }
}
