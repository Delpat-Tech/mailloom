import crypto from 'node:crypto';

/**
 * Encryption of stored mail passwords and helpers for session ids.
 * Nothing in this module reads the environment: the key is passed in by the app,
 * which gets it from loadConfig() (no fallback secret exists).
 */

const ALGORITHM = 'aes-256-gcm';
const FORMAT_VERSION = 'v1';

export interface CredentialCipher {
  /** Encrypts plaintext; `context` is bound as AAD so a ciphertext only opens for the same session. */
  encrypt(plaintext: string, context: string): string;
  /** Returns null when the value was tampered with, belongs to another context, or the key changed. */
  decrypt(payload: string, context: string): string | null;
}

export function createCredentialCipher(secret: string): CredentialCipher {
  if (!secret || secret.length < 32) {
    throw new Error('Credential encryption needs a secret of at least 32 characters.');
  }
  const key = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'mailloom:credentials:v1', 32)
  );

  return {
    encrypt(plaintext, context) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [FORMAT_VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
    },
    decrypt(payload, context) {
      try {
        const [version, ivB64, tagB64, dataB64] = payload.split('.');
        if (version !== FORMAT_VERSION || !ivB64 || !tagB64 || dataB64 === undefined) return null;
        const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64url'));
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    }
  };
}

/** 256-bit random session id, URL and cookie safe. Only ever sent to the browser in an httpOnly cookie. */
export function newSessionId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Short public handle naming one signed-in account in a browser. Not a secret. */
export function newAccountHandle(): string {
  return crypto.randomBytes(9).toString('base64url');
}

/** Sessions are stored by hash, so a copy of the database does not contain usable session ids. */
export function hashSessionId(sessionId: string): string {
  return crypto.createHash('sha256').update(sessionId, 'utf8').digest('hex');
}
