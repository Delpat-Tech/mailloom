/**
 * Server configuration, read once from the environment when the app is built.
 * Nothing here has a fallback secret: missing or weak secrets stop the server.
 */

import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface MailServerConfig {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  /** Allow SMTP without STARTTLS when smtpSecure is off. Local testing only (MAIL_SMTP_ALLOW_PLAIN=1). */
  smtpAllowPlain: boolean;
  tls: {
    rejectUnauthorized: boolean;
    servername?: string;
    /** PEM text of extra trusted CA certificate(s), from MAIL_TLS_CA_FILE. */
    ca?: string;
  };
}

export interface AppConfig {
  /** Key material for encrypting stored mail passwords (at least 32 characters). */
  sessionSecret: string;
  /** node:sqlite file for sessions; ':memory:' keeps them in memory only. */
  sessionDbPath: string;
  /** Idle timeout for sessions without Remember Me. */
  sessionIdleMs: number;
  /** Absolute cap for sessions without Remember Me. */
  sessionShortMaxMs: number;
  /** Lifetime for sessions with Remember Me. */
  sessionRememberMs: number;
  /** Absolute cap for Remember Me sessions from creation (SESSION_REMEMBER_MAX_DAYS, default 180). */
  sessionRememberMaxMs: number;
  /** Extra origins allowed to call the API with credentials (same origin is always allowed). */
  corsOrigins: string[];
  /** Force the Secure flag on cookies even for localhost. */
  cookieAlwaysSecure: boolean;
  /** Fastify trustProxy setting (needed behind nginx so req.ip is the client). */
  trustProxy: number | string | false;
  /** Mail domains that may sign in (lower case), from MAIL_DOMAINS. */
  mailDomains: string[];
  /** Largest outgoing message in bytes (MAIL_MAX_MESSAGE_BYTES, default 10 MB). */
  maxMessageBytes: number;
  demoMode: boolean;
  mail: MailServerConfig;
  /** Login throttle: failures allowed per user+IP within the window. */
  loginMaxFailures: number;
  loginWindowMs: number;
  /** Failures allowed per client IP (any user) within the window. */
  loginIpMaxFailures: number;
  /** Failures allowed per email address (any IP) within the window. */
  loginEmailMaxFailures: number;
}

// Values that were committed to the repository at some point. Never accept them.
const KNOWN_PUBLIC_SECRETS = new Set([
  'bacc858293506b3ea5ffea77f7cb2911e0eccae9124ee1b5780daac20cee8659',
  '9d4f9c127b3aeaa03001cfbdfdf0d69067060c0d19a930243a8c5071cb20b787',
  'roundcube-webmail-secret-encryption-key-32chars!',
  'mailloom-secret-cookie-sign-key-998811'
]);

type Env = Record<string, string | undefined>;

function flag(env: Env, name: string, defaultValue: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false (got "${env[name]}").`);
}

function int(env: Env, name: string, defaultValue: number, min = 1): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new ConfigError(`${name} must be a whole number of at least ${min} (got "${raw}").`);
  }
  return n;
}

function required(env: Env, name: string, hint: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is not set. ${hint}`);
  return value;
}

/**
 * TRUST_PROXY: a hop count (1 = one proxy in front) or a comma list of proxy IPs/CIDRs.
 * "true" would trust any X-Forwarded-For header and let anyone fake their IP, so it is refused.
 */
function parseTrustProxy(raw: string | undefined): number | string | false {
  const value = raw?.trim();
  if (!value) return false;
  const lower = value.toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > 10) throw new ConfigError('TRUST_PROXY hop count looks wrong (more than 10).');
    return hops;
  }
  if (['true', 'yes', 'on'].includes(lower)) {
    throw new ConfigError(
      'TRUST_PROXY=true trusts every client and lets anyone fake their IP. Use the proxy IP list (e.g. 127.0.0.1) or a hop count (e.g. 1).'
    );
  }
  const entries = value.split(',').map((e) => e.trim()).filter(Boolean);
  for (const e of entries) {
    const named = ['loopback', 'linklocal', 'uniquelocal'].includes(e.toLowerCase());
    const addr = /^[0-9a-f:.]+(\/\d{1,3})?$/i.test(e) && (e.includes('.') || e.includes(':'));
    if (!named && !addr) throw new ConfigError(`TRUST_PROXY entry "${e}" is not an IP address, CIDR range or hop count.`);
    if (e === '0.0.0.0/0' || e === '::/0' || /\/0$/.test(e)) {
      throw new ConfigError(`TRUST_PROXY entry "${e}" would trust every client.`);
    }
  }
  return entries.join(',');
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && [m[1], m[2], m[3]].every((o) => Number(o) <= 255);
}

/** Read MAIL_TLS_CA_FILE once; it must hold at least one PEM certificate. */
function readCaFile(env: Env): string | undefined {
  const path = env.MAIL_TLS_CA_FILE?.trim();
  if (!path) return undefined;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`MAIL_TLS_CA_FILE (${path}) cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
  }
  // Keep only certificate blocks (a private key in the same file is never passed on) and refuse corrupt ones.
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) {
    throw new ConfigError(`MAIL_TLS_CA_FILE (${path}) does not contain a PEM certificate (-----BEGIN CERTIFICATE-----).`);
  }
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch {
      throw new ConfigError(`MAIL_TLS_CA_FILE (${path}) contains a certificate that cannot be parsed.`);
    }
  }
  return blocks.join('\n') + '\n';
}

export function loadConfig(env: Env): AppConfig {
  const problems: string[] = [];
  const collect = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ConfigError) {
        problems.push(err.message);
        return fallback;
      }
      throw err;
    }
  };

  const sessionSecret = collect(() => {
    const s = required(
      env,
      'SESSION_SECRET',
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    if (s.length < 32) throw new ConfigError('SESSION_SECRET must be at least 32 characters.');
    if (KNOWN_PUBLIC_SECRETS.has(s) || /change[-_ ]?me|placeholder|example/i.test(s)) {
      throw new ConfigError('SESSION_SECRET is a published or placeholder value. Generate a new one.');
    }
    return s;
  }, '');

  const imapHost = collect(() => required(env, 'MAIL_IMAP_HOST', 'Set it to the IMAP server host, e.g. 127.0.0.1.'), '');
  const smtpHost = collect(() => required(env, 'MAIL_SMTP_HOST', 'Set it to the SMTP server host, e.g. 127.0.0.1.'), '');
  const imapSecure = collect(() => flag(env, 'MAIL_IMAP_SECURE', true), true);
  const imapPort = collect(() => int(env, 'MAIL_IMAP_PORT', imapSecure ? 993 : 143), 993);
  const smtpPort = collect(() => int(env, 'MAIL_SMTP_PORT', 587), 587);
  const smtpSecure = collect(() => flag(env, 'MAIL_SMTP_SECURE', smtpPort === 465), false);

  const rejectUnauthorized = collect(() => {
    const v = flag(env, 'MAIL_TLS_REJECT_UNAUTHORIZED', true);
    if (!v && !flag(env, 'MAIL_ALLOW_INSECURE_TLS', false)) {
      throw new ConfigError(
        'MAIL_TLS_REJECT_UNAUTHORIZED=false turns off certificate checks. It is only allowed for local testing ' +
          'together with MAIL_ALLOW_INSECURE_TLS=1. For a server reached by IP, set MAIL_TLS_SERVERNAME to the ' +
          'certificate name instead.'
      );
    }
    return v;
  }, true);

  const tlsCa = collect(() => readCaFile(env), undefined);

  const demoMode = collect(() => flag(env, 'DEMO_MODE', false), false);
  const cookieAlwaysSecure = collect(() => flag(env, 'COOKIE_SECURE', false), false);

  const sessionIdleMinutes = collect(() => int(env, 'SESSION_IDLE_MINUTES', 30), 30);
  const sessionShortMaxHours = collect(() => int(env, 'SESSION_SHORT_MAX_HOURS', 12), 12);
  const sessionRememberDays = collect(() => int(env, 'SESSION_REMEMBER_DAYS', 30), 30);
  const sessionRememberMaxDays = collect(() => int(env, 'SESSION_REMEMBER_MAX_DAYS', 180), 180);

  const corsOrigins = (env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  for (const origin of corsOrigins) {
    collect(() => {
      if (origin === '*') throw new ConfigError('CORS_ORIGINS may not be "*"; list exact origins.');
      try {
        const u = new URL(origin);
        if (u.origin !== origin) throw new Error();
      } catch {
        throw new ConfigError(`CORS_ORIGINS entry "${origin}" is not an origin like https://mail.example.com.`);
      }
    }, undefined);
  }

  const trustProxy = collect(() => parseTrustProxy(env.TRUST_PROXY), false as number | string | false);

  const mailDomains = collect(() => {
    const raw = required(env, 'MAIL_DOMAINS', 'List the mail domains that may sign in, comma separated, e.g. delpat.in,ydco.in.');
    const list = raw
      .split(',')
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean);
    for (const d of list) {
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
        throw new ConfigError(`MAIL_DOMAINS entry "${d}" is not a domain name like delpat.in.`);
      }
    }
    if (list.length === 0) throw new ConfigError('MAIL_DOMAINS must list at least one domain.');
    return list;
  }, [] as string[]);

  const smtpAllowPlain = collect(() => {
    const v = flag(env, 'MAIL_SMTP_ALLOW_PLAIN', false);
    if (v && smtpHost && !isLoopbackHost(smtpHost)) {
      throw new ConfigError(
        `MAIL_SMTP_ALLOW_PLAIN is only allowed when MAIL_SMTP_HOST is a loopback host (127.0.0.0/8, ::1, localhost); ` +
          `got "${smtpHost}". Sending mail without TLS to another host exposes passwords and messages. Remove MAIL_SMTP_ALLOW_PLAIN.`
      );
    }
    return v;
  }, false);
  const maxMessageBytes = collect(() => int(env, 'MAIL_MAX_MESSAGE_BYTES', 10 * 1024 * 1024), 10 * 1024 * 1024);

  if (problems.length > 0) {
    throw new ConfigError(`Configuration problems:\n  - ${problems.join('\n  - ')}`);
  }

  return {
    sessionSecret,
    sessionDbPath: env.SESSION_DB_PATH?.trim() || ':memory:',
    sessionIdleMs: sessionIdleMinutes * 60_000,
    sessionShortMaxMs: sessionShortMaxHours * 3_600_000,
    sessionRememberMs: sessionRememberDays * 86_400_000,
    sessionRememberMaxMs: Math.max(sessionRememberDays, sessionRememberMaxDays) * 86_400_000,
    corsOrigins,
    cookieAlwaysSecure,
    trustProxy,
    mailDomains,
    maxMessageBytes,
    demoMode,
    loginMaxFailures: 5,
    loginWindowMs: 15 * 60_000,
    loginIpMaxFailures: 20,
    loginEmailMaxFailures: 10,
    mail: {
      imapHost,
      imapPort,
      imapSecure,
      smtpHost,
      smtpPort,
      smtpSecure,
      smtpAllowPlain,
      tls: {
        rejectUnauthorized,
        servername: env.MAIL_TLS_SERVERNAME?.trim() || undefined,
        ...(tlsCa ? { ca: tlsCa } : {})
      }
    }
  };
}
