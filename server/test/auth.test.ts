import { describe, test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { LoginThrottle } from '../src/services/login-throttle.js';
import { getPooledImapClient, closeAllPooledClients, setMaxConnectionAgeMs } from '../src/services/imap.js';
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

  test('MAIL_SMTP_ALLOW_PLAIN is refused unless the SMTP host is loopback', async () => {
    await assert.rejects(
      buildApp({ env: testEnv({ MAIL_SMTP_HOST: 'mail.example.com', MAIL_SMTP_ALLOW_PLAIN: '1' }), clientDist: null }),
      /MAIL_SMTP_ALLOW_PLAIN.*loopback/s
    );
    for (const host of ['127.0.0.1', '127.5.6.7', 'localhost', '::1']) {
      const a = await buildApp({ env: testEnv({ MAIL_SMTP_HOST: host, MAIL_SMTP_ALLOW_PLAIN: '1' }), clientDist: null });
      assert.equal(a.mailloom.config.mail.smtpAllowPlain, true, host);
      await a.close();
    }
  });

  test('MAIL_DOMAINS is required and must hold real domains', async () => {
    await assert.rejects(buildApp({ env: testEnv({ MAIL_DOMAINS: undefined }), clientDist: null }), /MAIL_DOMAINS is not set/);
    await assert.rejects(buildApp({ env: testEnv({ MAIL_DOMAINS: 'not a domain' }), clientDist: null }), /MAIL_DOMAINS entry/);
  });

  test('TRUST_PROXY=true is refused; an IP list or hop count is accepted', async () => {
    for (const bad of ['true', 'yes', '0.0.0.0/0', 'banana']) {
      await assert.rejects(buildApp({ env: testEnv({ TRUST_PROXY: bad }), clientDist: null }), /TRUST_PROXY/, bad);
    }
    for (const good of ['127.0.0.1', '127.0.0.1,10.0.0.0/8', '1', 'loopback', undefined]) {
      const a = await buildApp({ env: testEnv({ TRUST_PROXY: good }), clientDist: null });
      await a.close();
    }
  });

  test('maxMessageBytes defaults to 10 MB and can be set', async () => {
    const a = await buildTestApp();
    assert.equal(a.mailloom.config.maxMessageBytes, 10 * 1024 * 1024);
    await a.close();
    const b = await buildTestApp({ MAIL_MAX_MESSAGE_BYTES: '2048' });
    assert.equal(b.mailloom.config.maxMessageBytes, 2048);
    await b.close();
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
    app = await buildTestApp({ TRUST_PROXY: '127.0.0.1' });
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
    const t = await signIn(app, TESTER, { host: 'mail.delpat.test', proto: 'https' });
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

  test('only Delpat domains may sign in', async () => {
    const t = await signIn(app, 'someone@gmail.com');
    assert.equal(t.res.statusCode, 403);
    assert.equal(t.res.json().error, 'This address is not a Delpat mailbox');
    assert.equal(t.res.cookies.length, 0);
    const upper = await signIn(app, 'TESTER@DELPAT.TEST');
    assert.equal(upper.res.statusCode, 200);
    // A look-alike domain does not pass.
    assert.equal((await signIn(app, 'tester@delpat.test.evil.example')).res.statusCode, 403);
    assert.equal((await signIn(app, 'tester@evil-delpat.test')).res.statusCode, 403);
  });

  test('plain http to a real host is refused instead of pretending to sign in', async () => {
    const res = await signIn(app, TESTER, { host: 'mail.delpat.test' });
    assert.equal(res.res.statusCode, 400);
    assert.equal(res.res.json().code, 'INSECURE_CONNECTION');
    assert.match(res.res.json().error, /https/);
    assert.equal(res.res.cookies.length, 0);
    // Direct plain http from an untrusted address cannot claim https.
    const spoof = await app.inject({
      method: 'POST',
      url: '/api/auth/connect',
      remoteAddress: '10.1.2.3',
      headers: { host: 'mail.delpat.test', 'x-forwarded-proto': 'https' },
      payload: { email: TESTER, password: TEST_PASSWORD }
    });
    assert.equal(spoof.statusCode, 400);
  });

  test('COOKIE_SECURE forces Secure __Host- cookies even on localhost', async () => {
    const secureApp = await buildTestApp({ COOKIE_SECURE: 'true' });
    const t = await signIn(secureApp, TESTER);
    assert.equal(t.res.statusCode, 200);
    const cookie = t.res.cookies[0] as { name: string; secure?: boolean };
    assert.equal(cookie.name, `__Host-mls_${t.handle}`);
    assert.equal(cookie.secure, true);
    await secureApp.close();
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

describe('login throttle', () => {
  test('parallel wrong guesses are counted before the mail server answers', async () => {
    const tapp = await buildTestApp();
    const ip = new Browser('10.8.8.8');
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => signIn(tapp, TESTER, { password: `guess-${i}`, browser: new Browser('10.8.8.8') }))
    );
    const codes = results.map((r) => r.res.statusCode);
    assert.equal(codes.filter((c) => c === 401).length, 5, `codes: ${codes}`);
    assert.equal(codes.filter((c) => c === 429).length, 7, `codes: ${codes}`);
    assert.equal((await signIn(tapp, TESTER, { browser: ip })).res.statusCode, 429);
    await tapp.close();
  });

  test('a right password clears the email+IP count', async () => {
    const tapp = await buildTestApp();
    const b = new Browser('10.8.8.9');
    for (let i = 0; i < 4; i++) await signIn(tapp, TESTER, { password: 'no', browser: b });
    assert.equal((await signIn(tapp, TESTER, { browser: b })).res.statusCode, 200);
    for (let i = 0; i < 4; i++) assert.equal((await signIn(tapp, TESTER, { password: 'no', browser: b })).res.statusCode, 401);
    await tapp.close();
  });

  test('per-IP bucket: 20 failures across mailboxes block that IP', () => {
    let clock = 1_000_000;
    const t = new LoginThrottle(5, 15 * MIN, () => clock, 20, 10);
    for (let i = 0; i < 20; i++) assert.equal(t.begin(`user${i}@delpat.test`, '9.9.9.9'), 0);
    assert.ok(t.begin('fresh@delpat.test', '9.9.9.9') > 0, 'new mailbox from the same IP is blocked');
    assert.equal(t.begin('fresh@delpat.test', '9.9.9.10'), 0, 'another IP is fine');
    clock += 15 * MIN + 1;
    assert.equal(t.begin('fresh@delpat.test', '9.9.9.9'), 0);
  });

  test('per-email bucket: 10 failures from different IPs block that mailbox', () => {
    let clock = 1_000_000;
    const t = new LoginThrottle(5, 15 * MIN, () => clock, 20, 10);
    for (let i = 0; i < 10; i++) assert.equal(t.begin('Victim@delpat.test', `8.8.8.${i}`), 0);
    assert.ok(t.begin('victim@delpat.test', '8.8.8.200') > 0);
    assert.equal(t.begin('other@delpat.test', '8.8.8.200'), 0);
  });

  test('a success does not wipe the IP bucket', () => {
    const t = new LoginThrottle(5, 15 * MIN, () => 1_000_000, 20, 10);
    for (let i = 0; i < 19; i++) t.begin(`u${i}@delpat.test`, '7.7.7.7');
    t.begin('mine@delpat.test', '7.7.7.7');
    t.succeed('mine@delpat.test', '7.7.7.7');
    t.begin('a@delpat.test', '7.7.7.7'); // 20th failure
    assert.ok(t.begin('b@delpat.test', '7.7.7.7') > 0);
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

  test('a connection older than the age cap is replaced', async () => {
    const cfg = base(TEST_PASSWORD, 'age-test');
    const first = await getPooledImapClient(cfg);
    assert.equal(await getPooledImapClient(cfg), first);
    const previous = setMaxConnectionAgeMs(5);
    try {
      await new Promise((r) => setTimeout(r, 20));
      const second = await getPooledImapClient(cfg);
      assert.notEqual(second, first);
      assert.ok(second.usable);
    } finally {
      setMaxConnectionAgeMs(previous);
    }
  });

  test('a failed reconnect throws a recognisable authentication error', async () => {
    await assert.rejects(getPooledImapClient(base('wrong-password', 'auth-fail')), (err: Error) => {
      assert.equal(err.name, 'ImapAuthError');
      return true;
    });
  });
});

describe('mail errors and expired credentials', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildTestApp();
  });
  after(() => app.close());

  test('credentials the mail server no longer accepts end the session with 401 SESSION_EXPIRED', async () => {
    // A session whose stored password is no longer valid (as after a password change).
    const { sessionId, session } = app.mailloom.sessions.create({
      email: TESTER,
      name: 'tester',
      password: 'changed-password',
      isDemo: false,
      remember: false
    });
    const headers = { cookie: `mls_${session.handle}=${sessionId}`, 'x-mailloom-account': session.handle };
    const res = await app.inject({ method: 'GET', url: '/api/mailboxes', headers });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'SESSION_EXPIRED');
    assert.equal(app.mailloom.sessions.resolve(sessionId).status === 'ok', false, 'session is deleted');
    const again = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    assert.equal(again.statusCode, 401);
  });

  test('server errors show a fixed plain message, never the mail server text', async () => {
    const t = await signIn(app, TESTER);
    const res = await app.inject({
      method: 'GET',
      url: `/api/mailboxes/${encodeURIComponent('No/Such/Folder')}/messages`,
      headers: t.headers
    });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: 'Could not load messages' });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/mailboxes/${encodeURIComponent('No/Such/Folder')}/messages/1`,
      headers: t.headers
    });
    assert.equal(detail.statusCode, 500);
    assert.deepEqual(detail.json(), { error: 'Could not load this message' });

    for (const [method, url, payload, message] of [
      ['POST', '/messages/1/flags', { flag: 'isSeen', value: true }, 'Could not update the message'],
      ['POST', '/messages/1/move', { targetFolder: 'INBOX' }, 'Could not move the message'],
      ['DELETE', '/messages/1', undefined, 'Could not delete the message'],
      ['POST', '/messages/1/spam', {}, 'Could not mark the message as spam']
    ] as const) {
      const r = await app.inject({
        method,
        url: `/api/mailboxes/${encodeURIComponent('No/Such/Folder')}${url}`,
        headers: t.headers,
        payload
      });
      assert.equal(r.statusCode, 500, url);
      assert.deepEqual(r.json(), { error: message }, url);
    }
  });

  test('send over plain SMTP is refused unless the server config allows it', async () => {
    const strict = await buildTestApp({ MAIL_SMTP_ALLOW_PLAIN: undefined });
    const t = await signIn(strict, TESTER);
    const res = await strict.inject({
      method: 'POST',
      url: '/api/messages/send',
      headers: t.headers,
      payload: { to: [COLLEAGUE], subject: 'hi', text: 'hello' }
    });
    // The send route answers with SendError's fixed plain message (no server transcript).
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json(), { error: 'The message could not be sent.' });
    await strict.close();

    const t2 = await signIn(app, TESTER);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      headers: t2.headers,
      payload: { to: [COLLEAGUE], subject: 'hi', text: 'hello' }
    });
    assert.equal(ok.statusCode, 200);
  });
});
