import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, signIn, TESTER, type SignedIn } from './helpers.js';
import { FEEDBACK_PER_HOUR } from '../src/routes/feedback.js';
import { loadIntakeConfig } from '../src/services/feedback-sink.js';

const TOKEN = 'tok_' + 'x'.repeat(40);
const SECRET_TEXT = 'My secret complaint about invoice 4471';

interface Seen {
  headers: http.IncomingHttpHeaders;
  body: Record<string, any>;
}
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A stand-in for the Work OS intake: records what it receives, answers from a queue (default: 201). */
function fakeIntake() {
  const seen: Seen[] = [];
  const queue: Handler[] = [];
  let other = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/elsewhere') {
      other++;
      res.writeHead(200).end('{}');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      const h = queue.shift();
      if (h) return h(req, res);
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ref: `T-${seen.length}`, url: 'https://work.example/t' }));
    });
  });
  return {
    seen,
    queue,
    get elsewhere() {
      return other;
    },
    reply: (status: number, body: unknown = {}, headers: Record<string, string> = {}): Handler => (_q, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(typeof body === 'string' ? body : JSON.stringify(body));
    },
    listen: () => new Promise<string>((ok) => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    close: () => new Promise<void>((ok) => server.close(() => ok())),
    closeAll: () => server.closeAllConnections()
  };
}

describe('report a problem: Work OS delivery', () => {
  let app: FastifyInstance;
  let t: SignedIn;
  let clock = Date.now();
  const intake = fakeIntake();
  const logs: string[] = [];
  let base = '';

  const post = async (payload: unknown, headers?: Record<string, string>) => {
    const send = () => app.inject({ method: 'POST', url: '/api/feedback', headers: headers ?? t.headers, payload: payload as object });
    const res = await send();
    if (res.statusCode !== 401 || headers) return res;
    t = await signIn(app, TESTER); // the test clock jumps far ahead: the session idled out
    return send();
  };
  const settle = () => app.mailloomFeedback.delivery!.idle();
  const advance = async (ms: number) => {
    clock += ms;
    await app.mailloomFeedback.delivery!.tick();
  };
  const row = (id?: string) => {
    const store = app.mailloomFeedback.store;
    return store.get(id ?? intake.seen[0]!.body.report_id)!;
  };

  before(async () => {
    base = await intake.listen();
    const stream = new Writable({
      write(chunk, _e, cb) {
        logs.push(chunk.toString());
        cb();
      }
    });
    app = await buildTestApp(
      { WORKOS_INTAKE_URL: `${base}/api/intake/mailloom`, WORKOS_INTAKE_TOKEN: TOKEN },
      { now: () => clock, logger: { level: 'info', stream } }
    );
    t = await signIn(app, TESTER);
    assert.equal(t.res.statusCode, 200);
  });
  after(async () => {
    await app.close();
    intake.closeAll();
    await intake.close();
  });
  beforeEach(() => {
    app.mailloomFeedback.hits.clear(); // the hourly limit has its own test
    intake.seen.length = 0;
    intake.queue.length = 0;
  });

  test('is on only when the intake is set; never exposes the token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/feedback', headers: t.headers });
    assert.deepEqual(res.json(), { enabled: true });
    assert.doesNotMatch(res.body, /tok_/);
    for (const env of [
      {},
      { WORKOS_INTAKE_URL: 'https://work.example/api/intake/mailloom' },
      { WORKOS_INTAKE_TOKEN: TOKEN },
      { WORKOS_INTAKE_URL: 'https://work.example/x', WORKOS_INTAKE_TOKEN: 'short' },
      { WORKOS_INTAKE_URL: 'http://work.example/x', WORKOS_INTAKE_TOKEN: TOKEN },
      { WORKOS_INTAKE_URL: 'https://user:pw@work.example/x', WORKOS_INTAKE_TOKEN: TOKEN }
    ]) assert.equal(loadIntakeConfig(env).config, null, JSON.stringify(env));
    assert.ok(loadIntakeConfig({ WORKOS_INTAKE_URL: 'https://work.example/x', WORKOS_INTAKE_TOKEN: TOKEN }).config);
    assert.ok(loadIntakeConfig({ WORKOS_INTAKE_URL: 'http://localhost:8080/x', WORKOS_INTAKE_TOKEN: TOKEN }).config);
    const off = await buildTestApp({ WORKOS_INTAKE_URL: undefined, WORKOS_INTAKE_TOKEN: undefined });
    try {
      const t2 = await signIn(off, TESTER);
      assert.deepEqual((await off.inject({ method: 'GET', url: '/api/feedback', headers: t2.headers })).json(), { enabled: false });
      assert.equal((await off.inject({ method: 'POST', url: '/api/feedback', headers: t2.headers, payload: { what: 'x' } })).statusCode, 404);
    } finally {
      await off.close();
    }
  });

  test('refuses without a session or the account header', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/feedback', payload: { what: 'x' } })).statusCode, 401);
    const r = await app.inject({ method: 'POST', url: '/api/feedback', headers: { cookie: t.headers.cookie }, payload: { what: 'x' } });
    assert.ok([400, 401, 403].includes(r.statusCode));
    assert.equal(intake.seen.length, 0);
  });

  test('validation: what is required and limited, expected limited, size cap', async () => {
    assert.equal((await post({ what: '   ' })).statusCode, 400);
    assert.equal((await post({ what: 'x'.repeat(4001) })).statusCode, 400);
    assert.equal((await post({ what: 'ok', expected: 'y'.repeat(2001) })).statusCode, 400);
    assert.equal((await post({ what: 'z'.repeat(70 * 1024) })).statusCode, 413);
    await settle();
    assert.equal(intake.seen.length, 0);
  });

  test('a report is stored, answered at once and delivered to Work OS in the agreed shape', async () => {
    const res = await post({
      what: `  ${SECRET_TEXT}\nsecond line`,
      expected: 'It to work',
      to: 'attacker@evil.example',
      details: { version: 'abc1234', userAgent: 'TestBrowser/1.0', screen: '390x844 window', display: 'installed app', view: 'Inbox', time: '2026-11-18T10:00:00Z', errors: ['Network error', 'Another'] }
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { success: true }, 'no Work OS ref goes back to staff');
    await settle();
    assert.equal(intake.seen.length, 1);
    const { headers, body } = intake.seen[0]!;
    assert.equal(headers.authorization, `Bearer ${TOKEN}`);
    assert.match(String(headers['content-type']), /application\/json/);
    assert.match(body.report_id, /^[0-9a-f]{32}$/);
    assert.equal(body.reporter, TESTER);
    assert.equal(body.title, SECRET_TEXT);
    assert.equal(body.description_markdown, `**What happened**\n\n${SECRET_TEXT}\nsecond line\n\n**What did you expect**\n\nIt to work`);
    assert.deepEqual(body.details, { version: 'abc1234', device: 'installed app, 390x844 window', browser: 'TestBrowser/1.0', view: 'Inbox', errors: ['Network error', 'Another'] });
    assert.deepEqual(Object.keys(body).sort(), ['description_markdown', 'details', 'report_id', 'reporter', 'title']);
    assert.doesNotMatch(JSON.stringify(body), /evil\.example|screenshot/);
    const r = row();
    assert.equal(r.status, 'delivered');
    assert.equal(r.ref, 'T-1');
  });

  test('without details the intake still gets an (empty) details object', async () => {
    assert.equal((await post({ what: 'Plain report' })).statusCode, 200);
    await settle();
    assert.deepEqual(intake.seen[0]!.body.details, { version: '', device: '', browser: '', view: '', errors: [] });
    assert.doesNotMatch(intake.seen[0]!.body.description_markdown, /expect/);
  });

  test('5xx and network errors: kept, retried with backoff and the same report_id', async () => {
    intake.queue.push(intake.reply(500), (req) => req.socket.destroy(), intake.reply(502));
    assert.equal((await post({ what: 'Retry me' })).statusCode, 200);
    await settle();
    const id = intake.seen[0]!.body.report_id;
    assert.equal(row(id).status, 'pending');
    assert.equal(row(id).lastCode, 'HTTP_500');
    await advance(5_000);
    assert.equal(intake.seen.length, 1, 'not before the backoff has passed');
    await advance(30_000);
    assert.equal(intake.seen.length, 2);
    assert.equal(row(id).lastCode, 'NETWORK');
    await advance(2 * 60_000 + 1000);
    assert.equal(intake.seen.length, 3);
    assert.equal(row(id).lastCode, 'HTTP_502');
    await advance(10 * 60_000 + 1000);
    assert.equal(intake.seen.length, 4);
    assert.ok(intake.seen.every((s) => s.body.report_id === id));
    assert.equal(row(id).status, 'delivered');
    assert.equal(row(id).ref, 'T-4');
    await advance(3_600_000);
    assert.equal(intake.seen.length, 4, 'a delivered report is not sent again');
  });

  test('429 honours Retry-After; 401 and 503 wait at least 15 minutes; both keep the report', async () => {
    intake.queue.push(intake.reply(429, {}, { 'Retry-After': '120' }));
    await post({ what: 'Too fast' });
    await settle();
    const id = intake.seen[0]!.body.report_id;
    assert.equal(row(id).status, 'pending');
    await advance(60_000);
    assert.equal(intake.seen.length, 1);
    await advance(61_000);
    assert.equal(intake.seen.length, 2);
    assert.equal(row(id).status, 'delivered');

    intake.seen.length = 0;
    intake.queue.push(intake.reply(401), intake.reply(503));
    await post({ what: 'Config problem' });
    await settle();
    const id2 = intake.seen[0]!.body.report_id;
    await advance(10 * 60_000);
    assert.equal(intake.seen.length, 1, 'config problems are not hammered');
    await advance(6 * 60_000);
    assert.equal(intake.seen.length, 2);
    assert.equal(row(id2).lastCode, 'HTTP_503');
    await advance(16 * 60_000);
    assert.equal(row(id2).status, 'delivered');
  });

  test('400 and 413 are permanent: the report is marked failed and kept, never retried', async () => {
    for (const status of [400, 413]) {
      intake.seen.length = 0;
      intake.queue.push(intake.reply(status, { error: 'nope' }));
      await post({ what: `Refused ${status}` });
      await settle();
      const r = row(intake.seen[0]!.body.report_id);
      assert.equal(r.status, 'failed');
      assert.equal(r.lastCode, `HTTP_${status}`);
      assert.match(r.text, /Refused/);
      await advance(24 * 3_600_000);
      assert.equal(intake.seen.length, 1);
    }
  });

  test('a reply without a ref or an over-large reply is not a delivery; a redirect is not followed', async () => {
    intake.queue.push(intake.reply(200, { nothing: true }), intake.reply(200, 'x'.repeat(1024 * 1024 + 10)));
    await post({ what: 'Odd replies' });
    await settle();
    const id = intake.seen[0]!.body.report_id;
    assert.equal(row(id).status, 'pending');
    assert.equal(row(id).lastCode, 'BAD_REPLY');
    await advance(31_000);
    assert.equal(row(id).status, 'pending');
    assert.equal(row(id).lastCode, 'BAD_REPLY');

    intake.queue.push(intake.reply(302, {}, { Location: `${base}/elsewhere` }));
    await advance(3 * 60_000);
    assert.equal(intake.elsewhere, 0, 'the redirect was not followed');
    assert.equal(row(id).lastCode, 'HTTP_302');
    await advance(16 * 60_000);
    assert.equal(row(id).status, 'delivered');
  });

  test('a pending report survives a restart of the delivery job', async () => {
    intake.queue.push(intake.reply(500));
    await post({ what: 'Survivor' });
    await settle();
    const id = intake.seen[0]!.body.report_id;
    assert.equal(row(id).status, 'pending');
    assert.equal(app.mailloomFeedback.store.pendingCount(), 1);
    await advance(31_000);
    assert.equal(row(id).status, 'delivered');
    assert.equal(app.mailloomFeedback.store.pendingCount(), 0);
  });

  test('the token and the report text never reach the log', async () => {
    const all = logs.join('\n');
    assert.ok(all.length > 0, 'the log was captured');
    assert.doesNotMatch(all, /tok_x/);
    assert.doesNotMatch(all, new RegExp(SECRET_TEXT));
    assert.doesNotMatch(all, /Retry me|Plain report|Config problem|Survivor/);
    assert.match(all, /Report not delivered yet/);
    assert.match(all, /Report delivered to Work OS/);
  });
});

describe('report a problem: rules', () => {
  let app: FastifyInstance;
  let t: SignedIn;
  let clock = Date.now();
  const intake = fakeIntake();

  before(async () => {
    const base = await intake.listen();
    app = await buildTestApp({ WORKOS_INTAKE_URL: `${base}/i`, WORKOS_INTAKE_TOKEN: TOKEN }, { now: () => clock });
    t = await signIn(app, TESTER);
  });
  after(async () => {
    await app.close();
    intake.closeAll();
    await intake.close();
  });

  test('at most 5 per hour per mailbox, then it frees up', async () => {
    const post = (what: string) => app.inject({ method: 'POST', url: '/api/feedback', headers: t.headers, payload: { what } });
    for (let i = 0; i < FEEDBACK_PER_HOUR; i++) assert.equal((await post(`Report ${i}`)).statusCode, 200);
    const res = await post('One too many');
    assert.equal(res.statusCode, 429);
    assert.ok(Number(res.headers['retry-after']) > 0);
    clock += 61 * 60_000;
    t = await signIn(app, TESTER); // the session itself idles out after 30 minutes
    assert.equal((await app.inject({ method: 'POST', url: '/api/feedback', headers: t.headers, payload: { what: 'After the hour' } })).statusCode, 200);
  });

  test('the demo mailbox cannot send reports', async () => {
    const demo = await buildTestApp({ WORKOS_INTAKE_URL: 'http://127.0.0.1:9/i', WORKOS_INTAKE_TOKEN: TOKEN, DEMO_MODE: '1' });
    try {
      const login = await demo.inject({ method: 'POST', url: '/api/auth/connect', payload: { isDemo: true } });
      assert.equal(login.statusCode, 200, login.body);
      const handle = login.json().account.handle as string;
      const cookie = (login.cookies as Array<{ name: string; value: string }>).map((c) => `${c.name}=${c.value}`).join('; ');
      const res = await demo.inject({ method: 'POST', url: '/api/feedback', headers: { cookie, 'x-mailloom-account': handle }, payload: { what: 'x' } });
      assert.equal(res.statusCode, 403);
    } finally {
      await demo.close();
    }
  });
});
