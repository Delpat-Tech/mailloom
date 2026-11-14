import crypto from 'node:crypto';
import { ConfigError } from '../config.js';

/**
 * Web Push settings (new-mail notifications while the app is closed).
 *
 *   VAPID_PUBLIC_KEY   base64url P-256 public key (65 bytes uncompressed). Given to browsers.
 *   VAPID_PRIVATE_KEY  base64url P-256 private key (32 bytes). Signs requests to push services.
 *   VAPID_SUBJECT      mailto: address or https: URL push services can contact about abuse.
 *
 * All three unset: push is off (the app says so and the button stays on in-tab notifications).
 * Some but not all set, or malformed: the server refuses to start.
 * Generate a pair with: npx web-push generate-vapid-keys
 */
export interface PushConfig {
  enabled: boolean;
  publicKey: string;
  privateKey: string;
  subject: string;
}

type Env = Record<string, string | undefined>;

function b64urlBytes(value: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return -1;
  return Buffer.from(value, 'base64url').length;
}

export function loadPushConfig(env: Env): PushConfig {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() || '';
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() || '';
  const subject = env.VAPID_SUBJECT?.trim() || '';
  if (!publicKey && !privateKey && !subject) return { enabled: false, publicKey: '', privateKey: '', subject: '' };
  const missing = [
    ['VAPID_PUBLIC_KEY', publicKey],
    ['VAPID_PRIVATE_KEY', privateKey],
    ['VAPID_SUBJECT', subject]
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new ConfigError(`Push notifications need all three VAPID settings; missing ${missing.join(', ')}. Generate keys with: npx web-push generate-vapid-keys`);
  }
  if (b64urlBytes(publicKey) !== 65 || Buffer.from(publicKey, 'base64url')[0] !== 4) {
    throw new ConfigError('VAPID_PUBLIC_KEY is not a base64url P-256 public key (65 bytes). Generate keys with: npx web-push generate-vapid-keys');
  }
  if (b64urlBytes(privateKey) !== 32) {
    throw new ConfigError('VAPID_PRIVATE_KEY is not a base64url P-256 private key (32 bytes).');
  }
  // The two halves must belong together, or every push service would refuse our signatures.
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (!ecdh.getPublicKey().equals(Buffer.from(publicKey, 'base64url'))) throw new Error('mismatch');
  } catch {
    throw new ConfigError('VAPID_PRIVATE_KEY does not match VAPID_PUBLIC_KEY.');
  }
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject) && !/^https:\/\/[^\s]+$/.test(subject)) {
    throw new ConfigError('VAPID_SUBJECT must be a mailto: address (e.g. mailto:it@delpat.in) or an https:// URL.');
  }
  return { enabled: true, publicKey, privateKey, subject };
}

/**
 * Push services the server will send to. The endpoint URL comes from the browser, and the server
 * POSTs to it, so any other host is refused (no requests to internal addresses on a user's say-so).
 */
const PUSH_HOST_PATTERNS: RegExp[] = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, Samsung
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/, // Edge on Windows
  /^web\.push\.apple\.com$/, // Safari on iPhone, iPad and Mac
  /^[a-z0-9-]+\.push\.apple\.com$/
];

export function isAllowedPushEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_PATTERNS.some((re) => re.test(host));
}
