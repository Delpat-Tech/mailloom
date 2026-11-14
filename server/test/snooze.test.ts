import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { accountFor, buildTestApp, signIn, resetAccount, buildMime, withImap, GM, type SignedIn } from './helpers.js';

let clock = Date.parse('2026-11-14T09:00:00Z');
const now = () => clock;
const MIN = 60_000;

let app: FastifyInstance;
let t: SignedIn;

async function put(folder: string, subject: string, messageId: string, flags: string[] = []): Promise<number> {
  return withImap(GM.tester, async (c) => {
    const r = await c.append(folder, await buildMime({ subject, text: subject, messageId }), flags);
    if (!r || !r.uid) throw new Error('append failed');
    return r.uid;
  });
}

async function folder(name: string): Promise<Array<{ uid: number; subject: string; seen: boolean }>> {
  return withImap(GM.tester, async (c) => {
    const lock = await c.getMailboxLock(name).catch(() => null);
    if (!lock) return [];
    try {
      const out: Array<{ uid: number; subject: string; seen: boolean }> = [];
      if (typeof c.mailbox === 'object' && c.mailbox.exists > 0) {
        for await (const m of c.fetch('1:*', { uid: true, flags: true, envelope: true })) {
          out.push({ uid: m.uid, subject: m.envelope!.subject!, seen: Boolean(m.flags?.has('\\Seen')) });
        }
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

const snooze = (who: SignedIn, body: object, a = app) => a.inject({ method: 'POST', url: '/api/messages/snooze', headers: who.headers, payload: body });

async function resetAll() {
  await resetAccount(GM.tester);
  await withImap(GM.tester, async (c) => {
    await c.mailboxCreate('Snoozed').catch(() => {});
    const lock = await c.getMailboxLock('Snoozed');
    try {
      await c.messageDelete('1:*').catch(() => {});
    } finally {
      lock.release();
    }
  });
}

before(async () => {
  await resetAccount(GM.tester);
  await withImap(GM.tester, async (c) => {
    // Start without the folder: the first snooze creates it.
    await c.mailboxDelete('Snoozed').catch(() => {});
  });
  // The tests drive the timer themselves (tick); the real one must not fire in between.
  app = await buildTestApp({}, { now, organise: { snoozeIntervalMs: 3_600_000 } });
  t = await signIn(app, GM.tester);
});

after(async () => {
  await app.close();
});

test('snooze validates the time, creates Snoozed, moves the mail and lists it with snoozedUntil', async () => {
  const uid = await put('INBOX', 'later please', '<snz-1@delpat.test>', ['\\Seen']);
  const iso = (ms: number) => new Date(ms).toISOString();

  assert.equal((await snooze(t, { mailbox: 'INBOX', uids: [uid], until: iso(clock - MIN) })).statusCode, 400);
  assert.equal((await snooze(t, { mailbox: 'INBOX', uids: [uid], until: iso(clock + 367 * 24 * 60 * MIN) })).statusCode, 400);
  assert.equal((await snooze(t, { mailbox: 'INBOX', uids: [uid], until: 'tomorrow' })).statusCode, 400);
  assert.equal((await snooze(t, { mailbox: 'INBOX', uids: [], until: iso(clock + MIN) })).statusCode, 400);
  assert.equal((await snooze(t, { mailbox: 'INBOX', uids: [987654], until: iso(clock + MIN) })).statusCode, 404);

  const until = clock + 2 * 60 * MIN;
  const res = await snooze(t, { mailbox: 'INBOX', uids: [uid], until: iso(until) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().folder, 'Snoozed');
  assert.deepEqual(await folder('INBOX'), []);
  assert.deepEqual((await folder('Snoozed')).map((m) => m.subject), ['later please']);

  const view = await app.inject({ method: 'GET', url: '/api/views/snoozed', headers: t.headers });
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().total, 1);
  assert.equal(view.json().messages[0].snoozedUntil, iso(until));
  assert.equal(view.json().messages[0].mailbox, 'Snoozed');
});

test('cancelling a snooze moves the mail back to the Inbox now', async () => {
  const [m] = await folder('Snoozed');
  const res = await app.inject({ method: 'DELETE', url: '/api/messages/snooze', headers: t.headers, payload: { uids: [m!.uid] } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().movedTo, 'INBOX');
  assert.deepEqual((await folder('INBOX')).map((x) => x.subject), ['later please']);
  assert.equal((await app.inject({ method: 'GET', url: '/api/views/snoozed', headers: t.headers })).json().total, 0);
  // Nothing left to wake.
  assert.equal(app.mailloomOrganise.store.snoozes(GM.tester).length, 0);
});

test('wake with a stored login: the timer brings mail back unread with nobody signed in', async () => {
  await resetAll();
  const uid = await put('INBOX', 'wake via push login', '<snz-2@delpat.test>', ['\\Seen']);
  assert.equal((await snooze(t, { mailbox: 'INBOX', uids: [uid], until: new Date(clock + 5 * MIN).toISOString() })).statusCode, 200);

  app.mailloomPush.store.upsert({
    email: GM.tester,
    endpoint: 'https://push.example.test/device-1',
    p256dh: 'p',
    auth: 'a',
    password: GM.password,
    sessionKey: null,
    label: 'test phone',
    showDetails: false,
    quiet: false
  });
  // Not yet due.
  assert.equal(await app.mailloomOrganise.snoozer.tick(), 0);
  assert.equal((await folder('Snoozed')).length, 1);

  clock += 6 * MIN;
  assert.equal(await app.mailloomOrganise.snoozer.tick(), 1);
  const inbox = await folder('INBOX');
  assert.deepEqual(inbox.map((m) => [m.subject, m.seen]), [['wake via push login', false]]);
  assert.deepEqual(await folder('Snoozed'), []);
  // Idempotent: a second pass finds nothing to do.
  assert.equal(await app.mailloomOrganise.snoozer.tick(), 0);
  app.mailloomPush.store.deleteAllForMailbox(GM.tester);
});

test('wake without a stored login: waits for the next signed-in request', async () => {
  await resetAll();
  const uid = await put('INBOX', 'wake on visit', '<snz-3@delpat.test>', ['\\Seen']);
  assert.equal((await snooze(t, { mailbox: 'INBOX', uids: [uid], until: new Date(clock + 5 * MIN).toISOString() })).statusCode, 200);
  clock += 6 * MIN;

  // The timer has no login for this mailbox: the mail stays snoozed.
  assert.equal(await app.mailloomOrganise.snoozer.tick(), 0);
  assert.equal((await folder('Snoozed')).length, 1);

  const res = await app.inject({ method: 'GET', url: '/api/mailboxes/INBOX/messages', headers: t.headers });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().messages.map((m: any) => [m.subject, m.isSeen]), [['wake on visit', false]]);
  assert.deepEqual(await folder('Snoozed'), []);
});

test('a snoozed message that disappeared is dropped from the records; nothing else moves', async () => {
  await resetAll();
  const uid = await put('INBOX', 'will vanish', '<snz-4@delpat.test>');
  assert.equal((await snooze(t, { mailbox: 'INBOX', uids: [uid], until: new Date(clock + 5 * MIN).toISOString() })).statusCode, 200);
  await withImap(GM.tester, async (c) => {
    const lock = await c.getMailboxLock('Snoozed');
    try {
      await c.messageMove('1:*', 'Trash');
    } finally {
      lock.release();
    }
  });
  clock += 6 * MIN;
  const r = await app.mailloomOrganise.snoozer.wakeFor(accountFor(GM.tester));
  assert.deepEqual(r, { woken: 0, dropped: 1 });
  assert.equal(app.mailloomOrganise.store.snoozes(GM.tester).length, 0);
  assert.deepEqual(await folder('INBOX'), []);
  assert.deepEqual((await folder('Trash')).map((m) => m.subject), ['will vanish']);
});

test('snoozes survive a restart and wake on the next sign-in', async () => {
  await resetAll();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailloom-snooze-'));
  const env = { SESSION_DB_PATH: path.join(dir, 'db.sqlite'), SESSION_SECRET: crypto.randomBytes(32).toString('hex') };
  try {
    let a = await buildTestApp(env, { now, organise: { snoozeIntervalMs: 3_600_000 } });
    const s1 = await signIn(a, GM.tester);
    const uid = await put('INBOX', 'across restart', '<snz-5@delpat.test>', ['\\Seen']);
    assert.equal((await snooze(s1, { mailbox: 'INBOX', uids: [uid], until: new Date(clock + 5 * MIN).toISOString() }, a)).statusCode, 200);
    await a.close();

    clock += 10 * MIN;
    a = await buildTestApp(env, { now, organise: { snoozeIntervalMs: 3_600_000 } });
    try {
      const s2 = await signIn(a, GM.tester);
      assert.equal(s2.res.statusCode, 200);
      // Sign-in starts the wake in the background; the next request waits for it.
      const res = await a.inject({ method: 'GET', url: '/api/mailboxes/INBOX/messages', headers: s2.headers });
      assert.deepEqual(res.json().messages.map((m: any) => [m.subject, m.isSeen]), [['across restart', false]]);
      assert.equal(a.mailloomOrganise.store.snoozes(GM.tester).length, 0);
    } finally {
      await a.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two copies with the same Message-ID are tracked and woken separately', async () => {
  await resetAll();
  t = await signIn(app, GM.tester); // the test clock has moved past the idle timeout
  const a = await put('INBOX', 'twin', '<snz-twin@delpat.test>', ['\Seen']);
  const b = await put('INBOX', 'twin', '<snz-twin@delpat.test>', ['\Seen']);
  assert.equal((await snooze(t, { mailbox: 'INBOX', uids: [a], until: new Date(clock + 5 * MIN).toISOString() })).statusCode, 200);
  assert.equal((await snooze(t, { mailbox: 'INBOX', uids: [b], until: new Date(clock + 50 * MIN).toISOString() })).statusCode, 200);
  const records = app.mailloomOrganise.store.snoozes(GM.tester);
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.uid > 0 && r.messageId === 'snz-twin@delpat.test'));
  assert.notEqual(records[0]!.uid, records[1]!.uid);

  clock += 6 * MIN;
  const r = await app.mailloomOrganise.snoozer.wakeFor(accountFor(GM.tester));
  assert.deepEqual(r, { woken: 1, dropped: 0 });
  assert.equal((await folder('INBOX')).length, 1);
  assert.equal((await folder('Snoozed')).length, 1);
  assert.equal(app.mailloomOrganise.store.snoozes(GM.tester).length, 1);

  clock += 45 * MIN;
  assert.deepEqual(await app.mailloomOrganise.snoozer.wakeFor(accountFor(GM.tester)), { woken: 1, dropped: 0 });
  assert.equal((await folder('INBOX')).length, 2);
  assert.deepEqual(await folder('Snoozed'), []);
});

test('a wake-up that keeps failing backs off 1, 5, 15, 60 minutes for that mailbox', async () => {
  await resetAll();
  t = await signIn(app, GM.tester); // the test clock has moved past the idle timeout
  const uid = await put('INBOX', 'backoff', '<snz-back@delpat.test>');
  assert.equal((await snooze(t, { mailbox: 'INBOX', uids: [uid], until: new Date(clock + MIN).toISOString() })).statusCode, 200);
  clock += 2 * MIN;
  const snoozer = app.mailloomOrganise.snoozer;
  const broken = accountFor(GM.tester, 'Test User', { imapPass: 'wrong-password' });
  for (const wait of [1, 5, 15, 60, 60]) {
    assert.equal(snoozer.coolingOff(GM.tester), false);
    assert.deepEqual(await snoozer.wakeFor(broken), { woken: 0, dropped: 0 });
    assert.equal(snoozer.coolingOff(GM.tester), true);
    // While cooling off, requests do not even try (the good login is skipped too).
    assert.deepEqual(await snoozer.wakeFor(accountFor(GM.tester)), { woken: 0, dropped: 0 });
    assert.equal((await folder('Snoozed')).length, 1);
    clock += wait * MIN - 1000;
    assert.equal(snoozer.coolingOff(GM.tester), true);
    clock += 1000;
  }
  // Success clears the back-off.
  assert.deepEqual(await snoozer.wakeFor(accountFor(GM.tester)), { woken: 1, dropped: 0 });
  assert.equal(snoozer.coolingOff(GM.tester), false);
});
