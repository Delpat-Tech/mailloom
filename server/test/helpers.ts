/**
 * Shared test helpers: build the app against the local GreenMail and sign in.
 *
 *   const app = await buildTestApp();
 *   const t = await signIn(app, 'tester@delpat.test');
 *   await app.inject({ method: 'GET', url: '/api/mailboxes', headers: t.headers });
 *
 * Ports default to greenmail-a (IMAPS 1993, SMTP 1587); override with
 * GREENMAIL_IMAP_PORT / GREENMAIL_SMTP_PORT (greenmail-b: 2993 / 2587).
 * The GreenMail seeding helpers (accountFor, resetAccount, seedMail, fetchAll, ...) use the same ports.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type BuildAppOptions } from '../src/app.js';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { AccountConfig } from '../src/types.js';


export const TEST_PASSWORD = 'testpass123';
export const TESTER = 'tester@delpat.test';
export const COLLEAGUE = 'colleague@delpat.test';

export const GM = {
  host: '127.0.0.1',
  imapsPort: Number(process.env.GREENMAIL_IMAP_PORT || 1993),
  smtpPort: Number(process.env.GREENMAIL_SMTP_PORT || 1587),
  password: TEST_PASSWORD,
  tester: TESTER,
  colleague: COLLEAGUE
};

/** An AccountConfig for GreenMail, shaped like the one requireAuth builds from the server config. */
export function accountFor(email: string, name = 'Test User', extra: Partial<AccountConfig> = {}): AccountConfig {
  return {
    email,
    name,
    imapHost: GM.host,
    imapPort: GM.imapsPort,
    imapSecure: true,
    imapUser: email,
    imapPass: GM.password,
    smtpHost: GM.host,
    smtpPort: GM.smtpPort,
    smtpSecure: false,
    smtpRequireTLS: false,
    smtpUser: email,
    smtpPass: GM.password,
    tls: { rejectUnauthorized: false },
    ...extra
  };
}

export function testEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    MAIL_IMAP_HOST: '127.0.0.1',
    MAIL_IMAP_PORT: String(GM.imapsPort),
    MAIL_IMAP_SECURE: 'true',
    MAIL_SMTP_HOST: '127.0.0.1',
    MAIL_SMTP_PORT: String(GM.smtpPort),
    MAIL_SMTP_SECURE: 'false',
    // GreenMail SMTP is plain text.
    MAIL_SMTP_ALLOW_PLAIN: '1',
    MAIL_DOMAINS: 'delpat.test',
    // GreenMail uses a self-signed certificate.
    MAIL_TLS_REJECT_UNAUTHORIZED: 'false',
    MAIL_ALLOW_INSECURE_TLS: '1',
    ...overrides
  };
}

export async function buildTestApp(
  envOverrides: Record<string, string | undefined> = {},
  opts: Omit<BuildAppOptions, 'env'> = {}
): Promise<FastifyInstance> {
  const app = await buildApp({ clientDist: null, ...opts, env: testEnv(envOverrides) });
  await app.ready();
  return app;
}

/** A minimal cookie jar: one per simulated browser. */
export class Browser {
  cookies = new Map<string, string>();
  constructor(public remoteAddress = '127.0.0.1') {}

  absorb(res: LightMyRequestResponse): void {
    for (const c of res.cookies as Array<{ name: string; value: string; maxAge?: number; expires?: Date }>) {
      const cleared = c.value === '' || c.maxAge === 0 || (c.expires && c.expires.getTime() <= Date.now());
      if (cleared) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export interface SignedIn {
  res: LightMyRequestResponse;
  handle: string;
  browser: Browser;
  /** Headers for an API call as this account: cookie + X-Mailloom-Account. */
  headers: Record<string, string>;
}

export async function signIn(
  app: FastifyInstance,
  email: string,
  opts: { password?: string; rememberMe?: boolean; browser?: Browser; host?: string; proto?: string } = {}
): Promise<SignedIn> {
  const browser = opts.browser ?? new Browser();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/connect',
    remoteAddress: browser.remoteAddress,
    headers: { ...(browser.cookies.size ? { cookie: browser.cookieHeader() } : {}), ...(opts.host ? { host: opts.host } : {}),
      ...(opts.proto ? { 'x-forwarded-proto': opts.proto } : {})
    },
    payload: { email, password: opts.password ?? TEST_PASSWORD, rememberMe: opts.rememberMe ?? false }
  });
  browser.absorb(res);
  const handle = res.statusCode === 200 ? (res.json().account.handle as string) : '';
  return {
    res,
    handle,
    browser,
    get headers() {
      return { cookie: browser.cookieHeader(), 'x-mailloom-account': handle };
    }
  };
}

// ---------------------------------------------------------------
// GreenMail seeding and inspection helpers
// ---------------------------------------------------------------
export async function withImap<T>(email: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({
    host: GM.host,
    port: GM.imapsPort,
    secure: true,
    auth: { user: email, pass: GM.password },
    logger: false,
    tls: { rejectUnauthorized: false }
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout().catch(() => {});
  }
}

/** Create Sent, Drafts, Trash, Junk if missing, and empty every folder. */
export async function resetAccount(email: string): Promise<void> {
  await withImap(email, async (c) => {
    for (const name of ['Sent', 'Drafts', 'Trash', 'Junk']) {
      await c.mailboxCreate(name).catch(() => {});
    }
    for (const mb of await c.list()) {
      if (mb.flags?.has('\Noselect')) continue;
      const lock = await c.getMailboxLock(mb.path);
      try {
        await c.messageDelete('1:*').catch(() => {});
      } finally {
        lock.release();
      }
    }
  });
}

export async function seedMail(opts: {
  from: string;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  text?: string;
  messageId?: string;
  references?: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
}): Promise<void> {
  const t = nodemailer.createTransport({
    host: GM.host,
    port: GM.smtpPort,
    secure: false,
    auth: { user: opts.from, pass: GM.password },
    tls: { rejectUnauthorized: false }
  });
  await t.sendMail({
    from: opts.from,
    to: opts.to,
    cc: opts.cc,
    replyTo: opts.replyTo,
    subject: opts.subject,
    text: opts.text ?? 'seed',
    messageId: opts.messageId,
    references: opts.references,
    attachments: opts.attachments
  });
  t.close();
}

export async function fetchAll(email: string, folder: string): Promise<Array<{ uid: number; mail: ParsedMail; raw: string }>> {
  return withImap(email, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const out: Array<{ uid: number; mail: ParsedMail; raw: string }> = [];
      const exists = typeof c.mailbox === 'object' ? c.mailbox.exists : 0;
      if (exists > 0) {
        for await (const m of c.fetch('1:*', { uid: true, source: true })) {
          out.push({ uid: m.uid, mail: await simpleParser(m.source as Buffer), raw: (m.source as Buffer).toString('utf8') });
        }
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

/** Wait until the folder holds at least n messages (GreenMail delivers asynchronously). */
export async function waitForMail(email: string, folder: string, n = 1, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const all = await fetchAll(email, folder);
    if (all.length >= n || Date.now() > end) return all;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Store a raw RFC 822 message directly in a folder (no SMTP); returns its UID. */
export async function appendRaw(email: string, folder: string, raw: string | Buffer, flags: string[] = []): Promise<number> {
  return withImap(email, async (c) => {
    const r = await c.append(folder, raw, flags);
    if (!r || !r.uid) throw new Error('append failed or gave no uid');
    return r.uid;
  });
}

/** Build a MIME message with nodemailer's composer (attachments, inline cids, alternatives). */
export async function buildMime(opts: Record<string, unknown>): Promise<Buffer> {
  const MailComposer = (await import('nodemailer/lib/mail-composer/index.js')).default;
  return (await new MailComposer({ from: 'colleague@delpat.test', to: 'tester@delpat.test', ...opts } as never).compile().build()) as Buffer;
}
