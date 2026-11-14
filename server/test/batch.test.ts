import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ImapFlow } from 'imapflow';
import { TESTER, buildMime, buildTestApp, resetAccount, signIn, withImap, type SignedIn } from './helpers.js';
import { uidSet } from '../src/services/batch.js';

const calls = { flagsAdd: 0, flagsRemove: 0, move: 0, del: 0 };
const proto = ImapFlow.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const originals = {
  messageFlagsAdd: proto.messageFlagsAdd!,
  messageFlagsRemove: proto.messageFlagsRemove!,
  messageMove: proto.messageMove!,
  messageDelete: proto.messageDelete!
};
before(() => {
  const wrap = (name: keyof typeof originals, key: keyof typeof calls) => {
    proto[name] = function (this: unknown, ...a: unknown[]) {
      calls[key]++;
      return originals[name].apply(this, a);
    };
  };
  wrap('messageFlagsAdd', 'flagsAdd');
  wrap('messageFlagsRemove', 'flagsRemove');
  wrap('messageMove', 'move');
  wrap('messageDelete', 'del');
});
after(() => {
  Object.assign(proto, originals);
});

async function put(folder: string, subject: string, flags: string[] = []): Promise<number> {
  return withImap(TESTER, async (c) => {
    await c.mailboxCreate(folder).catch(() => {});
    const r = await c.append(folder, await buildMime({ subject, text: subject }), flags);
    if (!r || !r.uid) throw new Error('append failed');
    return r.uid;
  });
}

async function state(folder: string): Promise<Map<string, string[]>> {
  return withImap(TESTER, async (c) => {
    const out = new Map<string, string[]>();
    const lock = await c.getMailboxLock(folder);
    try {
      if (typeof c.mailbox === 'object' && c.mailbox.exists > 0) {
        for await (const m of c.fetch('1:*', { uid: true, flags: true, envelope: true })) out.set(m.envelope!.subject!, [...(m.flags || [])]);
      }
    } finally {
      lock.release();
    }
    return out;
  });
}

describe('uidSet', () => {
  test('compresses runs', () => {
    assert.equal(uidSet([9, 1, 2, 3, 5, 6, 3]), '1:3,5:6,9');
    assert.equal(uidSet([7]), '7');
  });
});

describe('batch actions', () => {
  let app: FastifyInstance;
  let t: SignedIn;
  const post = (path: string, url: string, payload: object) =>
    app.inject({ method: 'POST', url: `/api/mailboxes/${encodeURIComponent(path)}${url}`, headers: t.headers, payload });
  const batch = (path: string, payload: object) => post(path, '/batch', payload);

  before(async () => {
    app = await buildTestApp();
    t = await signIn(app, TESTER);
  });
  after(() => app.close());
  beforeEach(async () => {
    await resetAccount(TESTER);
    for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k] = 0;
  });

  test('read, unread, flag and unflag use one STORE for the whole list', async () => {
    const uids = [await put('INBOX', 'a'), await put('INBOX', 'b'), await put('INBOX', 'c')];
    await put('INBOX', 'untouched');
    let r = await batch('INBOX', { action: 'read', uids });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().affected, 3);
    assert.equal(calls.flagsAdd, 1, 'one STORE command for three messages');
    let s = await state('INBOX');
    for (const n of ['a', 'b', 'c']) assert.ok(s.get(n)!.includes('\\Seen'), n);
    assert.ok(!s.get('untouched')!.includes('\\Seen'));

    r = await batch('INBOX', { action: 'unread', uids });
    assert.equal(r.statusCode, 200);
    assert.equal(calls.flagsRemove, 1);
    s = await state('INBOX');
    for (const n of ['a', 'b', 'c']) assert.ok(!s.get(n)!.includes('\\Seen'), n);

    assert.equal((await batch('INBOX', { action: 'flag', uids })).statusCode, 200);
    s = await state('INBOX');
    for (const n of ['a', 'b', 'c']) assert.ok(s.get(n)!.includes('\\Flagged'), n);
    assert.equal((await batch('INBOX', { action: 'unflag', uids })).statusCode, 200);
    s = await state('INBOX');
    for (const n of ['a', 'b', 'c']) assert.ok(!s.get(n)!.includes('\\Flagged'), n);
  });

  test('move, archive and delete are one MOVE each; delete goes to Trash', async () => {
    const uids = [await put('INBOX', 'm1'), await put('INBOX', 'm2'), await put('INBOX', 'm3')];
    await withImap(TESTER, (c) => c.mailboxCreate('Projects').then(() => undefined, () => undefined));
    let r = await batch('INBOX', { action: 'move', uids: uids.slice(0, 2), targetFolder: 'Projects' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().affected, 2);
    assert.equal(r.json().movedTo, 'Projects');
    assert.equal(calls.move, 1);
    assert.deepEqual([...(await state('Projects')).keys()].sort(), ['m1', 'm2']);
    assert.deepEqual([...(await state('INBOX')).keys()], ['m3']);

    r = await batch('INBOX', { action: 'archive', uids: [uids[2]!] });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().movedTo, 'Archive');
    assert.deepEqual([...(await state('Archive')).keys()], ['m3']);

    const more = [await put('INBOX', 'd1'), await put('INBOX', 'd2')];
    calls.move = 0;
    r = await batch('INBOX', { action: 'delete', uids: more });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual({ permanent: r.json().permanent, movedTo: r.json().movedTo, affected: r.json().affected }, { permanent: false, movedTo: 'Trash', affected: 2 });
    assert.equal(calls.move, 1);
    assert.deepEqual([...(await state('Trash')).keys()].sort(), ['d1', 'd2']);
  });

  test('delete inside Trash is permanent', async () => {
    const uids = [await put('Trash', 't1'), await put('Trash', 't2')];
    const r = await batch('Trash', { action: 'delete', uids });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual({ permanent: r.json().permanent, affected: r.json().affected }, { permanent: true, affected: 2 });
    assert.equal(calls.del, 1);
    assert.equal((await state('Trash')).size, 0);
  });

  test('spam marks read and moves to Junk', async () => {
    const uids = [await put('INBOX', 's1'), await put('INBOX', 's2')];
    const r = await batch('INBOX', { action: 'spam', uids });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().movedTo, 'Junk');
    const junk = await state('Junk');
    assert.deepEqual([...junk.keys()].sort(), ['s1', 's2']);
    for (const f of junk.values()) assert.ok(f.includes('\\Seen'));
    assert.equal((await state('INBOX')).size, 0);
  });

  test('all: true covers the whole folder with one command', async () => {
    for (const n of ['x1', 'x2', 'x3', 'x4']) await put('INBOX', n);
    const r = await batch('INBOX', { action: 'read', all: true });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().affected, 4);
    assert.equal(calls.flagsAdd, 1);
    for (const f of (await state('INBOX')).values()) assert.ok(f.includes('\\Seen'));

    calls.move = 0;
    const mv = await batch('INBOX', { action: 'archive', all: true });
    assert.equal(mv.json().affected, 4);
    assert.equal(calls.move, 1);
    assert.equal((await state('INBOX')).size, 0);
    assert.equal((await state('Archive')).size, 4);
    // An empty folder is not an error for all.
    assert.equal((await batch('INBOX', { action: 'read', all: true })).json().affected, 0);
  });

  test('uids that are gone are skipped; none left is 404', async () => {
    const a = await put('INBOX', 'here');
    const r = await batch('INBOX', { action: 'read', uids: [a, 99999] });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().affected, 1);
    const none = await batch('INBOX', { action: 'read', uids: [99998, 99999] });
    assert.equal(none.statusCode, 404);
    assert.equal(none.json().code, 'MESSAGE_NOT_FOUND');
  });

  test('bad input is refused before IMAP is touched', async () => {
    const cases: Array<[object, number]> = [
      [{ action: 'explode', uids: [1] }, 400],
      [{ action: 'read' }, 400],
      [{ action: 'read', uids: [1], all: true }, 400],
      [{ action: 'read', uids: [] }, 400],
      [{ action: 'read', uids: [0] }, 400],
      [{ action: 'read', uids: ['1'] }, 400],
      [{ action: 'read', uids: [1.5] }, 400],
      [{ action: 'move', uids: [1] }, 400],
      [{ action: 'read', all: 'yes' }, 400]
    ];
    for (const [payload, status] of cases) assert.equal((await batch('INBOX', payload)).statusCode, status, JSON.stringify(payload));
    const noAuth = await app.inject({ method: 'POST', url: '/api/mailboxes/INBOX/batch', payload: { action: 'read', all: true } });
    assert.equal(noAuth.statusCode, 401);
  });

  test('moving into the same folder is refused', async () => {
    const a = await put('INBOX', 'same');
    assert.equal((await batch('INBOX', { action: 'move', uids: [a], targetFolder: 'INBOX' })).statusCode, 400);
  });
});

describe('POST /api/mailboxes/:path/mark-all-read', () => {
  let app: FastifyInstance;
  let t: SignedIn;
  before(async () => {
    app = await buildTestApp();
    t = await signIn(app, TESTER);
  });
  after(() => app.close());

  test('marks every unread message read with one STORE and says how many were unread', async () => {
    await resetAccount(TESTER);
    await put('INBOX', 'u1');
    await put('INBOX', 'u2');
    await put('INBOX', 'r1', ['\\Seen']);
    await put('Sent', 'other folder');
    calls.flagsAdd = 0;
    const r = await app.inject({ method: 'POST', url: '/api/mailboxes/INBOX/mark-all-read', headers: t.headers });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { success: true, affected: 2 });
    assert.equal(calls.flagsAdd, 1);
    for (const f of (await state('INBOX')).values()) assert.ok(f.includes('\\Seen'));
    assert.ok(!(await state('Sent')).get('other folder')!.includes('\\Seen'), 'other folders are untouched');
    const again = await app.inject({ method: 'POST', url: '/api/mailboxes/INBOX/mark-all-read', headers: t.headers });
    assert.deepEqual(again.json(), { success: true, affected: 0 });
    assert.equal(calls.flagsAdd, 1, 'nothing to store the second time');
    assert.equal((await app.inject({ method: 'POST', url: '/api/mailboxes/INBOX/mark-all-read' })).statusCode, 401);
  });
});
