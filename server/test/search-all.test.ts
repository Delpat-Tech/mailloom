import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { TESTER, buildTestApp, resetAccount, signIn, withImap } from './helpers.js';

function mail(o: { from: string; to: string; cc?: string; subject: string; body: string }): string {
  return [
    `From: ${o.from}`,
    `To: ${o.to}`,
    ...(o.cc ? [`Cc: ${o.cc}`] : []),
    `Subject: ${o.subject}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@x.test>`,
    'Content-Type: text/plain',
    '',
    o.body,
    ''
  ].join('\r\n');
}

type Hit = { subject: string; mailbox?: string; uid: number };

// GreenMail matches address fields (from/to/cc) against the whole address; Dovecot matches substrings.
describe('search with scope=all', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildTestApp();
    await resetAccount(TESTER);
    await withImap(TESTER, async (c) => {
      for (const f of ['Archive', 'Snoozed']) await c.mailboxCreate(f).catch(() => undefined);
      const put = (folder: string, when: string, o: Parameters<typeof mail>[0]) => c.append(folder, mail(o), [], new Date(when));
      const me = 'tester@delpat.test';
      await put('INBOX', '2026-01-01T10:00:00Z', { from: 'Ann <ann@acme.test>', to: me, subject: 'inbox old', body: 'quarterly budget' });
      await put('Sent', '2026-01-03T10:00:00Z', { from: me, to: 'bob@acme.test', cc: 'carl@acme.test', subject: 'sent mid', body: 'see attached' });
      await put('Archive', '2026-01-05T10:00:00Z', { from: 'Dee <dee@acme.test>', to: me, subject: 'archive new', body: 'budget approved' });
      await put('Snoozed', '2026-01-04T10:00:00Z', { from: 'Eve <eve@acme.test>', to: me, subject: 'snoozed item', body: 'budget later' });
      await put('Trash', '2026-01-06T10:00:00Z', { from: 'Fay <fay@acme.test>', to: me, subject: 'trash item', body: 'budget gone' });
      await put('Junk', '2026-01-07T10:00:00Z', { from: 'Spam <spam@acme.test>', to: me, subject: 'junk item', body: 'budget offer' });
    });
  });
  after(() => app.close());

  async function search(query: string): Promise<{ messages: Hit[]; total: number }> {
    const t = await signIn(app, TESTER);
    const res = await app.inject({ method: 'GET', url: `/api/mailboxes/INBOX/messages?${query}`, headers: t.headers });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  }
  const subjects = (r: { messages: Hit[] }) => r.messages.map((m) => m.subject);

  test('free text across all folders except Trash and Junk, newest first, with mailbox paths', async () => {
    const r = await search('scope=all&search=budget');
    assert.deepEqual(subjects(r), ['archive new', 'snoozed item', 'inbox old']);
    assert.deepEqual(r.messages.map((m) => m.mailbox), ['Archive', 'Snoozed', 'INBOX']);
    assert.equal(r.total, 3);
  });

  test('default (no scope) still searches only the folder in the path', async () => {
    const r = await search('search=budget');
    assert.deepEqual(subjects(r), ['inbox old']);
  });

  test('each field: from, to, cc, subject, body', async () => {
    assert.deepEqual(subjects(await search('scope=all&from=dee@acme.test')), ['archive new']);
    assert.deepEqual(subjects(await search('scope=all&to=bob@acme.test')), ['sent mid']);
    assert.deepEqual(subjects(await search('scope=all&cc=carl@acme.test')), ['sent mid']);
    assert.deepEqual(subjects(await search('scope=all&subject=snoozed')), ['snoozed item']);
    assert.deepEqual(subjects(await search('scope=all&body=attached')), ['sent mid']);
    assert.deepEqual(subjects(await search('scope=all&body=approved')), ['archive new']);
  });

  test('fields combine (AND) and paging works over the merged list', async () => {
    assert.deepEqual(subjects(await search('scope=all&from=ann@acme.test&subject=old')), ['inbox old']);
    const p1 = await search('scope=all&search=budget&limit=2&page=1');
    const p2 = await search('scope=all&search=budget&limit=2&page=2');
    assert.deepEqual(subjects(p1), ['archive new', 'snoozed item']);
    assert.deepEqual(subjects(p2), ['inbox old']);
    assert.equal(p1.total, 3);
  });

  test('cc and body also work on a single folder', async () => {
    assert.deepEqual(subjects(await search('body=quarterly')), ['inbox old']);
    const t = await signIn(app, TESTER);
    const res = await app.inject({ method: 'GET', url: '/api/mailboxes/Sent/messages?cc=carl@acme.test', headers: t.headers });
    assert.deepEqual(subjects(res.json()), ['sent mid']);
  });

  test('scope=all with the attachments filter is refused', async () => {
    const t = await signIn(app, TESTER);
    const res = await app.inject({ method: 'GET', url: '/api/mailboxes/INBOX/messages?scope=all&filter=attachments', headers: t.headers });
    assert.equal(res.statusCode, 400);
  });
});

describe('search limits', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildTestApp();
    await resetAccount(TESTER);
  });
  after(() => app.close());

  test('q and every field are limited to 200 characters', async () => {
    const t = await signIn(app, TESTER);
    const get = (qs: string) => app.inject({ method: 'GET', url: `/api/mailboxes/INBOX/messages?${qs}`, headers: t.headers });
    for (const f of ['search', 'from', 'to', 'cc', 'subject', 'body']) {
      assert.equal((await get(`${f}=${'a'.repeat(201)}`)).statusCode, 400, f);
      assert.equal((await get(`${f}=${'a'.repeat(200)}`)).statusCode, 200, f);
      assert.equal((await get(`scope=all&${f}=${'a'.repeat(201)}`)).statusCode, 400, `${f} scope=all`);
    }
  });

  test('a cross-folder search only looks at the newest hits (capped)', async () => {
    const { crossFolderView } = await import('../src/services/organise.js');
    const { accountFor } = await import('./helpers.js');
    await withImap(TESTER, async (c) => {
      for (let i = 1; i <= 4; i++) await c.append('INBOX', mail({ from: 'a@acme.test', to: 'tester@delpat.test', subject: `in ${i}`, body: 'cap' }), [], new Date(`2026-02-0${i}T10:00:00Z`));
      for (let i = 1; i <= 4; i++) await c.append('Sent', mail({ from: 'tester@delpat.test', to: 'b@acme.test', subject: `out ${i}`, body: 'cap' }), [], new Date(`2026-03-0${i}T10:00:00Z`));
    });
    const r = await crossFolderView(accountFor(TESTER), { body: 'cap' }, ['INBOX', 'Sent'], 1, 50, 3);
    assert.equal(r.total, 3);
    assert.equal(r.capped, true);
    assert.deepEqual(r.messages.map((m) => m.subject), ['out 4', 'out 3', 'out 2']);
    const all = await crossFolderView(accountFor(TESTER), { body: 'cap' }, ['INBOX', 'Sent'], 1, 50);
    assert.equal(all.total, 8);
    assert.equal(all.capped, undefined);
  });
});
