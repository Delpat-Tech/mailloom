import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, signIn, resetAccount, buildMime, withImap, GM, type SignedIn } from './helpers.js';
import { htmlToText, looksLikeCode, makeSnippet } from '../src/utils/mime.js';

const snippetOf = (html: string) => {
  const s = makeSnippet(htmlToText(html));
  return looksLikeCode(s) ? '' : s;
};

/** A newsletter-like page: a long <head> with <style>, an MSO conditional comment, then the visible copy. */
function newsletter(rules = 400): string {
  const css = Array.from({ length: rules }, (_, i) => `.cls-${i} { font-family: Arial, sans-serif; color: #${(100000 + i).toString(16).slice(0, 6)}; padding: 4px; }`).join('\n');
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Spring news</title>',
    '<!--[if mso]><style>td { font-family: Arial; }</style><![endif]-->',
    `<style type="text/css">\n${css}\n@media (max-width:600px) { .wrap { width: 100% !important; } }\n</style></head>`,
    '<body class="body"><div class="wrap"><p>Hello Om, your spring update is here.</p><p>Fish &amp; chips &#8364;5 &nbsp;today</p></div></body></html>'
  ].join('\n');
}

test('long style block cut at 4096 and 16384 leaves no CSS', () => {
  const html = newsletter();
  assert.ok(html.lastIndexOf('</style>') > 16384, 'style must exceed 16 KB for this test');
  for (const cut of [4096, 16384]) {
    const out = htmlToText(html.slice(0, cut));
    assert.equal(out.trim(), '', `cut at ${cut}`);
    assert.equal(snippetOf(html.slice(0, cut)), '');
  }
  assert.match(snippetOf(html), /^Hello Om, your spring update is here\. Fish & chips €5 today$/);
});

test('a cut-off tag at the end is removed', () => {
  assert.equal(snippetOf('<p>Hello there</p><div class="x'), 'Hello there');
  assert.equal(snippetOf('Plain then <a href="http://exa'), 'Plain then');
});

test('comments, conditional comments, CDATA, title and noscript are removed', () => {
  assert.equal(snippetOf('<!--[if gte mso 9]><xml><o:x>junk</o:x></xml><![endif]--><p>Visible</p>'), 'Visible');
  assert.equal(snippetOf('<p>Before</p><!-- never closed <p>hidden</p>'), 'Before');
  assert.equal(snippetOf('<p>A</p><![CDATA[ B ]]><p>C</p>'), 'A B C');
  assert.equal(snippetOf('<p>A</p><![CDATA[ unterminated'), 'A');
  assert.equal(snippetOf('<title>Subject</title><noscript>Enable JS</noscript><p>Body</p>'), 'Body');
  assert.equal(snippetOf('<p>Body</p><script>var a = {b: 1;'), 'Body');
});

test('entities decode and whitespace collapses; a short mail still reads normally', () => {
  assert.equal(snippetOf('<html><body><p>Hi&nbsp;Om,</p>\n\n<p>5 &lt; 6 &amp;&amp; &#x41;&#66; &quot;ok&quot;</p></body></html>'), 'Hi Om, 5 < 6 && AB "ok"');
});

test('leftover CSS or script is never shown as a preview', () => {
  assert.equal(looksLikeCode('{ color: red; }'), true);
  assert.equal(looksLikeCode('.a { color: red; margin: 0 }'), true);
  assert.equal(looksLikeCode('color: red; margin: 0; padding: 1px'), true);
  assert.equal(looksLikeCode('Meeting at 3: bring notes; lunch after'), false);
  assert.equal(looksLikeCode('Note: see you soon'), false);
});

let app: FastifyInstance;
let t: SignedIn;

before(async () => {
  app = await buildTestApp();
  t = await signIn(app, GM.tester);
  await resetAccount(GM.tester);
});
after(async () => {
  await resetAccount(GM.tester);
  await app.close();
});

test('list API snippet of an HTML mail with a huge style block is the mail text', async () => {
  assert.ok(newsletter(80).lastIndexOf('</style>') > 4096 && newsletter(80).lastIndexOf('</style>') < 16000);
  const raw = await buildMime({ subject: 'Big style', html: newsletter(80), messageId: '<bigstyle@delpat.test>' });
  await withImap(GM.tester, async (c) => {
    await c.append('INBOX', raw);
  });
  const res = await app.inject({ method: 'GET', url: '/api/mailboxes/INBOX/messages', headers: t.headers });
  assert.equal(res.statusCode, 200, res.body);
  const m = res.json().messages.find((x: any) => x.subject === 'Big style');
  assert.ok(m);
  assert.match(m.snippet, /^Hello Om, your spring update is here\./);
  assert.doesNotMatch(m.snippet, /font-family|cls-|\{/);
});

test('a 20 KB style block gives the real text via the second (131072-byte) fetch', async () => {
  const html = newsletter(220);
  const end = html.lastIndexOf('</style>');
  assert.ok(end > 16384 && html.length < 131072);
  // First fetch (16384 bytes) is all CSS: empty. The larger one reaches the copy.
  assert.equal(snippetOf(html.slice(0, 16384)), '');
  assert.match(snippetOf(html.slice(0, 131072)), /^Hello Om, your spring update is here\./);
  const raw = await buildMime({ subject: 'Huge style', html, messageId: '<hugestyle@delpat.test>' });
  await withImap(GM.tester, async (c) => {
    await c.append('INBOX', raw);
  });
  const res = await app.inject({ method: 'GET', url: '/api/mailboxes/INBOX/messages', headers: t.headers });
  assert.equal(res.statusCode, 200, res.body);
  const m = res.json().messages.find((x: any) => x.subject === 'Huge style');
  assert.ok(m);
  assert.match(m.snippet, /^Hello Om, your spring update is here\./);
});
