/**
 * End-to-end route tests: every request goes through buildTestApp + signIn, so the merged
 * routes are exercised with real sessions against GreenMail.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { closeAllPooledClients } from '../src/services/imap.js';
import { buildTestApp, signIn, GM, resetAccount, appendRaw, buildMime, fetchAll, waitForMail, type SignedIn } from './helpers.js';

let app: FastifyInstance;
let t: SignedIn;

before(async () => {
  await resetAccount(GM.tester);
  await resetAccount(GM.colleague);
  app = await buildTestApp();
  t = await signIn(app, GM.tester);
  assert.equal(t.res.statusCode, 200);
});
after(async () => {
  await app.close();
  await closeAllPooledClients();
});

const enc = encodeURIComponent;

function multipart(payload: object, file: { name: string; data: Buffer; type?: string }) {
  const b = '----mailloomroutes';
  const parts = [
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n`),
    Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`
    ),
    file.data,
    Buffer.from(`\r\n--${b}--\r\n`)
  ];
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

test('routes refuse requests without a session', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/mailboxes' });
  assert.equal(r.statusCode, 401);
  const s = await app.inject({ method: 'POST', url: '/api/messages/send', payload: { to: [GM.colleague] } });
  assert.equal(s.statusCode, 401);
});

test('send: multipart with a file delivers the attachment and keeps a Sent copy', async () => {
  const data = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251));
  const m = multipart(
    { to: [GM.colleague], subject: 'route-send', text: 'see file', idempotencyKey: 'route-send-1' },
    { name: 'data.bin', data }
  );
  const r = await app.inject({
    method: 'POST',
    url: '/api/messages/send',
    headers: { ...t.headers, 'content-type': m.type },
    payload: m.body
  });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.accepted, [GM.colleague]);
  const got = (await waitForMail(GM.colleague, 'INBOX', 1)).find((x) => x.mail.subject === 'route-send')!;
  assert.equal(got.mail.attachments.length, 1);
  assert.equal(got.mail.attachments[0].filename, 'data.bin');
  assert.ok(got.mail.attachments[0].content.equals(data));
  assert.equal((await waitForMail(GM.tester, 'Sent', 1)).filter((x) => x.mail.subject === 'route-send').length, 1);
});

test('delete moves to Trash, restore brings it back, delete in Trash is permanent, empty clears Trash', async () => {
  await resetAccount(GM.tester);
  const uid = await appendRaw(GM.tester, 'INBOX', await buildMime({ subject: 'to-trash', text: 'x' }));

  const del = await app.inject({ method: 'DELETE', url: `/api/mailboxes/INBOX/messages/${uid}`, headers: t.headers });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(del.json().permanent, false);
  const inTrash = await fetchAll(GM.tester, 'Trash');
  assert.deepEqual(inTrash.map((m) => m.mail.subject), ['to-trash']);
  assert.equal((await fetchAll(GM.tester, 'INBOX')).length, 0);

  const restored = await app.inject({
    method: 'POST',
    url: `/api/mailboxes/Trash/messages/${inTrash[0].uid}/restore`,
    headers: t.headers
  });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().success, true);
  assert.deepEqual((await fetchAll(GM.tester, 'INBOX')).map((m) => m.mail.subject), ['to-trash']);
  assert.equal((await fetchAll(GM.tester, 'Trash')).length, 0);

  await appendRaw(GM.tester, 'Trash', await buildMime({ subject: 'trash-a', text: 'a' }));
  await appendRaw(GM.tester, 'Trash', await buildMime({ subject: 'trash-b', text: 'b' }));
  const empty = await app.inject({ method: 'POST', url: `/api/mailboxes/${enc('Trash')}/empty`, headers: t.headers });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.equal(empty.json().deleted, 2);
  assert.equal((await fetchAll(GM.tester, 'Trash')).length, 0);
});

test('draft: save, reopen, replace and delete', async () => {
  await resetAccount(GM.tester);
  const save = await app.inject({
    method: 'POST',
    url: '/api/drafts',
    headers: t.headers,
    payload: { to: [GM.colleague], subject: 'route-draft', text: 'first version' }
  });
  assert.equal(save.statusCode, 200, save.body);
  const first = save.json();
  assert.equal(first.folder, 'Drafts');

  const open = await app.inject({
    method: 'GET',
    url: `/api/mailboxes/${enc(first.folder)}/messages/${first.uid}`,
    headers: t.headers
  });
  assert.equal(open.statusCode, 200, open.body);
  assert.equal(open.json().subject, 'route-draft');
  assert.match(open.json().text, /first version/);

  const again = await app.inject({
    method: 'POST',
    url: '/api/drafts',
    headers: t.headers,
    payload: { to: [GM.colleague], subject: 'route-draft', text: 'second version', replaceUid: first.uid }
  });
  assert.equal(again.statusCode, 200, again.body);
  const drafts = await fetchAll(GM.tester, 'Drafts');
  assert.equal(drafts.length, 1, 'saving again replaces the old draft');
  assert.match(drafts[0].mail.text ?? '', /second version/);

  const del = await app.inject({ method: 'DELETE', url: `/api/drafts/${again.json().uid}`, headers: t.headers });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal((await fetchAll(GM.tester, 'Drafts')).length, 0);
});

test('attachment download returns the right bytes and filename', async () => {
  await resetAccount(GM.tester);
  const content = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7) % 256));
  const uid = await appendRaw(
    GM.tester,
    'INBOX',
    await buildMime({
      subject: 'has-file',
      text: 'attached',
      attachments: [{ filename: 'report final.bin', content, contentType: 'application/octet-stream' }]
    })
  );
  const detail = await app.inject({ method: 'GET', url: `/api/mailboxes/INBOX/messages/${uid}`, headers: t.headers });
  assert.equal(detail.statusCode, 200, detail.body);
  const att = detail.json().attachments[0];
  assert.equal(att.filename, 'report final.bin');

  const dl = await app.inject({
    method: 'GET',
    url: `/api/mailboxes/INBOX/messages/${uid}/attachments/${enc(att.partId)}`,
    headers: t.headers
  });
  assert.equal(dl.statusCode, 200);
  assert.ok(dl.rawPayload.equals(content));
  assert.match(String(dl.headers['content-disposition']), /report(%20| )final\.bin/);
  assert.equal(dl.headers['x-content-type-options'], 'nosniff');
});
