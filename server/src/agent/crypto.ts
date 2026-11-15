import crypto from 'node:crypto';

/**
 * Agent keys and the mailbox password stored with them.
 *
 * Key:     "mlk_" + 43 chars base64url (256 random bits). Shown to the person once.
 * Stored:  sha256(key) as hex, plus the first 12 characters ("mlk_" + 8) as a public prefix.
 * Password: AES-256-GCM. The encryption key is HKDF-SHA256 over SESSION_SECRET *and* the agent
 *          key itself (info "mailloom:agent-mailbox-password:v1"), and the row id + mailbox are
 *          bound as AAD. So the database plus SESSION_SECRET is not enough to recover a mailbox
 *          password: the bearer key (held only by Work OS) is needed too, and a ciphertext moved
 *          to another row or mailbox does not open.
 */

export const KEY_PREFIX = 'mlk_';
const KEY_RE = /^mlk_[A-Za-z0-9_-]{43}$/;
const HKDF_INFO = 'mailloom:agent-mailbox-password:v1';
const FORMAT = 'a1';

export function newAgentKey(): string {
  return KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
}

export function isWellFormedAgentKey(key: string): boolean {
  return KEY_RE.test(key);
}

export function hashAgentKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

export function agentKeyPrefix(key: string): string {
  return key.slice(0, 12);
}

/** Public id of a key record (used in management URLs). Not a secret. */
export function newKeyId(): string {
  return crypto.randomBytes(9).toString('base64url');
}

function derive(secret: string, agentKey: string, info: string = HKDF_INFO): Buffer {
  const ikm = Buffer.concat([Buffer.from(secret, 'utf8'), Buffer.from([0]), Buffer.from(agentKey, 'utf8')]);
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
}

function aad(id: string, email: string): Buffer {
  return Buffer.from(`${id}\n${email.toLowerCase()}`, 'utf8');
}

export function encryptMailboxPassword(secret: string, agentKey: string, id: string, email: string, password: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive(secret, agentKey), iv);
  cipher.setAAD(aad(id, email));
  const data = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return [FORMAT, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

/** null when the key, SESSION_SECRET, row id or mailbox do not match (or the value was altered). */
export function decryptMailboxPassword(secret: string, agentKey: string, id: string, email: string, payload: string): string | null {
  try {
    const [format, iv, tag, data] = payload.split('.');
    if (format !== FORMAT || !iv || !tag || data === undefined) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', derive(secret, agentKey), Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad(id, email));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ Connect (authorization codes)

const CODE_HKDF_INFO = 'mailloom:connect-code-password:v1';
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

/** An authorization code: 256 random bits, base64url. Only its hash is stored. */
export function newAuthCode(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function isWellFormedAuthCode(code: string): boolean {
  return CODE_RE.test(code);
}

export function hashAuthCode(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * The mailbox password waiting between Allow and the token swap. Sealed with a key derived from
 * SESSION_SECRET and the code itself (a different HKDF label from agent keys), so the database plus
 * SESSION_SECRET cannot open it: the code, which is never stored, is needed too. The code hash and
 * mailbox are bound as AAD.
 */
export function sealCodePassword(secret: string, code: string, email: string, password: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive(secret, code, CODE_HKDF_INFO), iv);
  cipher.setAAD(aad(hashAuthCode(code), email));
  const data = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return [FORMAT, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function openCodePassword(secret: string, code: string, email: string, payload: string): string | null {
  try {
    const [format, iv, tag, data] = payload.split('.');
    if (format !== FORMAT || !iv || !tag || data === undefined) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', derive(secret, code, CODE_HKDF_INFO), Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad(hashAuthCode(code), email));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
