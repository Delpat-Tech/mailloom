import crypto from 'node:crypto';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from './auth.js';
import { agentPoolKey, verifyReentry } from './connections.js';
import { closeSessionConnection } from '../services/imap.js';
import { ipAllowed, normaliseIp, type AgentConfig, type ConnectClient } from '../agent/config.js';
import { isWellFormedAuthCode } from '../agent/crypto.js';
import { ConnectStore } from '../agent/connect-store.js';
import { SCOPES, type Scope } from '../agent/store.js';

/**
 * Connect Mailloom: OAuth 2.0 authorization code + PKCE (S256) with one registered client (Work OS).
 *
 *   GET  /oauth/authorize            browser. Checks client and exact redirect URI, stores a pending request, sends the
 *                                    browser to the consent screen (#/connect/<id>). A bad client or redirect never redirects.
 *   GET  /api/oauth/requests/:id     consent screen (session). What is being asked.
 *   POST /api/oauth/consent          consent screen (session + X-Mailloom-Account). Allow needs the mailbox password.
 *   POST /api/agent/v1/oauth/token   Work OS server. Swaps code + verifier + client secret for an agent key.
 *
 * All of them are served under / and /mail (live Nginx strips /mail/, so the server sees /oauth/authorize).
 * The key is minted at the token swap, never at Allow, so an abandoned flow leaves no live key.
 */

declare module 'fastify' {
  interface FastifyInstance {
    mailloomConnect: ConnectStore;
  }
}

const P = '/api/agent/v1';
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const STATE_RE = /^[!-~]{1,512}$/;

/** Allow N hits per window per key (an address). Uses the app clock, so tests can move it. */
export class WindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number
  ) {}

  /** 0 when allowed (and counted); otherwise milliseconds until a slot frees. */
  take(key: string): number {
    const now = this.now();
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (v.every((t) => t <= now - this.windowMs)) this.hits.delete(k);
    }
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return Math.max(1000, list[0]! + this.windowMs - now);
    }
    list.push(now);
    this.hits.set(key, list);
    return 0;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A plain page for a request that cannot be honoured. Never echoes anything the caller sent. */
function errorPage(reply: FastifyReply, status: number, message: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cannot connect - Mailloom</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f6f9;color:#1b2430;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:#fff;border:1px solid #d5dbe3;border-radius:4px;max-width:28rem;padding:24px}h1{font-size:1.1rem;margin:0 0 8px}p{margin:0;line-height:1.5;font-size:.95rem}</style></head>
<body><main><h1>This connection cannot be completed</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  return reply
    .status(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    .send(html);
}

function cleanLabel(raw: string): string | null {
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.length >= 1 && s.length <= 80 ? s : null;
}

function connectClient(config: AgentConfig): ConnectClient | null {
  // Connect also needs the agent API on: without AGENT_ALLOWED_IPS the token swap can never be called.
  return config.allowList ? config.connect : null;
}

/** redirect_uri with code/error, state and iss added (existing query kept). */
function callbackUrl(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function issuer(req: FastifyRequest, config: AgentConfig): string {
  return config.publicUrl ?? `${req.protocol}://${req.host}`;
}

function noStore(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store');
}

// ------------------------------------------------------------------ browser side

export async function oauthRoutes(fastify: FastifyInstance) {
  const { config: agentConfig } = fastify.mailloomAgent;
  const { now } = fastify.mailloomOrganise;
  const store = fastify.mailloomConnect;
  const authorizeLimit = new WindowLimiter(60, 60_000, now);
  const auth = { onRequest: [requireAuth] };

  fastify.get('/oauth/authorize', async (req, reply) => {
    const client = connectClient(agentConfig);
    if (!client) return errorPage(reply, 404, 'Connecting is not switched on for this Mailloom.');
    const wait = authorizeLimit.take(normaliseIp(req.ip));
    if (wait > 0) {
      reply.header('Retry-After', String(Math.ceil(wait / 1000)));
      return errorPage(reply, 429, 'Too many attempts. Wait a minute and try again.');
    }

    const q = (req.query ?? {}) as Record<string, unknown>;
    const get = (name: string): string | null => (typeof q[name] === 'string' ? (q[name] as string) : null);

    // Client and redirect first. Until both match, nothing is ever redirected.
    const clientId = get('client_id');
    const redirectUri = get('redirect_uri');
    if (!clientId || clientId.length > 64 || !CLIENT_ID_RE.test(clientId) || clientId !== client.id) {
      return errorPage(reply, 400, 'This application is not known to Mailloom.');
    }
    if (!redirectUri || redirectUri.length > 2000 || !client.redirectUris.includes(redirectUri)) {
      return errorPage(reply, 400, 'The address to return to is not one Mailloom allows.');
    }

    if (get('response_type') !== 'code') return errorPage(reply, 400, 'The request is not valid (response type).');
    if (get('code_challenge_method') !== 'S256') return errorPage(reply, 400, 'The request is not valid (it must use S256).');
    const challenge = get('code_challenge');
    if (!challenge || !CHALLENGE_RE.test(challenge)) return errorPage(reply, 400, 'The request is not valid (code challenge).');
    const state = get('state');
    if (!state || !STATE_RE.test(state)) return errorPage(reply, 400, 'The request is not valid (state).');

    const scopeText = get('scope');
    const asked = (scopeText ?? '').split(' ').filter(Boolean);
    const scopes = new Set<Scope>();
    for (const s of asked) {
      if (!(SCOPES as readonly string[]).includes(s)) return errorPage(reply, 400, 'The request asks for something Mailloom does not offer.');
      scopes.add(s as Scope);
    }
    if (scopes.size === 0) return errorPage(reply, 400, 'The request does not say what it wants to do.');
    let label: string | null = null;
    if (q.label !== undefined) {
      label = typeof q.label === 'string' ? cleanLabel(q.label) : null;
      if (label === null) return errorPage(reply, 400, 'The request is not valid (label).');
    }

    const pending = store.createRequest({
      clientId: client.id,
      redirectUri,
      scopes: SCOPES.filter((s) => scopes.has(s)),
      state,
      codeChallenge: challenge,
      label
    });
    if (!pending) {
      reply.header('Retry-After', '60');
      return errorPage(reply, 429, 'Mailloom is busy with other connection requests. Try again in a few minutes.');
    }
    // Back to the app's own page: absolute when the public address is set, otherwise relative to this
    // page (/oauth/authorize or /mail/oauth/authorize, both one level below the app root).
    noStore(reply);
    reply.header('Referrer-Policy', 'no-referrer');
    return reply.redirect(`${agentConfig.publicUrl ?? '..'}/#/connect/${pending.id}`, 302);
  });

  fastify.get('/api/oauth/requests/:id', auth, async (req, reply) => {
    noStore(reply);
    const client = connectClient(agentConfig);
    const found = store.getRequest((req.params as { id: string }).id);
    if (!client || !found || found.clientId !== client.id || !client.redirectUris.includes(found.redirectUri)) {
      return reply.status(404).send({ code: 'REQUEST_NOT_FOUND', error: 'This connection request has expired. Start again from the other app.' });
    }
    return {
      client_name: client.name,
      label: found.label,
      scopes: found.scopes,
      redirect_host: new URL(found.redirectUri).host,
      expires_at: new Date(found.expiresAt).toISOString()
    };
  });

  fastify.post('/api/oauth/consent', auth, async (req, reply) => {
    noStore(reply);
    const client = connectClient(agentConfig);
    const body = (req.body ?? {}) as { request_id?: unknown; allow?: unknown; scopes?: unknown };
    if (typeof body.request_id !== 'string' || typeof body.allow !== 'boolean') {
      return reply.status(400).send({ code: 'INVALID_INPUT', error: 'The request is not valid.' });
    }
    const found = store.getRequest(body.request_id);
    if (!client || !found || found.clientId !== client.id || !client.redirectUris.includes(found.redirectUri)) {
      return reply.status(404).send({ code: 'REQUEST_NOT_FOUND', error: 'This connection request has expired. Start again from the other app.' });
    }
    const iss = issuer(req, agentConfig);

    if (!body.allow) {
      if (!store.consumeRequest(found.id)) {
        return reply.status(404).send({ code: 'REQUEST_NOT_FOUND', error: 'This connection request has expired. Start again from the other app.' });
      }
      return { redirect: callbackUrl(found.redirectUri, { error: 'access_denied', state: found.state, iss }) };
    }

    if (req.accountConfig!.isDemo) {
      return reply.status(403).send({ code: 'DEMO_ACCOUNT', error: 'Connections are not available for the demo account.' });
    }
    // Granted scopes: what was asked and what the person left ticked, never more. Read cannot be unticked.
    if (!Array.isArray(body.scopes) || body.scopes.length === 0 || body.scopes.length > SCOPES.length) {
      return reply.status(400).send({ code: 'INVALID_INPUT', error: 'Pick what to allow.' });
    }
    const ticked = new Set<string>();
    for (const s of body.scopes) {
      if (typeof s !== 'string' || !found.scopes.includes(s as Scope)) {
        return reply.status(400).send({ code: 'INVALID_INPUT', error: 'That permission was not asked for.' });
      }
      ticked.add(s);
    }
    if (found.scopes.includes('read') && !ticked.has('read')) {
      return reply.status(400).send({ code: 'INVALID_INPUT', error: 'Reading mail is needed for everything else and cannot be switched off.' });
    }
    const granted = SCOPES.filter((s) => ticked.has(s));

    const password = await verifyReentry(req, reply);
    if (password === null) return reply;
    // Used up only after the password is right, so a typo can be corrected; only one Allow can win.
    if (!store.consumeRequest(found.id)) {
      return reply.status(404).send({ code: 'REQUEST_NOT_FOUND', error: 'This connection request has expired. Start again from the other app.' });
    }
    const code = store.issueCode({
      clientId: found.clientId,
      redirectUri: found.redirectUri,
      email: req.accountConfig!.email,
      scopes: granted,
      codeChallenge: found.codeChallenge,
      label: found.label,
      password
    });
    return { redirect: callbackUrl(found.redirectUri, { code, state: found.state, iss }) };
  });
}

// ------------------------------------------------------------------ Work OS server side

function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time string equality (hashes first, so lengths do not leak). */
function same(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

export async function agentOAuthRoutes(fastify: FastifyInstance) {
  const { store: agentStore, config: agentConfig } = fastify.mailloomAgent;
  const { now } = fastify.mailloomOrganise;
  const connectStore = fastify.mailloomConnect;
  const appConfig = fastify.mailloom.config;
  const tokenLimit = new WindowLimiter(20, 60_000, now);

  // Form-encoded bodies (the usual OAuth way) as well as JSON.
  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8192 }, (_req, body, done) => {
    try {
      const out: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(typeof body === 'string' ? body : body.toString('utf8'))) out[k] = v;
      done(null, out);
    } catch (err) {
      done(err as Error);
    }
  });

  fastify.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    if (!agentConfig.allowList) {
      return reply.status(404).send({ error: 'invalid_request', error_description: 'The agent API is not enabled on this server.' });
    }
    if (req.headers.origin !== undefined) {
      return reply.status(403).send({ error: 'invalid_request', error_description: 'This endpoint cannot be called from a browser.' });
    }
    if (!ipAllowed(agentConfig, req.ip)) {
      req.log.warn({ ip: normaliseIp(req.ip) }, 'Connect token call from an address not in AGENT_ALLOWED_IPS');
      return reply.status(403).send({ error: 'access_denied', error_description: 'This address may not use the agent API.' });
    }
    const wait = tokenLimit.take(normaliseIp(req.ip));
    if (wait > 0) {
      reply.header('Retry-After', String(Math.ceil(wait / 1000)));
      return reply.status(429).send({ error: 'rate_limited', error_description: 'Too many requests. Try again shortly.' });
    }
  });

  fastify.addHook('onSend', async (_req, reply, payload) => {
    for (const h of Object.keys(reply.getHeaders())) {
      if (h.toLowerCase().startsWith('access-control-')) reply.removeHeader(h);
    }
    return payload;
  });

  // Never log the request or the reply: both carry secrets (code, verifier, client secret, the new key).
  fastify.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: 'invalid_request', error_description: 'The request could not be read.' });
    }
    req.log.error({ errName: err.name, errCode: err.code }, 'Connect token error');
    return reply.status(500).send({ error: 'server_error', error_description: 'Something went wrong. Try again.' });
  });

  const fail = (reply: FastifyReply, status: number, error: string, description: string) =>
    reply.status(status).send({ error, error_description: description });

  fastify.post(`${P}/oauth/token`, { bodyLimit: 8192 }, async (req, reply) => {
    const client = connectClient(agentConfig);
    if (!client) return fail(reply, 404, 'invalid_request', 'Connect is not enabled on this server.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const field = (name: string): string | null => (typeof body[name] === 'string' ? (body[name] as string) : null);

    if (field('grant_type') !== 'authorization_code') return fail(reply, 400, 'unsupported_grant_type', 'Only authorization_code is supported.');
    const clientId = field('client_id');
    const secret = field('client_secret');
    // Both compared every time so timing does not say which one was wrong. The code is not touched before this.
    const idOk = clientId !== null && same(clientId, client.id);
    const secretOk = secret !== null && same(secret, client.secret);
    if (!idOk || !secretOk) return fail(reply, 401, 'invalid_client', 'Client authentication failed.');

    const code = field('code');
    const redirectUri = field('redirect_uri');
    const verifier = field('code_verifier');
    if (!code || !redirectUri || !verifier || !VERIFIER_RE.test(verifier) || redirectUri.length > 2000) {
      return fail(reply, 400, 'invalid_request', 'code, redirect_uri and code_verifier are required.');
    }
    const bad = () => fail(reply, 400, 'invalid_grant', 'The code is not valid.');
    if (!isWellFormedAuthCode(code)) return bad();

    const taken = connectStore.takeCode(code);
    if (taken.status === 'unknown') return bad();
    if (taken.status === 'reused') {
      // A code used twice: the key the first use minted is revoked, the second attempt fails.
      if (taken.keyId) {
        const rec = agentStore.revokeById(taken.keyId);
        await closeSessionConnection(agentPoolKey(taken.keyId));
        if (rec) req.log.warn({ keyId: taken.keyId }, 'Connect code used twice: the key it produced was revoked');
      }
      return bad();
    }

    const g = taken.grant;
    const challenge = crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');
    const domain = g.email.slice(g.email.lastIndexOf('@') + 1);
    if (
      g.clientId !== client.id ||
      g.redirectUri !== redirectUri ||
      !client.redirectUris.includes(redirectUri) ||
      !same(challenge, g.codeChallenge) ||
      g.password === null ||
      !appConfig.mailDomains.includes(domain)
    ) {
      return bad();
    }

    const { key, record } = agentStore.createKey({
      email: g.email,
      name: client.name,
      scopes: g.scopes,
      password: g.password,
      clientId: client.id,
      label: g.label
    });
    connectStore.rememberKey(code, record.id);
    try {
      agentStore.audit({
        at: now(),
        keyId: record.id,
        keyPrefix: record.prefix,
        email: record.email,
        ip: normaliseIp(req.ip),
        workosUser: null,
        workosSession: null,
        tool: 'oauth_connect',
        folder: null,
        messageId: null,
        recipients: null,
        subject: null,
        sentMessageId: null,
        status: 200,
        result: 'ok'
      });
    } catch (err) {
      req.log.error({ errName: (err as Error).name }, 'Could not write connect audit entry');
    }
    reply.header('Cache-Control', 'no-store');
    return { key, key_id: record.id, prefix: record.prefix, email: record.email, scopes: record.scopes };
  });
}
