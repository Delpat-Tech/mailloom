import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLiveMessageDetail,
  getLiveMessages,
  streamLiveAttachment,
  setLiveMessageFlags,
  closeUserSession
} from '../src/services/imap.js';
import { renderEmail } from '../src/utils/sanitize.js';
import { contentDisposition, decodeEncodedWords } from '../src/utils/mime.js';
import { accountFor, GM, resetAccount, appendRaw, buildMime } from './helpers.js';

const tester = accountFor(GM.tester);

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

async function streamToBuffer(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

before(async () => {
  await resetAccount(GM.tester);
});
after(async () => {
  await closeUserSession(tester);
});

test('attachments: part ids are the IMAP parts, names are decoded, downloads return the right bytes', async () => {
  const pdf = Buffer.from('%PDF-1.4 fake pdf content');
  const csv = Buffer.from('a,b\n1,2\n');
  const uid = await appendRaw(
    GM.tester,
    'INBOX',
    await buildMime({
      subject: 'with files',
      text: 'see attached',
      html: '<p>see attached</p>',
      attachments: [
        { filename: 'Contract signed (final).pdf', content: pdf, contentType: 'application/pdf' },
        { filename: 'Rechnung für März.csv', content: csv, contentType: 'text/csv' }
      ]
    })
  );
  const d = await getLiveMessageDetail(tester, 'INBOX', uid);
  assert.ok(d);
  assert.equal(d.attachments.length, 2);
  const [a1, a2] = d.attachments;
  assert.equal(a1.filename, 'Contract signed (final).pdf');
  assert.equal(a1.contentType, 'application/pdf');
  assert.equal(a2.filename, 'Rechnung für März.csv');
  assert.equal(d.text?.trim(), 'see attached');

  const f1 = await streamLiveAttachment(tester, 'INBOX', uid, a1.partId);
  assert.ok(f1);
  assert.equal(f1.filename, 'Contract signed (final).pdf');
  assert.equal(f1.contentType, 'application/pdf');
  assert.deepEqual(await streamToBuffer(f1.stream), pdf);
  const f2 = await streamLiveAttachment(tester, 'INBOX', uid, a2.partId);
  assert.ok(f2);
  assert.equal(f2.filename, 'Rechnung für März.csv');
  assert.deepEqual(await streamToBuffer(f2.stream), csv);

  // not a part, and not a valid part id
  assert.equal(await streamLiveAttachment(tester, 'INBOX', uid, '99'), null);
  assert.equal(await streamLiveAttachment(tester, 'INBOX', uid, '../1'), null);
});

test('list shows a preview and a paperclip only where there are real attachments', async () => {
  await resetAccount(GM.tester);
  const long = 'Hello there. ' + 'word '.repeat(80);
  await appendRaw(GM.tester, 'INBOX', await buildMime({ subject: 'plain one', text: long }));
  await appendRaw(
    GM.tester,
    'INBOX',
    await buildMime({
      subject: 'with file',
      html: '<p>Hi <b>team</b>,</p><p>the report is here</p>',
      attachments: [{ filename: 'r.pdf', content: Buffer.from('x'), contentType: 'application/pdf' }]
    })
  );
  await appendRaw(
    GM.tester,
    'INBOX',
    await buildMime({
      subject: 'with logo only',
      html: '<p>logo mail</p><img src="cid:logo1">',
      attachments: [{ filename: 'logo.png', content: PNG, cid: 'logo1', contentDisposition: 'inline' }]
    })
  );
  const { messages } = await getLiveMessages(tester, 'INBOX');
  const by = (s: string) => messages.find((m) => m.subject === s)!;
  assert.equal(by('plain one').hasAttachments, false);
  assert.ok(by('plain one').snippet.startsWith('Hello there. word word'));
  assert.ok(by('plain one').snippet.length <= 140);
  assert.equal(by('with file').hasAttachments, true);
  assert.equal(by('with file').snippet, 'Hi team , the report is here');
  assert.equal(by('with logo only').hasAttachments, false, 'an inline logo is not an attachment');
});

test('logo sent as attachment-disposition with a Content-ID inside multipart/related is inline when the HTML references it', async () => {
  await resetAccount(GM.tester);
  const uid = await appendRaw(
    GM.tester,
    'INBOX',
    await buildMime({
      subject: 'apple logo',
      html: '<p>hi</p><img src="cid:applelogo">',
      attachments: [
        { filename: 'logo.png', content: PNG, cid: 'applelogo', contentDisposition: 'attachment', contentType: 'image/png' },
        { filename: 'spare.png', content: PNG, cid: 'unused', contentDisposition: 'attachment', contentType: 'image/png' }
      ]
    })
  );
  const d = (await getLiveMessageDetail(tester, 'INBOX', uid))!;
  assert.match(d.html || '', /src="data:image\/png;base64,/);
  assert.deepEqual(d.attachments.map((a) => a.filename), ['spare.png']);
  const uid2 = await appendRaw(
    GM.tester,
    'INBOX',
    await buildMime({
      subject: 'apple logo only',
      html: '<img src="cid:applelogo">',
      attachments: [{ filename: 'logo.png', content: PNG, cid: 'applelogo', contentDisposition: 'attachment', contentType: 'image/png' }]
    })
  );
  const l2 = await getLiveMessages(tester, 'INBOX');
  assert.equal(l2.messages.find((m) => m.subject === 'apple logo only')!.hasAttachments, false);
  const d2 = (await getLiveMessageDetail(tester, 'INBOX', uid2))!;
  assert.equal(d2.attachments.length, 0);
  assert.match(d2.html || '', /src="data:image\/png/);
});

test('inline cid parts that are not real png/jpeg/gif/webp bytes are dropped (svg, mislabelled)', async () => {
  await resetAccount(GM.tester);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const u1 = await appendRaw(
    GM.tester,
    'INBOX',
    await buildMime({
      subject: 'svg cid',
      html: '<img src="cid:s1"><img src="cid:s2">',
      attachments: [
        { filename: 'a.svg', content: svg, cid: 's1', contentDisposition: 'inline', contentType: 'image/svg+xml' },
        { filename: 'b.png', content: svg, cid: 's2', contentDisposition: 'inline', contentType: 'image/png' }
      ]
    })
  );
  const d = (await getLiveMessageDetail(tester, 'INBOX', u1))!;
  assert.doesNotMatch(d.html || "", /data:image/);
  assert.doesNotMatch(d.html || '', /<svg|alert/i);
});

test('previews decode quoted-printable and base64 in other charsets', async () => {
  await resetAccount(GM.tester);
  const qp =
    'From: a@delpat.test\r\nTo: tester@delpat.test\r\nSubject: qp\r\nMIME-Version: 1.0\r\n' +
    'Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' +
    'Gr=FC=DFe aus K=F6ln, long line that =\r\ncontinues\r\n';
  const b64 =
    'From: a@delpat.test\r\nTo: tester@delpat.test\r\nSubject: b64\r\nMIME-Version: 1.0\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
    Buffer.from('Привіт, світе — ₹ 500').toString('base64') + '\r\n';
  const u1 = await appendRaw(GM.tester, 'INBOX', qp);
  const u2 = await appendRaw(GM.tester, 'INBOX', b64);
  const { messages } = await getLiveMessages(tester, 'INBOX');
  assert.equal(messages.find((m) => m.subject === 'qp')!.snippet, 'Grüße aus Köln, long line that continues');
  assert.equal(messages.find((m) => m.subject === 'b64')!.snippet, 'Привіт, світе — ₹ 500');
  assert.equal((await getLiveMessageDetail(tester, 'INBOX', u1))!.text?.trim(), 'Grüße aus Köln, long line that continues');
  assert.equal((await getLiveMessageDetail(tester, 'INBOX', u2))!.text?.trim(), 'Привіт, світе — ₹ 500');
});

test('inline cid images show in the body and are not listed; remote images and pixels are handled', async () => {
  await resetAccount(GM.tester);
  const uid = await appendRaw(
    GM.tester,
    'INBOX',
    await buildMime({
      subject: 'newsletter',
      html:
        '<p>Hello</p><img src="cid:logo1" alt="logo">' +
        '<img src="https://cdn.example.com/hero.jpg" alt="hero">' +
        '<img src="https://track.example.com/p.gif" width="1" height="1">',
      attachments: [
        { filename: 'logo.png', content: PNG, cid: 'logo1', contentDisposition: 'inline', contentType: 'image/png' },
        { filename: 'terms.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' }
      ]
    })
  );
  const d = (await getLiveMessageDetail(tester, 'INBOX', uid))!;
  assert.deepEqual(d.attachments.map((a) => a.filename), ['terms.pdf']);
  assert.ok(d.html!.includes(`src="data:image/png;base64,${PNG.toString('base64')}"`), 'logo inlined');
  assert.ok(!d.html!.includes('cdn.example.com'), 'remote image blocked by default');
  assert.ok(!d.html!.includes('track.example.com'), 'tracking pixel never loaded');
  assert.equal(d.blockedImages, 1);
  assert.ok(!d.html!.includes('cid:'));

  const shown = (await getLiveMessageDetail(tester, 'INBOX', uid, { allowRemoteImages: true }))!;
  assert.ok(shown.html!.includes('src="https://cdn.example.com/hero.jpg"'));
  assert.ok(!shown.html!.includes('track.example.com'), 'tracking pixel stripped even when images are shown');
  assert.equal(shown.blockedImages, 0);
  assert.ok(shown.html!.includes("img-src data: https:"));
  assert.ok(d.html!.includes("img-src data:;") || d.html!.includes("img-src data:\""));
});

test('star state in the detail is the real flag', async () => {
  await resetAccount(GM.tester);
  const uid = await appendRaw(GM.tester, 'INBOX', await buildMime({ subject: 'starred', text: 'x' }), ['\\Flagged']);
  assert.equal((await getLiveMessageDetail(tester, 'INBOX', uid))!.isFlagged, true);
  await setLiveMessageFlags(tester, 'INBOX', uid, 'isFlagged', false);
  assert.equal((await getLiveMessageDetail(tester, 'INBOX', uid))!.isFlagged, false);
});

test('a missing message is null, not a crash', async () => {
  assert.equal(await getLiveMessageDetail(tester, 'INBOX', 999999), null);
});

test('renderEmail: full document, own styles kept when safe, scripts and url() removed', () => {
  const r = renderEmail(
    '<style>.x{color:red;background:url(https://t.example.com/a.png)} @import url(evil.css); p{margin:0}</style>' +
      '<p class="x" style="color:blue;background:url(javascript:alert(1))" onclick="alert(1)">Hi</p><script>alert(1)</script>'
  );
  assert.ok(r.html.startsWith('<!doctype html>'));
  assert.ok(r.html.includes("default-src 'none'"));
  assert.ok(r.html.includes('.x{color:red;background:none}'));
  assert.ok(!r.html.includes('evil.css'));
  assert.ok(!r.html.includes('onclick'));
  assert.ok(!r.html.includes('<script'));
  assert.ok(!r.html.includes('javascript:'));
  assert.ok(r.html.includes('font-family:-apple-system'));
});

test('renderEmail: link whose text is another host gets a warning, honest links do not', () => {
  const bad = renderEmail('<a href="https://evil.example.net/login">https://mybank.com/login</a>').html;
  assert.ok(bad.includes('goes to evil.example.net'));
  const ok = renderEmail('<a href="https://www.mybank.com/x">https://mybank.com/login</a>').html;
  assert.ok(!ok.includes('ml-warn"'));
  const plain = renderEmail('<a href="https://evil.example.net/">Click here</a>').html;
  assert.ok(!plain.includes('goes to'));
});

test('Content-Disposition carries the real file name (RFC 5987)', () => {
  const h = contentDisposition('Contract signed (final).pdf');
  assert.equal(h, `attachment; filename="Contract signed (final).pdf"; filename*=UTF-8''Contract%20signed%20%28final%29.pdf`);
  const u = contentDisposition('Rechnung für März "x".pdf');
  assert.ok(u.includes(`filename*=UTF-8''Rechnung%20f%C3%BCr%20M%C3%A4rz%20%22x%22.pdf`));
  assert.ok(!/[^\x20-\x7e]/.test(u));
  assert.equal(decodeEncodedWords('=?utf-8?B?UmVjaG51bmc=?= =?utf-8?Q?_=C3=BCber?='), 'Rechnung über');
});

test('attachment over 64 KB stays intact while another folder is opened on the same session', async () => {
  const big = Buffer.alloc(300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
  const other = Buffer.alloc(300 * 1024, 0xee);
  const uid = await appendRaw(
    GM.tester,
    'INBOX',
    await buildMime({
      subject: 'big one',
      text: 'x',
      attachments: [{ filename: 'big.bin', content: big, contentType: 'application/octet-stream' }]
    })
  );
  const { withImap } = await import('./helpers.js');
  await withImap(GM.tester, async (c) => {
    await c.mailboxCreate('OtherFolder').catch(() => undefined);
  });
  for (let i = 0; i < 3; i++) {
    await appendRaw(
      GM.tester,
      'OtherFolder',
      await buildMime({ subject: `other ${i}`, text: 'y', attachments: [{ filename: 'o.bin', content: other, contentType: 'application/octet-stream' }] })
    );
  }
  const d = await getLiveMessageDetail(tester, 'INBOX', uid);
  assert.ok(d);
  const f = await streamLiveAttachment(tester, 'INBOX', uid, d.attachments[0].partId);
  assert.ok(f);
  // Open another folder on the same session while the download is pending, then consume the stream.
  const concurrent = getLiveMessages(tester, 'OtherFolder');
  const got = await streamToBuffer(f.stream);
  await concurrent;
  assert.equal(got.length, big.length);
  assert.ok(got.equals(big));
});

test('renderEmail: CSS escapes and image-set cannot smuggle url() or @import', () => {
  const css =
    '.a{background:\\75 rl(https://t.example.com/x.png)} @\\69mport "evil.css"; ' +
    '.b{background:image-set("https://t.example.com/y.png" 1x)} .c{color:red} .d{background:-webkit-image-set(url(z.png) 1x)}';
  const html = renderEmail(`<style>${css}</style><p class="c">x</p>`).html;
  assert.ok(!html.includes('\\'));
  assert.ok(!/t\.example\.com|evil\.css|z\.png/.test(html));
  assert.ok(!/image-set/i.test(html));
  assert.ok(html.includes('.c{color:red}'));
});

test('renderEmail: link warning cannot be hidden or faked by mail CSS or ml-* classes', () => {
  const bad = renderEmail(
    '<style>.ml-warn{display:none} span{display:none}</style><a class="ml-warn x" href="https://evil.example.net/">https://mybank.com/login</a>'
  ).html;
  assert.ok(/<span class="ml-warn" style="[^"]*display:inline-block!important[^"]*"/.test(bad));
  assert.ok(!bad.includes('class="ml-warn x"') && !bad.includes('class="ml-warn"><') || bad.includes('goes to evil.example.net'));
  assert.ok(!bad.includes('<a class="ml-warn'));
  // faked warning in mail: class is stripped
  const fake = renderEmail('<span class="ml-warn">&#9888; goes to bank.com</span>').html;
  assert.ok(!fake.includes('class="ml-warn"'));
});
