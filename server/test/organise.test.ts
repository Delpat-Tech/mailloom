import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteLiveMessage,
  moveLiveMessage,
  restoreLiveMessage,
  emptyLiveFolder,
  markLiveMessageSpam,
  getLiveMailboxes,
  getLiveMessages,
  closeUserSession
} from '../src/services/imap.js';
import { accountFor, GM, resetAccount, appendRaw, buildMime, fetchAll, withImap } from './helpers.js';

const tester = accountFor(GM.tester);

async function put(folder: string, subject: string): Promise<number> {
  return appendRaw(GM.tester, folder, await buildMime({ subject, text: `body of ${subject}` }));
}
const subjects = async (folder: string) => (await fetchAll(GM.tester, folder)).map((m) => m.mail.subject);

before(async () => {
  await resetAccount(GM.tester);
});
after(async () => {
  await closeUserSession(tester);
});

test('delete moves the message to Trash instead of removing it', async () => {
  const uid = await put('INBOX', 'to-trash');
  const r = await deleteLiveMessage(tester, 'INBOX', uid);
  assert.equal(r.permanent, false);
  assert.equal(r.movedTo, 'Trash');
  assert.deepEqual(await subjects('INBOX'), []);
  assert.deepEqual(await subjects('Trash'), ['to-trash']);
});

test('delete inside Trash is permanent', async () => {
  const [{ uid }] = await fetchAll(GM.tester, 'Trash');
  const r = await deleteLiveMessage(tester, 'Trash', uid);
  assert.equal(r.permanent, true);
  assert.deepEqual(await subjects('Trash'), []);
});

test('delete, move and spam report failure when the message does not exist', async () => {
  await assert.rejects(deleteLiveMessage(tester, 'INBOX', 987654), /not found/i);
  await assert.rejects(moveLiveMessage(tester, 'INBOX', 987654, 'Junk'), /not found/i);
  await assert.rejects(markLiveMessageSpam(tester, 'INBOX', 987654), /not found/i);
  await assert.rejects(deleteLiveMessage(tester, 'Trash', 987654), /not found/i);
});

test('move to a folder that does not exist fails and the message stays', async () => {
  const uid = await put('INBOX', 'stays');
  await assert.rejects(moveLiveMessage(tester, 'INBOX', uid, 'NoSuchFolder'));
  assert.deepEqual(await subjects('INBOX'), ['stays']);
  await deleteLiveMessage(tester, 'INBOX', uid);
});

test('restore moves a message from Trash back to the Inbox; not from elsewhere', async () => {
  await resetAccount(GM.tester);
  const uid = await put('INBOX', 'restore-me');
  await deleteLiveMessage(tester, 'INBOX', uid);
  const [{ uid: tuid }] = await fetchAll(GM.tester, 'Trash');
  const inbox = await restoreLiveMessage(tester, 'Trash', tuid, 'Trash');
  assert.equal(inbox, 'INBOX');
  assert.deepEqual(await subjects('INBOX'), ['restore-me']);
  assert.deepEqual(await subjects('Trash'), []);
  const [{ uid: iuid }] = await fetchAll(GM.tester, 'INBOX');
  await assert.rejects(restoreLiveMessage(tester, 'INBOX', iuid, 'Trash'), /Trash/);
});

test('spam goes to Junk (marked read) and Not spam brings it back', async () => {
  await resetAccount(GM.tester);
  const uid = await put('INBOX', 'spammy');
  await markLiveMessageSpam(tester, 'INBOX', uid);
  assert.deepEqual(await subjects('INBOX'), []);
  const junk = await fetchAll(GM.tester, 'Junk');
  assert.equal(junk.length, 1);
  await restoreLiveMessage(tester, 'Junk', junk[0].uid, 'Junk');
  assert.deepEqual(await subjects('INBOX'), ['spammy']);
  assert.deepEqual(await subjects('Junk'), []);
});

test('empty Trash deletes everything for good; other folders cannot be emptied', async () => {
  await resetAccount(GM.tester);
  for (const s of ['a', 'b', 'c']) await put('Trash', s);
  await put('INBOX', 'keep');
  assert.equal(await emptyLiveFolder(tester, 'Trash'), 3);
  assert.deepEqual(await subjects('Trash'), []);
  assert.equal(await emptyLiveFolder(tester, 'Trash'), 0);
  await assert.rejects(emptyLiveFolder(tester, 'INBOX'), /Only the Trash and Junk/);
  assert.deepEqual(await subjects('INBOX'), ['keep']);
});

test('unknown folders keep their own names, nested folders know their depth, "%" folders work', async () => {
  await resetAccount(GM.tester); // makes sure Sent, Drafts, Trash and Junk exist on a fresh server
  // Own, uniquely named folders: nothing here depends on what other tests left behind.
  const tag = `${process.pid}${Date.now().toString(36)}`;
  const parent = `Projects ${tag}`;
  const nameAlpha = `Alpha ${tag}`;
  const percent = `100% done ${tag}`;
  const consent = `Consent forms ${tag}`;
  const nested = await withImap(GM.tester, async (c) => {
    const d = (await c.list())[0].delimiter || '/';
    const child = `${parent}${d}${nameAlpha}`;
    for (const n of [parent, child, percent, consent]) await c.mailboxCreate(n);
    return child;
  });
  try {
    const folders = await getLiveMailboxes(tester);
    const by = (n: string) => folders.find((f) => f.name === n);
    assert.equal(by(parent)?.specialUse, undefined);
    assert.equal(by(percent)?.specialUse, undefined);
    assert.equal(by(consent)?.specialUse, undefined, 'must not be mistaken for Sent');
    assert.equal(by('INBOX')?.specialUse, 'Inbox');
    assert.equal(by('Trash')?.specialUse, 'Trash');
    assert.equal(by('Sent')?.specialUse, 'Sent');
    const alpha = by(nameAlpha);
    assert.ok(alpha, 'nested folder listed by its own name');
    assert.equal(alpha.depth, 1);
    assert.ok(alpha.parentPath && by(parent)?.path === alpha.parentPath);

    const uid = await put(percent, 'percent');
    assert.ok(uid);
    const list = await getLiveMessages(tester, percent);
    assert.equal(list.total, 1);
    assert.equal(list.messages[0].subject, 'percent');
  } finally {
    await withImap(GM.tester, async (c) => {
      for (const n of [nested, parent, percent, consent]) await c.mailboxDelete(n).catch(() => {});
    });
  }
});
