import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, signIn, resetAccount, withImap, GM } from './helpers.js';

/**
 * The conversation index on a large folder: the first page never waits for it, it fills in the
 * background newest first in batches, and a run that breaks off resumes from its saved cursor.
 */

const N = 2500;
const BATCH = 1000;

function raw(i: number): string {
  return [
    `From: colleague@delpat.test`,
    `To: tester@delpat.test`,
    `Subject: bulk ${i}`,
    `Message-ID: <bulk-${i}@delpat.test>`,
    ...(i % 2 === 1 ? [`References: <bulk-${i - 1}@delpat.test>`] : []),
    'Date: Fri, 13 Nov 2026 10:00:00 +0000',
    '',
    `body ${i}`,
    ''
  ].join('\r\n');
}

let apps: FastifyInstance[] = [];

before(async () => {
  await resetAccount(GM.tester);
  await withImap(GM.tester, async (c) => {
    for (let i = 0; i < N; i++) await c.append('INBOX', raw(i), ['\\Seen']);
  });
});

after(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await resetAccount(GM.tester);
});

test('first page of a large folder does not wait for indexing; backfill resumes after a drop', async () => {
  const batches: Array<{ phase: string; count: number }> = [];
  let gate: (() => void) | null = null;
  let gateOpen: Promise<void> = new Promise((r) => (gate = r));
  let dropAfter = 2; // the first run "loses its connection" after two backfill batches
  const app = await buildTestApp(
    {},
    {
      organise: {
        batchSize: BATCH,
        retryMs: 0,
        onBatch: async ({ folder, phase, count }) => {
          if (folder !== 'INBOX') return;
          batches.push({ phase, count });
          if (phase !== 'backfill') return;
          await gateOpen; // hold the background run until the test lets it go
          if (--dropAfter === 0) throw Object.assign(new Error('simulated drop'), { code: 'ECONNRESET' });
        }
      }
    }
  );
  apps.push(app);
  const t = await signIn(app, GM.tester);
  const store = app.mailloomOrganise.store;
  const indexer = app.mailloomOrganise.indexer;

  // 1. The first page answers while the background run is still held at its first batch.
  const started = Date.now();
  const res = await app.inject({ method: 'GET', url: '/api/mailboxes/INBOX/messages?limit=50', headers: t.headers });
  const ms = Date.now() - started;
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().total, N);
  assert.equal(res.json().messages.length, 50);
  assert.ok(ms < 3000, `first page took ${ms} ms`);
  assert.ok(res.json().messages.every((m: any) => m.threadCount >= 1));
  assert.equal(indexer.running(GM.tester), true);
  // Waiting for the first batch, never blocking the session: a second list call answers too.
  assert.equal((await app.inject({ method: 'GET', url: '/api/mailboxes/INBOX/messages?limit=5', headers: t.headers })).statusCode, 200);

  // 2. Let it run: it saves two batches (newest first), then the connection "drops".
  gate!();
  await indexer.idle(GM.tester);
  let state = store.syncState(GM.tester, 'INBOX')!;
  assert.equal(state.complete, false);
  assert.equal(store.countFolder(GM.tester, 'INBOX'), 2 * BATCH);
  const newest = Math.max(...store.indexedUids(GM.tester, 'INBOX'));
  assert.equal(newest, state.highUid, 'newest mail is indexed first');

  // 3. The next list call starts a new run, which picks up below the saved cursor only.
  batches.length = 0;
  gateOpen = Promise.resolve();
  await app.inject({ method: 'GET', url: '/api/mailboxes/INBOX/messages?limit=5', headers: t.headers });
  await indexer.idle(GM.tester);
  state = store.syncState(GM.tester, 'INBOX')!;
  assert.equal(state.complete, true);
  assert.equal(store.countFolder(GM.tester, 'INBOX'), N);
  assert.deepEqual(batches, [{ phase: 'backfill', count: N - 2 * BATCH }]);

  // Threads are counted from the index (pairs of bulk-<even>, bulk-<odd>), and has-attachments is cached.
  const page = (await app.inject({ method: 'GET', url: '/api/mailboxes/INBOX/messages?limit=4', headers: t.headers })).json();
  assert.ok(page.messages.every((m: any) => m.threadCount === 2));
  const uids = store.indexedUids(GM.tester, 'INBOX');
  assert.equal(store.attachmentFlags(GM.tester, 'INBOX', state.uidValidity, uids).size, N);
  assert.equal(store.attachmentFlags(GM.tester, 'INBOX', 'other-validity', uids).size, 0);

  // 4. A little new mail is indexed inline on the next list call (no background run needed).
  await withImap(GM.tester, async (c) => {
    await c.append('INBOX', raw(N), ['\\Seen']);
    await c.append('INBOX', raw(N + 1), ['\\Seen']);
  });
  batches.length = 0;
  const fresh = (await app.inject({ method: 'GET', url: '/api/mailboxes/INBOX/messages?limit=2', headers: t.headers })).json();
  assert.equal(indexer.running(GM.tester), false);
  assert.deepEqual(batches, []);
  assert.ok(fresh.messages.every((m: any) => m.threadCount === 2));
  assert.equal(store.countFolder(GM.tester, 'INBOX'), N + 2);
});
