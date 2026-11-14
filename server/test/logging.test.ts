import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { buildTestApp } from './helpers.js';

test('request logs drop the query string', async () => {
  let captured = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      captured += chunk.toString();
      cb();
    }
  });
  const app = await buildTestApp({}, { logger: { level: 'info', stream } });
  try {
    await app.inject({ method: 'GET', url: '/api/mailboxes/INBOX/messages?search=topsecret&message_id=%3Cabc@x%3E' });
    await app.inject({ method: 'GET', url: '/api/messages/locate?message_id=secret-id-123' });
  } finally {
    await app.close();
  }
  assert.match(captured, /"url":"\/api\/mailboxes\/INBOX\/messages"/, 'the path is still logged');
  assert.doesNotMatch(captured, /topsecret|secret-id-123|search=/);
});
