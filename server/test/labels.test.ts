import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, signIn, resetAccount, buildMime, withImap, GM, type SignedIn } from './helpers.js';

let app: FastifyInstance;
let t: SignedIn;
let c: SignedIn;

async function put(email: string, folder: string, subject: string, flags: string[] = []): Promise<number> {
  return withImap(email, async (cl) => {
    await cl.mailboxCreate(folder).catch(() => {});
    const r = await cl.append(folder, await buildMime({ subject, text: subject }), flags);
    if (!r || !r.uid) throw new Error('append failed');
    return r.uid;
  });
}

async function flagsOf(email: string, folder: string): Promise<Map<string, string[]>> {
  return withImap(email, async (cl) => {
    const out = new Map<string, string[]>();
    const lock = await cl.getMailboxLock(folder);
    try {
      if (typeof cl.mailbox === 'object' && cl.mailbox.exists > 0) {
        for await (const m of cl.fetch('1:*', { uid: true, flags: true, envelope: true })) out.set(m.envelope!.subject!, [...(m.flags || [])]);
      }
    } finally {
      lock.release();
    }
    return out;
  });
}

const req = (who: SignedIn, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: who.headers, ...(payload ? { payload } : {}) });

before(async () => {
  await resetAccount(GM.tester);
  await resetAccount(GM.colleague);
  for (const who of [GM.tester, GM.colleague]) {
    await withImap(who, async (cl) => {
      await cl.mailboxCreate('Archive').catch(() => {});
      const lock = await cl.getMailboxLock('Archive');
      try {
        await cl.messageDelete('1:*').catch(() => {});
      } finally {
        lock.release();
      }
    });
  }
  app = await buildTestApp();
  t = await signIn(app, GM.tester);
  c = await signIn(app, GM.colleague);
});

after(async () => {
  await app.close();
});

test('a new mailbox starts with no labels (no defaults are seeded)', async () => {
  const res = await req(t, 'GET', '/api/labels');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), []);
  assert.equal((await app.inject({ method: 'GET', url: '/api/labels' })).statusCode, 401);
  // The labels the later tests use are made the way a person would make them.
  for (const [name, colour] of [['Client', 'mint'], ['Finance', 'marigold'], ['Product', 'lilac'], ['People', 'coral'], ['Ops', 'blue']]) {
    const made = await req(t, 'POST', '/api/labels', { name, colour });
    assert.equal(made.statusCode, 201, made.body);
    assert.match(made.json().id, /^[a-z0-9]{10}$/);
  }
  assert.deepEqual(
    (await req(t, 'GET', '/api/labels')).json().map((l: any) => [l.name, l.colour, l.count, l.unread, l.total]),
    [
      ['Client', 'mint', 0, 0, 0],
      ['Finance', 'marigold', 0, 0, 0],
      ['Product', 'lilac', 0, 0, 0],
      ['People', 'coral', 0, 0, 0],
      ['Ops', 'blue', 0, 0, 0]
    ]
  );
});

test('old default labels that no message carries are removed once; used ones and own labels stay', async () => {
  const db = app.mailloom.sessions.database;
  const email = 'pruning@delpat.test';
  // A mailbox seeded by an earlier version: five defaults plus its own label.
  db.prepare('INSERT INTO label_seeded (email, seeded_at) VALUES (?, ?)').run(email, 1);
  const defs: Array<[string, string, string]> = [
    ['aaaaaaaaa1', 'Client', 'mint'], ['aaaaaaaaa2', 'Finance', 'marigold'], ['aaaaaaaaa3', 'Product', 'lilac'],
    ['aaaaaaaaa4', 'People', 'coral'], ['aaaaaaaaa5', 'Ops', 'blue'], ['aaaaaaaaa6', 'Mine', 'mint']
  ];
  defs.forEach(([id, name, colour], i) => db.prepare('INSERT INTO labels (email, id, name, colour, ord, created_at) VALUES (?, ?, ?, ?, ?, 1)').run(email, id, name, colour, i));
  const store = app.mailloomOrganise.store;
  // Finance has two messages tagged, "Mine" none (not a default, so kept).
  const totals = new Map(defs.map(([id]) => [id, id === 'aaaaaaaaa2' ? 2 : 0]));
  const removed = store.pruneLegacyDefaults(email, totals);
  assert.deepEqual(removed.sort(), ['aaaaaaaaa1', 'aaaaaaaaa3', 'aaaaaaaaa4', 'aaaaaaaaa5']);
  assert.deepEqual(store.labels(email).map((l) => l.name), ['Finance', 'Mine']);
  // Only once: a default-named label made later is not touched.
  store.createLabel(email, 'Client', 'mint');
  assert.deepEqual(store.pruneLegacyDefaults(email, new Map()), []);
  assert.ok(store.labels(email).some((l) => l.name === 'Client'));
  // A mailbox that never had defaults seeded is never pruned.
  store.createLabel('fresh@delpat.test', 'Client', 'mint');
  assert.deepEqual(store.pruneLegacyDefaults('fresh@delpat.test', new Map()), []);
  assert.equal(store.labels('fresh@delpat.test').length, 1);
});

test('create, rename, recolour and validate labels', async () => {
  const made = await req(t, 'POST', '/api/labels', { name: '  Legal  ', colour: 'coral' });
  assert.equal(made.statusCode, 201, made.body);
  const legal = made.json();
  assert.deepEqual({ ...legal, id: undefined }, { id: undefined, name: 'Legal', colour: 'coral', count: 0, unread: 0, total: 0 });

  assert.equal((await req(t, 'POST', '/api/labels', { name: 'legal', colour: 'mint' })).statusCode, 409);
  assert.equal((await req(t, 'POST', '/api/labels', { name: 'X', colour: 'pink' })).statusCode, 400);
  assert.equal((await req(t, 'POST', '/api/labels', { name: '', colour: 'mint' })).statusCode, 400);
  assert.equal((await req(t, 'POST', '/api/labels', { name: 'x'.repeat(41), colour: 'mint' })).statusCode, 400);

  const patched = await req(t, 'PATCH', `/api/labels/${legal.id}`, { name: 'Legal team', colour: 'blue', order: 0 });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().name, 'Legal team');
  assert.equal(patched.json().colour, 'blue');
  assert.equal((await req(t, 'GET', '/api/labels')).json()[0].name, 'Legal team');
  assert.equal((await req(t, 'PATCH', `/api/labels/${legal.id}`, { colour: 'grey' })).statusCode, 400);
  assert.equal((await req(t, 'PATCH', '/api/labels/zzzzzzzzzz', { name: 'Nope' })).statusCode, 404);
});

test('label messages: keywords on the mailbox, unread count in Inbox, label view across folders', async () => {
  const labels = (await req(t, 'GET', '/api/labels')).json();
  const client = labels.find((l: any) => l.name === 'Client');
  const finance = labels.find((l: any) => l.name === 'Finance');
  const a = await put(GM.tester, 'INBOX', 'acme order');
  const b = await put(GM.tester, 'INBOX', 'acme invoice', ['\\Seen']);
  const arch = await put(GM.tester, 'Archive', 'acme archived');

  let r = await req(t, 'POST', '/api/messages/labels', { mailbox: 'INBOX', uids: [a, b], add: [client.id, finance.id] });
  assert.equal(r.statusCode, 200, r.body);
  r = await req(t, 'POST', '/api/messages/labels', { mailbox: 'Archive', uids: [arch], add: [client.id] });
  assert.equal(r.statusCode, 200, r.body);
  r = await req(t, 'POST', '/api/messages/labels', { mailbox: 'INBOX', uids: [b], remove: [finance.id] });
  assert.equal(r.statusCode, 200, r.body);

  // Stored as IMAP keywords, visible to any client.
  const inboxFlags = await flagsOf(GM.tester, 'INBOX');
  assert.ok(inboxFlags.get('acme order')!.includes(`$label_${client.id}`));
  assert.ok(inboxFlags.get('acme order')!.includes(`$label_${finance.id}`));
  assert.ok(!inboxFlags.get('acme invoice')!.includes(`$label_${finance.id}`));

  const counts = new Map((await req(t, 'GET', '/api/labels')).json().map((l: any) => [l.id, l.count]));
  // count is the unread number over the folders a label view shows: the unread Inbox message and the unread Archive one.
  assert.equal(counts.get(client.id), 2);
  assert.equal(counts.get(finance.id), 1);
  const full = new Map((await req(t, 'GET', '/api/labels')).json().map((l: any) => [l.id, [l.unread, l.total]]));
  assert.deepEqual(full.get(client.id), [2, 3]);
  assert.deepEqual(full.get(finance.id), [1, 1]);

  const list = (await req(t, 'GET', '/api/mailboxes/INBOX/messages')).json();
  const order = list.messages.find((m: any) => m.subject === 'acme order');
  assert.deepEqual([...order.labels].sort(), [client.id, finance.id].sort());

  const view = await req(t, 'GET', `/api/labels/${client.id}/messages?page=1&limit=10`);
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().total, 3);
  assert.deepEqual(view.json().messages.map((m: any) => m.mailbox).sort(), ['Archive', 'INBOX', 'INBOX']);

  // Unknown label ids and bad input are refused before IMAP is touched.
  assert.equal((await req(t, 'POST', '/api/messages/labels', { mailbox: 'INBOX', uids: [a], add: ['zzzzzzzzzz'] })).statusCode, 400);
  assert.equal((await req(t, 'POST', '/api/messages/labels', { mailbox: 'INBOX', uids: [], add: [client.id] })).statusCode, 400);
  assert.equal((await req(t, 'POST', '/api/messages/labels', { mailbox: 'INBOX', uids: [a] })).statusCode, 400);
  assert.equal((await req(t, 'POST', '/api/messages/labels', { mailbox: 'INBOX', uids: [987654], add: [client.id] })).statusCode, 404);
});

test('deleting a label removes its keyword from Inbox and Archive messages', async () => {
  const client = (await req(t, 'GET', '/api/labels')).json().find((l: any) => l.name === 'Client');
  const del = await req(t, 'DELETE', `/api/labels/${client.id}`);
  assert.equal(del.statusCode, 200, del.body);
  for (const folder of ['INBOX', 'Archive']) {
    for (const flags of (await flagsOf(GM.tester, folder)).values()) assert.ok(!flags.includes(`$label_${client.id}`), folder);
  }
  assert.ok(!(await req(t, 'GET', '/api/labels')).json().some((l: any) => l.id === client.id));
  assert.equal((await req(t, 'DELETE', `/api/labels/${client.id}`)).statusCode, 404);
  // Deleting all labels does not bring the defaults back.
  assert.ok(!(await req(t, 'GET', '/api/labels')).json().some((l: any) => l.name === 'Client'));
});

test('labels on two mailboxes do not leak between accounts', async () => {
  const mine = (await req(t, 'GET', '/api/labels')).json();
  const made = (await req(t, 'POST', '/api/labels', { name: 'Tester only', colour: 'lilac' })).json();

  assert.deepEqual((await req(c, 'GET', '/api/labels')).json(), [], 'the colleague has no labels of their own yet');
  await req(c, 'POST', '/api/labels', { name: 'Client', colour: 'mint' });
  const theirs = (await req(c, 'GET', '/api/labels')).json();
  assert.deepEqual(theirs.map((l: any) => l.name), ['Client']);
  const myIds = new Set([...mine.map((l: any) => l.id), made.id]);
  assert.ok(theirs.every((l: any) => !myIds.has(l.id)));

  // The colleague cannot see, change, delete or apply the tester's label by id.
  assert.equal((await req(c, 'PATCH', `/api/labels/${made.id}`, { name: 'Hijack' })).statusCode, 404);
  assert.equal((await req(c, 'DELETE', `/api/labels/${made.id}`)).statusCode, 404);
  assert.equal((await req(c, 'GET', `/api/labels/${made.id}/messages`)).statusCode, 404);
  const cu = await put(GM.colleague, 'INBOX', 'colleague mail');
  assert.equal((await req(c, 'POST', '/api/messages/labels', { mailbox: 'INBOX', uids: [cu], add: [made.id] })).statusCode, 400);
  assert.equal((await req(t, 'GET', '/api/labels')).json().find((l: any) => l.id === made.id).name, 'Tester only');

  // A keyword the tester's mailbox does not define is not reported as a label.
  const theirClient = theirs.find((l: any) => l.name === 'Client');
  const tu = await put(GM.tester, 'INBOX', 'stray keyword', [`$label_${theirClient.id}`]);
  const item = (await req(t, 'GET', '/api/mailboxes/INBOX/messages')).json().messages.find((m: any) => m.uid === tu);
  assert.deepEqual(item.labels, []);
});
