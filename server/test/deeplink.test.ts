import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { COLLEAGUE, TESTER, TEST_PASSWORD, buildTestApp, signIn, withImap, type SignedIn } from './helpers.js';
import { loadAgentConfig, messageWebUrl } from '../src/agent/config.js';

/** Deep links: find one message of the signed-in mailbox by Message-ID, and web_url in agent responses. */

const run = crypto.randomBytes(4).toString('hex');

async function plant(email: string, folder: string, subject: string): Promise<string> {
  const messageId = `<${crypto.randomBytes(8).toString('hex')}.${run}@delpat.test>`;
  const raw = await new MailComposer({ from: COLLEAGUE, to: email, subject, text: 'hello', messageId, date: new Date() }).compile().build();
  await withImap(email, async (c) => {
    if (folder !== 'INBOX' && !(await c.list()).some((m) => m.path === folder)) await c.mailboxCreate(folder);
    await c.append(folder, raw, []);
  });
  return messageId;
}

const locate = (app: FastifyInstance, s: SignedIn, id: string) =>
  app.inject({ method: 'GET', url: `/api/messages/locate?message_id=${encodeURIComponent(id)}`, headers: s.headers });

describe('message lookup by Message-ID', () => {
  let app: FastifyInstance;
  let tester: SignedIn;
  let colleague: SignedIn;
  before(async () => {
    app = await buildTestApp({ AGENT_ALLOWED_IPS: '127.0.0.1', MAILLOOM_PUBLIC_URL: 'https://mail.delpat.test/' });
    tester = await signIn(app, TESTER);
    colleague = await signIn(app, COLLEAGUE);
  });
  after(() => app.close());

  test('finds a message in INBOX and in another folder, with or without angle brackets', async () => {
    const inInbox = await plant(TESTER, 'INBOX', `deep inbox ${run}`);
    const inOther = await plant(TESTER, `Deep${run}`, `deep other ${run}`);
    const a = await locate(app, tester, inInbox);
    assert.equal(a.statusCode, 200);
    assert.equal(a.json().folder, 'INBOX');
    assert.ok(a.json().uid > 0);
    const b = await locate(app, tester, inOther.slice(1, -1));
    assert.equal(b.statusCode, 200);
    assert.equal(b.json().folder, `Deep${run}`);
  });

  test('unknown Message-ID is 404, a bad one is 400, no session is 401', async () => {
    assert.equal((await locate(app, tester, `<nope.${run}@delpat.test>`)).statusCode, 404);
    assert.equal((await locate(app, tester, 'has space')).statusCode, 400);
    const anon = await app.inject({ method: 'GET', url: '/api/messages/locate?message_id=%3Ca%40b.c%3E' });
    assert.equal(anon.statusCode, 401);
  });

  test("another account cannot resolve a message that is not in its own mailbox", async () => {
    const mine = await plant(TESTER, 'INBOX', `deep private ${run}`);
    assert.equal((await locate(app, tester, mine)).statusCode, 200);
    assert.equal((await locate(app, colleague, mine)).statusCode, 404);
  });

  test('agent responses carry web_url built from MAILLOOM_PUBLIC_URL', async () => {
    const id = await plant(TESTER, 'INBOX', `deep agent ${run}`);
    const created = (await app.inject({ method: 'POST', url: '/api/connections/keys', headers: tester.headers, payload: { password: TEST_PASSWORD, name: 'Work OS' } })).json();
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent/v1/message?message_id=${encodeURIComponent(id)}`,
      remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${created.key}` }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().web_url, `https://mail.delpat.test/#/m/${encodeURIComponent(id)}`);
    const search = await app.inject({
      method: 'GET',
      url: `/api/agent/v1/search?query=${encodeURIComponent(`deep agent ${run}`)}`,
      remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${created.key}` }
    });
    assert.equal(search.json().messages[0].web_url, `https://mail.delpat.test/#/m/${encodeURIComponent(id)}`);
  });
});

describe('MAILLOOM_PUBLIC_URL', () => {
  test('is optional, trimmed, and must be https', () => {
    assert.equal(loadAgentConfig({}).publicUrl, null);
    assert.equal(messageWebUrl(loadAgentConfig({}), '<a@b.c>'), null);
    const cfg = loadAgentConfig({ MAILLOOM_PUBLIC_URL: 'https://mail.delpat.in/mail/' });
    assert.equal(cfg.publicUrl, 'https://mail.delpat.in/mail');
    assert.equal(messageWebUrl(cfg, 'x@y.z'), 'https://mail.delpat.in/mail/#/m/%3Cx%40y.z%3E');
    assert.equal(messageWebUrl(cfg, null), null);
    assert.throws(() => loadAgentConfig({ MAILLOOM_PUBLIC_URL: 'http://mail.delpat.in' }), /https/);
    assert.throws(() => loadAgentConfig({ MAILLOOM_PUBLIC_URL: 'nonsense' }), /web address/);
    assert.ok(loadAgentConfig({ MAILLOOM_PUBLIC_URL: 'http://localhost:3000' }).publicUrl);
  });
});
