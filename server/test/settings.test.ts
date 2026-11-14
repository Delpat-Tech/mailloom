import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, signIn, resetAccount, GM, type SignedIn } from './helpers.js';

let app: FastifyInstance;
let t: SignedIn;
let c: SignedIn;

const get = (who: SignedIn) => app.inject({ method: 'GET', url: '/api/settings', headers: who.headers });
const patch = (who: SignedIn, payload: object, headers = who.headers) =>
  app.inject({ method: 'PATCH', url: '/api/settings', headers, payload });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cur = async (who: SignedIn) => (await get(who)).json() as { version: number; [k: string]: any };

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const png = `data:image/png;base64,${PNG.toString('base64')}`;

before(async () => {
  await resetAccount(GM.tester);
  await resetAccount(GM.colleague);
  app = await buildTestApp();
  t = await signIn(app, GM.tester);
  c = await signIn(app, GM.colleague);
});
after(async () => {
  await app.close();
});

test('defaults are filled in for a new mailbox', async () => {
  const d = await cur(t);
  assert.deepEqual(d, {
    version: 0,
    loadPictures: true,
    signature: { html: '', logo: null },
    templates: [],
    theme: 'system',
    defaultReply: 'reply'
  });
});

test('requires a session and the account header', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode, 401);
  assert.equal((await patch(t, { version: 0, theme: 'dark' }, {})).statusCode, 401);
  const noHeader = { cookie: t.headers.cookie! };
  assert.equal((await patch(t, { version: 0, theme: 'dark' }, noHeader)).statusCode, 401);
});

test('patch merges known fields, bumps version, keeps the rest', async () => {
  const v = (await cur(t)).version;
  const r = await patch(t, { version: v, theme: 'dark', defaultReply: 'replyAll' });
  assert.equal(r.statusCode, 200);
  const d = r.json();
  assert.equal(d.version, v + 1);
  assert.equal(d.theme, 'dark');
  assert.equal(d.defaultReply, 'replyAll');
  assert.equal(d.loadPictures, true);
  assert.deepEqual(await cur(t), d);
  assert.equal((await patch(t, { version: d.version, theme: 'system', defaultReply: 'reply' })).statusCode, 200);
});

test('validation: unknown fields, types, enums, missing version', async () => {
  const v = (await cur(t)).version;
  for (const body of [
    { version: v, nope: 1 },
    { version: v, signature: { html: '', extra: 1 } },
    { version: v, loadPictures: 'yes' },
    { version: v, theme: 'blue' },
    { version: v, defaultReply: 'forward' },
    { theme: 'dark' },
    { version: 'x', theme: 'dark' },
    { version: v, templates: 'x' },
    { version: v, importLocal: { other: 1 } }
  ]) {
    assert.equal((await patch(t, body)).statusCode, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal((await cur(t)).version, v);
});

test('limits: signature 20 KB, 50 templates, name 80, subject 200, template html 20 KB', async () => {
  const v = (await cur(t)).version;
  const tpl = (o: object = {}) => ({ id: 'a', name: 'n', subject: 's', html: '<p>x</p>', ...o });
  const big = '<p>' + 'a'.repeat(20 * 1024) + '</p>';
  assert.equal((await patch(t, { version: v, signature: { html: big } })).statusCode, 400);
  assert.equal((await patch(t, { version: v, templates: [tpl({ name: 'n'.repeat(81) })] })).statusCode, 400);
  assert.equal((await patch(t, { version: v, templates: [tpl({ name: '' })] })).statusCode, 400);
  assert.equal((await patch(t, { version: v, templates: [tpl({ subject: 's'.repeat(201) })] })).statusCode, 400);
  assert.equal((await patch(t, { version: v, templates: [tpl({ html: big })] })).statusCode, 400);
  assert.equal((await patch(t, { version: v, templates: [tpl(), tpl()] })).statusCode, 400, 'duplicate id');
  const many = Array.from({ length: 51 }, (_, i) => tpl({ id: `t${i}` }));
  assert.equal((await patch(t, { version: v, templates: many })).statusCode, 400);
  const ok = await patch(t, {
    version: v,
    templates: many.slice(0, 50).map((x) => ({ ...x, name: 'n'.repeat(80), subject: 's'.repeat(200) }))
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().templates.length, 50);
  assert.equal((await patch(t, { version: v + 1, templates: [] })).statusCode, 200);
});

test('signature and template html is sanitised like the composer', async () => {
  const v = (await cur(t)).version;
  const dirty =
    '<p onclick="x()">Hi<script>alert(1)</script> <a href="javascript:alert(1)">bad</a> <a href="https://ok.test">ok</a></p>' +
    '<img src="https://evil.test/p.gif"><img src="' + png + '" alt="logo"><style>p{}</style>';
  const r = await patch(t, { version: v, signature: { html: dirty }, templates: [{ id: 'x', name: 'T', subject: '', html: dirty }] });
  assert.equal(r.statusCode, 200);
  const d = r.json();
  for (const h of [d.signature.html, d.templates[0].html] as string[]) {
    assert.ok(!/script|onclick|javascript:|evil\.test|<style/i.test(h), h);
    assert.ok(h.includes('https://ok.test'));
    assert.ok(h.includes('data:image/png;base64,'), 'data image kept');
  }
  assert.equal((await patch(t, { version: d.version, signature: { html: '' }, templates: [] })).statusCode, 200);
});

test('logo: only sniffed png/jpeg/gif/webp data images up to 200 KB; null clears', async () => {
  const v = (await cur(t)).version;
  const bad: unknown[] = [
    'https://x.test/a.png',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    `data:image/jpeg;base64,${PNG.toString('base64')}`, // claims jpeg, is png
    `data:image/png;base64,${Buffer.from('<html>not an image</html>').toString('base64')}`,
    `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(200 * 1024)]).toString('base64')}`,
    42
  ];
  for (const logo of bad) assert.equal((await patch(t, { version: v, signature: { logo } })).statusCode, 400, String(logo).slice(0, 40));
  const ok = await patch(t, { version: v, signature: { logo: png } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().signature.logo, png);
  const cleared = await patch(t, { version: ok.json().version, signature: { logo: null } });
  assert.equal(cleared.json().signature.logo, null);
});

test('version conflict answers 409 with the current document', async () => {
  const v = (await cur(t)).version;
  assert.equal((await patch(t, { version: v, theme: 'light' })).statusCode, 200);
  const stale = await patch(t, { version: v, theme: 'dark' });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().settings.theme, 'light');
  assert.equal(stale.json().settings.version, v + 1);
  assert.equal((await patch(t, { version: v + 1, theme: 'system' })).statusCode, 200);
});

test('two accounts keep separate documents', async () => {
  const vt = (await cur(t)).version;
  await patch(t, { version: vt, theme: 'dark' });
  const other = await cur(c);
  assert.equal(other.theme, 'system');
  assert.equal((await patch(c, { version: other.version, theme: 'light' })).statusCode, 200);
  assert.equal((await cur(t)).theme, 'dark');
  assert.equal((await cur(c)).theme, 'light');
  await patch(t, { version: vt + 1, theme: 'system' });
  await patch(c, { version: other.version + 1, theme: 'system' });
});

test('importLocal fills only fields still at default', async () => {
  const v = (await cur(c)).version;
  const first = await patch(c, {
    version: v,
    importLocal: {
      signature: { html: '<p>Local sig</p>', logo: png },
      templates: [{ id: 'l1', name: 'Local', subject: 'S', html: '<p>t</p>' }],
      loadPictures: false
    }
  });
  assert.equal(first.statusCode, 200);
  const d = first.json();
  assert.equal(d.signature.html, '<p>Local sig</p>');
  assert.equal(d.signature.logo, png);
  assert.equal(d.templates.length, 1);
  assert.equal(d.loadPictures, false);
  // a second device: server values already set, nothing is overwritten
  const second = await patch(c, {
    version: d.version,
    importLocal: { signature: { html: '<p>Other</p>' }, templates: [{ id: 'l2', name: 'Other', subject: '', html: '' }], loadPictures: true }
  });
  assert.equal(second.statusCode, 200);
  const e = second.json();
  assert.equal(e.signature.html, '<p>Local sig</p>');
  assert.equal(e.templates[0].id, 'l1');
  assert.equal(e.templates.length, 1);
  assert.equal(e.loadPictures, false);
  // imported content is validated and sanitised too
  const evil = await patch(t, { version: (await cur(t)).version, importLocal: { signature: { html: '<script>x</script><p>ok</p>' } } });
  assert.equal(evil.statusCode, 200);
  assert.equal(evil.json().signature.html, '<p>ok</p>');
  assert.equal((await patch(t, { version: (await cur(t)).version, importLocal: { templates: [{ id: '!', name: 'x' }] } })).statusCode, 400);
});
