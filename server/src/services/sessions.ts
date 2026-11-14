import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createCredentialCipher, hashSessionId, newAccountHandle, newSessionId } from '../utils/crypto.js';

/**
 * Server-side sessions.
 *
 * The browser only ever holds an opaque random session id (in an httpOnly cookie).
 * The server keeps who the session belongs to, the mail password encrypted with a
 * key from SESSION_SECRET, and when it expires. Rows are keyed by sha256(session id),
 * so a copy of the database alone gives neither usable session ids nor passwords.
 *
 * Storage is node:sqlite: a file (SESSION_DB_PATH) survives restarts; ':memory:'
 * is used when no path is configured.
 */

export interface SessionLifetimes {
  /** Idle timeout for sessions without Remember Me. */
  idleMs: number;
  /** Absolute cap for sessions without Remember Me. */
  shortMaxMs: number;
  /** Lifetime for sessions with Remember Me. */
  rememberMs: number;
}

export interface Session {
  /** sha256 of the session id; safe to use as an internal key (e.g. connection pool). */
  key: string;
  /** Public per-browser account handle; names the cookie. */
  handle: string;
  email: string;
  name: string;
  isDemo: boolean;
  remember: boolean;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  /** Decrypted mail password. Server memory only; never serialise to a response. */
  password: string;
}

export type ResolveResult =
  | { status: 'ok'; session: Session }
  | { status: 'expired' }
  | { status: 'unknown' };

interface Row {
  id_hash: string;
  handle: string;
  email: string;
  name: string;
  is_demo: number;
  remember: number;
  enc_password: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
}

// Writes for "last used" are throttled; idle expiry is accurate to this much.
const TOUCH_INTERVAL_MS = 10_000;
// Remember Me sessions slide a 30-day window; their expiry is only rewritten this often.
const REMEMBER_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export class SessionStore {
  private db: DatabaseSync;
  private cipher;

  constructor(
    dbPath: string,
    secret: string,
    private lifetimes: SessionLifetimes,
    private now: () => number = Date.now
  ) {
    this.cipher = createCredentialCipher(secret);
    try {
      this.db = new DatabaseSync(dbPath);
    } catch (err) {
      throw new Error(
        `Cannot open the session database at SESSION_DB_PATH="${dbPath}" (${(err as Error).message}). ` +
          'Check that the folder exists and the server user can write to it.'
      );
    }
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {
        // Best effort (no-op on Windows).
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        is_demo INTEGER NOT NULL,
        remember INTEGER NOT NULL,
        enc_password TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
    `);
  }

  private expiryFor(remember: boolean, createdAt: number, lastUsedAt: number): number {
    // Remember Me: a sliding window from last use; the idle limit does not apply.
    if (remember) return lastUsedAt + this.lifetimes.rememberMs;
    return Math.min(createdAt + this.lifetimes.shortMaxMs, lastUsedAt + this.lifetimes.idleMs);
  }

  create(input: { email: string; name: string; password: string; isDemo: boolean; remember: boolean }): {
    sessionId: string;
    session: Session;
  } {
    const sessionId = newSessionId();
    const key = hashSessionId(sessionId);
    const handle = newAccountHandle();
    const now = this.now();
    const expiresAt = this.expiryFor(input.remember, now, now);
    this.db
      .prepare(
        `INSERT INTO sessions (id_hash, handle, email, name, is_demo, remember, enc_password, created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        key,
        handle,
        input.email,
        input.name,
        input.isDemo ? 1 : 0,
        input.remember ? 1 : 0,
        this.cipher.encrypt(input.password, key),
        now,
        now,
        expiresAt
      );
    return {
      sessionId,
      session: {
        key,
        handle,
        email: input.email,
        name: input.name,
        isDemo: input.isDemo,
        remember: input.remember,
        createdAt: now,
        lastUsedAt: now,
        expiresAt,
        password: input.password
      }
    };
  }

  /** Looks a session id up; expired sessions are deleted. Does not extend the session. */
  resolve(sessionId: string): ResolveResult {
    if (typeof sessionId !== 'string' || sessionId.length < 20 || sessionId.length > 100) {
      return { status: 'unknown' };
    }
    const key = hashSessionId(sessionId);
    const row = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(key) as Row | undefined;
    if (!row) return { status: 'unknown' };
    if (this.now() >= row.expires_at) {
      this.deleteByKey(key);
      return { status: 'expired' };
    }
    const password = this.cipher.decrypt(row.enc_password, key);
    if (password === null) {
      // SESSION_SECRET changed or the row was tampered with: the session cannot be used.
      this.deleteByKey(key);
      return { status: 'expired' };
    }
    return {
      status: 'ok',
      session: {
        key,
        handle: row.handle,
        email: row.email,
        name: row.name,
        isDemo: row.is_demo === 1,
        remember: row.remember === 1,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
        password
      }
    };
  }

  /**
   * Records use of a session. Short sessions slide their idle timeout; Remember Me sessions
   * slide a window of rememberMs from now (written at most once an hour).
   * Returns true when the expiry was rewritten.
   */
  touch(session: Session): boolean {
    const now = this.now();
    const interval = session.remember ? REMEMBER_TOUCH_INTERVAL_MS : TOUCH_INTERVAL_MS;
    if (now - session.lastUsedAt < interval) return false;
    const expiresAt = this.expiryFor(session.remember, session.createdAt, now);
    this.db
      .prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id_hash = ?')
      .run(now, expiresAt, session.key);
    session.lastUsedAt = now;
    session.expiresAt = expiresAt;
    return true;
  }

  deleteByKey(key: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(key);
    return Number(result.changes) > 0;
  }

  delete(sessionId: string): boolean {
    return this.deleteByKey(hashSessionId(sessionId));
  }

  /** Deletes expired sessions; returns their keys so their connections can be closed. */
  sweep(): string[] {
    const now = this.now();
    const rows = this.db.prepare('SELECT id_hash FROM sessions WHERE expires_at <= ?').all(now) as Array<{ id_hash: string }>;
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    return rows.map((r) => r.id_hash);
  }

  /** The underlying database, shared with the agent key store (same file). */
  get database(): DatabaseSync {
    return this.db;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    return Number(row.n);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
