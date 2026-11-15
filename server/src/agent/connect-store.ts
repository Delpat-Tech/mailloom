import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hashAuthCode, newAuthCode, openCodePassword, sealCodePassword } from './crypto.js';
import type { Scope } from './store.js';

/**
 * Connect Mailloom (OAuth authorization code + PKCE): pending authorisation requests, one-use codes and the
 * short memory of spent codes. Same node:sqlite database as the sessions.
 *
 *   (requests)           not stored: a signed blob (see signRequest); agent_auth_used remembers answered ones
 *   agent_auth_codes     a granted request: sha256(code) only, the mailbox password sealed with a key that needs the
 *                        code, valid 60 seconds, deleted the moment it is used
 *   agent_auth_spent     sha256(code) -> key id of the key the first use minted, kept 10 minutes, so a reused code
 *                        can revoke that key
 */

export const REQUEST_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 60_000;
export const SPENT_TTL_MS = 10 * 60_000;

export interface AuthRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  scopes: Scope[];
  state: string;
  codeChallenge: string;
  label: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface GrantedCode {
  clientId: string;
  redirectUri: string;
  email: string;
  scopes: Scope[];
  codeChallenge: string;
  label: string | null;
  password: string | null;
  expiresAt: number;
}

export type TakeCode = { status: 'ok'; grant: GrantedCode } | { status: 'unknown' } | { status: 'reused'; keyId: string };

/** Answered requests are keyed by the hash of the signed payload (the signature part is not part of the identity). */
function hashBlob(blob: string): string {
  return crypto.createHash('sha256').update(blob, 'utf8').digest('hex');
}

export class ConnectStore {
  private requestKey: Buffer;

  constructor(
    private db: DatabaseSync,
    private secret: string,
    private now: () => number = Date.now
  ) {
    this.requestKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'mailloom:connect-request:v1', 32));
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_auth_used (
        blob_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_auth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        email TEXT NOT NULL,
        scopes TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        label TEXT,
        enc_password TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_auth_spent (
        code_hash TEXT PRIMARY KEY,
        key_id TEXT,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  // ---------------------------------------------------------------- requests

  /**
   * A validated authorisation request as a signed blob. Nothing is stored at authorize, so the unauthenticated
   * page cannot fill the database. The blob carries its own expiry (10 minutes) and an HMAC made with a key
   * derived from SESSION_SECRET under its own label; the consent screen carries it in the URL hash.
   */
  signRequest(input: Omit<AuthRequest, 'id' | 'createdAt' | 'expiresAt'>): AuthRequest {
    const now = this.now();
    const expiresAt = now + REQUEST_TTL_MS;
    const payload = Buffer.from(
      JSON.stringify([input.clientId, input.redirectUri, input.scopes.join(','), input.state, input.codeChallenge, input.label, now, expiresAt])
    ).toString('base64url');
    const id = `${payload}.${this.mac(payload)}`;
    return { ...input, id, createdAt: now, expiresAt };
  }

  private mac(payload: string): string {
    return crypto.createHmac('sha256', this.requestKey).update(payload).digest('base64url');
  }

  /** The request when the blob is genuine, not expired and not yet answered. */
  getRequest(blob: string): AuthRequest | null {
    if (typeof blob !== 'string' || blob.length > 4000) return null;
    // Only the exact form this server makes: payload.signature, both strict base64url. Anything else (a trailing
    // "=", a newline, a stray character) would still decode to the same bytes, so it is refused outright.
    const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(blob);
    if (!m) return null;
    const payload = m[1]!;
    const given = Buffer.from(m[2]!, 'base64url');
    const want = Buffer.from(this.mac(payload), 'base64url');
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
    let v: unknown;
    try {
      v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!Array.isArray(v) || v.length !== 8) return null;
    const [clientId, redirectUri, scopes, state, codeChallenge, label, createdAt, expiresAt] = v as unknown[];
    if (
      typeof clientId !== 'string' ||
      typeof redirectUri !== 'string' ||
      typeof scopes !== 'string' ||
      typeof state !== 'string' ||
      typeof codeChallenge !== 'string' ||
      (label !== null && typeof label !== 'string') ||
      typeof createdAt !== 'number' ||
      typeof expiresAt !== 'number'
    ) {
      return null;
    }
    if (expiresAt <= this.now()) return null;
    if (this.db.prepare('SELECT 1 FROM agent_auth_used WHERE blob_hash = ?').get(hashBlob(payload))) return null;
    return {
      id: blob,
      clientId,
      redirectUri,
      scopes: String(scopes).split(',') as Scope[],
      state,
      codeChallenge,
      label: label ?? null,
      createdAt,
      expiresAt
    };
  }

  /** Uses the request up (records the blob's hash until it would have expired): true for exactly one caller. */
  consumeRequest(blob: string): boolean {
    const req = this.getRequest(blob);
    if (!req) return false;
    return Number(this.db.prepare('INSERT OR IGNORE INTO agent_auth_used (blob_hash, expires_at) VALUES (?, ?)').run(hashBlob(blob.slice(0, blob.indexOf('.'))), req.expiresAt).changes) === 1;
  }

  // ---------------------------------------------------------------- codes

  /** Makes a code for a granted request. The code is returned once and never stored. */
  issueCode(input: {
    clientId: string;
    redirectUri: string;
    email: string;
    scopes: Scope[];
    codeChallenge: string;
    label: string | null;
    password: string;
  }): string {
    const code = newAuthCode();
    const now = this.now();
    const email = input.email.toLowerCase();
    this.db
      .prepare(
        `INSERT INTO agent_auth_codes (code_hash, client_id, redirect_uri, email, scopes, code_challenge, label, enc_password, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        hashAuthCode(code),
        input.clientId,
        input.redirectUri,
        email,
        input.scopes.join(','),
        input.codeChallenge,
        input.label,
        sealCodePassword(this.secret, code, email, input.password),
        now,
        now + CODE_TTL_MS
      );
    return code;
  }

  /**
   * Takes a code, deleting its row first so a second attempt cannot also win. A code that was already used
   * (and is still remembered) answers 'reused' with the key it minted. An expired code is deleted and 'unknown'.
   * The caller checks client, redirect and PKCE on the returned grant.
   */
  takeCode(code: string): TakeCode {
    const hash = hashAuthCode(code);
    const row = this.db.prepare('SELECT * FROM agent_auth_codes WHERE code_hash = ?').get(hash) as Record<string, unknown> | undefined;
    if (!row) {
      const spent = this.db.prepare('SELECT key_id FROM agent_auth_spent WHERE code_hash = ? AND expires_at > ?').get(hash, this.now()) as
        | { key_id: string | null }
        | undefined;
      return spent ? { status: 'reused', keyId: spent.key_id ?? '' } : { status: 'unknown' };
    }
    // Delete first: only the caller whose DELETE changed a row may go on.
    const gone = Number(this.db.prepare('DELETE FROM agent_auth_codes WHERE code_hash = ?').run(hash).changes);
    if (gone !== 1) return { status: 'unknown' };
    const expiresAt = Number(row.expires_at);
    // The code is spent now, whatever happens next (an expired or wrong-PKCE code is burned).
    this.db.prepare('INSERT OR REPLACE INTO agent_auth_spent (code_hash, key_id, expires_at) VALUES (?, NULL, ?)').run(hash, this.now() + SPENT_TTL_MS);
    if (expiresAt <= this.now()) return { status: 'unknown' };
    const email = String(row.email);
    return {
      status: 'ok',
      grant: {
        clientId: String(row.client_id),
        redirectUri: String(row.redirect_uri),
        email,
        scopes: String(row.scopes).split(',') as Scope[],
        codeChallenge: String(row.code_challenge),
        label: (row.label as string | null) ?? null,
        password: openCodePassword(this.secret, code, email, String(row.enc_password)),
        expiresAt
      }
    };
  }

  /** Remembers which key a code produced, so reusing the code can revoke it. */
  rememberKey(code: string, keyId: string): void {
    this.db.prepare('UPDATE agent_auth_spent SET key_id = ? WHERE code_hash = ?').run(keyId, hashAuthCode(code));
  }

  prune(): void {
    const now = this.now();
    this.db.prepare('DELETE FROM agent_auth_used WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM agent_auth_codes WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM agent_auth_spent WHERE expires_at <= ?').run(now);
  }
}
