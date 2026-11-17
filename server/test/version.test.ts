import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from './helpers.js';

test('GET /api/version is open, tiny and never cached', async () => {
  const app = await buildTestApp({ MAILLOOM_VERSION: 'mailloom-0123abcd45' });
  try {
    for (const url of ['/api/version', '/mail/api/version']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.deepEqual(res.json(), { version: '0123abcd45' });
    }
  } finally {
    await app.close();
  }
});

test('GET /api/version says dev when no build id is known', async () => {
  const app = await buildTestApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/version' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { version: 'dev' });
  } finally {
    await app.close();
  }
});
