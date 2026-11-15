import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, signIn, testEnv, TESTER, COLLEAGUE, TEST_PASSWORD, type SignedIn } from './helpers.js';
import { buildApp } from '../src/app.js';
import { loadAgentConfig } from '../src/agent/config.js';
import { encryptMailboxPassword, hashAgentKey, agentKeyPrefix, newAgentKey } from '../src/agent/crypto.js';
import { AgentStore } from '../src/agent/store.js';

/**
 * Connect Mailloom (OAuth authorization code + PKCE for Work OS), against the local GreenMail.
 * The app clock is a variable so codes, requests and rate limits can be aged without waiting.
 */

const SECRET = 'connect-secret-' + 'x'.repeat(30);
const CLIENT_ID = 'work-os';
const REDIRECT = 'https://os.example/api/mail/callback';
const LOCAL_REDIRECT = 'http://localhost:4000/api/mail/callback';
const PUBLIC_URL = 'https://mail.example.test/mail';
const ENV = {
  MAILLOOM_PUBLIC_URL: PUBLIC_URL,
  AGENT_ALLOWED_IPS: '127.0.0.1',
  AGENT_CLIENT_ID: CLIENT_ID,
  AGENT_CLIENT_SECRET: SECRET,
  AGENT_CLIENT_REDIRECT_URIS: `${REDIRECT},${LOCAL_REDIRECT}`
};

let clock = Date.now();
const now = () => clock;
const advance = (ms: number) => {
  clock += ms;
};

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeQuery(p: ReturnType<typeof pkce>, over: Record<string, string | undefined> = {}) {
  const q: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: 'read organise send',
    state: 'state-' + crypto.randomBytes(8).toString('hex'),
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    label: 'Delpat',
    ...over
  };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) sp.set(k, v);
  return sp.toString();
}

async function authorize(app: FastifyInstance, p: ReturnType<typeof pkce>, over: Record<string, string | undefined> = {}, prefix = '') {
  const withState = { state: 'state-' + crypto.randomBytes(8).toString('hex'), ...over };
  const res = await app.inject({ method: 'GET', url: `${prefix}/oauth/authorize?${authorizeQuery(p, withState)}` });
  const loc = String(res.headers.location ?? '');
  const id = /#\/connect\/([A-Za-z0-9_.-]+)$/.exec(loc)?.[1];
  return { res, id, state: withState.state! };
}

function consent(app: FastifyInstance, t: SignedIn | null, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/oauth/consent',
    headers: { ...(t ? t.headers : {}), ...headers },
    payload: body
  });
}

/** Authorise + Allow; returns the code from the redirect. */
async function grant(
  app: FastifyInstance,
  t: SignedIn,
  p: ReturnType<typeof pkce>,
  opts: { scopes?: string[]; password?: string; authz?: Record<string, string | undefined> } = {}
) {
  const a = await authorize(app, p, opts.authz);
  assert.equal(a.res.statusCode, 302, 'authorize redirects to the consent screen');
  const res = await consent(app, t, { request_id: a.id, allow: true, scopes: opts.scopes ?? ['read', 'organise', 'send'], password: opts.password ?? TEST_PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  const url = new URL(res.json().redirect);
  return { code: url.searchParams.get('code')!, url, state: a.state, res };
}

function token(app: FastifyInstance, body: Record<string, unknown>, opts: { form?: boolean; remoteAddress?: string; headers?: Record<string, string>; prefix?: string } = {}) {
  const base = { grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: SECRET, redirect_uri: REDIRECT, ...body };
  return app.inject({
    method: 'POST',
    url: `${opts.prefix ?? ''}/api/agent/v1/oauth/token`,
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
    headers: {
      ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...opts.headers
    },
    payload: opts.form ? new URLSearchParams(base as Record<string, string>).toString() : base
  });
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe('Connect Mailloom', () => {
  let app: FastifyInstance;
  let t: SignedIn;
  const logs: string[] = [];

  before(async () => {
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logs.push(chunk.toString());
        cb();
      }
    });
    app = await buildTestApp({ ...ENV, DEMO_MODE: '1' }, { now, logger: { level: 'info', stream } });
    t = await signIn(app, TESTER);
    assert.equal(t.res.statusCode, 200);
  });
  after(async () => {
    await app.close();
  });
  // Each test starts a fresh minute, so the per-address limits of earlier tests do not leak into later ones.
  beforeEach(() => advance(61_000));

  test('authorize: unknown client or redirect shows an error page and never redirects', async () => {
    const p = pkce();
    for (const over of [
      { client_id: 'someone-else' },
      { client_id: undefined },
      { redirect_uri: 'https://evil.example/cb' },
      { redirect_uri: REDIRECT + '/' },
      { redirect_uri: REDIRECT + '?x=1' },
      { redirect_uri: undefined },
      { redirect_uri: 'http://os.example/api/mail/callback' }
    ]) {
      const res = await app.inject({ method: 'GET', url: `/oauth/authorize?${authorizeQuery(p, over)}` });
      assert.equal(res.statusCode, 400, JSON.stringify(over));
      assert.equal(res.headers.location, undefined, 'no redirect');
      assert.match(String(res.headers['content-type']), /text\/html/);
      assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.doesNotMatch(res.body, /evil\.example|someone-else/, 'nothing the caller sent is echoed');
    }
    // A repeated parameter is not a string: refused as well.
    const dup = await app.inject({ method: 'GET', url: `/oauth/authorize?${authorizeQuery(p)}&client_id=other` });
    assert.equal(dup.statusCode, 400);
    assert.equal(dup.headers.location, undefined);
  });

  test('authorize: only S256 and a valid request are accepted', async () => {
    const p = pkce();
    for (const over of [
      { code_challenge_method: 'plain' },
      { code_challenge_method: undefined },
      { code_challenge: 'short' },
      { code_challenge: undefined },
      { response_type: 'token' },
      { state: undefined },
      { scope: 'read admin' },
      { scope: '' },
      { scope: undefined },
      { label: 'x'.repeat(200) }
    ]) {
      const res = await app.inject({ method: 'GET', url: `/oauth/authorize?${authorizeQuery(p, over)}` });
      assert.equal(res.statusCode, 400, JSON.stringify(over));
      assert.equal(res.headers.location, undefined);
    }
    // A subset of the three scopes is fine.
    const ok = await authorize(app, p, { scope: 'read' });
    assert.equal(ok.res.statusCode, 302);
  });

  test('authorize: redirects to the consent screen at the public address (under / and /mail), storing nothing', async () => {
    const p = pkce();
    const db = app.mailloom.sessions.database;
    const before = JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all());
    for (const prefix of ['', '/mail']) {
      const a = await authorize(app, p, {}, prefix);
      assert.equal(a.res.statusCode, 302);
      const loc = String(a.res.headers.location);
      assert.ok(loc.startsWith(`${PUBLIC_URL}/#/connect/`), loc);
      assert.ok(loc.length < 800, `the link stays short (${loc.length} characters)`);
      assert.match(String(a.res.headers['cache-control']), /no-store/);
    }
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM agent_auth_used').get() as { n: number }).n), 0, 'nothing is stored at authorize');
    assert.equal(JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()), before);
  });

  test('authorize cannot be used to fill the database or lock others out: 50 requests all succeed', async () => {
    for (let i = 0; i < 50; i++) assert.equal((await authorize(app, pkce())).res.statusCode, 302);
  });

  test('the request blob is signed: a changed or foreign blob is refused', async () => {
    const a = await authorize(app, pkce());
    const [payload, sig] = a.id!.split('.');
    const forged = Buffer.from(JSON.stringify(['work-os', 'https://evil.example/cb', 'read', 's', 'c'.repeat(43), null, clock, clock + 600000])).toString('base64url');
    for (const bad of [`${forged}.${sig}`, `${payload}.${sig!.slice(0, -2)}AA`, payload!, `${payload}.`, '.', `${payload}.${sig}.x`]) {
      assert.equal((await app.inject({ method: 'GET', url: `/api/oauth/requests?request=${encodeURIComponent(bad)}`, headers: t.headers })).statusCode, 404);
      assert.equal((await consent(app, t, { request_id: bad, allow: true, scopes: ['read'], password: TEST_PASSWORD })).statusCode, 404);
    }
    // A blob made by another Mailloom (another SESSION_SECRET) is not accepted either.
    const other = await buildTestApp(ENV, { now });
    try {
      const o = await authorize(other, pkce());
      assert.equal((await app.inject({ method: 'GET', url: `/api/oauth/requests?request=${o.id}`, headers: t.headers })).statusCode, 404);
    } finally {
      await other.close();
    }
    assert.equal((await app.inject({ method: 'GET', url: `/api/oauth/requests?request=${a.id}`, headers: t.headers })).statusCode, 200);
  });

  test('an answered request is remembered by hash until it would have expired, then forgotten', async () => {
    const a = await authorize(app, pkce());
    assert.equal((await consent(app, t, { request_id: a.id, allow: false })).statusCode, 200);
    const db = app.mailloom.sessions.database;
    const rows = db.prepare('SELECT blob_hash FROM agent_auth_used').all() as Array<{ blob_hash: string }>;
    assert.ok(rows.some((r) => r.blob_hash === crypto.createHash('sha256').update(a.id!).digest('hex')));
    assert.ok(!JSON.stringify(rows).includes(a.id!.slice(0, 20)), 'only a hash is kept');
    advance(11 * 60_000);
    app.mailloomConnect.prune();
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM agent_auth_used').get() as { n: number }).n), 0);
  });

  test('request details need a session; expired or unknown requests are 404', async () => {
    const p = pkce();
    const a = await authorize(app, p);
    const anon = await app.inject({ method: 'GET', url: `/api/oauth/requests?request=${a.id}` });
    assert.equal(anon.statusCode, 401);
    const ok = await app.inject({ method: 'GET', url: `/api/oauth/requests?request=${a.id}`, headers: t.headers });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json().scopes, ['read', 'organise', 'send']);
    assert.equal(ok.json().label, 'Delpat');
    assert.equal(ok.json().client_name, 'Work OS');
    assert.equal(ok.json().redirect_host, 'os.example');
    assert.equal((await app.inject({ method: 'GET', url: '/api/oauth/requests?request=nope', headers: t.headers })).statusCode, 404);
    advance(10 * 60_000 + 1000);
    assert.equal((await app.inject({ method: 'GET', url: `/api/oauth/requests?request=${a.id}`, headers: t.headers })).statusCode, 404);
    const late = await consent(app, t, { request_id: a.id, allow: true, scopes: ['read'], password: TEST_PASSWORD });
    assert.equal(late.statusCode, 404);
  });

  test('consent needs a session and the account header (CSRF guard)', async () => {
    const a = await authorize(app, pkce());
    const body = { request_id: a.id, allow: true, scopes: ['read'], password: TEST_PASSWORD };
    assert.equal((await consent(app, null, body)).statusCode, 401, 'no cookie');
    assert.equal((await consent(app, t, body, { 'x-mailloom-account': '' })).statusCode, 401, 'cookie without the account header');
    const cookieOnly = await app.inject({ method: 'POST', url: '/api/oauth/consent', headers: { cookie: t.browser.cookieHeader() }, payload: body });
    assert.equal(cookieOnly.statusCode, 401);
    const crossSite = await consent(app, t, body, { origin: 'https://evil.example' });
    assert.equal(crossSite.statusCode, 403);
    // The request is still there after all of that.
    assert.equal((await app.inject({ method: 'GET', url: `/api/oauth/requests?request=${a.id}`, headers: t.headers })).statusCode, 200);
  });

  test('consent: a wrong or missing password does not use the request up; the right one works once', async () => {
    const a = await authorize(app, pkce());
    const wrong = await consent(app, t, { request_id: a.id, allow: true, scopes: ['read'], password: 'nope' });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().code, 'WRONG_PASSWORD');
    const none = await consent(app, t, { request_id: a.id, allow: true, scopes: ['read'] });
    assert.equal(none.statusCode, 400);
    const ok = await consent(app, t, { request_id: a.id, allow: true, scopes: ['read'], password: TEST_PASSWORD });
    assert.equal(ok.statusCode, 200);
    const again = await consent(app, t, { request_id: a.id, allow: true, scopes: ['read'], password: TEST_PASSWORD });
    assert.equal(again.statusCode, 404, 'a request can be answered only once');
  });

  test('consent: wrong passwords are throttled', async () => {
    const other = await buildTestApp(ENV, { now });
    try {
      const c = await signIn(other, COLLEAGUE);
      const a = await authorize(other, pkce());
      let last = 0;
      for (let i = 0; i < 8; i++) {
        last = (await consent(other, c, { request_id: a.id, allow: true, scopes: ['read'], password: 'wrong' + i })).statusCode;
        if (last === 429) break;
      }
      assert.equal(last, 429, 'the sign-in throttle applies');
      const rightButLocked = await consent(other, c, { request_id: a.id, allow: true, scopes: ['read'], password: TEST_PASSWORD });
      assert.equal(rightButLocked.statusCode, 429);
    } finally {
      await other.close();
    }
  });

  test('consent: scopes are only what was asked and ticked; read cannot be unticked', async () => {
    const a = await authorize(app, pkce(), { scope: 'read send' });
    const post = (scopes: unknown) => consent(app, t, { request_id: a.id, allow: true, scopes, password: TEST_PASSWORD });
    assert.equal((await post(['read', 'organise'])).statusCode, 400, 'organise was not asked for');
    assert.equal((await post(['send'])).statusCode, 400, 'read unticked');
    assert.equal((await post([])).statusCode, 400);
    assert.equal((await post('read')).statusCode, 400);
    assert.equal((await post(['read', 7])).statusCode, 400);
    assert.equal((await post(['read'])).statusCode, 200, 'a subset that keeps read is fine');
  });

  test('consent: the demo account is refused', async () => {
    const demo = await app.inject({ method: 'POST', url: '/api/auth/connect', payload: { isDemo: true } });
    assert.equal(demo.statusCode, 200);
    const handle = demo.json().account.handle as string;
    const cookies = (demo.cookies as Array<{ name: string; value: string }>).map((c) => `${c.name}=${c.value}`).join('; ');
    const a = await authorize(app, pkce());
    const res = await app.inject({
      method: 'POST',
      url: '/api/oauth/consent',
      headers: { cookie: cookies, 'x-mailloom-account': handle },
      payload: { request_id: a.id, allow: true, scopes: ['read'], password: 'demo' }
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'DEMO_ACCOUNT');
  });

  test('Cancel returns access_denied with the state and uses the request up', async () => {
    const a = await authorize(app, pkce());
    const res = await consent(app, t, { request_id: a.id, allow: false });
    assert.equal(res.statusCode, 200);
    const url = new URL(res.json().redirect);
    assert.equal(url.origin + url.pathname, REDIRECT);
    assert.equal(url.searchParams.get('error'), 'access_denied');
    assert.equal(url.searchParams.get('state'), a.state);
    assert.equal(url.searchParams.get('code'), null);
    assert.equal((await consent(app, t, { request_id: a.id, allow: false })).statusCode, 404);
  });

  test('full flow: Allow gives a redirect with code, state and iss; the token swap mints a working key', async () => {
    const p = pkce();
    const g = await grant(app, t, p, { scopes: ['read', 'send'] });
    assert.equal(g.url.origin + g.url.pathname, REDIRECT);
    assert.equal(g.url.searchParams.get('state'), g.state);
    assert.equal(g.url.searchParams.get('iss'), PUBLIC_URL, 'iss is the configured public address');
    assert.match(g.code, /^[A-Za-z0-9_-]{43}$/);

    // The code is stored hashed, the password sealed: neither appears in the database.
    const db = app.mailloom.sessions.database;
    const dump = JSON.stringify(db.prepare('SELECT * FROM agent_auth_codes').all());
    assert.ok(!dump.includes(g.code), 'plain code is not stored');
    assert.ok(!dump.includes(TEST_PASSWORD), 'mailbox password is not stored in the clear');
    assert.ok(dump.includes(crypto.createHash('sha256').update(g.code).digest('hex')), 'its hash is');

    const res = await token(app, { code: g.code, code_verifier: p.verifier });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers['cache-control']), /no-store/);
    const out = res.json();
    assert.deepEqual(Object.keys(out).sort(), ['email', 'key', 'key_id', 'prefix', 'scopes']);
    assert.match(out.key, /^mlk_/);
    assert.equal(out.email, TESTER);
    assert.deepEqual(out.scopes, ['read', 'send']);
    assert.equal(out.prefix, out.key.slice(0, 12));

    const who = await app.inject({ method: 'GET', url: '/api/agent/v1/whoami', headers: bearer(out.key) });
    assert.equal(who.statusCode, 200);
    assert.equal(who.json().email, TESTER);
    assert.deepEqual(who.json().key.scopes, ['read', 'send']);

    // Connections shows the client and label, and Revoke works as for any key.
    const list = await app.inject({ method: 'GET', url: '/api/connections/keys', headers: t.headers });
    const rec = list.json().keys.find((k: { id: string }) => k.id === out.key_id);
    assert.equal(rec.client_id, CLIENT_ID);
    assert.equal(rec.label, 'Delpat');
    assert.equal(rec.name, 'Work OS');
    const audit = await app.inject({ method: 'GET', url: '/api/connections/audit', headers: t.headers });
    assert.ok(audit.json().entries.some((e: { tool: string; key_prefix: string }) => e.tool === 'oauth_connect' && e.key_prefix === out.prefix));
    const rv = await app.inject({ method: 'POST', url: `/api/connections/keys/${out.key_id}/revoke`, headers: t.headers });
    assert.equal(rv.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/agent/v1/whoami', headers: bearer(out.key) })).statusCode, 401);
  });

  test('token works form-encoded, under /mail, and the key can revoke itself (once)', async () => {
    const p = pkce();
    const g = await grant(app, t, p);
    const res = await token(app, { code: g.code, code_verifier: p.verifier }, { form: true, prefix: '/mail' });
    assert.equal(res.statusCode, 200, res.body);
    const key = res.json().key as string;
    const rv = await app.inject({ method: 'POST', url: '/api/agent/v1/key/revoke', headers: bearer(key) });
    assert.equal(rv.statusCode, 200);
    assert.equal(rv.json().revoked, true);
    assert.match(String(rv.headers['cache-control']), /no-store/);
    const after = await app.inject({ method: 'GET', url: '/api/agent/v1/whoami', headers: bearer(key) });
    assert.equal(after.statusCode, 401);
    assert.equal(after.json().code, 'KEY_REVOKED');
    assert.equal((await app.inject({ method: 'POST', url: '/api/agent/v1/key/revoke', headers: bearer(key) })).statusCode, 401, 'already revoked');
    assert.equal((await app.inject({ method: 'POST', url: '/api/agent/v1/key/revoke' })).statusCode, 401, 'needs a key');
    // Self-revoke sits under the IP check like every agent call.
    const other = await app.inject({ method: 'POST', url: '/mail/api/agent/v1/key/revoke', remoteAddress: '8.8.8.8', headers: bearer(key) });
    assert.equal(other.statusCode, 403);
  });

  test('a broken key can still revoke itself, and only that', async () => {
    const p = pkce();
    const made = (await token(app, { code: (await grant(app, t, p)).code, code_verifier: p.verifier })).json();
    const key = made.key as string;
    app.mailloomAgent.store.markBroken(made.key_id, 'test: password changed');
    const who = await app.inject({ method: 'GET', url: '/api/agent/v1/whoami', headers: bearer(key) });
    assert.equal(who.statusCode, 403);
    assert.equal(who.json().code, 'KEY_BROKEN');
    const folders = await app.inject({ method: 'GET', url: '/api/agent/v1/folders', headers: bearer(key) });
    assert.equal(folders.statusCode, 403, 'other routes still refuse a broken key');
    const rv = await app.inject({ method: 'POST', url: '/api/agent/v1/key/revoke', headers: bearer(key) });
    assert.equal(rv.statusCode, 200, rv.body);
    const after = await app.inject({ method: 'GET', url: '/api/agent/v1/whoami', headers: bearer(key) });
    assert.equal(after.statusCode, 401);
    assert.equal(after.json().code, 'KEY_REVOKED');
    assert.ok(app.mailloomAgent.store.getRecord(made.key_id)?.revokedAt, 'revoked, not just refused');
  });

  test('self-revoke closes only its own key', async () => {
    const p1 = pkce();
    const p2 = pkce();
    const k1 = (await token(app, { code: (await grant(app, t, p1)).code, code_verifier: p1.verifier })).json().key as string;
    const k2 = (await token(app, { code: (await grant(app, t, p2)).code, code_verifier: p2.verifier })).json().key as string;
    assert.equal((await app.inject({ method: 'POST', url: '/api/agent/v1/key/revoke', headers: bearer(k1) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/agent/v1/whoami', headers: bearer(k2) })).statusCode, 200);
  });

  test('token: wrong verifier is refused and the code is burned', async () => {
    const p = pkce();
    const g = await grant(app, t, p);
    const wrong = await token(app, { code: g.code, code_verifier: pkce().verifier });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().error, 'invalid_grant');
    const right = await token(app, { code: g.code, code_verifier: p.verifier });
    assert.equal(right.statusCode, 400, 'a code that failed once cannot be tried again');
  });

  test('token: a verifier for a plain-PKCE style (challenge == verifier) cannot be used', async () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    // A client that sends the verifier itself as the challenge still gets S256 checked.
    const g = await grant(app, t, { verifier, challenge: verifier });
    const res = await token(app, { code: g.code, code_verifier: verifier });
    assert.equal(res.statusCode, 400);
  });

  test('token: a code older than 60 seconds is refused', async () => {
    const p = pkce();
    const g = await grant(app, t, p);
    advance(61_000);
    const res = await token(app, { code: g.code, code_verifier: p.verifier });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_grant');
    // 59 seconds is still fine.
    const p2 = pkce();
    const g2 = await grant(app, t, p2);
    advance(59_000);
    assert.equal((await token(app, { code: g2.code, code_verifier: p2.verifier })).statusCode, 200);
  });

  test('token: a reused code is refused and the key the first use minted is revoked', async () => {
    const p = pkce();
    const g = await grant(app, t, p);
    const first = await token(app, { code: g.code, code_verifier: p.verifier });
    assert.equal(first.statusCode, 200);
    const key = first.json().key as string;
    assert.equal((await app.inject({ method: 'GET', url: '/api/agent/v1/whoami', headers: bearer(key) })).statusCode, 200);
    const second = await token(app, { code: g.code, code_verifier: p.verifier });
    assert.equal(second.statusCode, 400);
    assert.equal(second.json().error, 'invalid_grant');
    const dead = await app.inject({ method: 'GET', url: '/api/agent/v1/whoami', headers: bearer(key) });
    assert.equal(dead.statusCode, 401);
    assert.equal(dead.json().code, 'KEY_REVOKED');
  });

  test('token: a reused code is still remembered after 60 seconds, forgotten after 10 minutes', async () => {
    const p = pkce();
    const g = await grant(app, t, p);
    const key = (await token(app, { code: g.code, code_verifier: p.verifier })).json().key as string;
    advance(5 * 60_000);
    assert.equal((await token(app, { code: g.code, code_verifier: p.verifier })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/agent/v1/whoami', headers: bearer(key) })).statusCode, 401, 'revoked after 5 minutes');
    const p2 = pkce();
    const g2 = await grant(app, t, p2);
    const key2 = (await token(app, { code: g2.code, code_verifier: p2.verifier })).json().key as string;
    advance(11 * 60_000);
    assert.equal((await token(app, { code: g2.code, code_verifier: p2.verifier })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/agent/v1/whoami', headers: bearer(key2) })).statusCode, 200, 'too late to revoke');
  });

  test('token: wrong or missing client secret or id is refused and does not burn the code', async () => {
    const p = pkce();
    const g = await grant(app, t, p);
    for (const over of [{ client_secret: 'wrong' + SECRET }, { client_secret: undefined }, { client_id: 'other' }, { client_id: undefined }, { client_secret: SECRET.slice(0, -1) }]) {
      const res = await token(app, { code: g.code, code_verifier: p.verifier, ...over });
      assert.equal(res.statusCode, 401, JSON.stringify(Object.keys(over)));
      assert.equal(res.json().error, 'invalid_client');
    }
    assert.equal((await token(app, { code: g.code, code_verifier: p.verifier })).statusCode, 200, 'the right call still works');
  });

  test('token: a different redirect_uri or grant type is refused', async () => {
    const p = pkce();
    const g = await grant(app, t, p);
    const wrongRedirect = await token(app, { code: g.code, code_verifier: p.verifier, redirect_uri: LOCAL_REDIRECT });
    assert.equal(wrongRedirect.statusCode, 400);
    const p2 = pkce();
    const g2 = await grant(app, t, p2);
    assert.equal((await token(app, { code: g2.code, code_verifier: p2.verifier, grant_type: 'password' })).statusCode, 400);
    assert.equal((await token(app, { code: 'short', code_verifier: p2.verifier })).statusCode, 400);
    assert.equal((await token(app, { code: g2.code, code_verifier: 'tooshort' })).statusCode, 400);
  });

  test('token: only the allowed IP may call, and browsers may not', async () => {
    const p = pkce();
    const g = await grant(app, t, p);
    const out = await token(app, { code: g.code, code_verifier: p.verifier }, { remoteAddress: '8.8.8.8' });
    assert.equal(out.statusCode, 403);
    const browser = await token(app, { code: g.code, code_verifier: p.verifier }, { headers: { origin: 'https://evil.example' } });
    assert.equal(browser.statusCode, 403);
    assert.equal(browser.headers['access-control-allow-origin'], undefined);
    // Neither burned the code.
    assert.equal((await token(app, { code: g.code, code_verifier: p.verifier })).statusCode, 200);
  });

  test('token: rate limited per address', async () => {
    advance(5 * 60_000);
    let last = 0;
    for (let i = 0; i < 25; i++) {
      last = (await token(app, { code: crypto.randomBytes(32).toString('base64url'), code_verifier: pkce().verifier })).statusCode;
      if (last === 429) break;
    }
    assert.equal(last, 429);
    const blocked = await token(app, { code: 'x', code_verifier: 'y' });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    advance(61_000);
    assert.notEqual((await token(app, { code: 'x', code_verifier: 'y' })).statusCode, 429, 'the window passes');
  });

  test('secrets, codes, verifiers and keys never reach the logs', async () => {
    advance(5 * 60_000);
    const p = pkce();
    const g = await grant(app, t, p);
    const res = await token(app, { code: g.code, code_verifier: p.verifier }, { form: true });
    assert.equal(res.statusCode, 200);
    const key = res.json().key as string;
    await token(app, { code: g.code, code_verifier: p.verifier }); // reused: logs a warning
    await token(app, { code: g.code, code_verifier: p.verifier, client_secret: 'bad-' + SECRET });
    await token(app, 'not an object' as never);
    const all = logs.join('');
    assert.ok(all.length > 0, 'something was logged');
    for (const secret of [key, key.slice(4), g.code, p.verifier, p.challenge, SECRET, TEST_PASSWORD, g.state]) {
      assert.ok(!all.includes(secret), `log contains a secret: ${secret.slice(0, 8)}...`);
    }
    assert.doesNotMatch(all, /code_verifier|client_secret|code_challenge/);
  });
});

describe('Connect Mailloom configuration and storage', () => {
  test('Connect is off unless all three settings are set', async () => {
    for (const env of [
      { AGENT_ALLOWED_IPS: '127.0.0.1' },
      { AGENT_ALLOWED_IPS: '127.0.0.1', AGENT_CLIENT_ID: CLIENT_ID, AGENT_CLIENT_SECRET: SECRET },
      { AGENT_ALLOWED_IPS: '127.0.0.1', AGENT_CLIENT_ID: CLIENT_ID, AGENT_CLIENT_REDIRECT_URIS: REDIRECT },
      { AGENT_ALLOWED_IPS: '127.0.0.1', AGENT_CLIENT_SECRET: SECRET, AGENT_CLIENT_REDIRECT_URIS: REDIRECT }
    ]) {
      assert.equal(loadAgentConfig(env).connect, null);
      const app = await buildTestApp(env, { now });
      try {
        const res = await app.inject({ method: 'GET', url: `/oauth/authorize?${authorizeQuery(pkce())}` });
        assert.equal(res.statusCode, 404);
        assert.equal(res.headers.location, undefined);
        const tok = await token(app, { code: 'x'.repeat(43), code_verifier: 'v'.repeat(43) });
        assert.equal(tok.statusCode, 404);
      } finally {
        await app.close();
      }
    }
  });

  test('Connect is off when the agent API is off (no allowed addresses)', async () => {
    const app = await buildTestApp({ ...ENV, AGENT_ALLOWED_IPS: undefined }, { now });
    try {
      const res = await app.inject({ method: 'GET', url: `/oauth/authorize?${authorizeQuery(pkce())}` });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  test('a secret shorter than 32 characters refuses to start; so do bad redirect addresses', async () => {
    const base = { MAILLOOM_PUBLIC_URL: PUBLIC_URL, AGENT_ALLOWED_IPS: '127.0.0.1', AGENT_CLIENT_ID: CLIENT_ID, AGENT_CLIENT_SECRET: SECRET, AGENT_CLIENT_REDIRECT_URIS: REDIRECT };
    assert.throws(() => loadAgentConfig({ ...base, AGENT_CLIENT_SECRET: 'x'.repeat(31) }), /at least 32/);
    assert.ok(loadAgentConfig({ ...base, AGENT_CLIENT_SECRET: 'x'.repeat(32) }).connect);
    assert.throws(() => loadAgentConfig({ ...base, AGENT_CLIENT_REDIRECT_URIS: 'http://os.example/cb' }), /https/);
    assert.throws(() => loadAgentConfig({ ...base, AGENT_CLIENT_REDIRECT_URIS: 'not a url' }), /web address/);
    assert.throws(() => loadAgentConfig({ ...base, AGENT_CLIENT_REDIRECT_URIS: 'https://os.example/cb#x' }), /# part/);
    assert.throws(() => loadAgentConfig({ ...base, AGENT_CLIENT_ID: 'bad id!' }), /AGENT_CLIENT_ID/);
    for (const local of ['http://localhost:3000/cb', 'http://127.0.0.1:3000/cb']) {
      assert.deepEqual(loadAgentConfig({ ...base, AGENT_CLIENT_REDIRECT_URIS: `${REDIRECT}, ${local}` }).connect?.redirectUris, [REDIRECT, local]);
    }
    // Connect needs the public address (it is the issuer); localhost redirects are refused in production.
    assert.throws(() => loadAgentConfig({ ...base, MAILLOOM_PUBLIC_URL: undefined }), /MAILLOOM_PUBLIC_URL/);
    assert.throws(() => loadAgentConfig({ ...base, NODE_ENV: 'production', AGENT_CLIENT_REDIRECT_URIS: LOCAL_REDIRECT }), /localhost/);
    assert.throws(() => loadAgentConfig({ ...base, NODE_ENV: 'production', AGENT_CLIENT_REDIRECT_URIS: `${REDIRECT},http://127.0.0.1:3000/cb` }), /localhost/);
    assert.ok(loadAgentConfig({ ...base, NODE_ENV: 'production' }).connect, 'https redirects are fine in production');
    assert.ok(loadAgentConfig({ ...base, NODE_ENV: 'development', AGENT_CLIENT_REDIRECT_URIS: LOCAL_REDIRECT }).connect);
    // The app refuses to build with a short secret, and the message never repeats the secret.
    await assert.rejects(
      buildApp({ clientDist: null, env: testEnv({ ...base, AGENT_CLIENT_SECRET: 'short-secret' }) }),
      (err: Error) => /at least 32/.test(err.message) && !err.message.includes('short-secret')
    );
  });

  test('the migration adds client_id and label to a database made by the current schema, keeping its keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailloom-connect-'));
    const file = path.join(dir, 'sessions.db');
    const secret = crypto.randomBytes(32).toString('hex');
    try {
      // A database as the live server has it today: agent_keys without the two new columns.
      const old = new DatabaseSync(file);
      old.exec(`CREATE TABLE agent_keys (
        id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
        scopes TEXT NOT NULL, enc_password TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER,
        broken_at INTEGER, broken_reason TEXT)`);
      const key = newAgentKey();
      old
        .prepare('INSERT INTO agent_keys (id, key_hash, prefix, name, email, scopes, enc_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('legacy-key-1', hashAgentKey(key), agentKeyPrefix(key), 'Work OS', TESTER, 'read,send', encryptMailboxPassword(secret, key, 'legacy-key-1', TESTER, TEST_PASSWORD), 1000);
      old.close();

      // Opening it twice (two starts) is safe, and the old row still works.
      for (let i = 0; i < 2; i++) {
        const db = new DatabaseSync(file);
        const store = new AgentStore(db, secret, now);
        const auth = store.authenticate(key);
        assert.equal(auth.status, 'ok');
        if (auth.status === 'ok') {
          assert.equal(auth.password, TEST_PASSWORD);
          assert.equal(auth.record.clientId, null);
          assert.equal(auth.record.label, null);
          assert.deepEqual(auth.record.scopes, ['read', 'send']);
        }
        const made = store.createKey({ email: TESTER, name: 'Work OS', scopes: ['read'], password: TEST_PASSWORD, clientId: CLIENT_ID, label: 'Delpat' });
        assert.equal(made.record.clientId, CLIENT_ID);
        assert.equal(made.record.label, 'Delpat');
        const cols = (db.prepare('PRAGMA table_info(agent_keys)').all() as Array<{ name: string }>).map((c) => c.name);
        assert.equal(cols.filter((c) => c === 'client_id').length, 1);
        db.close();
      }

      // And the whole app starts on it.
      const app = await buildApp({ clientDist: null, env: testEnv({ ...ENV, SESSION_SECRET: secret, SESSION_DB_PATH: file }), now });
      try {
        await app.ready();
        const who = await app.inject({ method: 'GET', url: '/api/agent/v1/whoami', headers: bearer(key) });
        assert.equal(who.statusCode, 200);
      } finally {
        await app.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
