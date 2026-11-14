import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { saveLiveDraft, deleteLiveDraft } from '../src/services/drafts.js';
import { getLiveMessageDetail, closeUserSession } from '../src/services/imap.js';
import { accountFor, GM, resetAccount, fetchAll, withImap } from './helpers.js';
import Fastify from 'fastify';

const tester = accountFor(GM.tester, 'Tester Person');

before(async () => {
  await resetAccount(GM.tester);
});
after(async () => {
  await closeUserSession(tester);
});

test('a draft is stored in Drafts with the \\Draft flag and can be read back', async () => {
  const saved = await saveLiveDraft(tester, {
    to: [GM.colleague],
    cc: ['cc@delpat.test'],
    bcc: ['hidden@delpat.test'],
    subject: 'Quote draft',
    text: 'First version',
    inReplyTo: 'orig@delpat.test',
    references: ['<root@delpat.test>']
  });
  assert.equal(saved.folder, 'Drafts');
  const all = await fetchAll(GM.tester, 'Drafts');
  assert.equal(all.length, 1);
  assert.equal(all[0].uid, saved.uid);
  const flags = await withImap(GM.tester, async (c) => {
    const lock = await c.getMailboxLock('Drafts');
    try {
      const m = await c.fetchOne(String(saved.uid), { flags: true }, { uid: true });
      return m ? Array.from(m.flags || []) : [];
    } finally {
      lock.release();
    }
  });
  assert.ok(flags.includes('\\Draft'));

  const d = await getLiveMessageDetail(tester, 'Drafts', saved.uid);
  assert.ok(d);
  assert.equal(d.subject, 'Quote draft');
  assert.equal(d.text?.trim(), 'First version');
  assert.deepEqual(d.to.map((a) => a.address), [GM.colleague]);
  assert.deepEqual(d.cc?.map((a) => a.address), ['cc@delpat.test']);
  assert.deepEqual(d.bcc?.map((a) => a.address), ['hidden@delpat.test']);
  assert.equal(all[0].mail.inReplyTo, '<orig@delpat.test>');
});

test('saving again replaces the old version: one draft, new content', async () => {
  await resetAccount(GM.tester);
  const v1 = await saveLiveDraft(tester, { subject: 's', text: 'v1' });
  const v2 = await saveLiveDraft(tester, { subject: 's', text: 'v2' }, v1.uid);
  const v3 = await saveLiveDraft(tester, { subject: 's', text: 'v3' }, v2.uid);
  const all = await fetchAll(GM.tester, 'Drafts');
  assert.equal(all.length, 1);
  assert.equal(all[0].uid, v3.uid);
  assert.equal(all[0].mail.text?.trim(), 'v3');
});

test('an empty-recipient draft is fine; deleting a draft removes it, deleting twice says so', async () => {
  await resetAccount(GM.tester);
  const d = await saveLiveDraft(tester, { subject: '', text: 'note to self' });
  assert.equal(await deleteLiveDraft(tester, d.uid), true);
  assert.equal((await fetchAll(GM.tester, 'Drafts')).length, 0);
  assert.equal(await deleteLiveDraft(tester, d.uid), false);
});

test('the router decodes a folder name in the URL exactly once ("%" in a folder name)', async () => {
  // Documents why routes must not decodeURIComponent again: the folder "50%25 off" is sent as "50%2525%20off".
  const app = Fastify();
  app.get('/f/:path', async (req) => (req.params as { path: string }).path);
  const res = await app.inject({ url: `/f/${encodeURIComponent('100% done')}` });
  assert.equal(res.body, '100% done');
  await app.close();
});
