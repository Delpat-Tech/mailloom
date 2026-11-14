import { describe, test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { getPooledImapClient, closeAllPooledClients } from '../src/services/imap.js';
import type { AccountConfig } from '../src/types.js';
import { Browser, COLLEAGUE, TESTER, TEST_PASSWORD, buildTestApp, signIn, testEnv } from './helpers.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe('configuration', () => {
  test('refuses to start without SESSION_SECRET or mail host, naming each', async () => {
    await assert.rejects(buildApp({ env: {}, clientDist: null }), (err: Error) => {
      assert.match(err.message, /SESSION_SECRET is not set/);
      assert.match(err.message, /MAIL_IMAP_HOST is not set/);
      assert.match(err.message, /MAIL_SMTP_HOST is not set/);
      return true;
    });
  });

  test('refuses short, placeholder and previously published secrets', async () => {
    for (const secret of [
      'short',
      'bacc858293506b3ea5ffea77f7cb2911e0eccae9124ee1b5780daac20cee8659',
      'roundcube-webmail-secret-encryption-key-32chars!',
      'change-me-change-me-change-me-change-me'
    ]) {
      await assert.rejects(buildApp({ env: testEnv({ SESSION_SECRET: secret }), clientDist: null }), /SESSION_SECRET/);
    }
  });

  test('turning off certificate checks needs the explicit local-testing switch', async () => {
    await assert.rejects(
      buildApp({ env: testEnv({ MAIL_ALLOW_INSECURE_TLS: undefined }), clientDist: null }),
      /MAIL_ALLOW_INSECURE_TLS/
    );
  });

  test('demo login is off by default', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/connect', payload: { isDemo: true } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'DEMO_DISABLED');
    await app.close();
  });
});

describe('CORS and origin checks', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildTestApp({ CORS_ORIGINS: 'https://allowed.example' });
  });
  after(() => app.close());

  test('refuses API calls from other origins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/connect',
      headers: { origin: 'https://evil.example', host: 'localhost:3000' },
      payload: { email: TESTER, password: TEST_PASSWORD }
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'ORIGIN_NOT_ALLOWED');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.cookies.length, 0);
  });

  test('refuses preflight from other origins', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/logout',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', host: 'localhost:3000' }
    });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.notEqual(res.statusCode, 204);
  });

  test('allows same origin and listed origins', async () => {
    const same = await app.inject({
      method: 'POST',
      url: '/api/auth/connect',
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
      payload: {}
    });
    assert.equal(same.statusCode, 400); // reached the route (input check), not blocked
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/logout',
      headers: { origin: 'https://allowed.example', 'access-control-request-method': 'POST', host: 'localhost:3000' }
    });
    assert.equal(pre.headers['access-control-allow-origin'], 'https://allowed.example');
    assert.equal(pre.headers['access-control-allow-credentials'], 'true');
  });
});

describe('sign-in', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildTestApp();
  });
  after(() => app.close());

  test('good password: session cookie only, no secret in the body', async () => {
    const t = await signIn(app, TESTER);
    assert.equal(t.res.statusCode, 200);
    const body = t.res.json();
    assert.equal(body.account.email, TESTER);
    assert.match(body.account.handle, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(body.token, undefined);
    assert.ok(!t.res.body.includes(TEST_PASSWORD));
    const cookie = t.res.cookies[0] as { name: string; value: string; httpOnly?: boolean; sameSite?: string; secure?: boolean; path?: string };
    assert.equal(cookie.name, `mls_${body.account.handle}`);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Strict');
    assert.equal(cookie.path, '/');
    assert.ok(!cookie.secure, 'no Secure flag on localhost');
    assert.ok(cookie.value.length >= 40);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: t.headers });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().account.email, TESTER);
    assert.ok(!me.body.includes(TEST_PASSWORD));
    assert.equal(me.json().account.imapHost, undefined);
  });

  test('off localhost the cookie is Secure and __Host- prefixed', async () => {
    const t = await signIn(app, TESTER, { host: 'mail.delpat.test' });
    assert.equal(t.res.statusCode, 200);
    const cookie = t.res.cookies[0] as { name: string; secure?: boolean };
    assert.equal(cookie.name, `__Host-mls_${t.handle}`);
    assert.equal(cookie.secure, true);
  });

  test('wrong password: plain message, no IMAP text', async () => {
    const t = await signIn(app, TESTER, { password: 'wrong-password', browser: new Browser('10.0.0.1') });
    assert.equal(t.res.statusCode, 401);
    assert.deepEqual(t.res.json(), { error: 'Wrong email or password.', code: 'BAD_CREDENTIALS' });
    assert.equal(t.res.cookies.length, 0);
  });

  test('missing fields: 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/connect', payload: { email: TESTER } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'INVALID_INPUT');
  });

  test('host/port in the request body are ignored', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/connect',
      payload: { email: TESTER, password: TEST_PASSWORD, imapHost: '203.0.113.9', imapPort: 1, smtpHost: '203.0.113.9' }
    });
    assert.equal(res.statusCode, 200);
  });

  test('mail server down: "Mail server unreachable"', async () => {
    const down = await buildTestApp({ MAIL_IMAP_PORT: '1' });
    const t = await signIn(down, TESTER);
    assert.equal(t.res.statusCode, 503);
    assert.equal(t.res.json().code, 'MAIL_SERVER_UNREACHABLE');
    assert.match(t.res.json().error, /^Mail server unreachable/);
    await down.close();
  });

  test('throttled after 5 failures per user+IP for 15 minutes', async () => {
    let clock = Date.now();
    const tapp = await buildTestApp({}, { now: () => clock });
    const ip = new Browser('10.9.9.9');
    for (let i = 0; i < 5; i++) {
      const bad = await signIn(tapp, TESTER, { password: `nope-${i}`, browser: ip });
      assert.equal(bad.res.statusCode, 401);
    }
    const blocked = await signIn(tapp, TESTER, { browser: ip }); // even with the right password
    assert.equal(blocked.res.statusCode, 429);
    assert.equal(blocked.res.json().code, 'TOO_MANY_ATTEMPTS');
    assert.match(blocked.res.json().error, /Try again in 15 minutes/);
    assert.ok(Number(blocked.res.headers['retry-after']) > 0);

    // Another IP and another user are unaffected.
    assert.equal((await signIn(tapp, TESTER, { browser: new Browser('10.9.9.10') })).res.statusCode, 200);
    assert.equal((await signIn(tapp, COLLEAGUE, { browser: new Browser('10.9.9.9') })).res.statusCode, 200);

    clock += 15 * MIN + 1000;
    assert.equal((await signIn(tapp, TESTER, { browser: ip })).res.statusCode, 200);
    await tapp.close();
  });
});

describe('sessions', () => {
  let app: FastifyInstance;
  let clock = Date.now();
  before(async () => {
    app = await buildTestApp({}, { now: () => clock });
  });
  after(() => app.close());

  const me = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/auth/me', headers });

  test('forged session id gets 401 while the same user is signed in elsewhere', async () => {
    const real = await signIn(app, TESTER);
    assert.equal((await me(real.headers)).statusCode, 200);
    // Warm the real session's IMAP connection.
    assert.equal((await app.inject({ method: 'GET', url: '/api/mailboxes', headers: real.headers })).statusCode, 200);

    const forgedId = crypto.randomBytes(32).toString('base64url');
    const forged = { cookie: `mls_${real.handle}=${forgedId}`, 'x-mailloom-account': real.handle };
    const res = await app.inject({ method: 'GET', url: '/api/mailboxes', headers: forged });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'SESSION_EXPIRED');

    // An old-style token (encrypted password) is not accepted either.
    const legacy = await app.inject({ method: 'GET', url: '/api/mailboxes', headers: { authorization: 'Bearer aa:bb:cc' } });
    assert.equal(legacy.statusCode, 401);
    assert.equal(legacy.json().code, 'NOT_SIGNED_IN');

    // A real session id presented under another account's handle is refused.
    const other = await signIn(app, COLLEAGUE);
    const swapped = { cookie: `mls_${other.handle}=${real.browser.cookies.get(`mls_${real.handle}`)}`, 'x-mailloom-account': other.handle };
    assert.equal((await me(swapped)).statusCode, 401);
  });

  test('sign-out ends only that session; signed-out id gets 401, other device keeps working', async () => {
    const phone = await signIn(app, TESTER);
    const laptop = await signIn(app, TESTER);
    const oldCookie = phone.headers;

    // Sign-out with no body and no Content-Type (what the fixed client sends).
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: phone.headers });
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.json(), { success: true });
    assert.ok(out.cookies.some((c) => c.name === `mls_${phone.handle}` && c.value === ''));

    const again = await me(oldCookie);
    assert.equal(again.statusCode, 401);
    assert.equal(again.json().code, 'SESSION_EXPIRED');

    assert.equal((await me(laptop.headers)).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/mailboxes', headers: laptop.headers })).statusCode, 200);
  });

  test('sign-out and DELETE with an empty JSON body are not rejected', async () => {
    const t = await signIn(app, TESTER);
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/mailboxes/INBOX/messages/999999',
      headers: { ...t.headers, 'content-type': 'application/json' },
      payload: ''
    });
    assert.notEqual(del.json().code, 'FST_ERR_CTP_EMPTY_JSON_BODY');
    assert.notEqual(del.statusCode, 401);
    const delNoType = await app.inject({ method: 'DELETE', url: '/api/mailboxes/INBOX/messages/999999', headers: t.headers });
    assert.notEqual(delNoType.statusCode, 400);

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...t.headers, 'content-type': 'application/json' },
      payload: ''
    });
    assert.equal(out.statusCode, 200);
  });

  test('state-changing calls need the account header; ?account= only works for GET', async () => {
    const t = await signIn(app, TESTER);
    const get = await app.inject({ method: 'GET', url: `/api/auth/me?account=${t.handle}`, headers: { cookie: t.headers.cookie } });
    assert.equal(get.statusCode, 200);
    const post = await app.inject({
      method: 'POST',
      url: `/api/mailboxes/INBOX/messages/1/flags?account=${t.handle}`,
      headers: { cookie: t.headers.cookie },
      payload: { flag: 'isSeen', value: true }
    });
    assert.equal(post.statusCode, 401);
  });

  test('two accounts in one browser each use their own session', async () => {
    const browser = new Browser();
    const a = await signIn(app, TESTER, { browser });
    const b = await signIn(app, COLLEAGUE, { browser });
    assert.equal(browser.cookies.size, 2);
    const asA = await app.inject({ method: 'GET', url: `/api/auth/me?account=${a.handle}`, headers: { cookie: browser.cookieHeader() } });
    const asB = await app.inject({ method: 'GET', url: `/api/auth/me?account=${b.handle}`, headers: { cookie: browser.cookieHeader() } });
    assert.equal(asA.json().account.email, TESTER);
    assert.equal(asB.json().account.email, COLLEAGUE);

    const list = await app.inject({ method: 'GET', url: '/api/auth/accounts', headers: { cookie: browser.cookieHeader() } });
    assert.deepEqual(list.json().accounts.map((x: { email: string }) => x.email).sort(), [COLLEAGUE, TESTER]);

    // Signing out of B leaves A signed in in the same browser.
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: browser.cookieHeader(), 'x-mailloom-account': b.handle } });
    browser.absorb(out);
    assert.equal(browser.cookies.size, 1);
    const stillA = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: browser.cookieHeader(), 'x-mailloom-account': a.handle } });
    assert.equal(stillA.statusCode, 200);

    // Signing in again to the same account replaces its session rather than adding a second one.
    const a2 = await signIn(app, TESTER, { browser });
    assert.equal(browser.cookies.size, 1);
    const oldA = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `mls_${a.handle}=${'x'.repeat(43)}`, 'x-mailloom-account': a.handle } });
    assert.equal(oldA.statusCode, 401);
    assert.equal((await me(a2.headers)).statusCode, 200);
  });

  test('without Remember Me: browser-session cookie, ends after 30 idle minutes, 12 h at most', async () => {
    clock = Date.now();
    const t = await signIn(app, TESTER, { rememberMe: false });
    const cookie = t.res.cookies[0] as { maxAge?: number; expires?: Date };
    assert.equal(cookie.maxAge, undefined);
    assert.equal(cookie.expires, undefined);

    // Activity every 20 minutes keeps it alive...
    for (let i = 0; i < 5; i++) {
      clock += 20 * MIN;
      assert.equal((await me(t.headers)).statusCode, 200, `still alive after ${(i + 1) * 20} min of activity`);
    }
    // ...but 31 idle minutes end it.
    clock += 31 * MIN;
    const res = await me(t.headers);
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'SESSION_EXPIRED');

    // Absolute cap: even with constant activity, 12 hours after sign-in it ends.
    const u = await signIn(app, TESTER, { rememberMe: false });
    const start = clock;
    while (clock - start < 12 * 60 * MIN - 20 * MIN) {
      clock += 20 * MIN;
      assert.equal((await me(u.headers)).statusCode, 200);
    }
    clock = start + 12 * 60 * MIN + 1;
    assert.equal((await me(u.headers)).statusCode, 401);
  });

  test('with Remember Me: 30-day cookie and session, even when idle', async () => {
    clock = Date.now();
    const t = await signIn(app, TESTER, { rememberMe: true });
    const cookie = t.res.cookies[0] as { maxAge?: number };
    assert.equal(cookie.maxAge, 30 * 24 * 3600);
    assert.equal(Date.parse(t.res.json().account.expiresAt), clock + 30 * DAY);
    assert.equal(t.res.json().account.rememberMe, true);

    clock += 29 * DAY;
    assert.equal((await me(t.headers)).statusCode, 200);
    clock += DAY;
    const res = await me(t.headers);
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'SESSION_EXPIRED');
  });
});

describe('session store on disk', () => {
  test('sessions survive a restart; a changed SESSION_SECRET ends them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailloom-sessions-'));
    const dbPath = path.join(dir, 'sessions.db');
    const secret = crypto.randomBytes(32).toString('hex');

    const first = await buildTestApp({ SESSION_DB_PATH: dbPath, SESSION_SECRET: secret });
    const t = await signIn(first, TESTER, { rememberMe: true });
    assert.equal(t.res.statusCode, 200);
    await first.close();

    const second = await buildTestApp({ SESSION_DB_PATH: dbPath, SESSION_SECRET: secret });
    assert.equal((await second.inject({ method: 'GET', url: '/api/mailboxes', headers: t.headers })).statusCode, 200);
    await second.close();

    const raw = fs.readFileSync(dbPath);
    assert.ok(!raw.includes(Buffer.from(TEST_PASSWORD)), 'password is not stored in clear');
    assert.ok(!raw.includes(Buffer.from(t.browser.cookies.get(`mls_${t.handle}`)!)), 'session id is not stored');

    const rotated = await buildTestApp({ SESSION_DB_PATH: dbPath });
    assert.equal((await rotated.inject({ method: 'GET', url: '/api/auth/me', headers: t.headers })).statusCode, 401);
    await rotated.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('IMAP connection pool', () => {
  after(() => closeAllPooledClients());
  const base = (pass: string, sessionKey?: string): AccountConfig => ({
    email: TESTER,
    imapHost: '127.0.0.1',
    imapPort: Number(process.env.GREENMAIL_IMAP_PORT || 1993),
    imapSecure: true,
    imapUser: TESTER,
    imapPass: pass,
    smtpHost: '127.0.0.1',
    smtpPort: 1587,
    smtpSecure: false,
    tls: { rejectUnauthorized: false },
    sessionKey
  });

  test('concurrent requests for one session share a single connection', async () => {
    const cfg = base(TEST_PASSWORD, 'race-test');
    const [a, b, c] = await Promise.all([getPooledImapClient(cfg), getPooledImapClient(cfg), getPooledImapClient(cfg)]);
    assert.equal(a, b);
    assert.equal(b, c);
  });

  test('different sessions of the same user get different connections', async () => {
    const one = await getPooledImapClient(base(TEST_PASSWORD, 'session-one'));
    const two = await getPooledImapClient(base(TEST_PASSWORD, 'session-two'));
    assert.notEqual(one, two);
  });

  test('a wrong password never rides a warm connection of the same user', async () => {
    await getPooledImapClient(base(TEST_PASSWORD));
    await assert.rejects(getPooledImapClient(base('wrong-password')));
  });
});
