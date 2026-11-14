import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendLiveEmail, clearIdempotencyStore, SendError } from '../src/services/smtp.js';
import { closeUserSession, isImapAuthError } from '../src/services/imap.js';
import { accountFor, GM, resetAccount, seedMail, waitForMail, fetchAll } from './helpers.js';

const tester = accountFor(GM.tester, 'Tester Person');

before(async () => {
  await resetAccount(GM.tester);
  await resetAccount(GM.colleague);
});
after(async () => {
  await closeUserSession(tester);
});

async function inboxMail(subject: string) {
  const end = Date.now() + 5000;
  for (;;) {
    const m = (await fetchAll(GM.colleague, 'INBOX')).filter((x) => x.mail.subject === subject);
    if (m.length > 0 || Date.now() > end) return m;
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('plain text is HTML-escaped in the html part and intact in the text part', async () => {
  const text = 'a<b & c "q"\nsecond <script>x</script>';
  const r = await sendLiveEmail(tester, { to: [GM.colleague], subject: 'escape', text });
  assert.equal(r.rejected.length, 0);
  const mails = await inboxMail('escape');
  assert.equal(mails.length, 1);
  const m = mails[0].mail;
  assert.equal(m.text?.trim(), text);
  assert.ok(m.html && m.html.includes('a&lt;b &amp; c'), String(m.html));
  assert.ok(!String(m.html).includes('<script>'));
});

test('From is the signed-in account as name and address', async () => {
  await sendLiveEmail(tester, { to: [GM.colleague], subject: 'from-check', text: 'x' });
  const m = (await inboxMail('from-check'))[0];
  assert.equal(m.mail.from?.value[0].address, GM.tester);
  assert.equal(m.mail.from?.value[0].name, 'Tester Person');
});

test('reply headers In-Reply-To and References are set', async () => {
  const r = await sendLiveEmail(tester, {
    to: [GM.colleague],
    subject: 'Re: thread',
    text: 'reply',
    inReplyTo: 'orig-1@delpat.test',
    references: ['<root@delpat.test>', '<orig-1@delpat.test>']
  });
  assert.ok(r.messageId);
  const m = (await inboxMail('Re: thread'))[0];
  assert.equal(m.mail.inReplyTo, '<orig-1@delpat.test>');
  assert.deepEqual(m.mail.references, ['<root@delpat.test>', '<orig-1@delpat.test>']);
});

test('Sent copy has the same Message-ID, keeps Bcc, and is reported saved', async () => {
  const r = await sendLiveEmail(tester, {
    to: [GM.colleague],
    bcc: ['hidden@delpat.test'],
    subject: 'sent-copy',
    text: 'body'
  });
  assert.equal(r.sentCopySaved, true);
  const sent = (await waitForMail(GM.tester, 'Sent', 1)).find((x) => x.mail.subject === 'sent-copy')!;
  assert.equal(sent.mail.messageId, r.messageId);
  assert.match(sent.raw, /^Bcc:.*hidden@delpat\.test/im);
  const delivered = (await inboxMail('sent-copy'))[0];
  assert.equal(delivered.mail.messageId, r.messageId);
  assert.doesNotMatch(delivered.raw, /^Bcc:/im);
});

test('a failed Sent copy is reported, not hidden', async () => {
  const bad = { ...tester, imapPort: 1 };
  const r = await sendLiveEmail(bad, { to: [GM.colleague], subject: 'no-sent-copy', text: 'x' });
  assert.equal(r.sentCopySaved, false);
  assert.ok(r.sentCopyError);
  const sent = (await fetchAll(GM.tester, 'Sent')).filter((x) => x.mail.subject === 'no-sent-copy');
  assert.equal(sent.length, 0);
});

test('a 2 MiB attachment is delivered intact', async () => {
  const content = Buffer.alloc(2 * 1024 * 1024, 7);
  await sendLiveEmail(tester, {
    to: [GM.colleague],
    subject: 'big-attachment',
    text: 'see file',
    attachments: [{ filename: 'big.bin', content, contentType: 'application/octet-stream' }]
  });
  const m = (await inboxMail('big-attachment'))[0];
  assert.equal(m.mail.attachments.length, 1);
  assert.ok(m.mail.attachments[0].content.equals(content));
});

test('attachments over the configured limit are refused before sending', async () => {
  const limited = { ...tester, maxMessageBytes: 100 * 1024 };
  {
    await assert.rejects(
      sendLiveEmail(limited, {
        to: [GM.colleague],
        subject: 'too-big',
        text: 'x',
        attachments: [{ filename: 'a.bin', content: Buffer.alloc(150 * 1024) }]
      }),
      (e: unknown) => e instanceof SendError && e.status === 413
    );
    await assert.rejects(
      sendLiveEmail(limited, {
        to: [GM.colleague],
        subject: 'too-big-total',
        text: 'x',
        attachments: [
          { filename: 'a.bin', content: Buffer.alloc(60 * 1024) },
          { filename: 'b.bin', content: Buffer.alloc(60 * 1024) }
        ]
      }),
      (e: unknown) => e instanceof SendError && e.status === 413
    );
  }
  const all = await fetchAll(GM.colleague, 'INBOX');
  assert.equal(all.filter((x) => x.mail.subject?.startsWith('too-big')).length, 0);
});

test('forward includes the original attachments', async () => {
  const content = Buffer.from('original attachment data');
  await seedMail({
    from: GM.colleague,
    to: GM.tester,
    subject: 'with-file',
    attachments: [{ filename: 'orig.txt', content }]
  });
  const inbox = (await waitForMail(GM.tester, 'INBOX', 1)).find((x) => x.mail.subject === 'with-file')!;
  await sendLiveEmail(tester, {
    to: [GM.colleague],
    subject: 'Fwd: with-file',
    text: 'fyi',
    forwardOf: { folder: 'INBOX', uid: inbox.uid }
  });
  const m = (await inboxMail('Fwd: with-file'))[0];
  assert.equal(m.mail.attachments.length, 1);
  assert.equal(m.mail.attachments[0].filename, 'orig.txt');
  assert.ok(m.mail.attachments[0].content.equals(content));
});

test('a recipient the server rejects is never reported as accepted', async () => {
  let result: unknown;
  let error: unknown;
  try {
    result = await sendLiveEmail(tester, { to: ['nobody-without-domain'], subject: 'rej', text: 'x' });
  } catch (e) {
    error = e;
  }
  assert.equal(result, undefined, 'must not report success');
  assert.ok(error instanceof SendError);
  assert.match((error as Error).message, /Not a valid address: nobody-without-domain/);
});

test('a rejected SMTP login is an auth error (ends the session) without transcript details', async () => {
  const bad = { ...tester, smtpPass: 'wrong-password' };
  await assert.rejects(sendLiveEmail(bad, { to: [GM.colleague], subject: 'auth', text: 'x' }), (e: unknown) => {
    assert.ok(isImapAuthError(e));
    assert.doesNotMatch((e as Error).message, /\b(535|5\.\d\.\d|EHLO|127\.0\.0\.1|wrong-password)\b/i);
    return true;
  });
});

test('the same idempotency key sends only once', async () => {
  clearIdempotencyStore();
  const p = { to: [GM.colleague], subject: 'idem', text: 'once', idempotencyKey: 'key-1' };
  const [a, b] = await Promise.all([sendLiveEmail(tester, p), sendLiveEmail(tester, p)]);
  const c = await sendLiveEmail(tester, p);
  assert.equal(a.messageId, b.messageId);
  assert.equal(a.messageId, c.messageId);
  await new Promise((r) => setTimeout(r, 500));
  const got = (await fetchAll(GM.colleague, 'INBOX')).filter((x) => x.mail.subject === 'idem');
  assert.equal(got.length, 1);
  const d = await sendLiveEmail(tester, { ...p, idempotencyKey: 'key-2' });
  assert.notEqual(d.messageId, a.messageId);
});

test('a failed send can be retried with the same key', async () => {
  clearIdempotencyStore();
  const bad = { ...tester, smtpPass: 'nope' };
  const p = { to: [GM.colleague], subject: 'retry', text: 'x', idempotencyKey: 'key-retry' };
  await assert.rejects(sendLiveEmail(bad, p));
  const ok = await sendLiveEmail(tester, p);
  assert.ok(ok.messageId);
});
