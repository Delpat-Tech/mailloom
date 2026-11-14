import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { TESTER, appendRaw, buildMime, buildTestApp, resetAccount, signIn } from './helpers.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const BIG_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200_000, 0x61)]);

describe('attachment route: ?inline=1', () => {
  let app: FastifyInstance;
  let uid = 0;
  const parts: Record<string, string> = {};
  before(async () => {
    app = await buildTestApp();
    await resetAccount(TESTER);
    uid = await appendRaw(
      TESTER,
      'INBOX',
      await buildMime({
        subject: 'files',
        text: 'x',
        attachments: [
          { filename: 'pic.png', content: PNG, contentType: 'image/png' },
          { filename: 'disguised.txt', content: PNG, contentType: 'text/plain' },
          { filename: 'doc.pdf', content: BIG_PDF, contentType: 'application/octet-stream' },
          { filename: 'page.html', content: Buffer.from('<script>alert(1)</script>'), contentType: 'image/png' },
          { filename: 'logo.svg', content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), contentType: 'image/svg+xml' },
          { filename: 'tiny.txt', content: Buffer.from('hi'), contentType: 'text/plain' },
          { filename: 'fake.pdf', content: Buffer.from('<html>no</html>'), contentType: 'application/pdf' }
        ]
      })
    );
    const t = await signIn(app, TESTER);
    const d = (await app.inject({ method: 'GET', url: `/api/mailboxes/INBOX/messages/${uid}`, headers: t.headers })).json();
    for (const a of d.attachments) parts[a.filename] = a.partId;
  });
  after(() => app.close());

  async function get(name: string, inline: boolean) {
    const t = await signIn(app, TESTER);
    return app.inject({
      method: 'GET',
      url: `/api/mailboxes/INBOX/messages/${uid}/attachments/${parts[name]}${inline ? '?inline=1' : ''}`,
      headers: t.headers
    });
  }

  test('without inline everything stays an attachment with the sandbox CSP', async () => {
    for (const name of ['pic.png', 'doc.pdf']) {
      const r = await get(name, false);
      assert.equal(r.statusCode, 200);
      assert.match(String(r.headers['content-disposition']), /^attachment;/);
      assert.equal(r.headers['content-security-policy'], "default-src 'none'; sandbox");
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
  });

  test('a real image is shown inline with the sandbox CSP', async () => {
    const r = await get('pic.png', true);
    assert.match(String(r.headers['content-disposition']), /^inline;/);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(r.rawPayload, PNG);
  });

  test('the sniffed type wins over a wrong label: PNG bytes called text/plain are an inline image', async () => {
    const r = await get('disguised.txt', true);
    assert.match(String(r.headers['content-disposition']), /^inline;/);
    assert.equal(r.headers['content-type'], 'image/png');
  });

  test('a PDF (by %PDF-) is inline, intact over 64 KB, with a CSP the PDF viewer can live with', async () => {
    const r = await get('doc.pdf', true);
    assert.match(String(r.headers['content-disposition']), /^inline;/);
    assert.equal(r.headers['content-type'], 'application/pdf');
    assert.equal(r.headers['content-security-policy'], "default-src 'none'");
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(r.rawPayload, BIG_PDF);
  });

  test('HTML, SVG, text and a fake PDF are never inline, whatever they claim', async () => {
    for (const name of ['page.html', 'logo.svg', 'tiny.txt', 'fake.pdf']) {
      const r = await get(name, true);
      assert.equal(r.statusCode, 200, name);
      assert.match(String(r.headers['content-disposition']), /^attachment;/, name);
      assert.equal(r.headers['content-security-policy'], "default-src 'none'; sandbox", name);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', name);
    }
    assert.equal((await get('tiny.txt', true)).body, 'hi', 'short files survive the peek');
  });
});
