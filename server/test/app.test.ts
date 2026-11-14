import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

test('buildApp builds without listening and answers unknown API routes', async () => {
  const app = await buildApp({ clientDist: null });
  const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
  assert.equal(res.statusCode, 404);
  await app.close();
});
