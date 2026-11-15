import { getAccountSettings, patchAccountSettings, type AccountSettings, type AccountSettingsPatch, type AccountTemplate } from './accountSettings.js';
import { getSignatureForAccount, splitSignatureHtml } from './signatures.js';
import { getCustomTemplates, toAccountTemplate } from './templates.js';
import { getLoadPictures, hasStoredLoadPictures, setLoadPictures } from './settings.js';
import { applyThemeChoice, hasStoredThemeChoice } from './theme.js';

/*
 * The server is the source of truth for per-mailbox settings. This browser keeps only a cache (so the composer
 * has the signature at once, and the picture choice is known before the first message request) and, once, the
 * old localStorage values to hand over on the first sign-in after the move.
 */

type ImportLocal = NonNullable<AccountSettingsPatch['importLocal']>;

const CACHE_PREFIX = 'mailloom_settings_cache_v1_';

export function readCachedSettings(handle: string): AccountSettings | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + handle);
    const v = raw ? (JSON.parse(raw) as AccountSettings) : null;
    return v && typeof v.version === 'number' && v.signature ? v : null;
  } catch {
    return null;
  }
}

/** Remembers the document (and the picture choice, which the message requests read synchronously). */
export function cacheSettings(handle: string, s: AccountSettings): void {
  setLoadPictures(handle, s.loadPictures);
  try {
    localStorage.setItem(CACHE_PREFIX + handle, JSON.stringify(s));
  } catch {
    /* the cache is optional */
  }
}

/** The browser's old signature, templates and pictures choice, in the shape the server imports. */
export function localImportPayload(email: string, handle: string): ImportLocal {
  const out: ImportLocal = {};
  const sig = getSignatureForAccount(email);
  if (sig.enabled && sig.html.trim()) out.signature = splitSignatureHtml(sig.html);
  const templates: AccountTemplate[] = getCustomTemplates()
    .filter((t) => t && typeof t.name === 'string' && t.name.trim())
    .slice(0, 50)
    .map((t) =>
      toAccountTemplate({
        id: /^[A-Za-z0-9_-]{1,64}$/.test(t.id) ? t.id : `t-${Math.random().toString(36).slice(2, 10)}`,
        name: t.name.slice(0, 80),
        subject: (t.subject || '').slice(0, 200),
        body: t.body || ''
      })
    );
  if (templates.length) out.templates = templates;
  if (hasStoredLoadPictures(handle)) out.loadPictures = getLoadPictures(handle);
  return out;
}

const isRefusal = (err: unknown) => (err as { status?: number } | null)?.status === 400;

/**
 * Reads the settings. Version 0 means nothing was ever saved for this mailbox: the browser's old values are sent
 * once as importLocal (the server only fills what is still at its default). If the server refuses the import
 * (for example the logo is too big), it is retried without the logo, then without the signature.
 */
export async function loadSettings(email: string, handle: string): Promise<AccountSettings> {
  const current = await getAccountSettings();
  if (current.version !== 0) return current;
  const local = localImportPayload(email, handle);
  const attempts: ImportLocal[] = [local];
  if (local.signature?.logo) attempts.push({ ...local, signature: { html: local.signature.html } });
  if (local.signature) attempts.push({ ...local, signature: undefined });
  for (const importLocal of attempts) {
    try {
      return await patchAccountSettings({ importLocal });
    } catch (err) {
      if (!isRefusal(err)) throw err;
    }
  }
  return current;
}

/** The server's theme is only a default: a choice made on this device wins. */
export function applyServerThemeDefault(theme: AccountSettings['theme']): void {
  if (!hasStoredThemeChoice()) applyThemeChoice(theme);
}
