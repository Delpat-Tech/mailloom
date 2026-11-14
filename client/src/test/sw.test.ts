import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadWorker(fetchImpl: () => Promise<unknown>) {
  const code = fs.readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8');
  const handlers: Record<string, (e: unknown) => void> = {};
  const self = {
    location: { origin: 'https://mail.example' },
    addEventListener: (n: string, f: (e: unknown) => void) => (handlers[n] = f),
    skipWaiting() {},
    clients: { claim() {} },
    registration: {}
  };
  const caches = { match: async () => undefined, open: async () => ({ put() {} }), keys: async () => [] };
  class FakeResponse {
    static error() {
      return new FakeResponse('error');
    }
    constructor(public kind = 'ok') {}
  }
  vm.runInNewContext(code, { self, caches, fetch: fetchImpl, Response: FakeResponse, URL, console });
  return handlers.fetch!;
}

function fire(handler: (e: unknown) => void, url: string, mode = 'cors') {
  let responded: Promise<unknown> | undefined;
  handler({ request: { url, method: 'GET', mode }, respondWith: (p: Promise<unknown>) => (responded = p) });
  return responded;
}

describe('service worker fetch handler', () => {
  it('leaves cross-origin requests (fonts, remote images) to the browser', () => {
    const h = loadWorker(() => Promise.reject(new Error('should not be called')));
    expect(fire(h, 'https://fonts.gstatic.com/s/inter.woff2')).toBeUndefined();
    expect(fire(h, 'https://img.example/a.png')).toBeUndefined();
  });
  it('never resolves to undefined when offline and nothing is cached', async () => {
    const h = loadWorker(() => Promise.reject(new Error('offline')));
    expect(await fire(h, 'https://mail.example/assets/a.js')).toBeDefined();
    expect(await fire(h, 'https://mail.example/', 'navigate')).toBeDefined();
  });
});
