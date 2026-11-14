import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ImapFlow } from 'imapflow';
import { TESTER, appendRaw, buildMime, buildTestApp, resetAccount, signIn, withImap, type SignedIn } from './helpers.js';

/*
 * Dovecot (and most servers) answer EXAMINE, the read-only select, with an empty PERMANENTFLAGS list.
 * imapflow then silently DROPS a KEYWORD search term for a keyword that no message uses yet, so
 * "UNSEEN KEYWORD $label_x" became plain "UNSEEN": every empty label showed the whole unread count
 * and an empty label's view listed every message. GreenMail reports "\*" even on EXAMINE, so the
 * test makes it behave like Dovecot.
 */
const realLock = ImapFlow.prototype.getMailboxLock;
before(() => {
  ImapFlow.prototype.getMailboxLock = async function (this: ImapFlow, path: string, opts?: { readOnly?: boolean }) {
    const lock = await realLock.call(this, path, opts as never);
    if (opts?.readOnly && this.mailbox && typeof this.mailbox === 'object') {
      (this.mailbox as { permanentFlags?: Set<string> }).permanentFlags = new Set();
    }
    return lock;
  } as typeof realLock;
});
after(() => {
  ImapFlow.prototype.getMailboxLock = realLock;
});

/** Appends a message the way the other label tests do (GreenMail only keeps \Seen given this way). */
async function put(folder: string, subject: string, flags: string[] = []): Promise<number> {
  return withImap(TESTER, async (c) => {
    await c.mailboxCreate(folder).catch(() => {});
    const r = await c.append(folder, await buildMime({ subject, text: subject }), flags);
    if (!r || !r.uid) throw new Error('append failed');
    return r.uid;
  });
}

const raw = (subject: string) => `From: a@b.test\r\nTo: tester@delpat.test\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@x.test>\r\n\r\nx\r\n`;

describe('label counts', () => {
  let app: FastifyInstance;
  let t: SignedIn;
  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: t.headers, ...(payload ? { payload } : {}) });

  before(async () => {
    app = await buildTestApp();
    await resetAccount(TESTER);
    await withImap(TESTER, async (c) => {
      await c.mailboxCreate('Archive').catch(() => undefined);
    });
    t = await signIn(app, TESTER);
  });
  after(() => app.close());

  test('empty labels count 0 even with many unread messages (no KEYWORD term silently dropped)', async () => {
    for (let i = 0; i < 12; i++) await appendRaw(TESTER, 'INBOX', raw(`unread ${i}`));
    const a = (await req('POST', '/api/labels', { name: 'Alpha', colour: 'mint' })).json();
    const b = (await req('POST', '/api/labels', { name: 'Beta', colour: 'blue' })).json();
    const list = (await req('GET', '/api/labels')).json() as Array<{ id: string; count: number; unread: number; total: number }>;
    for (const l of list) {
      assert.equal(l.count, 0, 'count (kept for older clients)');
      assert.equal(l.unread, 0, 'unread');
      assert.equal(l.total, 0, 'total');
    }
    const view = (await req('GET', `/api/labels/${a.id}/messages`)).json();
    assert.equal(view.total, 0, 'an empty label lists nothing');
    assert.equal((await req('GET', `/api/labels/${b.id}/messages`)).json().messages.length, 0);
  });

  test('unread and total are per label, across folders, excluding Trash and Junk', async () => {
    const a = (await req('GET', '/api/labels')).json().find((l: { name: string }) => l.name === 'Alpha');
    const b = (await req('GET', '/api/labels')).json().find((l: { name: string }) => l.name === 'Beta');
    const u1 = await put('INBOX', 'alpha unread');
    const u2 = await put('INBOX', 'alpha read', ['\\Seen']);
    const u3 = await put('Archive', 'alpha archived unread');
    const u4 = await put('Trash', 'alpha in trash');
    const u5 = await put('INBOX', 'beta read', ['\\Seen']);
    for (const [mailbox, uids, id] of [
      ['INBOX', [u1, u2], a.id],
      ['Archive', [u3], a.id],
      ['Trash', [u4], a.id],
      ['INBOX', [u5], b.id]
    ] as const) {
      const r = await req('POST', '/api/messages/labels', { mailbox, uids, add: [id] });
      assert.equal(r.statusCode, 200, r.body);
    }
    const list = (await req('GET', '/api/labels')).json() as Array<{ name: string; count: number; unread: number; total: number }>;
    const by = (n: string) => list.find((l) => l.name === n)!;
    assert.deepEqual({ unread: by('Alpha').unread, total: by('Alpha').total }, { unread: 2, total: 3 });
    assert.deepEqual({ unread: by('Beta').unread, total: by('Beta').total }, { unread: 0, total: 1 });
    assert.equal(by('Alpha').count, 2);
    const view = (await req('GET', `/api/labels/${a.id}/messages`)).json();
    assert.equal(view.total, 3, 'the label view agrees with the total');
  });
});
