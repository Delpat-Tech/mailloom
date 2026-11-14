import type { DatabaseSync } from 'node:sqlite';

/**
 * Per-mailbox settings that follow the person across devices: one JSON document per mailbox
 * address (lower-cased) in the same node:sqlite database as the sessions and labels, with a
 * version number for optimistic concurrency. Validation lives in routes/settings.ts.
 */

export interface SettingsTemplate {
  id: string;
  name: string;
  subject: string;
  html: string;
}

export interface SettingsDoc {
  version: number;
  loadPictures: boolean;
  signature: { html: string; logo: string | null };
  templates: SettingsTemplate[];
  theme: 'system' | 'light' | 'dark';
  defaultReply: 'reply' | 'replyAll';
}

export type SettingsFields = Omit<SettingsDoc, 'version'>;

export function defaultSettings(): SettingsFields {
  return {
    loadPictures: true,
    signature: { html: '', logo: null },
    templates: [],
    theme: 'system',
    defaultReply: 'reply'
  };
}

const lc = (email: string) => email.trim().toLowerCase();

export class SettingsStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_settings (
        email TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        doc TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** The stored document with defaults filled in for anything missing. Version 0 = never saved. */
  get(email: string): SettingsDoc {
    const row = this.db.prepare('SELECT version, doc FROM mailbox_settings WHERE email = ?').get(lc(email)) as
      | { version: number; doc: string }
      | undefined;
    const base = defaultSettings();
    if (!row) return { version: 0, ...base };
    let stored: Partial<SettingsFields> = {};
    try {
      stored = JSON.parse(row.doc) as Partial<SettingsFields>;
    } catch {
      stored = {};
    }
    return {
      version: row.version,
      loadPictures: typeof stored.loadPictures === 'boolean' ? stored.loadPictures : base.loadPictures,
      signature: { ...base.signature, ...(stored.signature || {}) },
      templates: Array.isArray(stored.templates) ? stored.templates : base.templates,
      theme: stored.theme || base.theme,
      defaultReply: stored.defaultReply || base.defaultReply
    };
  }

  /** Writes `fields` if the stored version is still `expected`; returns the new document or null on a mismatch. */
  save(email: string, expected: number, fields: SettingsFields): SettingsDoc | null {
    const key = lc(email);
    const next = expected + 1;
    const doc = JSON.stringify(fields);
    let changed: number | bigint;
    if (expected === 0) {
      changed = this.db
        .prepare('INSERT INTO mailbox_settings (email, version, doc, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
        .run(key, next, doc, this.now()).changes;
    } else {
      changed = this.db
        .prepare('UPDATE mailbox_settings SET version = ?, doc = ?, updated_at = ? WHERE email = ? AND version = ?')
        .run(next, doc, this.now(), key, expected).changes;
    }
    return Number(changed) === 1 ? { version: next, ...fields } : null;
  }
}
