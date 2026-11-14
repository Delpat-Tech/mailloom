import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendLiveEmail, clearIdempotencyStore, SendError } from '../src/services/smtp.js';
import { saveLiveDraft } from '../src/services/drafts.js';
import { prepareRichBody } from '../src/services/richbody.js';
import { sanitizeOutgoingHtml, htmlToPlainText } from '../src/utils/outgoing.js';
import { closeUserSession, getLiveMessageDetail, getLiveMessages } from '../src/services/imap.js';
import { simpleParser } from 'mailparser';
import { accountFor, GM, resetAccount, fetchAll, waitForMail, buildTestApp, signIn } from './helpers.js';

const tester = accountFor(GM.tester, 'Tester Person');
const colleague = accountFor(GM.colleague, 'Colleague');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const dataUri = (b: Buffer, type = 'image/png') => `data:${type};base64,${b.toString('base64')}`;

before(async () => {
  clearIdempotencyStore();
  await resetAccount(GM.tester);
  await resetAccount(GM.colleague);
});
after(async () => {
  await closeUserSession(tester);
  await closeUserSession(colleague);
});

async function inboxMail(subject: string) {
  const end = Date.now() + 5000;
  for (;;) {
    const m = (await fetchAll(GM.colleague, 'INBOX')).filter((x) => x.mail.subject === subject);
    if (m.length > 0 || Date.now() > end) return m;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** The html part as sent (mailparser would otherwise swap cid: for data: URIs). */
async function sentHtml(raw: string): Promise<string> {
  return String((await simpleParser(raw, { skipImageLinks: true })).html);
}

/** The raw MIME of a mail, headers of every part, so structure can be asserted. */
function contentTypes(raw: string): string[] {
  return [...raw.matchAll(/^Content-Type:\s*([^;\r\n]+)/gim)].map((m) => m[1].trim().toLowerCase());
}

test('a body image is sent inline: multipart/related, Content-ID referenced by cid:, no attachment, text alternative', async () => {
  const r = await sendLiveEmail(tester, {
    to: [GM.colleague],
    subject: 'inline-logo',
    html: `<p>Hello <strong>team</strong></p><p><img src="${dataUri(PNG)}" alt="logo"></p><p>Bye</p>`
  });
  assert.equal(r.rejected.length, 0);
  const m = (await inboxMail('inline-logo'))[0];
  const types = contentTypes(m.raw);
  assert.ok(types.includes('multipart/alternative'), types.join(','));
  assert.ok(types.includes('multipart/related'), types.join(','));
  assert.ok(types.includes('text/plain'));
  assert.ok(types.includes('text/html'));
  assert.ok(types.includes('image/png'));
  // the image part: inline + Content-ID, never "attachment"
  assert.match(m.raw, /Content-Disposition:\s*inline/i);
  assert.doesNotMatch(m.raw, /Content-Disposition:\s*attachment/i);
  const cid = /^Content-ID:\s*<([^>]+)>/im.exec(m.raw)?.[1];
  assert.ok(cid, 'image has a Content-ID');
  const html = await sentHtml(m.raw);
  assert.ok(html.includes(`src="cid:${cid}"`), html);
  assert.ok(!html.includes('data:image'));
  assert.match(m.mail.text || '', /Hello team/);
  assert.match(m.mail.text || '', /\[logo\]/);
  // mailparser sees one image, shown inline, not a file the reader must download
  assert.equal(m.mail.attachments.length, 1);
  assert.equal(m.mail.attachments[0].contentDisposition, 'inline');
  assert.equal(m.mail.attachments[0].related, true);
  assert.deepEqual(m.mail.attachments[0].content, PNG);

  // our own reader: renders the logo in the body and lists no attachment
  const d = (await getLiveMessageDetail(colleague, 'INBOX', m.uid))!;
  assert.ok(d.html!.includes(`src="data:image/png;base64,${PNG.toString('base64')}"`));
  assert.equal(d.attachments.filter((a) => !a.isInline).length, 0);
  const list = await getLiveMessages(colleague, 'INBOX');
  assert.equal(list.messages.find((x) => x.subject === 'inline-logo')!.hasAttachments, false);
});

test('the Sent copy has the same structure and the same Message-ID', async () => {
  const r = await sendLiveEmail(tester, {
    to: [GM.colleague],
    bcc: ['hidden@delpat.test'],
    subject: 'inline-sent-copy',
    html: `<p>x</p><img src="${dataUri(PNG)}">`
  });
  assert.equal(r.sentCopySaved, true);
  const sent = (await waitForMail(GM.tester, 'Sent', 1)).find((x) => x.mail.subject === 'inline-sent-copy')!;
  assert.equal(sent.mail.messageId, r.messageId);
  const types = contentTypes(sent.raw);
  assert.ok(types.includes('multipart/related') && types.includes('multipart/alternative'));
  assert.doesNotMatch(sent.raw, /Content-Disposition:\s*attachment/i);
  assert.match(sent.raw, /^Bcc:.*hidden@delpat\.test/im);
  const cid = /^Content-ID:\s*<([^>]+)>/im.exec(sent.raw)?.[1];
  assert.ok(cid && (await sentHtml(sent.raw)).includes(`cid:${cid}`));
});

test('a signature logo arrives inline, next to a real attachment that stays an attachment', async () => {
  const sig = `<p>Rahul Sharma<br>Delpat</p><p><img src="${dataUri(PNG)}" alt="Delpat logo"></p>`;
  await sendLiveEmail(tester, {
    to: [GM.colleague],
    subject: 'with-signature',
    html: `<p>Body</p>${sig}<blockquote><p>old text</p></blockquote>`,
    attachments: [{ filename: 'report.pdf', content: Buffer.from('%PDF-1.4 x'), contentType: 'application/pdf' }]
  });
  const m = (await inboxMail('with-signature'))[0];
  assert.ok(contentTypes(m.raw).includes('multipart/mixed'));
  assert.ok(contentTypes(m.raw).includes('multipart/related'));
  const logo = m.mail.attachments.find((a) => a.contentType === 'image/png')!;
  assert.equal(logo.contentDisposition, 'inline');
  assert.ok(logo.cid);
  const pdf = m.mail.attachments.find((a) => a.filename === 'report.pdf')!;
  assert.equal(pdf.contentDisposition, 'attachment');
  const d = (await getLiveMessageDetail(colleague, 'INBOX', m.uid))!;
  assert.deepEqual(d.attachments.filter((a) => !a.isInline).map((a) => a.filename), ['report.pdf']);
  assert.match(m.mail.text || '', /> old text/);
});

test('cid: images in the HTML are always dropped (only data: images come in)', async () => {
  await sendLiveEmail(tester, {
    to: [GM.colleague],
    subject: 'cid-dropped',
    html:
      '<p>hi</p><img src="cid:mine@x"><img src="https://evil.example/pixel.png"><img src="file:///etc/passwd">'
  });
  const m = (await inboxMail('cid-dropped'))[0];
  const html = await sentHtml(m.raw);
  assert.ok(!html.includes('cid:') && !html.includes('evil.example') && !html.includes('file:'));
  assert.equal(m.mail.attachments.length, 0);
});

test('a picture whose base64 is far over the limit is refused before decoding', () => {
  const big = 'A'.repeat(Math.ceil(((2 * 1024 * 1024 + 100) * 4) / 3));
  assert.throws(() => prepareRichBody(`<img src="data:image/png;base64,${big}">`, 'x.test', { maxTotal: 50 * 1024 * 1024 }), /larger than/);
});

test('outgoing sanitiser strips scripts, event handlers, styles, remote images and bad links', () => {
  const dirty =
    '<p onclick="x()" style="position:fixed" class="a">Hi<script>alert(1)</script></p>' +
    '<style>body{background:url(http://evil/x)}</style>' +
    '<img src="http://evil.example/a.png" onerror="x()"><img src="https://evil.example/b.png">' +
    '<img src="javascript:alert(1)"><img src="data:text/html;base64,PHNjcmlwdD4=">' +
    '<a href="javascript:alert(1)">bad</a><a href="https://ok.example/" onmouseover="x()">good</a>' +
    '<iframe src="https://evil.example"></iframe><form action="x"><input></form>' +
    '<img src="data:image/png;base64,AAAA">';
  const clean = sanitizeOutgoingHtml(dirty);
  assert.doesNotMatch(clean, /script|onclick|onerror|onmouseover|style|class=|evil|javascript|iframe|form|<input/i);
  assert.match(clean, /<a href="https:\/\/ok\.example\/" rel="noopener noreferrer">good<\/a>/);
  assert.match(clean, /<a rel="noopener noreferrer">bad<\/a>/);
  assert.equal((clean.match(/<img/g) || []).length, 1, 'only the data:image/png survives');
  assert.match(clean, /<p>Hi<\/p>/);
});

test('plain-text alternative: links, lists, quotes', () => {
  const t = htmlToPlainText(
    '<p>Hi <a href="https://x.example/">site</a></p><ul><li>one</li><li>two</li></ul>' +
      '<blockquote><p>quoted &amp; more</p></blockquote>'
  );
  assert.match(t, /Hi site \(https:\/\/x\.example\/\)/);
  assert.match(t, /- one\n- two/);
  assert.match(t, /> quoted & more/);
});

test('pictures: 2 MB each, a non-image is refused, and the total stays within the message limit', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 1)]);
  assert.throws(() => prepareRichBody(`<img src="${dataUri(big)}">`, 'x.test', { maxTotal: 50 * 1024 * 1024 }), /larger than the 2 MB/);
  assert.throws(
    () => prepareRichBody(`<img src="${dataUri(Buffer.from('not an image at all'))}">`, 'x.test', { maxTotal: 1e6 }),
    /not a PNG/
  );
  const one = Buffer.concat([PNG, Buffer.alloc(1500)]);
  const two = Buffer.concat([PNG, Buffer.alloc(1501)]);
  assert.throws(
    () => prepareRichBody(`<img src="${dataUri(one)}"><img src="${dataUri(two)}">`, 'x.test', { maxTotal: 3000 }),
    /together are larger/
  );
  // same picture twice is one part
  const same = prepareRichBody(`<img src="${dataUri(PNG)}"><img src="${dataUri(PNG)}">`, 'x.test', { maxTotal: 1e6 });
  assert.equal(same.inline.length, 1);

  // via the send path: total with attachments over the limit -> 413-style SendError, nothing sent
  const small = accountFor(GM.tester, 'T', { maxMessageBytes: 2000 });
  await assert.rejects(
    sendLiveEmail(small, {
      to: [GM.colleague],
      subject: 'too-much',
      html: `<img src="${dataUri(one)}">`,
      attachments: [{ filename: 'a.bin', content: Buffer.alloc(1000), contentType: 'application/octet-stream' }]
    }),
    (e: unknown) => e instanceof SendError && e.status === 413
  );
  assert.equal((await fetchAll(GM.colleague, 'INBOX')).filter((x) => x.mail.subject === 'too-much').length, 0);
});

test('idempotency still holds for rich mail: a retry with the same key sends once', async () => {
  const p = { to: [GM.colleague], subject: 'rich-once', html: `<p>x</p><img src="${dataUri(PNG)}">`, idempotencyKey: 'rich-1' };
  const [a, b] = await Promise.all([sendLiveEmail(tester, p), sendLiveEmail(tester, p)]);
  assert.equal(a.messageId, b.messageId);
  await inboxMail('rich-once');
  assert.equal((await fetchAll(GM.colleague, 'INBOX')).filter((x) => x.mail.subject === 'rich-once').length, 1);
});

test('a rich draft keeps its formatting and its picture, and the reader shows it', async () => {
  const saved = await saveLiveDraft(tester, {
    subject: 'rich draft',
    html: `<p>Draft <strong>bold</strong></p><img src="${dataUri(PNG)}" alt="logo"><script>x</script>`
  });
  const d = (await getLiveMessageDetail(tester, 'Drafts', saved.uid))!;
  assert.match(d.html || '', /<strong>bold<\/strong>/);
  assert.match(d.html || '', /src="data:image\/png;base64,/);
  assert.doesNotMatch(d.html || '', /<script>x/);
  assert.match(d.text || '', /Draft bold/);
  assert.equal(d.attachments.filter((a) => !a.isInline).length, 0);
});

test('route: JSON html is sanitised and sent inline; plain text still works', async () => {
  const app = await buildTestApp();
  const t = await signIn(app, GM.tester);
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages/send',
    headers: t.headers,
    payload: {
      to: [GM.colleague],
      subject: 'route-rich',
      html: `<p onclick="x()">via route</p><img src="${dataUri(PNG)}">`,
      idempotencyKey: 'route-rich-1'
    }
  });
  assert.equal(res.statusCode, 200, res.body);
  const m = (await inboxMail('route-rich'))[0];
  assert.doesNotMatch(await sentHtml(m.raw), /onclick/);
  assert.equal(m.mail.attachments[0].contentDisposition, 'inline');

  const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 1)]);
  const tooBig = await app.inject({
    method: 'POST',
    url: '/api/messages/send',
    headers: t.headers,
    payload: { to: [GM.colleague], subject: 'route-big', html: `<img src="${dataUri(big)}">` }
  });
  assert.equal(tooBig.statusCode, 413, tooBig.body);
  await app.close();
});
