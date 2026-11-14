import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { decryptDeviceSecrets, encryptDeviceSecrets, endpointHash, type DeviceSecrets } from './crypto.js';

/**
 * Push subscriptions, one row per (device endpoint, mailbox). Two accounts signed in on one phone
 * share the browser's endpoint but get separate rows, each with its own settings.
 * Same node:sqlite database as the sessions.
 */

export interface PushDevice {
  id: string;
  email: string;
  label: string;
  showDetails: boolean;
  quiet: boolean;
  createdAt: number;
  lastPushAt: number | null;
  disabledAt: number | null;
  disabledReason: string | null;
}

export interface ActiveDevice extends PushDevice {
  endpoint: string;
  secrets: DeviceSecrets;
}

interface Row {
  id: string;
  email: string;
  endpoint: string;
  endpoint_hash: string;
  enc_secrets: string;
  session_key: string | null;
  label: string;
  show_details: number;
  quiet: number;
  created_at: number;
  last_push_at: number | null;
  disabled_at: number | null;
  disabled_reason: string | null;
}

export const MAX_DEVICES_PER_MAILBOX = 10;

function toDevice(r: Row): PushDevice {
  return {
    id: r.id,
    email: r.email,
    label: r.label,
    showDetails: r.show_details === 1,
    quiet: r.quiet === 1,
    createdAt: r.created_at,
    lastPushAt: r.last_push_at,
    disabledAt: r.disabled_at,
    disabledReason: r.disabled_reason
  };
}

export class PushStore {
  constructor(
    private db: DatabaseSync,
    private secret: string,
    private now: () => number = Date.now
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        endpoint_hash TEXT NOT NULL,
        enc_secrets TEXT NOT NULL,
        session_key TEXT,
        label TEXT NOT NULL,
        show_details INTEGER NOT NULL,
        quiet INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_push_at INTEGER,
        disabled_at INTEGER,
        disabled_reason TEXT,
        UNIQUE (endpoint_hash, email)
      );
      CREATE INDEX IF NOT EXISTS push_subscriptions_email ON push_subscriptions (email);
      CREATE INDEX IF NOT EXISTS push_subscriptions_session ON push_subscriptions (session_key);
    `);
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as Row | undefined;
  }

  /** Creates or replaces this device's subscription for the mailbox (fresh id, fresh secrets). */
  upsert(input: {
    email: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    password: string;
    sessionKey: string | null;
    label: string;
    showDetails: boolean;
    quiet: boolean;
  }): PushDevice {
    const email = input.email.toLowerCase();
    const epHash = endpointHash(input.endpoint);
    const id = crypto.randomBytes(9).toString('base64url');
    const enc = encryptDeviceSecrets(this.secret, id, email, epHash, { password: input.password, p256dh: input.p256dh, auth: input.auth });
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND email = ?').run(epHash, email);
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, email, endpoint, endpoint_hash, enc_secrets, session_key, label, show_details, quiet, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, email, input.endpoint, epHash, enc, input.sessionKey, input.label, input.showDetails ? 1 : 0, input.quiet ? 1 : 0, this.now());
    return toDevice(this.row(id)!);
  }

  countForMailbox(email: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE email = ?').get(email.toLowerCase()) as { n: number };
    return Number(r.n);
  }

  hasEndpoint(email: string, endpoint: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM push_subscriptions WHERE endpoint_hash = ? AND email = ?')
      .get(endpointHash(endpoint), email.toLowerCase());
  }

  list(email: string): PushDevice[] {
    const rows = this.db
      .prepare('SELECT * FROM push_subscriptions WHERE email = ? ORDER BY created_at DESC')
      .all(email.toLowerCase()) as unknown as Row[];
    return rows.map(toDevice);
  }

  /** This mailbox's row for a device endpoint, or null. */
  findByEndpoint(email: string, endpoint: string): PushDevice | null {
    const r = this.db
      .prepare('SELECT * FROM push_subscriptions WHERE endpoint_hash = ? AND email = ?')
      .get(endpointHash(endpoint), email.toLowerCase()) as Row | undefined;
    return r ? toDevice(r) : null;
  }

  /** A row of this mailbox, or null (another mailbox's id looks exactly like an unknown id). */
  getOwned(id: string, email: string): PushDevice | null {
    const r = this.row(id);
    return r && r.email === email.toLowerCase() ? toDevice(r) : null;
  }

  updateSettings(id: string, email: string, s: { showDetails?: boolean; quiet?: boolean }): PushDevice | null {
    if (!this.getOwned(id, email)) return null;
    if (s.showDetails !== undefined) this.db.prepare('UPDATE push_subscriptions SET show_details = ? WHERE id = ?').run(s.showDetails ? 1 : 0, id);
    if (s.quiet !== undefined) this.db.prepare('UPDATE push_subscriptions SET quiet = ? WHERE id = ?').run(s.quiet ? 1 : 0, id);
    return toDevice(this.row(id)!);
  }

  /** Records which session last confirmed this device, so signing out there removes it. */
  bindSession(id: string, sessionKey: string): void {
    this.db.prepare('UPDATE push_subscriptions SET session_key = ? WHERE id = ?').run(sessionKey, id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id).changes) > 0;
  }

  deleteOwned(id: string, email: string): boolean {
    return Number(this.db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND email = ?').run(id, email.toLowerCase()).changes) > 0;
  }

  deleteAllForMailbox(email: string): number {
    return Number(this.db.prepare('DELETE FROM push_subscriptions WHERE email = ?').run(email.toLowerCase()).changes);
  }

  /** Signing out of a session removes the devices it turned notifications on for. Returns their mailboxes. */
  deleteForSession(sessionKey: string): string[] {
    const rows = this.db.prepare('SELECT DISTINCT email FROM push_subscriptions WHERE session_key = ?').all(sessionKey) as Array<{ email: string }>;
    this.db.prepare('DELETE FROM push_subscriptions WHERE session_key = ?').run(sessionKey);
    return rows.map((r) => r.email);
  }

  /** Stops a device for good: secrets wiped, row kept so the app can say why. */
  disable(id: string, reason: string): void {
    this.db
      .prepare("UPDATE push_subscriptions SET disabled_at = ?, disabled_reason = ?, enc_secrets = '' WHERE id = ? AND disabled_at IS NULL")
      .run(this.now(), reason, id);
  }

  markPushed(id: string): void {
    this.db.prepare('UPDATE push_subscriptions SET last_push_at = ? WHERE id = ?').run(this.now(), id);
  }

  /** Mailboxes with at least one working device. */
  activeMailboxes(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT email FROM push_subscriptions WHERE disabled_at IS NULL').all() as Array<{ email: string }>;
    return rows.map((r) => r.email);
  }

  /** Working devices of one mailbox, newest first, with their secrets opened. Rows that fail to open are disabled. */
  active(email: string): ActiveDevice[] {
    const rows = this.db
      .prepare('SELECT * FROM push_subscriptions WHERE email = ? AND disabled_at IS NULL ORDER BY created_at DESC')
      .all(email.toLowerCase()) as unknown as Row[];
    const out: ActiveDevice[] = [];
    for (const r of rows) {
      const secrets = decryptDeviceSecrets(this.secret, r.id, r.email, r.endpoint_hash, r.enc_secrets);
      if (!secrets) {
        this.disable(r.id, 'stored secrets cannot be opened');
        continue;
      }
      out.push({ ...toDevice(r), endpoint: r.endpoint, secrets });
    }
    return out;
  }
}
