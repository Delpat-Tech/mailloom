import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSlot, runningCount } from '../src/utils/limiter.js';
import { sendLiveEmail, SendError } from '../src/services/smtp.js';
import { closeUserSession, closeAllPooledClients } from '../src/services/imap.js';
import { buildTestApp, signIn, accountFor, GM, resetAccount, seedMail, waitForMail, fetchAll } from './helpers.js';

const tester = accountFor(GM.tester, 'Tester Person');

before(async () => {
  await resetAccount(GM.tester);
  await resetAccount(GM.colleague);
});
after(async () => {
  await closeUserSession(tester);
  await closeAllPooledClients();
});

function multipartBody(fields: Record<string, string>, file?: { name: string; data: Buffer }) {
  const b = '----mailloomtest';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${b}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      ),
      file.data,
      Buffer.from('\r\n')
    );
  }
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

test('limiter hands out at most max slots and frees them on release', () => {
  const r1 = acquireSlot('k', 2)!;
  const r2 = acquireSlot('k', 2)!;
  assert.equal(acquireSlot('k', 2), null);
  r1();
  r1(); // releasing twice must not free a second slot
  assert.equal(runningCount('k'), 1);
  assert.ok(acquireSlot('k', 2));
  r2();
});

test('forwarding an original over the size limit is refused before it is downloaded', async () => {
  await seedMail({
    from: GM.colleague,
    to: GM.tester,
    subject: 'big-original',
    attachments: [{ filename: 'big.bin', content: Buffer.alloc(40 * 1024, 7) }]
  });
  const inbox = (await waitForMail(GM.tester, 'INBOX', 1)).find((x) => x.mail.subject === 'big-original')!;
  try {
    await assert.rejects(
      sendLiveEmail({ ...tester, maxMessageBytes: 10 * 1024 }, {
        to: [GM.colleague],
        subject: 'Fwd: big-original',
        text: 'x',
        forwardOf: { folder: 'INBOX', uid: inbox.uid }
      }),
      (e: unknown) => e instanceof SendError && e.status === 413 && /larger than/.test(e.message)
    );
  } finally {
    // nothing to restore: the limit travels with the account config
  }
  assert.equal((await fetchAll(GM.colleague, 'INBOX')).filter((x) => x.mail.subject === 'Fwd: big-original').length, 0);
});

test('a third simultaneous send in one session gets 429 with a plain message', async () => {
  const a = await buildTestApp();
  const t = await signIn(a, GM.tester);
  const send = (i: number) =>
    a.inject({
      method: 'POST',
      url: '/api/messages/send',
      headers: t.headers,
      payload: { to: [GM.colleague], subject: `burst-${i}`, text: 'x', idempotencyKey: `burst-${i}` }
    });
  const res = await Promise.all([0, 1, 2, 3, 4].map(send));
  const codes = res.map((r) => r.statusCode);
  assert.ok(codes.filter((c) => c === 429).length >= 1, codes.join(','));
  assert.ok(codes.filter((c) => c === 200).length >= 1, codes.join(','));
  const limited = res.find((r) => r.statusCode === 429)!;
  assert.match(JSON.parse(limited.body).error, /already being sent/);
  // slots are free again afterwards
  const after = await send(9);
  assert.equal(after.statusCode, 200);
  await a.close();
});

test('an oversized upload gets 413 and the connection is closed', async () => {
  const a = await buildTestApp({ MAIL_MAX_MESSAGE_BYTES: String(10 * 1024) });
  const t = await signIn(a, GM.tester);
  try {
    const m = multipartBody(
      { payload: JSON.stringify({ to: [GM.colleague], subject: 'big upload' }) },
      { name: 'big.bin', data: Buffer.alloc(64 * 1024, 1) }
    );
    const r = await a.inject({
      method: 'POST',
      url: '/api/messages/send',
      headers: { ...t.headers, 'content-type': m.type },
      payload: m.body
    });
    assert.equal(r.statusCode, 413);
    assert.match(String(r.headers.connection), /close/i);
    // and a slot was released
    assert.equal(runningCount(`send|${tester.email.toLowerCase()}|${tester.imapHost}`), 0);
  } finally {
    await a.close();
  }
});

test('a multipart field named cid:... is rejected (no client-chosen Content-ID)', async () => {
  const a = await buildTestApp();
  const t = await signIn(a, GM.tester);
  try {
    const m = multipartBody(
      { payload: JSON.stringify({ to: [GM.colleague], subject: 'cid field', html: '<p>x</p>' }) },
      { name: 'x.html', data: Buffer.from('<p>x</p>') }
    );
    const body = Buffer.from(m.body.toString('latin1').replace('name="files"', 'name="cid:a&quot; onerror=&quot;alert(1)"'), 'latin1');
    const r = await a.inject({
      method: 'POST',
      url: '/api/messages/send',
      headers: { ...t.headers, 'content-type': m.type },
      payload: body
    });
    assert.equal(r.statusCode, 400);
  } finally {
    await a.close();
  }
});
