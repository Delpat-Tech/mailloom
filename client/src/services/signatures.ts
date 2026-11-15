import { htmlToPlainText } from './richtext.js';

/**
 * A signature is rich text (`html`, with the company logo as an inline picture) and an on/off switch.
 *
 * Storage: still this browser's localStorage, per account (key mailloom_sig_<email>). It is NOT stored on
 * the server yet, so a signature (and its logo) has to be set up once on each browser. Moving it to the
 * server account settings is a later step. The logo is kept as a data: URI, so pictures in a signature
 * are limited to SIGNATURE_IMAGE_MAX_BYTES to stay well inside the browser's localStorage quota.
 *
 * The old four-field signature (name, designation, phone, website, disclaimer) is still read: when a
 * stored signature has no `html`, one is built from those fields.
 */
export interface AccountSignature {
  /** Rich signature (editor HTML). */
  html: string;
  enabled: boolean;
  // Legacy fields of the old form; only read to build `html` once.
  name?: string;
  designation?: string;
  phone?: string;
  website?: string;
  customText?: string;
}

export const SIGNATURE_IMAGE_MAX_BYTES = 300 * 1024;

const STORAGE_PREFIX = 'mailloom_sig_';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Nobody has a signature until they set one.
export function getDefaultSignature(): AccountSignature {
  return { html: '', enabled: false };
}

// Placeholder signature older versions saved automatically for every account.
function isOldPlaceholder(sig: Partial<AccountSignature>): boolean {
  return sig.phone === '+91 98250 12345' || Boolean(sig.customText?.startsWith('Confidentiality Notice: This message'));
}

/** The rich version of an old four-field signature. */
export function legacySignatureHtml(sig: Partial<AccountSignature>): string {
  const lines = [sig.name, sig.designation, [sig.phone, sig.website].filter(Boolean).join(' | ')]
    .map((l) => (l || '').trim())
    .filter(Boolean);
  const parts: string[] = [];
  if (lines.length) parts.push(`<p>${lines.map(esc).join('<br>')}</p>`);
  if ((sig.customText || '').trim()) parts.push(`<p>${esc(sig.customText!.trim()).replace(/\n/g, '<br>')}</p>`);
  return parts.join('');
}

export function getSignatureForAccount(email: string, _fallbackName = ''): AccountSignature {
  if (!email) return getDefaultSignature();
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${email.toLowerCase()}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AccountSignature>;
      if (!isOldPlaceholder(parsed)) {
        const html = typeof parsed.html === 'string' ? parsed.html : legacySignatureHtml(parsed);
        return { html, enabled: Boolean(parsed.enabled) };
      }
    }
  } catch {
    // Ignore JSON parse errors
  }
  return getDefaultSignature();
}

/** Returns false when the browser refused to store it (storage full or blocked). */
export function saveSignatureForAccount(email: string, signature: AccountSignature): boolean {
  if (!email) return false;
  try {
    localStorage.setItem(
      `${STORAGE_PREFIX}${email.toLowerCase()}`,
      JSON.stringify({ html: signature.html, enabled: signature.enabled })
    );
    return true;
  } catch {
    return false;
  }
}

/** The signature as editor HTML ('' when it is off or empty). */
export function signatureHtml(sig: AccountSignature): string {
  return sig.enabled && sig.html.trim() ? sig.html : '';
}

/** The signature as plain text with the usual "--" line ('' when it is off or empty). */
export function formatSignatureText(sig: AccountSignature): string {
  const html = signatureHtml(sig);
  if (!html) return '';
  const text = htmlToPlainText(html);
  return text ? `--\n${text}` : '';
}

/** The picture a signature carries: the logo from the settings, as a small paragraph at the end. */
export function composeSignatureHtml(sig: { html: string; logo: string | null } | null | undefined): string {
  if (!sig) return '';
  const body = sig.html.trim();
  const logo = sig.logo ? `<p><img src="${esc(sig.logo)}" alt="Logo"></p>` : '';
  return body || logo ? body + logo : '';
}

const IMG_RE = /<img\b[^>]*>/gi;
const DATA_SRC_RE = /\ssrc=["'](data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2})["']/i;

/**
 * An older signature kept its logo as a picture inside the text. The server keeps the logo apart (and the text
 * small), so the first embedded picture becomes the logo and every picture is taken out of the text.
 */
export function splitSignatureHtml(html: string): { html: string; logo: string | null } {
  let logo: string | null = null;
  for (const tag of html.match(IMG_RE) ?? []) {
    const m = DATA_SRC_RE.exec(tag);
    if (m) {
      logo = m[1]!;
      break;
    }
  }
  return { html: html.replace(IMG_RE, '').replace(/<p>\s*<\/p>/gi, ''), logo };
}
