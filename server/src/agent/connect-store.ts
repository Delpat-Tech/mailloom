import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hashAuthCode, newAuthCode, openCodePassword, sealCodePassword } from './crypto.js';
import type { Scope } from './store.js';

/**
 * Connect Mailloom (OAuth authorization code + PKCE): pending authorisation requests, one-use codes and the
 * short memory of spent codes. Same node:sqlite database as the sessions.
 *
 *   agent_auth_requests  a request that passed the client/redirect checks and waits for the person (10 minutes)
 *   agent_auth_codes     a granted request: sha256(code) only, the mailbox password sealed with a key that needs the
 *                        code, valid 60 seconds, deleted the moment it is used
 *   agent_auth_spent     sha256(code) -> key id of the key the first use minted, kept 10 minutes, so a reused code
 *                        can revoke that key
 */

export const REQUEST_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 60_000;
export const SPENT_TTL_MS = 10 * 60_000;
/** Most pending requests at once; the page is open to anyone who can reach it, so it is capped. */
export const MAX_PENDING_REQUESTS = 500;

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

export class ConnectStore {
  constructor(
    private db: DatabaseSync,
    private secret: string,
    private now: () => number = Date.now
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_auth_requests (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scopes TEXT NOT NULL,
        state TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
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

  /** Stores a pending request; null when too many are pending already. */
  createRequest(input: Omit<AuthRequest, 'id' | 'createdAt' | 'expiresAt'>): AuthRequest | null {
    const now = this.now();
    this.prune();
    const pending = Number((this.db.prepare('SELECT COUNT(*) AS n FROM agent_auth_requests').get() as { n: number }).n);
    if (pending >= MAX_PENDING_REQUESTS) return null;
    const id = crypto.randomBytes(16).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO agent_auth_requests (id, client_id, redirect_uri, scopes, state, code_challenge, label, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.clientId, input.redirectUri, input.scopes.join(','), input.state, input.codeChallenge, input.label, now, now + REQUEST_TTL_MS);
    return { ...input, id, createdAt: now, expiresAt: now + REQUEST_TTL_MS };
  }

  /** The request when it exists and has not expired. */
  getRequest(id: string): AuthRequest | null {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
    const r = this.db.prepare('SELECT * FROM agent_auth_requests WHERE id = ? AND expires_at > ?').get(id, this.now()) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      clientId: String(r.client_id),
      redirectUri: String(r.redirect_uri),
      scopes: String(r.scopes).split(',') as Scope[],
      state: String(r.state),
      codeChallenge: String(r.code_challenge),
      label: (r.label as string | null) ?? null,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at)
    };
  }

  /** Uses the request up: true for exactly one caller. */
  consumeRequest(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM agent_auth_requests WHERE id = ? AND expires_at > ?').run(id, this.now()).changes) === 1;
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
    this.db.prepare('DELETE FROM agent_auth_requests WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM agent_auth_codes WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM agent_auth_spent WHERE expires_at <= ?').run(now);
  }
}
