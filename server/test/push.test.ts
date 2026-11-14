import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { generateVAPIDKeys } from 'web-push';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { buildApp } from '../src/app.js';
import { isAllowedPushEndpoint, loadPushConfig } from '../src/push/config.js';
import { decryptDeviceSecrets, encryptDeviceSecrets, endpointHash } from '../src/push/crypto.js';
import { buildNewMailPayload } from '../src/push/watcher.js';
import { COLLEAGUE, TESTER, TEST_PASSWORD, buildTestApp, signIn, testEnv, withImap, type SignedIn } from './helpers.js';

/**
 * Push notifications against the local GreenMail and a local mock push service (plain HTTP on
 * 127.0.0.1). No real push service is ever contacted: the app's endpoint check is replaced by one
 * that only accepts the mock's address.
 */

const run = crypto.randomBytes(4).toString('hex');
let seq = 0;
const uniq = (label: string) => `${label}-${run}-${++seq}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- mock push service

interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const received: Received[] = [];
let mockServer: http.Server;
let mockBase = '';

function startMock(): Promise<void> {
  mockServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url || '', headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = (req.url || '').startsWith('/gone/') ? 410 : 201;
      res.end();
    });
  });
  return new Promise((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => {
      mockBase = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

/** A fake browser push subscription with real keys, so payloads can be decrypted. */
function fakeDevice(kind: 'ok' | 'gone' = 'ok') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const path = `/${kind}/${crypto.randomBytes(8).toString('hex')}`;
  return {
    path,
    ecdh,
    auth,
    subscription: {
      endpoint: mockBase + path,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
    }
  };
}
type FakeDevice = ReturnType<typeof fakeDevice>;

/** RFC 8291 aes128gcm decryption, as a browser does it. */
function decrypt(device: FakeDevice, body: Buffer): Record<string, unknown> {
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const serverPublic = body.subarray(21, 21 + idLen);
  const cipherText = body.subarray(21 + idLen);
  const shared = device.ecdh.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), device.ecdh.getPublicKey(), serverPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, device.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipherText.subarray(cipherText.length - 16));
  let plain = Buffer.concat([d.update(cipherText.subarray(0, cipherText.length - 16)), d.final()]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  plain = plain.subarray(0, end - 1); // drop the 0x02 record delimiter
  return JSON.parse(plain.toString('utf8'));
}

const pushesFor = (d: FakeDevice) => received.filter((r) => r.path === d.path);

async function waitFor(cond: () => boolean, ms = 8000, label = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------- app helpers

const vapid = generateVAPIDKeys();
const PUSH_ENV = { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:it@delpat.test' };

async function pushApp(timing: Record<string, number> = {}): Promise<FastifyInstance> {
  return buildTestApp(PUSH_ENV, {
    push: {
      timing: { debounceMs: 600, collapseMs: 30_000, pollMs: 400, idlePollMs: 60_000, retryMs: 200, ...timing },
      endpointAllowed: (e) => e.startsWith(mockBase + '/')
    }
  });
}

async function subscribe(app: FastifyInstance, t: SignedIn, device: FakeDevice, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    headers: t.headers,
    payload: { subscription: device.subscription, password: TEST_PASSWORD, label: 'Test phone', ...extra }
  });
}

/** Puts an unread message straight into INBOX. */
async function plant(email: string, subject: string, from = COLLEAGUE): Promise<void> {
  const raw = await new MailComposer({ from: `Colleague Name <${from}>`, to: email, subject, text: 'SECRET-BODY-TEXT', date: new Date() })
    .compile()
    .build();
  await withImap(email, (c) => c.append('INBOX', raw, []));
}

function rawRow(app: FastifyInstance, id: string) {
  return app.mailloom.sessions.database.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as
    | { enc_secrets: string; email: string; endpoint_hash: string; disabled_at: number | null; disabled_reason: string | null }
    | undefined;
}

// ---------------------------------------------------------------- tests

before(startMock);
after(() => new Promise<void>((r) => mockServer.close(() => r())));

describe('push configuration', () => {
  test('VAPID settings: all or nothing, and a matching pair', () => {
    assert.equal(loadPushConfig({}).enabled, false);
    assert.equal(loadPushConfig(PUSH_ENV).enabled, true);
    assert.throws(() => loadPushConfig({ VAPID_PUBLIC_KEY: vapid.publicKey }), /missing VAPID_PRIVATE_KEY, VAPID_SUBJECT/);
    const other = generateVAPIDKeys();
    assert.throws(() => loadPushConfig({ ...PUSH_ENV, VAPID_PRIVATE_KEY: other.privateKey }), /does not match/);
    assert.throws(() => loadPushConfig({ ...PUSH_ENV, VAPID_SUBJECT: 'it@delpat.test' }), /VAPID_SUBJECT/);
  });

  test('server refuses to start with half the VAPID settings', async () => {
    await assert.rejects(buildApp({ clientDist: null, env: testEnv({ VAPID_PUBLIC_KEY: vapid.publicKey }) }), /VAPID/);
  });

  test('only real push services are accepted as endpoints', () => {
    assert.ok(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
    assert.ok(isAllowedPushEndpoint('https://web.push.apple.com/QGx'));
    assert.ok(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
    assert.ok(isAllowedPushEndpoint('https://db5p.notify.windows.com/w/?token=x'));
    assert.ok(!isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'));
    assert.ok(!isAllowedPushEndpoint('https://fcm.googleapis.com:8443/x'));
    assert.ok(!isAllowedPushEndpoint('https://127.0.0.1/x'));
    assert.ok(!isAllowedPushEndpoint('https://fcm.googleapis.com.evil.example/x'));
    assert.ok(!isAllowedPushEndpoint('https://user:pw@web.push.apple.com/x'));
  });

  test('push off: config says so and subscribing is refused', async () => {
    const app = await buildTestApp();
    try {
      const t = await signIn(app, TESTER);
      const cfg = await app.inject({ method: 'GET', url: '/api/push/config', headers: t.headers });
      assert.equal(cfg.json().enabled, false);
      const res = await subscribe(app, t, fakeDevice());
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().code, 'PUSH_OFF');
    } finally {
      await app.close();
    }
  });

  test('payload has no sender or subject unless details were chosen, and never the body', () => {
    const latest = { uid: 7, from: 'Asha‮Rao', subject: 'Quarterly numbers' };
    const plain = buildNewMailPayload(TESTER, { showDetails: false, quiet: false }, 3, 5, latest);
    assert.equal(plain.title, 'New mail');
    assert.equal(plain.body, '3 new messages');
    assert.ok(!JSON.stringify(plain).includes('Asha') && !JSON.stringify(plain).includes('Quarterly'));
    const one = buildNewMailPayload(TESTER, { showDetails: true, quiet: true }, 1, 1, latest);
    assert.equal(one.title, 'Asha Rao'); // bidi override removed
    assert.equal(one.body, 'Quarterly numbers');
    assert.equal(one.uid, 7);
    assert.equal(one.silent, true);
  });

  test('stored secrets only open for the same row, mailbox and device', () => {
    const secret = crypto.randomBytes(32).toString('hex');
    const ep = endpointHash('https://web.push.apple.com/x');
    const enc = encryptDeviceSecrets(secret, 'row1', TESTER, ep, { password: 'pw', p256dh: 'k', auth: 'a' });
    assert.ok(!enc.includes('pw'));
    assert.deepEqual(decryptDeviceSecrets(secret, 'row1', TESTER, ep, enc), { password: 'pw', p256dh: 'k', auth: 'a' });
    assert.equal(decryptDeviceSecrets(secret, 'row2', TESTER, ep, enc), null);
    assert.equal(decryptDeviceSecrets(secret, 'row1', COLLEAGUE, ep, enc), null);
    assert.equal(decryptDeviceSecrets(secret, 'row1', TESTER, endpointHash('https://web.push.apple.com/y'), enc), null);
    assert.equal(decryptDeviceSecrets(crypto.randomBytes(32).toString('hex'), 'row1', TESTER, ep, enc), null);
  });
});

describe('push subscriptions', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await pushApp();
  });
  after(async () => {
    await app.close();
  });

  test('config gives the VAPID public key', async () => {
    const t = await signIn(app, TESTER);
    const res = await app.inject({ method: 'GET', url: '/api/push/config', headers: t.headers });
    assert.equal(res.json().enabled, true);
    assert.equal(res.json().public_key, vapid.publicKey);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  test('needs sign-in, the right password and a usable subscription', async () => {
    const d = fakeDevice();
    const anon = await app.inject({ method: 'POST', url: '/api/push/subscribe', payload: { subscription: d.subscription, password: TEST_PASSWORD } });
    assert.equal(anon.statusCode, 401);
    const t = await signIn(app, TESTER);
    const wrong = await subscribe(app, t, d, { password: 'not-the-password' });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().code, 'WRONG_PASSWORD');
    const noPw = await subscribe(app, t, d, { password: '' });
    assert.equal(noPw.statusCode, 400);
    const badKeys = await subscribe(app, t, { ...d, subscription: { ...d.subscription, keys: { p256dh: 'abc', auth: 'x' } } });
    assert.equal(badKeys.json().code, 'BAD_SUBSCRIPTION');
    const internal = await subscribe(app, t, { ...d, subscription: { ...d.subscription, endpoint: 'http://169.254.169.254/latest' } });
    assert.equal(internal.json().code, 'BAD_SUBSCRIPTION');
    assert.equal(app.mailloomPush.store.list(TESTER).length, 0);
  });

  test('turn on stores the password encrypted; turn off deletes it', async () => {
    const t = await signIn(app, TESTER);
    const d = fakeDevice();
    const res = await subscribe(app, t, d);
    assert.equal(res.statusCode, 201, res.body);
    const device = res.json().device;
    assert.equal(device.show_details, false);
    assert.equal(device.quiet, false);
    assert.equal(device.label, 'Test phone');
    assert.equal(device.status, 'on');
    assert.ok(!JSON.stringify(res.json()).includes(TEST_PASSWORD));

    const row = rawRow(app, device.id)!;
    assert.ok(row.enc_secrets.startsWith('p1.'));
    assert.ok(!row.enc_secrets.includes(TEST_PASSWORD));
    assert.ok(!row.enc_secrets.includes(d.subscription.keys.auth));

    const lookup = await app.inject({ method: 'POST', url: '/api/push/device', headers: t.headers, payload: { endpoint: d.subscription.endpoint } });
    assert.equal(lookup.json().device.id, device.id);

    const patched = await app.inject({ method: 'PATCH', url: `/api/push/devices/${device.id}`, headers: t.headers, payload: { show_details: true, quiet: true } });
    assert.equal(patched.json().device.show_details, true);
    assert.equal(patched.json().device.quiet, true);

    const del = await app.inject({ method: 'DELETE', url: `/api/push/devices/${device.id}`, headers: t.headers });
    assert.equal(del.statusCode, 200);
    assert.equal(rawRow(app, device.id), undefined);
    await waitFor(() => !app.mailloomPush.watcher!.isWatching(TESTER), 3000, 'watcher to stop');
  });

  test("another mailbox cannot see, change or delete your device", async () => {
    const t = await signIn(app, TESTER);
    const c = await signIn(app, COLLEAGUE);
    const d = fakeDevice();
    const id = (await subscribe(app, t, d)).json().device.id as string;
    const lookup = await app.inject({ method: 'POST', url: '/api/push/device', headers: c.headers, payload: { endpoint: d.subscription.endpoint } });
    assert.equal(lookup.json().device, null);
    const list = await app.inject({ method: 'GET', url: '/api/push/devices', headers: c.headers });
    assert.equal(list.json().devices.length, 0);
    for (const [method, url] of [['PATCH', `/api/push/devices/${id}`], ['DELETE', `/api/push/devices/${id}`], ['POST', `/api/push/devices/${id}/test`]] as const) {
      const res = await app.inject({ method, url, headers: c.headers, payload: method === 'PATCH' ? { quiet: true } : undefined });
      assert.equal(res.statusCode, 404, `${method} ${url}`);
    }
    assert.ok(rawRow(app, id));
    // Turn off on all devices of a mailbox only touches that mailbox.
    await app.inject({ method: 'DELETE', url: '/api/push/devices', headers: c.headers });
    assert.ok(rawRow(app, id));
    await app.inject({ method: 'DELETE', url: '/api/push/devices', headers: t.headers });
    assert.equal(rawRow(app, id), undefined);
  });

  test('signing out on the device removes its subscription', async () => {
    const t = await signIn(app, TESTER);
    const id = (await subscribe(app, t, fakeDevice())).json().device.id as string;
    assert.ok(rawRow(app, id));
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: t.headers });
    assert.equal(out.statusCode, 200);
    assert.equal(rawRow(app, id), undefined);
  });

  test('test notification reaches the device, and a 410 deletes it', async () => {
    const t = await signIn(app, TESTER);
    const ok = fakeDevice();
    const okId = (await subscribe(app, t, ok)).json().device.id as string;
    const res = await app.inject({ method: 'POST', url: `/api/push/devices/${okId}/test`, headers: t.headers });
    assert.equal(res.statusCode, 200);
    const [push] = pushesFor(ok);
    assert.ok(push);
    assert.equal(push.headers['content-encoding'], 'aes128gcm');
    assert.match(String(push.headers.authorization), /^vapid t=.+, k=/);
    assert.equal(decrypt(ok, push.body).kind, 'test');

    const gone = fakeDevice('gone');
    const goneId = (await subscribe(app, t, gone)).json().device.id as string;
    const res2 = await app.inject({ method: 'POST', url: `/api/push/devices/${goneId}/test`, headers: t.headers });
    assert.equal(res2.statusCode, 410);
    assert.equal(rawRow(app, goneId), undefined);
    await app.inject({ method: 'DELETE', url: '/api/push/devices', headers: t.headers });
  });
});

describe('push watcher', () => {
  test('a burst of 3 mails gives one push with a count, no details by default, never the body', async () => {
    const app = await pushApp();
    try {
      const t = await signIn(app, TESTER);
      const d = fakeDevice();
      assert.equal((await subscribe(app, t, d)).statusCode, 201);
      await waitFor(() => app.mailloomPush.watcher!.isConnected(TESTER), 8000, 'watcher connection');
      const subjects = [uniq('burst-a'), uniq('burst-b'), uniq('burst-c')];
      for (const s of subjects) await plant(TESTER, s);
      await waitFor(() => pushesFor(d).length >= 1, 8000, 'push');
      await sleep(1500); // nothing else may follow inside the 30 s window
      const pushes = pushesFor(d);
      assert.equal(pushes.length, 1);
      const payload = decrypt(d, pushes[0]!.body);
      assert.equal(payload.kind, 'new-mail');
      assert.equal(payload.count, 3);
      assert.equal(payload.title, 'New mail');
      assert.equal(payload.body, '3 new messages');
      assert.ok((payload.unread as number) >= 3);
      assert.equal(payload.silent, false);
      const text = JSON.stringify(payload);
      for (const s of subjects) assert.ok(!text.includes(s));
      assert.ok(!text.includes('Colleague Name') && !text.includes('SECRET-BODY-TEXT'));
      assert.equal(pushes[0]!.headers.topic, 'newmail');
    } finally {
      await app.close();
    }
  });

  test('with "show details" and quiet on, the push carries sender and subject and is silent', async () => {
    const app = await pushApp();
    try {
      const t = await signIn(app, TESTER);
      const d = fakeDevice();
      assert.equal((await subscribe(app, t, d, { show_details: true, quiet: true })).statusCode, 201);
      await waitFor(() => app.mailloomPush.watcher!.isConnected(TESTER), 8000, 'watcher connection');
      const subject = uniq('details');
      await plant(TESTER, subject);
      await waitFor(() => pushesFor(d).length >= 1, 8000, 'push');
      const payload = decrypt(d, pushesFor(d)[0]!.body);
      assert.equal(payload.title, 'Colleague Name');
      assert.equal(payload.body, subject);
      assert.equal(payload.count, 1);
      assert.equal(payload.silent, true);
      assert.equal(typeof payload.uid, 'number');
      assert.ok(!JSON.stringify(payload).includes('SECRET-BODY-TEXT'));
    } finally {
      await app.close();
    }
  });

  test("another person's device never receives your mail", async () => {
    const app = await pushApp();
    try {
      const t = await signIn(app, TESTER);
      const c = await signIn(app, COLLEAGUE);
      const mine = fakeDevice();
      const theirs = fakeDevice();
      assert.equal((await subscribe(app, t, mine)).statusCode, 201);
      assert.equal((await subscribe(app, c, theirs)).statusCode, 201);
      const w = app.mailloomPush.watcher!;
      await waitFor(() => w.isConnected(TESTER) && w.isConnected(COLLEAGUE), 8000, 'both watchers');
      await plant(TESTER, uniq('only-tester'));
      await waitFor(() => pushesFor(mine).length >= 1, 8000, 'push');
      await sleep(1500);
      assert.equal(pushesFor(theirs).length, 0);
      assert.equal(decrypt(mine, pushesFor(mine)[0]!.body).mailbox, TESTER);
    } finally {
      await app.close();
    }
  });

  test('a 410 from the push service deletes the subscription and stops the watcher', async () => {
    const app = await pushApp();
    try {
      const t = await signIn(app, TESTER);
      const d = fakeDevice('gone');
      const id = (await subscribe(app, t, d)).json().device.id as string;
      const w = app.mailloomPush.watcher!;
      await waitFor(() => w.isConnected(TESTER), 8000, 'watcher connection');
      await plant(TESTER, uniq('gone'));
      await waitFor(() => pushesFor(d).length >= 1, 8000, 'push attempt');
      await waitFor(() => rawRow(app, id) === undefined, 3000, 'row deleted');
      await waitFor(() => !w.isWatching(TESTER), 3000, 'watcher stopped');
    } finally {
      await app.close();
    }
  });

  test('a password the mail server refuses disables the device, wipes it and tells the device once', async () => {
    const app = await pushApp();
    try {
      const { store, watcher } = app.mailloomPush;
      const d = fakeDevice();
      const device = store.upsert({
        email: TESTER,
        endpoint: d.subscription.endpoint,
        p256dh: d.subscription.keys.p256dh,
        auth: d.subscription.keys.auth,
        password: 'changed-since',
        sessionKey: null,
        label: 'Old phone',
        showDetails: false,
        quiet: false
      });
      watcher!.ensure(TESTER);
      await waitFor(() => rawRow(app, device.id)?.disabled_at != null, 8000, 'device disabled');
      const row = rawRow(app, device.id)!;
      assert.equal(row.enc_secrets, '');
      assert.match(row.disabled_reason!, /refused/);
      await waitFor(() => !watcher!.isWatching(TESTER), 3000, 'watcher stopped');
      const pushes = pushesFor(d);
      assert.equal(pushes.length, 1);
      const payload = decrypt(d, pushes[0]!.body);
      assert.equal(payload.kind, 'paused');
      assert.ok(!JSON.stringify(payload).includes('changed-since'));
      // The app shows the device as stopped.
      const t = await signIn(app, TESTER);
      const lookup = await app.inject({ method: 'POST', url: '/api/push/device', headers: t.headers, payload: { endpoint: d.subscription.endpoint } });
      assert.equal(lookup.json().device.status, 'stopped');
    } finally {
      await app.close();
    }
  });

  test('watchers start again for stored devices when the server starts', async () => {
    const app = await pushApp();
    try {
      const t = await signIn(app, TESTER);
      await subscribe(app, t, fakeDevice());
      await app.mailloomPush.watcher!.stopAll();
      assert.equal(app.mailloomPush.watcher!.isWatching(TESTER), false);
      app.mailloomPush.watcher!.startAll();
      await waitFor(() => app.mailloomPush.watcher!.isConnected(TESTER), 8000, 'watcher connection');
    } finally {
      await app.close();
    }
  });
});
