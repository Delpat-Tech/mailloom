import crypto from 'node:crypto';
import type { AccountConfig } from '../types.js';

const ALGORITHM = 'aes-256-gcm';
const DEFAULT_SECRET = process.env.SESSION_SECRET || 'roundcube-webmail-secret-encryption-key-32chars!';
const KEY = crypto.createHash('sha256').update(DEFAULT_SECRET).digest();

export function encryptSession(data: AccountConfig): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const json = JSON.stringify(data);
  let encrypted = cipher.update(json, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

export function decryptSession(token: string): AccountConfig | null {
  try {
    const parts = token.split(':');
    if (parts.length !== 3) return null;
    const [ivHex, tagHex, encryptedHex] = parts as [string, string, string];
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted) as AccountConfig;
  } catch (err) {
    return null;
  }
}
