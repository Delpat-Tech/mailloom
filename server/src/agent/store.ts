import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  agentKeyPrefix,
  decryptMailboxPassword,
  encryptMailboxPassword,
  hashAgentKey,
  isWellFormedAgentKey,
  newAgentKey,
  newKeyId
} from './crypto.js';

/**
 * Agent keys, audit log, idempotency records and the send counter.
 * Lives in the same node:sqlite database as the sessions.
 */

export const SCOPES = ['read', 'organise', 'send'] as const;
export type Scope = (typeof SCOPES)[number];

export interface AgentKeyRecord {
  id: string;
  prefix: string;
  name: string;
  email: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  brokenAt: number | null;
  brokenReason: string | null;
  /** OAuth client that minted this key (Connect), or null for a key made by hand. */
  clientId: string | null;
  /** Free label shown with the client, e.g. the Work OS organisation name. */
  label: string | null;
}

interface KeyRow {
  id: string;
  key_hash: string;
  prefix: string;
  name: string;
  email: string;
  scopes: string;
  enc_password: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  broken_at: number | null;
  broken_reason: string | null;
  client_id: string | null;
  label: string | null;
}

export type AuthResult =
  | { status: 'ok'; record: AgentKeyRecord; password: string }
  | { status: 'invalid' }
  | { status: 'revoked'; record: AgentKeyRecord }
  | { status: 'broken'; record: AgentKeyRecord };

export interface AuditEntry {
  at: number;
  keyId: string;
  keyPrefix: string;
  email: string;
  ip: string;
  workosUser: string | null;
  workosSession: string | null;
  tool: string;
  folder: string | null;
  messageId: string | null;
  recipients: string[] | null;
  subject: string | null;
  sentMessageId: string | null;
  status: number;
  result: string;
}

export type IdempotencyBegin =
  | { state: 'new' }
  | { state: 'replay'; status: number; body: unknown }
  | { state: 'in_progress' }
  | { state: 'mismatch' };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TOUCH_INTERVAL_MS = 10_000;
const AUDIT_KEEP_MS = 180 * DAY;

function toRecord(row: KeyRow): AgentKeyRecord {
  return {
    id: row.id,
    prefix: row.prefix,
    name: row.name,
    email: row.email,
    scopes: row.scopes.split(',').filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    brokenAt: row.broken_at,
    brokenReason: row.broken_reason,
    clientId: row.client_id ?? null,
    label: row.label ?? null
  };
}

export class AgentStore {
  constructor(
    private db: DatabaseSync,
    private secret: string,
    private now: () => number = Date.now
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        scopes TEXT NOT NULL,
        enc_password TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        broken_at INTEGER,
        broken_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_keys_email ON agent_keys (email);
      CREATE TABLE IF NOT EXISTS agent_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        email TEXT NOT NULL,
        ip TEXT NOT NULL,
        workos_user TEXT,
        workos_session TEXT,
        tool TEXT NOT NULL,
        folder TEXT,
        message_id TEXT,
        recipients TEXT,
        subject TEXT,
        sent_message_id TEXT,
        status INTEGER NOT NULL,
        result TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_audit_email ON agent_audit (email, at);
      CREATE TABLE IF NOT EXISTS agent_idempotency (
        key_id TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        done INTEGER NOT NULL,
        status INTEGER,
        response TEXT,
        PRIMARY KEY (key_id, idem_key)
      );
      CREATE TABLE IF NOT EXISTS agent_sends (
        key_id TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_sends_key ON agent_sends (key_id, at);
    `);
    // Additive migration for databases made before Connect: two nullable columns, no data touched.
    const cols = (db.prepare('PRAGMA table_info(agent_keys)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const col of ['client_id', 'label']) {
      if (!cols.includes(col)) db.exec(`ALTER TABLE agent_keys ADD COLUMN ${col} TEXT`);
    }
  }

  // ---------------------------------------------------------------- keys

  createKey(input: { email: string; name: string; scopes: Scope[]; password: string; clientId?: string | null; label?: string | null }): { key: string; record: AgentKeyRecord } {
    const key = newAgentKey();
    const id = newKeyId();
    const email = input.email.toLowerCase();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO agent_keys (id, key_hash, prefix, name, email, scopes, enc_password, created_at, client_id, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        hashAgentKey(key),
        agentKeyPrefix(key),
        input.name,
        email,
        input.scopes.join(','),
        encryptMailboxPassword(this.secret, key, id, email, input.password),
        now,
        input.clientId ?? null,
        input.label ?? null
      );
    return { key, record: this.getRecord(id)! };
  }

  private getRow(id: string): KeyRow | undefined {
    return this.db.prepare('SELECT * FROM agent_keys WHERE id = ?').get(id) as KeyRow | undefined;
  }

  /** The key whose public prefix this is (used only to attribute refused attempts in the audit). */
  findByPrefix(prefix: string): AgentKeyRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_keys WHERE prefix = ? LIMIT 1').get(prefix) as KeyRow | undefined;
    return row ? toRecord(row) : null;
  }

  getRecord(id: string): AgentKeyRecord | null {
    const row = this.getRow(id);
    return row ? toRecord(row) : null;
  }

  /** A key of this mailbox, or null (also for another mailbox's key: no difference visible). */
  getOwned(id: string, email: string): AgentKeyRecord | null {
    const row = this.getRow(id);
    return row && row.email === email.toLowerCase() ? toRecord(row) : null;
  }

  listKeys(email: string): AgentKeyRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_keys WHERE email = ? ORDER BY created_at DESC')
      .all(email.toLowerCase()) as unknown as KeyRow[];
    return rows.map(toRecord);
  }

  rename(id: string, email: string, name: string): AgentKeyRecord | null {
    if (!this.getOwned(id, email)) return null;
    this.db.prepare('UPDATE agent_keys SET name = ? WHERE id = ?').run(name, id);
    return this.getRecord(id);
  }

  /** Revokes at once; the stored password is wiped. */
  revoke(id: string, email: string): AgentKeyRecord | null {
    const rec = this.getOwned(id, email);
    if (!rec) return null;
    if (!rec.revokedAt) {
      this.db.prepare("UPDATE agent_keys SET revoked_at = ?, enc_password = '' WHERE id = ?").run(this.now(), id);
    }
    return this.getRecord(id);
  }

  /** Revokes by id alone (a code was reused: the key the first use minted must die). Null when there is no such key. */
  revokeById(id: string): AgentKeyRecord | null {
    const row = this.getRow(id);
    if (!row) return null;
    return this.revoke(id, row.email);
  }

  /** New key value for the same record (name, scopes, history kept). The old value stops working at once. */
  rotate(id: string, email: string, password: string): { key: string; record: AgentKeyRecord } | null {
    const rec = this.getOwned(id, email);
    if (!rec || rec.revokedAt) return null;
    const key = newAgentKey();
    this.db
      .prepare(
        `UPDATE agent_keys SET key_hash = ?, prefix = ?, enc_password = ?, broken_at = NULL, broken_reason = NULL WHERE id = ?`
      )
      .run(hashAgentKey(key), agentKeyPrefix(key), encryptMailboxPassword(this.secret, key, id, rec.email, password), id);
    return { key, record: this.getRecord(id)! };
  }

  markBroken(id: string, reason: string): void {
    this.db.prepare('UPDATE agent_keys SET broken_at = ?, broken_reason = ? WHERE id = ? AND broken_at IS NULL').run(this.now(), reason, id);
  }

  authenticate(key: string): AuthResult {
    if (!isWellFormedAgentKey(key)) return { status: 'invalid' };
    const row = this.db.prepare('SELECT * FROM agent_keys WHERE key_hash = ?').get(hashAgentKey(key)) as KeyRow | undefined;
    if (!row) return { status: 'invalid' };
    const record = toRecord(row);
    if (row.revoked_at) return { status: 'revoked', record };
    if (row.broken_at) return { status: 'broken', record };
    const password = decryptMailboxPassword(this.secret, key, row.id, row.email, row.enc_password);
    if (password === null) {
      // SESSION_SECRET changed or the row was altered: the key can never work again.
      this.markBroken(row.id, 'stored password cannot be decrypted');
      return { status: 'broken', record: this.getRecord(row.id)! };
    }
    const now = this.now();
    if (!row.last_used_at || now - row.last_used_at >= TOUCH_INTERVAL_MS) {
      this.db.prepare('UPDATE agent_keys SET last_used_at = ? WHERE id = ?').run(now, row.id);
      record.lastUsedAt = now;
    }
    return { status: 'ok', record, password };
  }

  // ---------------------------------------------------------------- audit

  audit(entry: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO agent_audit (at, key_id, key_prefix, email, ip, workos_user, workos_session, tool, folder, message_id,
           recipients, subject, sent_message_id, status, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.at,
        entry.keyId,
        entry.keyPrefix,
        entry.email.toLowerCase(),
        entry.ip,
        entry.workosUser,
        entry.workosSession,
        entry.tool,
        entry.folder,
        entry.messageId,
        entry.recipients ? JSON.stringify(entry.recipients) : null,
        entry.subject,
        entry.sentMessageId,
        entry.status,
        entry.result
      );
  }

  listAudit(email: string, limit = 200): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_audit WHERE email = ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(email.toLowerCase(), Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      at: Number(r.at),
      keyId: String(r.key_id),
      keyPrefix: String(r.key_prefix),
      email: String(r.email),
      ip: String(r.ip),
      workosUser: (r.workos_user as string | null) ?? null,
      workosSession: (r.workos_session as string | null) ?? null,
      tool: String(r.tool),
      folder: (r.folder as string | null) ?? null,
      messageId: (r.message_id as string | null) ?? null,
      recipients: r.recipients ? (JSON.parse(String(r.recipients)) as string[]) : null,
      subject: (r.subject as string | null) ?? null,
      sentMessageId: (r.sent_message_id as string | null) ?? null,
      status: Number(r.status),
      result: String(r.result)
    }));
  }

  // ---------------------------------------------------------------- idempotency (24 h, per key)

  beginIdempotent(keyId: string, idemKey: string, requestBody: unknown): IdempotencyBegin {
    const hash = crypto.createHash('sha256').update(JSON.stringify(requestBody)).digest('hex');
    const now = this.now();
    this.db.prepare('DELETE FROM agent_idempotency WHERE key_id = ? AND idem_key = ? AND created_at <= ?').run(keyId, idemKey, now - DAY);
    const inserted = this.db
      .prepare(
        'INSERT OR IGNORE INTO agent_idempotency (key_id, idem_key, request_hash, created_at, done) VALUES (?, ?, ?, ?, 0)'
      )
      .run(keyId, idemKey, hash, now);
    if (Number(inserted.changes) > 0) return { state: 'new' };
    const row = this.db
      .prepare('SELECT * FROM agent_idempotency WHERE key_id = ? AND idem_key = ?')
      .get(keyId, idemKey) as { request_hash: string; done: number; status: number; response: string } | undefined;
    if (!row) return { state: 'new' };
    if (row.request_hash !== hash) return { state: 'mismatch' };
    if (!row.done) return { state: 'in_progress' };
    return { state: 'replay', status: row.status, body: JSON.parse(row.response) };
  }

  finishIdempotent(keyId: string, idemKey: string, status: number, body: unknown): void {
    this.db
      .prepare('UPDATE agent_idempotency SET done = 1, status = ?, response = ? WHERE key_id = ? AND idem_key = ?')
      .run(status, JSON.stringify(body), keyId, idemKey);
  }

  /** Forget a key that did not lead to a send (failure before the mail left), so a retry can send. */
  abortIdempotent(keyId: string, idemKey: string): void {
    this.db.prepare('DELETE FROM agent_idempotency WHERE key_id = ? AND idem_key = ? AND done = 0').run(keyId, idemKey);
  }

  // ---------------------------------------------------------------- send guard

  /** 0 when a send is allowed now (and counts it); otherwise milliseconds until one is. */
  takeSendSlot(keyId: string, perHour: number): number {
    const now = this.now();
    const rows = this.db
      .prepare('SELECT at FROM agent_sends WHERE key_id = ? AND at > ? ORDER BY at ASC')
      .all(keyId, now - HOUR) as Array<{ at: number }>;
    if (rows.length >= perHour) {
      return Math.max(1000, Number(rows[rows.length - perHour]!.at) + HOUR - now);
    }
    this.db.prepare('INSERT INTO agent_sends (key_id, at) VALUES (?, ?)').run(keyId, now);
    return 0;
  }

  /** Drops old audit rows, finished idempotency records and send counters. */
  prune(): void {
    const now = this.now();
    this.db.prepare('DELETE FROM agent_audit WHERE at < ?').run(now - AUDIT_KEEP_MS);
    this.db.prepare('DELETE FROM agent_idempotency WHERE created_at <= ?').run(now - DAY);
    this.db.prepare('DELETE FROM agent_sends WHERE at <= ?').run(now - HOUR);
  }
}
