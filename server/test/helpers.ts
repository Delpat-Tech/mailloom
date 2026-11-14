/**
 * Shared test helpers: build the app against the local GreenMail and sign in.
 *
 *   const app = await buildTestApp();
 *   const t = await signIn(app, 'tester@delpat.test');
 *   await app.inject({ method: 'GET', url: '/api/mailboxes', headers: t.headers });
 *
 * Ports default to greenmail-a (IMAPS 1993, SMTP 1587); override with
 * GREENMAIL_IMAP_PORT / GREENMAIL_SMTP_PORT (greenmail-b: 2993 / 2587).
 */
import crypto from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type BuildAppOptions } from '../src/app.js';

export const TEST_PASSWORD = 'testpass123';
export const TESTER = 'tester@delpat.test';
export const COLLEAGUE = 'colleague@delpat.test';

export function testEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    MAIL_IMAP_HOST: '127.0.0.1',
    MAIL_IMAP_PORT: process.env.GREENMAIL_IMAP_PORT || '1993',
    MAIL_IMAP_SECURE: 'true',
    MAIL_SMTP_HOST: '127.0.0.1',
    MAIL_SMTP_PORT: process.env.GREENMAIL_SMTP_PORT || '1587',
    MAIL_SMTP_SECURE: 'false',
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
  opts: { password?: string; rememberMe?: boolean; browser?: Browser; host?: string } = {}
): Promise<SignedIn> {
  const browser = opts.browser ?? new Browser();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/connect',
    remoteAddress: browser.remoteAddress,
    headers: { ...(browser.cookies.size ? { cookie: browser.cookieHeader() } : {}), ...(opts.host ? { host: opts.host } : {}) },
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
