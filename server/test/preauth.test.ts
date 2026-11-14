import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildTestApp } from './helpers.js';

// An unauthenticated caller must be refused from the headers alone, without the
// server reading (or waiting for) the body.
for (const url of ['/api/drafts', '/api/messages/send']) {
  test(`unauthenticated large POST to ${url} is refused before the body is read`, async () => {
    const app = await buildTestApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: url,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024), 'x-mailloom-account': 'a@delpat.test' }
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
            req.destroy();
          }
        );
        req.on('error', (e) => {
          if ((e as { code?: string }).code !== 'ECONNRESET') reject(e);
        });
        // Send only 1 KB of the declared 10 MB, then wait: a 401 must come anyway.
        req.write(Buffer.alloc(1024, 0x20));
        setTimeout(() => reject(new Error('no response before the body was sent')), 3000).unref();
      });
      assert.equal(status, 401);
    } finally {
      await app.close();
    }
  });
}
