import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { TESTER, appendRaw, buildTestApp, resetAccount, signIn } from './helpers.js';

function raw(opts: { from: string; to?: string; cc?: string; bcc?: string; date?: string }): string {
  return [
    `From: ${opts.from}`,
    opts.to ? `To: ${opts.to}` : '',
    opts.cc ? `Cc: ${opts.cc}` : '',
    opts.bcc ? `Bcc: ${opts.bcc}` : '',
    `Subject: s`,
    `Date: ${opts.date ?? 'Mon, 02 Nov 2026 10:00:00 +0000'}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@x.test>`,
    'Content-Type: text/plain',
    '',
    'body',
    ''
  ]
    .filter((l, i) => l !== '' || i > 5)
    .join('\r\n');
}

type Suggestion = { name: string; email: string; count: number; lastUsed: string };

describe('GET /api/contacts/suggest', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildTestApp({}, { contacts: { batchSize: 2, minIntervalMs: 0 } });
    await resetAccount(TESTER);
    const me = 'Tester <tester@delpat.test>';
    // Sent: Pat Out x2 (To), Zoe Cc x1 (Cc), Hidden Bcc x1 (Bcc), self once.
    await appendRaw(TESTER, 'Sent', raw({ from: me, to: '"Pat Out" <pat.out@acme.test>' }));
    await appendRaw(TESTER, 'Sent', raw({ from: me, to: '"Pat Out" <pat.out@acme.test>', cc: 'Zoe Cc <zoe@acme.test>' }));
    await appendRaw(TESTER, 'Sent', raw({ from: me, to: 'tester@delpat.test', bcc: 'Hidden Bcc <hidden@acme.test>' }));
    // Inbox: Pat In x5, Old Pat once long ago.
    for (let i = 0; i < 5; i++) await appendRaw(TESTER, 'INBOX', raw({ from: 'Pat In <pat.in@acme.test>', to: 'tester@delpat.test' }));
    await appendRaw(TESTER, 'INBOX', raw({ from: 'Ünï Name <UNI@Acme.test>', to: 'tester@delpat.test' }));
  });
  after(() => app.close());

  async function suggest(q: string, limit?: number): Promise<Suggestion[]> {
    const t = await signIn(app, TESTER);
    const res = await app.inject({
      method: 'GET',
      url: `/api/contacts/suggest?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`,
      headers: t.headers
    });
    assert.equal(res.statusCode, 200);
    return res.json();
  }

  test('first call builds the index (waits briefly) and returns ranked matches', async () => {
    const r = await suggest('pat');
    assert.deepEqual(r.map((s) => s.email), ['pat.out@acme.test', 'pat.in@acme.test']);
    assert.equal(r[0]!.name, 'Pat Out');
    assert.equal(r[0]!.count, 2);
    assert.equal(r[1]!.count, 5);
    assert.ok(!Number.isNaN(Date.parse(r[0]!.lastUsed)));
  });

  test('Sent weighs more than Inbox: two sent beat five received, one sent beats one received', async () => {
    const r = await suggest('pat');
    assert.equal(r[0]!.email, 'pat.out@acme.test');
  });

  test('matches name word prefixes and email prefixes, case-insensitively', async () => {
    assert.deepEqual((await suggest('OUT')).map((s) => s.email), ['pat.out@acme.test']);
    assert.deepEqual((await suggest('pat.i')).map((s) => s.email), ['pat.in@acme.test']);
    assert.deepEqual((await suggest('Zo')).map((s) => s.email), ['zoe@acme.test']);
    assert.deepEqual((await suggest('uni@')).map((s) => s.email), ['uni@acme.test']);
    assert.deepEqual((await suggest('ünï')).map((s) => s.email), ['uni@acme.test']);
    assert.deepEqual((await suggest('pat o')).map((s) => s.email), ['pat.out@acme.test']);
    assert.deepEqual(await suggest('ut'), [], 'not a prefix of any word');
  });

  test('Cc and Bcc recipients count as written-to', async () => {
    assert.equal((await suggest('hidden'))[0]?.email, 'hidden@acme.test');
    assert.equal((await suggest('zoe'))[0]?.count, 1);
  });

  test('the user\'s own addresses are never suggested', async () => {
    assert.deepEqual(await suggest('tester'), []);
    assert.deepEqual(await suggest('delpat'), []);
  });

  test('limit is honoured; empty query gives nothing', async () => {
    assert.equal((await suggest('p', 1)).length, 1);
    assert.deepEqual(await suggest(''), []);
  });

  test('suggestions are per mailbox', async () => {
    const t = await signIn(app, 'colleague@delpat.test');
    const res = await app.inject({ method: 'GET', url: '/api/contacts/suggest?q=pat', headers: t.headers });
    assert.deepEqual(res.json(), []);
  });

  test('sending refreshes the index', async () => {
    const t = await signIn(app, TESTER);
    const send = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      headers: t.headers,
      payload: { to: ['Nina Newcomer <nina@fresh.test>'], subject: 'hello', text: 'hi' }
    });
    assert.equal(send.statusCode, 200, send.body);
    await app.mailloomContacts.indexer.idle(TESTER);
    const r = await suggest('nina');
    assert.equal(r[0]?.email, 'nina@fresh.test');
    assert.equal(r[0]?.name, 'Nina Newcomer');
  });

  test('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/contacts/suggest?q=pat' });
    assert.equal(res.statusCode, 401);
  });
});
