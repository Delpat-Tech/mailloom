import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTestApp } from './helpers.js';
import { renderEmail } from '../src/utils/sanitize.js';

function fixtureDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailloom-dist-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
  return dir;
}

test('app shell and static files carry the security headers and CSP', async () => {
  const dist = fixtureDist();
  const app = await buildTestApp({ CLIENT_DIST: dist }, { clientDist: dist });
  try {
    for (const url of ['/', '/some/deep/link', '/app.js', '/mail/']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
      assert.equal(res.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
      const csp = String(res.headers['content-security-policy']);
      for (const part of [
        "default-src 'self'",
        "script-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        'img-src \'self\' data: https: blob:'
      ]) {
        assert.ok(csp.includes(part), `${url}: CSP has ${part}`);
      }
      assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
    }
    // API answers do not get the page CSP.
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(api.headers['content-security-policy'], undefined);
  } finally {
    await app.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('rendered mail only needs what the page CSP allows (inline styles, data: and https images, no scripts)', () => {
  const dirty =
    '<style>p{color:red}</style><p style="color:#123">Hi</p><img src="data:image/png;base64,iVBORw0KGgo=">' +
    '<img src="https://img.example/a.png"><script>alert(1)</script><img src="http://img.example/b.png"><link rel="stylesheet" href="https://x.example/a.css">';
  const hidden = renderEmail(dirty, { allowRemoteImages: false });
  const shown = renderEmail(dirty, { allowRemoteImages: true });
  assert.match(hidden.html, /style="color:#123"|style="color: ?#123/);
  assert.match(hidden.html, /data:image\/png;base64/);
  assert.doesNotMatch(hidden.html, /img\.example/);
  assert.match(shown.html, /https:\/\/img\.example\/a\.png/);
  for (const html of [hidden.html, shown.html]) {
    assert.doesNotMatch(html, /<script|<link|http:\/\/img\.example/i);
  }
});
