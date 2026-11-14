import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  fetchRemoteImage,
  ImageProxyError,
  isPublicAddress,
  proxyImageUrl,
  signImageUrl,
  verifyImageSignature
} from '../src/services/image-proxy.js';
import { renderEmail } from '../src/utils/sanitize.js';
import { TESTER, appendRaw, buildTestApp, resetAccount, signIn } from './helpers.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let server: http.Server;
let port = 0;
const hits: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(
      `${req.url}|cookie=${req.headers.cookie || ''}|referer=${req.headers.referer || ''}|ua=${req.headers['user-agent']}|accept=${req.headers.accept}`
    );
    const u = req.url || '';
    const redirect = (to: string) => void res.writeHead(302, { Location: to }).end();
    if (u === '/ok.png') return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end(PNG); // label lies; bytes decide
    if (u === '/ok.jpg') return void res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(JPEG);
    if (u === '/big.png') return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.concat([PNG, Buffer.alloc(5000)]));
    if (u === '/page.html') return void res.writeHead(200, { 'Content-Type': 'image/png' }).end('<html>not an image</html>');
    if (u === '/x.svg') return void res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(SVG);
    if (u === '/hang') return; // never answers
    if (u === '/404') return void res.writeHead(404).end('no');
    if (u === '/r1') return redirect('/ok.png');
    if (u === '/chain4') return redirect('/chain3');
    if (u === '/chain3') return redirect('/chain2');
    if (u === '/chain2') return redirect('/chain1');
    if (u === '/chain1') return redirect('/ok.png');
    if (u === '/to-metadata') return redirect('http://169.254.169.254/latest/meta-data/');
    if (u === '/to-private-name') return redirect('http://internal.test/a.png');
    if (u === '/to-v6') return redirect('http://[::1]/a.png');
    if (u === '/to-file') return redirect('file:///etc/passwd');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

/** Test seam: the local server is on loopback, so loopback is allowed here; every other rule stays on. */
function testOpts(extra: Record<string, unknown> = {}) {
  return {
    resolve: async (host: string) => (host === 'img.test' ? ['127.0.0.1'] : host === 'internal.test' ? ['10.1.2.3'] : ['93.184.216.34']),
    addressAllowed: (ip: string) => ip === '127.0.0.1' || isPublicAddress(ip),
    portAllowed: (p: number) => p === port || p === 80 || p === 443,
    ...extra
  };
}
const local = (p: string) => `http://img.test:${port}${p}`;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ImageProxyError ? e.code : `other:${(e as Error).message}`;
  }
}

describe('isPublicAddress', () => {
  const refused = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '127.255.0.9',
    '169.254.0.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '224.0.0.1', '239.255.255.255', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1', '2001:db8::1', 'not an ip', ''
  ];
  for (const ip of refused) test(`refuses ${ip || '(empty)'}`, () => assert.equal(isPublicAddress(ip), false));
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    test(`allows ${ip}`, () => assert.equal(isPublicAddress(ip), true));
  }
});

describe('signing', () => {
  const secret = 'a'.repeat(40);
  test('round trip and tampering', () => {
    const sig = signImageUrl(secret, 'https://x.test/a.png');
    assert.equal(verifyImageSignature(secret, 'https://x.test/a.png', sig), true);
    assert.equal(verifyImageSignature(secret, 'https://x.test/b.png', sig), false);
    assert.equal(verifyImageSignature('b'.repeat(40), 'https://x.test/a.png', sig), false);
    assert.equal(verifyImageSignature(secret, 'https://x.test/a.png', ''), false);
    assert.equal(verifyImageSignature(secret, 'https://x.test/a.png', 'x'.repeat(43)), false);
  });
  test('proxy URL shape', () => {
    assert.match(
      proxyImageUrl(secret, 'https://x.test/a.png', { account: 'abc' }),
      /^\/api\/image-proxy\?u=https%3A%2F%2Fx\.test%2Fa\.png&sig=[\w-]{43}&account=abc$/
    );
  });
});

describe('fetchRemoteImage refusals (default rules, injected resolver only)', () => {
  const dnsTo = (ip: string) => ({ resolve: async () => [ip] });
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.5.5', '192.168.0.9', '169.254.169.254', '100.64.1.1', '0.0.0.0', '224.0.0.5', '::1', 'fc00::5', 'fe80::5', '::ffff:127.0.0.1']) {
    test(`DNS that resolves to ${ip} is refused`, async () => {
      assert.equal(await code(fetchRemoteImage('http://evil.test/a.png', dnsTo(ip))), 'BLOCKED_ADDRESS');
    });
  }
  test('a host with one public and one private address is refused', async () => {
    assert.equal(await code(fetchRemoteImage('http://evil.test/a.png', { resolve: async () => ['93.184.216.34', '10.0.0.1'] })), 'BLOCKED_ADDRESS');
  });
  for (const url of ['http://127.0.0.1/a.png', 'http://[::1]/a.png', 'http://169.254.169.254/latest/', 'http://2130706433/a.png', 'http://0x7f.1/a.png', 'http://[::ffff:127.0.0.1]/a.png', 'http://[fe80::1]/a.png']) {
    test(`literal ${url} is refused`, async () => {
      assert.equal(await code(fetchRemoteImage(url)), 'BLOCKED_ADDRESS');
    });
  }
  test('other schemes, odd ports and credentials in the URL are refused', async () => {
    assert.equal(await code(fetchRemoteImage('ftp://x.test/a.png', dnsTo('93.184.216.34'))), 'BAD_URL');
    assert.equal(await code(fetchRemoteImage('file:///etc/passwd')), 'BAD_URL');
    assert.equal(await code(fetchRemoteImage('javascript:alert(1)')), 'BAD_URL');
    assert.equal(await code(fetchRemoteImage('http://x.test:8080/a.png', dnsTo('93.184.216.34'))), 'BLOCKED_PORT');
    assert.equal(await code(fetchRemoteImage('https://x.test:22/a.png', dnsTo('93.184.216.34'))), 'BLOCKED_PORT');
    assert.equal(await code(fetchRemoteImage('http://u:p@x.test/a.png', dnsTo('93.184.216.34'))), 'BAD_URL');
    assert.equal(await code(fetchRemoteImage('not a url')), 'BAD_URL');
  });
  test('a failed lookup is refused', async () => {
    const resolve = async (): Promise<string[]> => {
      throw new Error('ENOTFOUND');
    };
    assert.equal(await code(fetchRemoteImage('http://nx.test/a.png', { resolve })), 'DNS_FAILED');
  });
});

describe('fetchRemoteImage against a local server', () => {
  test('success: sniffed type wins over the claimed one; no cookies, no referer, generic UA, image/* accepted', async () => {
    hits.length = 0;
    const r = await fetchRemoteImage(local('/ok.png'), testOpts());
    assert.equal(r.contentType, 'image/png');
    assert.deepEqual(r.body, PNG);
    assert.match(hits[0]!, /cookie=\|referer=\|ua=Mozilla\/5\.0 \(compatible; ImageFetcher\/1\.0\)\|accept=image\/\*/);
    assert.equal((await fetchRemoteImage(local('/ok.jpg'), testOpts())).contentType, 'image/jpeg');
  });
  test('the vetted address is used: one lookup per hop', async () => {
    let calls = 0;
    await fetchRemoteImage(
      local('/ok.png'),
      testOpts({
        resolve: async () => {
          calls++;
          return ['127.0.0.1'];
        }
      })
    );
    assert.equal(calls, 1);
  });
  test('follows a redirect', async () => {
    assert.equal((await fetchRemoteImage(local('/r1'), testOpts())).contentType, 'image/png');
  });
  test('three redirects are followed, a fourth is refused', async () => {
    assert.equal((await fetchRemoteImage(local('/chain1'), testOpts())).contentType, 'image/png');
    assert.equal((await fetchRemoteImage(local('/chain3'), testOpts())).contentType, 'image/png');
    assert.equal(await code(fetchRemoteImage(local('/chain4'), testOpts())), 'TOO_MANY_REDIRECTS');
  });
  test('redirects to metadata, a private DNS name, IPv6 loopback or a file URL are refused', async () => {
    assert.equal(await code(fetchRemoteImage(local('/to-metadata'), testOpts())), 'BLOCKED_ADDRESS');
    assert.equal(await code(fetchRemoteImage(local('/to-private-name'), testOpts())), 'BLOCKED_ADDRESS');
    assert.equal(await code(fetchRemoteImage(local('/to-v6'), testOpts())), 'BLOCKED_ADDRESS');
    assert.equal(await code(fetchRemoteImage(local('/to-file'), testOpts())), 'BAD_URL');
  });
  test('oversize is refused', async () => {
    assert.equal(await code(fetchRemoteImage(local('/big.png'), testOpts({ maxBytes: 1000 }))), 'TOO_LARGE');
  });
  test('wrong content (html labelled image/png) and SVG are refused', async () => {
    assert.equal(await code(fetchRemoteImage(local('/page.html'), testOpts())), 'NOT_AN_IMAGE');
    assert.equal(await code(fetchRemoteImage(local('/x.svg'), testOpts())), 'NOT_AN_IMAGE');
  });
  test('a server that never answers times out', async () => {
    const t0 = Date.now();
    assert.equal(await code(fetchRemoteImage(local('/hang'), testOpts({ timeoutMs: 300 }))), 'TIMEOUT');
    assert.ok(Date.now() - t0 < 3000);
  });
  test('upstream errors are 502-class', async () => {
    assert.equal(await code(fetchRemoteImage(local('/404'), testOpts())), 'UPSTREAM_ERROR');
  });
});

describe('rendering', () => {
  const proxy = (u: string) => `/api/image-proxy?u=${encodeURIComponent(u)}`;
  test('proxy rewrites remote images, keeps blocked behaviour otherwise, drops tracking pixels', () => {
    const html =
      '<p>hi</p><img src="https://a.test/x.png?a=1&b=2"><img src="//b.test/y.png"><img src="http://c.test/z.png" width="1" height="1">';
    const auto = renderEmail(html, { proxyImage: proxy });
    assert.match(auto.html, /src="\/api\/image-proxy\?u=https%3A%2F%2Fa\.test%2Fx\.png%3Fa%3D1%26b%3D2"/);
    assert.match(auto.html, /u=https%3A%2F%2Fb\.test%2Fy\.png/);
    assert.ok(!auto.html.includes('c.test'));
    assert.equal(auto.blockedImages, 0);
    assert.match(auto.html, /img-src data: 'self'/);
    const blocked = renderEmail(html);
    assert.equal(blocked.blockedImages, 2);
    assert.ok(!blocked.html.includes('a.test'));
  });
  test('CSS background urls never survive', () => {
    const out = renderEmail(
      '<style>body{background-image:url(https://t.test/p.png)}</style><div style="background:url(https://t.test/q.png)">x</div><table background="https://t.test/r.png"><tr><td>a</td></tr></table>',
      { proxyImage: proxy }
    );
    assert.ok(!out.html.includes('t.test'));
  });
});

describe('GET /api/image-proxy and detail rewriting', () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildTestApp({}, { imageProxy: testOpts() });
    await resetAccount(TESTER);
  });
  after(() => app.close());

  const htmlMail = (img: string) =>
    `From: colleague@delpat.test\r\nTo: tester@delpat.test\r\nSubject: pic\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@x.test>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>hello</p><img src="${img}" width="20" height="20">\r\n`;

  async function detail(t: Awaited<ReturnType<typeof signIn>>, folder: string, uid: number, images?: string) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/mailboxes/${folder}/messages/${uid}${images ? `?images=${images}` : ''}`,
      headers: t.headers
    });
    assert.equal(res.statusCode, 200);
    return res.json() as { html: string; blockedImages: number };
  }

  test('auto rewrites to signed proxy URLs that serve the image with the required headers', async () => {
    const t = await signIn(app, TESTER);
    const uid = await appendRaw(TESTER, 'INBOX', htmlMail(local('/ok.png')));
    const d = await detail(t, 'INBOX', uid, 'auto');
    const m = /src="(\/api\/image-proxy\?[^"]+)"/.exec(d.html);
    assert.ok(m, 'rewritten');
    assert.equal(d.blockedImages, 0);
    const path = m![1]!.replace(/&amp;/g, '&');
    assert.ok(path.includes(`account=${t.handle}`));
    // the browser sends the cookie but no account header: the account query parameter identifies it
    const res = await app.inject({ method: 'GET', url: path, headers: { cookie: t.headers.cookie } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['content-security-policy'], "default-src 'none'");
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'private, max-age=86400');
    assert.equal(res.headers['content-disposition'], 'inline');
    assert.deepEqual(res.rawPayload, PNG);
  });

  test('absent or blocked keeps images blocked', async () => {
    const t = await signIn(app, TESTER);
    const uid = await appendRaw(TESTER, 'INBOX', htmlMail(local('/ok.png')));
    for (const mode of [undefined, 'blocked']) {
      const d = await detail(t, 'INBOX', uid, mode);
      assert.equal(d.blockedImages, 1);
      assert.ok(!d.html.includes('image-proxy'));
    }
  });

  test('Junk is always blocked, even with images=auto', async () => {
    const t = await signIn(app, TESTER);
    const uid = await appendRaw(TESTER, 'Junk', htmlMail(local('/ok.png')));
    const d = await detail(t, 'Junk', uid, 'auto');
    assert.equal(d.blockedImages, 1);
    assert.ok(!d.html.includes('image-proxy'));
  });

  test('bad or missing signature, missing session and unsigned arbitrary URLs are refused', async () => {
    const t = await signIn(app, TESTER);
    const secret = app.mailloom.config.sessionSecret;
    const u = local('/ok.png');
    const good = proxyImageUrl(secret, u, { account: t.handle });
    const cookie = { cookie: t.headers.cookie! };
    const bad = good.replace(/sig=[\w-]{43}/, `sig=${'A'.repeat(43)}`);
    assert.equal((await app.inject({ method: 'GET', url: bad, headers: cookie })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: `/api/image-proxy?u=${encodeURIComponent(u)}&account=${t.handle}`, headers: cookie })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: `/api/image-proxy?account=${t.handle}`, headers: cookie })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: good })).statusCode, 401);
    // a correctly signed URL for a private target still fails the address check
    const meta = proxyImageUrl(secret, 'http://169.254.169.254/latest/meta-data/', { account: t.handle });
    assert.equal((await app.inject({ method: 'GET', url: meta, headers: cookie })).statusCode, 403);
    // a signature made with another key is useless
    const forged = `/api/image-proxy?u=${encodeURIComponent(u)}&sig=${signImageUrl('z'.repeat(40), u)}&account=${t.handle}`;
    assert.equal((await app.inject({ method: 'GET', url: forged, headers: cookie })).statusCode, 403);
  });

  test('an SVG behind a valid signature is refused with 415', async () => {
    const t = await signIn(app, TESTER);
    const url = proxyImageUrl(app.mailloom.config.sessionSecret, local('/x.svg'), { account: t.handle });
    const res = await app.inject({ method: 'GET', url, headers: { cookie: t.headers.cookie! } });
    assert.equal(res.statusCode, 415);
  });
});

describe('DNS timeout and concurrency caps', () => {
  test('a lookup that never answers ends at the deadline', async () => {
    const t0 = Date.now();
    const hang = () => new Promise<string[]>(() => undefined);
    assert.equal(await code(fetchRemoteImage('http://slow.test/a.png', { resolve: hang, timeoutMs: 300 })), 'TIMEOUT');
    assert.ok(Date.now() - t0 < 3000);
  });

  test('per-session cap 6 (429) and global cap 16 (503) on in-flight fetches', async () => {
    const app = await buildTestApp({}, { imageProxy: testOpts({ timeoutMs: 1500 }) });
    try {
      const secret = app.mailloom.config.sessionSecret;
      const sessions = [await signIn(app, TESTER), await signIn(app, TESTER), await signIn(app, TESTER)];
      const fire = (t: Awaited<ReturnType<typeof signIn>>) =>
        app.inject({ method: 'GET', url: proxyImageUrl(secret, local('/hang'), { account: t.handle }), headers: { cookie: t.headers.cookie! } });
      // One session: the 7th request is refused at once while 6 hang.
      const first = Array.from({ length: 6 }, () => fire(sessions[0]!));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal((await fire(sessions[0]!)).statusCode, 429);
      const done1 = await Promise.all(first);
      assert.ok(done1.every((r) => r.statusCode === 504));
      // Three sessions x 6 = 18 > 16: two requests are refused with 503 while 16 hang.
      const all = sessions.flatMap((t) => Array.from({ length: 6 }, () => fire(t)));
      const results = await Promise.all(all);
      assert.equal(results.filter((r) => r.statusCode === 503).length, 2);
      assert.equal(results.filter((r) => r.statusCode === 504).length, 16);
    } finally {
      await app.close();
    }
  });
});
