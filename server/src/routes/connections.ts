import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from './auth.js';
import { createImapClient, closeSessionConnection } from '../services/imap.js';
import type { AccountConfig } from '../types.js';
import { SCOPES, type AgentKeyRecord, type AgentStore, type Scope } from '../agent/store.js';
import type { AgentConfig } from '../agent/config.js';

/**
 * Connections: the signed-in person manages agent keys for their own mailbox.
 * Session auth via requireAuth (cookie + X-Mailloom-Account header, which is also the CSRF guard).
 * A key always belongs to the mailbox of the session that created it; every lookup is filtered by
 * that mailbox, so another mailbox's key id answers 404 exactly like an unknown id.
 */

declare module 'fastify' {
  interface FastifyInstance {
    mailloomAgent: { store: AgentStore; config: AgentConfig };
  }
}

/** Pool key for a key's IMAP connection; never shared with browser sessions. */
export const agentPoolKey = (id: string) => `agent:${id}`;

export function publicKey(r: AgentKeyRecord) {
  return {
    id: r.id,
    prefix: r.prefix,
    name: r.name,
    email: r.email,
    scopes: r.scopes,
    created_at: new Date(r.createdAt).toISOString(),
    last_used_at: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
    revoked_at: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
    broken_at: r.brokenAt ? new Date(r.brokenAt).toISOString() : null,
    broken_reason: r.brokenReason,
    status: r.revokedAt ? 'revoked' : r.brokenAt ? 'broken' : 'active'
  };
}

function bad(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.status(status).send({ code, error });
}

function cleanName(v: unknown): string | null {
  if (v === undefined) return 'Work OS';
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.length >= 1 && s.length <= 80 ? s : null;
}

function cleanScopes(v: unknown): Scope[] | null {
  if (v === undefined) return [...SCOPES];
  if (!Array.isArray(v) || v.length === 0) return null;
  const set = new Set<Scope>();
  for (const s of v) {
    if (typeof s !== 'string' || !(SCOPES as readonly string[]).includes(s)) return null;
    set.add(s as Scope);
  }
  return SCOPES.filter((s) => set.has(s));
}

type Check = 'ok' | 'bad_credentials' | 'unreachable';

async function checkPassword(account: AccountConfig, req: FastifyRequest): Promise<Check> {
  const client = createImapClient(account, { connectionTimeout: 10000, greetingTimeout: 8000 });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.logout().catch(() => undefined);
    return 'ok';
  } catch (err) {
    const e = err as { authenticationFailed?: boolean; serverResponseCode?: string; code?: string };
    if (e.authenticationFailed || e.serverResponseCode === 'AUTHENTICATIONFAILED') return 'bad_credentials';
    req.log.warn({ code: e.code }, 'IMAP password check failed (server problem)');
    return 'unreachable';
  } finally {
    client.close();
  }
}

/** Re-entered password, checked against IMAP and the sign-in throttle. Sends the error reply itself. */
export async function verifyReentry(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const body = (req.body ?? {}) as { password?: unknown };
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password || password.length > 1024) {
    bad(reply, 400, 'PASSWORD_REQUIRED', 'Enter your mailbox password to confirm.');
    return null;
  }
  const { throttle } = req.server.mailloom;
  const account = req.accountConfig!;
  const retryMs = throttle.begin(account.email, req.ip);
  if (retryMs > 0) {
    reply.header('Retry-After', String(Math.ceil(retryMs / 1000)));
    bad(reply, 429, 'TOO_MANY_ATTEMPTS', 'Too many wrong passwords. Try again later.');
    return null;
  }
  const outcome = await checkPassword({ ...account, imapPass: password, smtpPass: password, sessionKey: undefined }, req);
  if (outcome === 'bad_credentials') {
    bad(reply, 401, 'WRONG_PASSWORD', 'That password is not right.');
    return null;
  }
  if (outcome === 'unreachable') {
    throttle.refund(account.email, req.ip);
    bad(reply, 503, 'MAIL_SERVER_UNREACHABLE', 'Mail server unreachable. Please try again in a few minutes.');
    return null;
  }
  throttle.succeed(account.email, req.ip);
  return password;
}

function realMailboxOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.accountConfig!.isDemo) {
    bad(reply, 403, 'DEMO_ACCOUNT', 'Connections are not available for the demo account.');
    return false;
  }
  return true;
}

export async function connectionRoutes(fastify: FastifyInstance) {
  const auth = { preHandler: [requireAuth] };

  fastify.get('/api/connections/keys', auth, async (req) => {
    const { store, config } = fastify.mailloomAgent;
    return {
      agent_api_enabled: config.allowList !== null,
      keys: store.listKeys(req.accountConfig!.email).map(publicKey)
    };
  });

  fastify.post('/api/connections/keys', auth, async (req, reply) => {
    if (!realMailboxOnly(req, reply)) return reply;
    const body = (req.body ?? {}) as { name?: unknown; scopes?: unknown };
    const name = cleanName(body.name);
    const scopes = cleanScopes(body.scopes);
    if (!name) return bad(reply, 400, 'INVALID_INPUT', 'Name must be 1 to 80 characters.');
    if (!scopes) return bad(reply, 400, 'INVALID_INPUT', 'Pick at least one of: read, organise, send.');
    const password = await verifyReentry(req, reply);
    if (password === null) return reply;
    const { key, record } = fastify.mailloomAgent.store.createKey({
      email: req.accountConfig!.email,
      name,
      scopes,
      password
    });
    return reply.status(201).send({ key, key_shown_once: true, record: publicKey(record) });
  });

  fastify.patch('/api/connections/keys/:id', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const name = cleanName((req.body as { name?: unknown } | undefined)?.name ?? null);
    if (!name) return bad(reply, 400, 'INVALID_INPUT', 'Name must be 1 to 80 characters.');
    const rec = fastify.mailloomAgent.store.rename(id, req.accountConfig!.email, name);
    if (!rec) return bad(reply, 404, 'KEY_NOT_FOUND', 'Key not found.');
    return { record: publicKey(rec) };
  });

  fastify.post('/api/connections/keys/:id/revoke', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = fastify.mailloomAgent.store.revoke(id, req.accountConfig!.email);
    if (!rec) return bad(reply, 404, 'KEY_NOT_FOUND', 'Key not found.');
    await closeSessionConnection(agentPoolKey(id));
    return { record: publicKey(rec) };
  });

  fastify.post('/api/connections/keys/:id/rotate', auth, async (req, reply) => {
    if (!realMailboxOnly(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const { store } = fastify.mailloomAgent;
    const existing = store.getOwned(id, req.accountConfig!.email);
    if (!existing) return bad(reply, 404, 'KEY_NOT_FOUND', 'Key not found.');
    if (existing.revokedAt) return bad(reply, 409, 'KEY_REVOKED', 'A revoked key cannot be rotated. Create a new one.');
    const password = await verifyReentry(req, reply);
    if (password === null) return reply;
    const rotated = store.rotate(id, req.accountConfig!.email, password);
    if (!rotated) return bad(reply, 404, 'KEY_NOT_FOUND', 'Key not found.');
    await closeSessionConnection(agentPoolKey(id));
    return { key: rotated.key, key_shown_once: true, record: publicKey(rotated.record) };
  });

  fastify.get('/api/connections/audit', auth, async (req) => {
    const entries = fastify.mailloomAgent.store.listAudit(req.accountConfig!.email, 200);
    return {
      entries: entries.map((e) => ({
        at: new Date(e.at).toISOString(),
        key_prefix: e.keyPrefix,
        tool: e.tool,
        folder: e.folder,
        message_id: e.messageId,
        recipients: e.recipients,
        subject: e.subject,
        sent_message_id: e.sentMessageId,
        status: e.status,
        result: e.result,
        workos_user: e.workosUser,
        workos_session: e.workosSession,
        ip: e.ip
      }))
    };
  });
}
