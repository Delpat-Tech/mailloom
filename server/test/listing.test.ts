import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, signIn, resetAccount, buildMime, withImap, GM, type SignedIn } from './helpers.js';
import { parseDsn, parsePlainBounce, reasonFor } from '../src/services/bounce.js';
import { threadIdFor } from '../src/services/threading.js';

let app: FastifyInstance;
let t: SignedIn;

async function put(folder: string, raw: Buffer | string, flags: string[] = [], date?: Date): Promise<number> {
  return withImap(GM.tester, async (c) => {
    await c.mailboxCreate(folder).catch(() => {});
    const r = await c.append(folder, raw, flags, date);
    if (!r || !r.uid) throw new Error('append failed');
    return r.uid;
  });
}

const list = async (folder: string, query = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/mailboxes/${encodeURIComponent(folder)}/messages${query}`, headers: t.headers });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { messages: Array<Record<string, any>>; total: number };
};

const DSN = (status: string, diag: string, subject: string, recipient: string) =>
  [
    'Return-Path: <>',
    'From: MAILER-DAEMON@delpat.test (Mail Delivery System)',
    'Subject: Undelivered Mail Returned to Sender',
    'To: tester@delpat.test',
    'Date: Fri, 13 Nov 2026 10:01:00 +0000',
    `Message-ID: <dsn-${status}@mail.delpat.test>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=delivery-status;',
    '\tboundary="B0UND/mail.delpat.test"',
    '',
    'This is a MIME-encapsulated message.',
    '',
    '--B0UND/mail.delpat.test',
    'Content-Description: Notification',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'This is the mail system at host mail.delpat.test.',
    '',
    "I'm sorry to have to inform you that your message could not",
    'be delivered to one or more recipients.',
    '',
    `<${recipient}>: host mx.example.org[203.0.113.5] said: ${diag}`,
    '',
    '--B0UND/mail.delpat.test',
    'Content-Description: Delivery report',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mail.delpat.test',
    'X-Postfix-Queue-ID: 4ABC123',
    'X-Postfix-Sender: rfc822; tester@delpat.test',
    'Arrival-Date: Fri, 13 Nov 2026 10:00:00 +0000 (UTC)',
    '',
    `Final-Recipient: rfc822; ${recipient}`,
    `Original-Recipient: rfc822;${recipient}`,
    'Action: failed',
    `Status: ${status}`,
    'Remote-MTA: dns; mx.example.org',
    `Diagnostic-Code: smtp; ${diag.slice(0, 30)}`,
    `    ${diag.slice(30)}`,
    '',
    '--B0UND/mail.delpat.test',
    'Content-Description: Undelivered Message Headers',
    'Content-Type: text/rfc822-headers',
    '',
    'Return-Path: <tester@delpat.test>',
    'From: Tester <tester@delpat.test>',
    `To: ${recipient}`,
    `Subject: ${subject}`,
    'Message-ID: <orig-1@delpat.test>',
    'Date: Fri, 13 Nov 2026 10:00:00 +0000',
    '',
    '--B0UND/mail.delpat.test--',
    ''
  ].join('\r\n');

const EXIM_BOUNCE = [
  'From: Mail Delivery System <Mailer-Daemon@mx.other.test>',
  'To: tester@delpat.test',
  'Subject: Mail delivery failed: returning message to sender',
  'Message-ID: <exim-1@mx.other.test>',
  'Date: Fri, 13 Nov 2026 11:00:00 +0000',
  'Content-Type: text/plain; charset=us-ascii',
  '',
  'This message was created automatically by mail delivery software.',
  '',
  'A message that you sent could not be delivered to one or more of its',
  'recipients. This is a permanent error. The following address(es) failed:',
  '',
  '  someone@far.example',
  '    host far.example [10.4.5.6]',
  '    SMTP error from remote mail server after RCPT TO:<someone@far.example>:',
  '    550 5.7.1 Message rejected as spam by Content Filtering',
  '',
  '------ This is a copy of the message, including all the headers. ------',
  '',
  'Return-path: <tester@delpat.test>',
  'Subject: Invoice 42',
  'From: tester@delpat.test',
  '',
  'Please find the invoice.',
  ''
].join('\r\n');

before(async () => {
  await resetAccount(GM.tester);
  await withImap(GM.tester, async (c) => {
    await c.mailboxCreate('Archive').catch(() => {});
    for (const f of ['Archive', 'Snoozed']) {
      const lock = await c.getMailboxLock(f).catch(() => null);
      if (!lock) continue;
      try {
        await c.messageDelete('1:*').catch(() => {});
      } finally {
        lock.release();
      }
    }
  });
  app = await buildTestApp();
  t = await signIn(app, GM.tester);
  assert.equal(t.res.statusCode, 200);
});

after(async () => {
  await app.close();
});

test('filters: unread, starred and attachments use IMAP search; items carry the new fields', async () => {
  await put('INBOX', await buildMime({ subject: 'plain read', text: 'a', messageId: '<f1@delpat.test>' }), ['\\Seen']);
  await put('INBOX', await buildMime({ subject: 'plain unread', text: 'b', messageId: '<f2@delpat.test>' }));
  await put('INBOX', await buildMime({ subject: 'starred one', text: 'c', messageId: '<f3@delpat.test>' }), ['\\Seen', '\\Flagged']);
  await put(
    'INBOX',
    await buildMime({ subject: 'with file', text: 'd', messageId: '<f4@delpat.test>', attachments: [{ filename: 'a.pdf', content: Buffer.from('%PDF-1.4') }] }),
    ['\\Seen']
  );

  const all = await list('INBOX');
  assert.equal(all.total, 4);
  for (const m of all.messages) {
    assert.ok(Array.isArray(m.labels));
    assert.match(m.threadId, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(m.threadCount, 1);
    assert.equal(typeof m.hasAttachments, 'boolean');
    assert.equal(m.bounce, undefined);
  }
  assert.equal(all.messages.find((m) => m.subject === 'plain read')!.threadId, threadIdFor({ messageId: '<f1@delpat.test>', fallbackKey: '' }));

  assert.deepEqual((await list('INBOX', '?filter=unread')).messages.map((m) => m.subject), ['plain unread']);
  assert.deepEqual((await list('INBOX', '?filter=starred')).messages.map((m) => m.subject), ['starred one']);
  const att = await list('INBOX', '?filter=attachments');
  assert.deepEqual(att.messages.map((m) => m.subject), ['with file']);
  assert.equal(att.messages[0]!.hasAttachments, true);
  assert.equal(att.total, 1);
  // Filters combine with search.
  assert.equal((await list('INBOX', '?filter=unread&search=starred')).total, 0);

  const bad = await app.inject({ method: 'GET', url: '/api/mailboxes/INBOX/messages?filter=everything', headers: t.headers });
  assert.equal(bad.statusCode, 400);
});

test('bounces: a real-shaped Postfix DSN and an Exim text bounce get a plain summary', async () => {
  await resetAccount(GM.tester);
  await put('INBOX', DSN('5.1.1', '550 5.1.1 <nobody@example.org>: Recipient address rejected: User unknown in virtual mailbox table', '=?UTF-8?Q?Quarterly_r=C3=A9port?=', 'nobody@example.org'));
  await put('INBOX', DSN('5.2.2', '552 5.2.2 Mailbox full: user is over quota', 'Lunch', 'full@example.org'));
  await put('INBOX', EXIM_BOUNCE);
  await put('INBOX', await buildMime({ subject: 'not a bounce', text: 'hello' }));

  const { messages } = await list('INBOX');
  const by = (s: string) => messages.filter((m) => m.bounce && m.bounce.recipient === s)[0]?.bounce;
  assert.deepEqual(by('nobody@example.org'), { originalSubject: 'Quarterly réport', recipient: 'nobody@example.org', reason: 'address does not exist' });
  assert.deepEqual(by('full@example.org'), { originalSubject: 'Lunch', recipient: 'full@example.org', reason: 'mailbox full' });
  assert.deepEqual(by('someone@far.example'), { originalSubject: 'Invoice 42', recipient: 'someone@far.example', reason: 'rejected as spam' });
  assert.equal(messages.find((m) => m.subject === 'not a bounce')!.bounce, undefined);
});

test('bounce reasons in plain English', async () => {
  assert.equal(reasonFor('5.1.1'), 'address does not exist');
  assert.equal(reasonFor('4.2.2'), 'mailbox full');
  assert.equal(reasonFor('5.7.1'), 'rejected as spam');
  assert.equal(reasonFor('4.4.1'), 'server could not be reached');
  assert.equal(reasonFor('5.4.4'), 'server could not be reached');
  assert.equal(reasonFor(undefined, 'Host or domain name not found. Name service error'), 'server could not be reached');
  assert.equal(reasonFor('5.0.0', 'something odd'), 'could not be delivered');
  const delayed = await parseDsn(
    'Reporting-MTA: dns; a\n\nFinal-Recipient: rfc822; late@x.example\nAction: delayed\nStatus: 4.4.1\nDiagnostic-Code: X-Postfix; connect to x.example: Connection timed out\n',
    ''
  );
  assert.deepEqual(delayed, { originalSubject: '', recipient: 'late@x.example', reason: 'server could not be reached' });
  const plain = await parsePlainBounce('<gone@y.example>: host y.example said: 550 No such user here\n', 'tester@delpat.test');
  assert.equal(plain.recipient, 'gone@y.example');
  assert.equal(plain.reason, 'address does not exist');
});

test('starred view spans Inbox and Archive (not Trash), newest first, with mailbox', async () => {
  await resetAccount(GM.tester);
  await put('INBOX', await buildMime({ subject: 'star inbox' }), ['\\Flagged'], new Date('2026-11-10T10:00:00Z'));
  await put('Archive', await buildMime({ subject: 'star archive' }), ['\\Flagged'], new Date('2026-11-12T10:00:00Z'));
  await put('Trash', await buildMime({ subject: 'star trash' }), ['\\Flagged'], new Date('2026-11-13T10:00:00Z'));
  await put('INBOX', await buildMime({ subject: 'no star' }));

  const res = await app.inject({ method: 'GET', url: '/api/views/starred?page=1&limit=10', headers: t.headers });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.total, 2);
  assert.deepEqual(body.messages.map((m: any) => [m.subject, m.mailbox]), [
    ['star archive', 'Archive'],
    ['star inbox', 'INBOX']
  ]);
  const p2 = (await app.inject({ method: 'GET', url: '/api/views/starred?page=2&limit=1', headers: t.headers })).json();
  assert.deepEqual(p2.messages.map((m: any) => m.subject), ['star inbox']);

  const anon = await app.inject({ method: 'GET', url: '/api/views/starred' });
  assert.equal(anon.statusCode, 401);
});

test('a conversation across Inbox and Sent: same threadId, threadCount 2, thread oldest first', async () => {
  await resetAccount(GM.tester);
  await put(
    'INBOX',
    await buildMime({ from: 'Colleague <colleague@delpat.test>', subject: 'Budget', text: 'Shall we?', messageId: '<root-1@delpat.test>' }),
    ['\\Seen'],
    new Date('2026-11-10T09:00:00Z')
  );
  await put(
    'Sent',
    await buildMime({
      from: 'Tester <tester@delpat.test>',
      to: 'Colleague <colleague@delpat.test>',
      subject: 'Re: Budget',
      text: 'Yes, let us.',
      messageId: '<reply-1@delpat.test>',
      inReplyTo: '<root-1@delpat.test>',
      references: '<root-1@delpat.test>'
    }),
    ['\\Seen'],
    new Date('2026-11-10T10:00:00Z')
  );
  await put('INBOX', await buildMime({ subject: 'Unrelated', messageId: '<other@delpat.test>' }));

  const inbox = await list('INBOX');
  const root = inbox.messages.find((m) => m.subject === 'Budget')!;
  assert.equal(root.threadCount, 2);
  assert.equal(inbox.messages.find((m) => m.subject === 'Unrelated')!.threadCount, 1);
  const sent = await list('Sent');
  assert.equal(sent.messages[0]!.threadId, root.threadId);
  assert.equal(sent.messages[0]!.threadCount, 2);

  const res = await app.inject({ method: 'GET', url: `/api/threads/${root.threadId}?mailbox=INBOX`, headers: t.headers });
  assert.equal(res.statusCode, 200, res.body);
  const th = res.json();
  assert.equal(th.subject, 'Budget');
  assert.deepEqual(th.messages.map((m: any) => [m.mailbox, m.isOwn, m.from.address]), [
    ['INBOX', false, 'colleague@delpat.test'],
    ['Sent', true, 'tester@delpat.test']
  ]);
  assert.match(th.messages[0].snippet, /Shall we/);
  assert.ok(th.messages.every((m: any) => typeof m.uid === 'number' && typeof m.date === 'string'));
  const addrs = th.participants.map((p: any) => p.address).sort();
  assert.ok(addrs.includes('colleague@delpat.test') && addrs.includes('tester@delpat.test'));

  // Moving the reply out of Sent (to Trash) drops it from the count on the next list.
  await withImap(GM.tester, async (c) => {
    const lock = await c.getMailboxLock('Sent');
    try {
      await c.messageMove('1:*', 'Trash');
    } finally {
      lock.release();
    }
  });
  assert.equal((await list('INBOX')).messages.find((m) => m.subject === 'Budget')!.threadCount, 1);

  assert.equal((await app.inject({ method: 'GET', url: '/api/threads/not-an-id', headers: t.headers })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/threads/AAAAAAAAAAAAAAAA', headers: t.headers })).statusCode, 404);
});
