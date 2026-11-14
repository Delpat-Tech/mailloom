import crypto from 'node:crypto';

/**
 * Secrets kept for one device's push subscription: the mailbox password (so the server can watch
 * INBOX while the person is away) and the subscription's payload keys (p256dh, auth).
 *
 * AES-256-GCM. Key = HKDF-SHA256(SESSION_SECRET, salt = 16 random bytes stored with the row,
 * info "mailloom:push-device-secrets:v1"), so it is a different key from session passwords and
 * agent keys. AAD binds the row id, mailbox and sha256(endpoint): a ciphertext copied to another
 * row, mailbox or device does not open.
 *
 * Unlike agent keys, no secret held only by the device can be mixed in: the server has to open
 * this while the device is switched off. Database + SESSION_SECRET therefore recovers the password;
 * that is why it is opt-in per device, deleted on turn-off, and wiped when the mail server refuses it.
 */

const HKDF_INFO = 'mailloom:push-device-secrets:v1';
const FORMAT = 'p1';

export interface DeviceSecrets {
  password: string;
  p256dh: string;
  auth: string;
}

export function endpointHash(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint, 'utf8').digest('hex');
}

function derive(secret: string, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), salt, HKDF_INFO, 32));
}

function aad(id: string, email: string, epHash: string): Buffer {
  return Buffer.from(`${id}\n${email.toLowerCase()}\n${epHash}`, 'utf8');
}

export function encryptDeviceSecrets(secret: string, id: string, email: string, epHash: string, value: DeviceSecrets): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive(secret, salt), iv);
  cipher.setAAD(aad(id, email, epHash));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [FORMAT, salt, iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

/** null when SESSION_SECRET, row id, mailbox or endpoint do not match, or the value was altered. */
export function decryptDeviceSecrets(secret: string, id: string, email: string, epHash: string, payload: string): DeviceSecrets | null {
  try {
    const [format, salt, iv, tag, data] = payload.split('.');
    if (format !== FORMAT || !salt || !iv || !tag || data === undefined) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', derive(secret, Buffer.from(salt, 'base64url')), Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad(id, email, epHash));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'));
    if (typeof parsed?.password !== 'string' || typeof parsed?.p256dh !== 'string' || typeof parsed?.auth !== 'string') return null;
    return parsed as DeviceSecrets;
  } catch {
    return null;
  }
}
