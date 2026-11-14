/**
 * Server configuration, read once from the environment when the app is built.
 * Nothing here has a fallback secret: missing or weak secrets stop the server.
 */

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
  tls: {
    rejectUnauthorized: boolean;
    servername?: string;
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
  /** Extra origins allowed to call the API with credentials (same origin is always allowed). */
  corsOrigins: string[];
  /** Force the Secure flag on cookies even for localhost. */
  cookieAlwaysSecure: boolean;
  /** Fastify trustProxy setting (needed behind nginx so req.ip is the client). */
  trustProxy: boolean | string;
  demoMode: boolean;
  mail: MailServerConfig;
  /** Login throttle: failures allowed per user+IP within the window. */
  loginMaxFailures: number;
  loginWindowMs: number;
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

  const demoMode = collect(() => flag(env, 'DEMO_MODE', false), false);
  const cookieAlwaysSecure = collect(() => flag(env, 'COOKIE_SECURE', false), false);

  const sessionIdleMinutes = collect(() => int(env, 'SESSION_IDLE_MINUTES', 30), 30);
  const sessionShortMaxHours = collect(() => int(env, 'SESSION_SHORT_MAX_HOURS', 12), 12);
  const sessionRememberDays = collect(() => int(env, 'SESSION_REMEMBER_DAYS', 30), 30);

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

  const trustProxyRaw = env.TRUST_PROXY?.trim();
  let trustProxy: boolean | string = false;
  if (trustProxyRaw) {
    const lower = trustProxyRaw.toLowerCase();
    trustProxy = ['1', 'true', 'yes'].includes(lower) ? true : ['0', 'false', 'no'].includes(lower) ? false : trustProxyRaw;
  }

  if (problems.length > 0) {
    throw new ConfigError(`Configuration problems:\n  - ${problems.join('\n  - ')}`);
  }

  return {
    sessionSecret,
    sessionDbPath: env.SESSION_DB_PATH?.trim() || ':memory:',
    sessionIdleMs: sessionIdleMinutes * 60_000,
    sessionShortMaxMs: sessionShortMaxHours * 3_600_000,
    sessionRememberMs: sessionRememberDays * 86_400_000,
    corsOrigins,
    cookieAlwaysSecure,
    trustProxy,
    demoMode,
    loginMaxFailures: 5,
    loginWindowMs: 15 * 60_000,
    mail: {
      imapHost,
      imapPort,
      imapSecure,
      smtpHost,
      smtpPort,
      smtpSecure,
      tls: {
        rejectUnauthorized,
        servername: env.MAIL_TLS_SERVERNAME?.trim() || undefined
      }
    }
  };
}
