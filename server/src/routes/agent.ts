import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AccountConfig } from '../types.js';
import { closeSessionConnection, isImapAuthError } from '../services/imap.js';
import { cleanEmailHtml } from '../utils/sanitize.js';
import { ipAllowed, normaliseIp } from '../agent/config.js';
import type { AgentKeyRecord, Scope } from '../agent/store.js';
import {
  AgentError,
  attachmentList,
  listFolders,
  loadMessage,
  locate,
  messageAddresses,
  messageView,
  moveMessage,
  needsAttention,
  normaliseMessageId,
  referencesOf,
  searchMessages,
  setFlag,
  trashFolder,
  type Address
} from '../agent/mail.js';
import { htmlToAgentText } from '../agent/text.js';
import { AllRecipientsRejectedError, isSmtpAuthError, sendForAgent, type OutgoingMail } from '../agent/send-adapter.js';
import { agentPoolKey, publicKey } from './connections.js';

/**
 * Agent API: /api/agent/v1/*, for Work OS acting on one person's mailbox.
 *
 * - Off unless AGENT_ALLOWED_IPS is set; callers outside the list get 403.
 * - Authenticated only by "Authorization: Bearer mlk_...". Cookies are ignored, any request
 *   carrying an Origin header (a browser) is refused, and no CORS headers are ever sent.
 * - The mailbox is the one stored with the key. No request field names a mailbox, so a key
 *   can only ever reach its own mailbox. X-Workos-User / X-Workos-Session are recorded in the
 *   audit log only.
 * - Message content is returned as plain text wrapped as {untrusted: true, source: "external email"}.
 */

interface AuditInfo {
  folder?: string | null;
  messageId?: string | null;
  recipients?: string[] | null;
  subject?: string | null;
  sentMessageId?: string | null;
  result?: string;
}

interface AgentContext {
  record: AgentKeyRecord;
  account: AccountConfig;
  audit: AuditInfo;
}

declare module 'fastify' {
  interface FastifyRequest {
    agent?: AgentContext;
  }
  interface FastifyContextConfig {
    agentTool?: string;
    agentScope?: Scope | null;
  }
}

const HOUR = 3_600_000;

function fail(status: number, code: string, message: string): never {
  throw new AgentError(status, code, message);
}

function headerText(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) return null;
  return s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || null;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

function accountFor(req: FastifyRequest, record: AgentKeyRecord, password: string): AccountConfig {
  const mail = req.server.mailloom.config.mail;
  return {
    email: record.email,
    name: record.email.split('@')[0],
    imapHost: mail.imapHost,
    imapPort: mail.imapPort,
    imapSecure: mail.imapSecure,
    imapUser: record.email,
    imapPass: password,
    smtpHost: mail.smtpHost,
    smtpPort: mail.smtpPort,
    smtpSecure: mail.smtpSecure,
    smtpRequireTLS: !mail.smtpSecure && !mail.smtpAllowPlain,
    smtpUser: record.email,
    smtpPass: password,
    tls: { ...mail.tls },
    sessionKey: agentPoolKey(record.id),
    isDemo: false
  };
}

// ------------------------------------------------------------------ input helpers

type Obj = Record<string, unknown>;

function str(v: unknown, name: string, opts: { max?: number; required?: boolean } = {}): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (opts.required) fail(400, 'INVALID_INPUT', `${name} is required.`);
    return undefined;
  }
  if (typeof v !== 'string') fail(400, 'INVALID_INPUT', `${name} must be a string.`);
  if (v.length > (opts.max ?? 1000)) fail(400, 'INVALID_INPUT', `${name} is too long.`);
  return v;
}

function folderArg(v: unknown, name = 'folder', required = false): string | undefined {
  const s = str(v, name, { max: 500, required });
  if (s !== undefined && /[\u0000-\u001f\u007f]/.test(s)) fail(400, 'INVALID_INPUT', `${name} has control characters.`);
  return s;
}

function intArg(v: unknown, name: string, def: number | undefined, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, 'INVALID_INPUT', `${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

function boolArg(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  fail(400, 'INVALID_INPUT', `${name} must be true or false.`);
}

function dateArg(v: unknown, name: string): Date | undefined {
  const s = str(v, name, { max: 64 });
  if (!s) return undefined;
  const d = new Date(s);
  if (isNaN(d.getTime())) fail(400, 'INVALID_INPUT', `${name} must be a date like 2026-11-14 or 2026-11-14T09:00:00Z.`);
  return d;
}

function messageRef(o: Obj) {
  const folder = folderArg(o.folder);
  const uid = intArg(o.uid, 'uid', undefined, 1, 2 ** 32 - 1);
  const messageId = str(o.message_id, 'message_id', { max: 998 });
  if (uid === undefined && !messageId) fail(400, 'INVALID_INPUT', 'Give message_id, or folder and uid.');
  if (messageId && /[\s\u0000-\u001f]/.test(messageId.trim())) fail(400, 'INVALID_INPUT', 'message_id is not valid.');
  return { folder, uid, messageId: messageId?.trim() };
}

const ADDRESS_RE = /^[^\s@<>(),;:"[\]\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function addressListArg(v: unknown, name: string): Address[] {
  if (v === undefined || v === null || v === '') return [];
  const list = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : fail(400, 'INVALID_INPUT', `${name} must be a list of addresses.`);
  const out: Address[] = [];
  for (const item of list) {
    if (typeof item !== 'string') fail(400, 'INVALID_INPUT', `${name} must be a list of addresses.`);
    const s = item.trim();
    if (!s) continue;
    if (/[\r\n]/.test(s)) fail(400, 'INVALID_INPUT', `${name} has a line break.`);
    const m = /^(.*?)\s*<([^<>]+)>$/.exec(s);
    const address = (m ? m[2]! : s).trim();
    const display = m ? m[1]!.replace(/^"|"$/g, '').trim() : '';
    if (!ADDRESS_RE.test(address)) fail(400, 'INVALID_ADDRESS', `"${address.slice(0, 100)}" is not an email address.`);
    out.push({ name: display, address });
  }
  return out;
}

function dedupe(list: Address[], exclude: Set<string>): Address[] {
  const seen = new Set(exclude);
  const out: Address[] = [];
  for (const a of list) {
    const key = a.address.toLowerCase();
    if (!a.address || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function fmt(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ------------------------------------------------------------------ plugin

export async function agentRoutes(fastify: FastifyInstance) {
  const { store, config: agentConfig } = fastify.mailloomAgent;
  const appConfig = fastify.mailloom.config;

  fastify.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!agentConfig.allowList) {
      return reply.status(404).send({ code: 'AGENT_API_OFF', error: 'The agent API is not enabled on this server.' });
    }
    if (req.headers.origin !== undefined) {
      return reply.status(403).send({ code: 'ORIGIN_NOT_ALLOWED', error: 'The agent API cannot be called from a browser.' });
    }
    if (!ipAllowed(agentConfig, req.ip)) {
      req.log.warn({ ip: normaliseIp(req.ip) }, 'Agent API call from an address not in AGENT_ALLOWED_IPS');
      return reply.status(403).send({ code: 'IP_NOT_ALLOWED', error: 'This address may not use the agent API.' });
    }
    const key = bearer(req);
    if (!key) {
      return reply.status(401).send({ code: 'MISSING_KEY', error: 'Send the agent key as "Authorization: Bearer <key>".' });
    }
    const auth = store.authenticate(key);
    if (auth.status === 'invalid') {
      return reply.status(401).send({ code: 'INVALID_KEY', error: 'This agent key is not valid.' });
    }
    if (auth.status === 'revoked') {
      return reply.status(401).send({ code: 'KEY_REVOKED', error: 'This agent key was revoked in Mailloom.' });
    }
    if (auth.status === 'broken') {
      return reply.status(403).send({
        code: 'KEY_BROKEN',
        error: 'Mailloom can no longer sign in to this mailbox with this key (the password probably changed). The person must rotate or recreate the key in Mailloom > Connections.'
      });
    }
    const domain = auth.record.email.slice(auth.record.email.lastIndexOf('@') + 1);
    if (!appConfig.mailDomains.includes(domain)) {
      return reply.status(403).send({ code: 'MAILBOX_NOT_ALLOWED', error: 'This mailbox is not a Delpat mailbox.' });
    }
    req.agent = { record: auth.record, account: accountFor(req, auth.record, auth.password), audit: {} };
    const scope = req.routeOptions.config?.agentScope;
    if (scope && !auth.record.scopes.includes(scope)) {
      req.agent.audit.result = 'SCOPE_MISSING';
      return reply.status(403).send({ code: 'SCOPE_MISSING', error: `This key does not have the "${scope}" permission.` });
    }
  });

  fastify.addHook('onSend', async (_req, reply, payload) => {
    for (const h of Object.keys(reply.getHeaders())) {
      if (h.toLowerCase().startsWith('access-control-')) reply.removeHeader(h);
    }
    return payload;
  });

  fastify.addHook('onResponse', async (req, reply) => {
    const ctx = req.agent;
    if (!ctx) return;
    const a = ctx.audit;
    try {
      store.audit({
        at: Date.now(),
        keyId: ctx.record.id,
        keyPrefix: ctx.record.prefix,
        email: ctx.record.email,
        ip: normaliseIp(req.ip),
        workosUser: headerText(req, 'x-workos-user'),
        workosSession: headerText(req, 'x-workos-session'),
        tool: req.routeOptions.config?.agentTool || 'unknown',
        folder: a.folder ?? null,
        messageId: a.messageId ?? null,
        recipients: a.recipients ?? null,
        subject: a.subject ?? null,
        sentMessageId: a.sentMessageId ?? null,
        status: reply.statusCode,
        result: a.result || (reply.statusCode < 400 ? 'ok' : `error ${reply.statusCode}`)
      });
    } catch (err) {
      req.log.error({ errName: (err as Error).name }, 'Could not write agent audit entry');
    }
  });

  fastify.setErrorHandler(async (err: FastifyError, req, reply) => {
    const ctx = req.agent;
    if (err instanceof AgentError) {
      if (ctx) ctx.audit.result = err.code;
      return reply.status(err.status).send({ code: err.code, error: err.message });
    }
    if (ctx && (isImapAuthError(err) || isSmtpAuthError(err))) {
      store.markBroken(ctx.record.id, isSmtpAuthError(err) ? 'SMTP sign-in refused' : 'IMAP sign-in refused');
      await closeSessionConnection(agentPoolKey(ctx.record.id));
      ctx.audit.result = 'KEY_BROKEN';
      return reply.status(403).send({
        code: 'KEY_BROKEN',
        error: 'The mail server refused the stored password (it probably changed). The person must rotate or recreate the key in Mailloom > Connections.'
      });
    }
    const status = err.statusCode;
    if (status && status >= 400 && status < 500) {
      if (ctx) ctx.audit.result = err.code || `error ${status}`;
      return reply.status(status).send({ code: err.code || 'BAD_REQUEST', error: err.message });
    }
    const e = err as { code?: string; name?: string; responseCode?: number };
    req.log.warn({ errName: e.name, errCode: e.code, smtp: e.responseCode, route: req.routeOptions.url }, 'Agent API mail operation failed');
    if (ctx) ctx.audit.result = 'MAIL_SERVER_ERROR';
    return reply.status(502).send({ code: 'MAIL_SERVER_ERROR', error: 'The mail server did not complete the request. Try again shortly.' });
  });

  const route = (tool: string, scope: Scope | null) => ({ config: { agentTool: tool, agentScope: scope } });
  const P = '/api/agent/v1';

  // ---------------------------------------------------------------- read

  fastify.get(`${P}/whoami`, route('whoami', null), async (req) => {
    const r = req.agent!.record;
    const k = publicKey(r);
    return {
      email: r.email,
      key: { id: k.id, prefix: k.prefix, name: k.name, scopes: k.scopes, created_at: k.created_at },
      limits: { sends_per_hour: agentConfig.sendsPerHour, recipients_per_mail: agentConfig.maxRecipients }
    };
  });

  fastify.get(`${P}/folders`, route('folders', 'read'), async (req) => {
    return { folders: await listFolders(req.agent!.account) };
  });

  fastify.get(`${P}/search`, route('search', 'read'), async (req) => {
    const q = (req.query ?? {}) as Obj;
    const folder = folderArg(q.folder) || 'INBOX';
    req.agent!.audit.folder = folder;
    const res = await searchMessages(req.agent!.account, {
      folder,
      query: str(q.query, 'query', { max: 500 }),
      from: str(q.from, 'from', { max: 300 }),
      since: dateArg(q.since, 'since'),
      unread: boolArg(q.unread, 'unread'),
      limit: intArg(q.limit, 'limit', 25, 1, 100)!,
      cursor: str(q.cursor, 'cursor', { max: 2000 })
    });
    return { untrusted: true, source: 'external email', ...res };
  });

  fastify.get(`${P}/needs-attention`, route('needs_attention', 'read'), async (req) => {
    const q = (req.query ?? {}) as Obj;
    const since = dateArg(q.since, 'since') ?? new Date(Date.now() - 7 * 24 * HOUR);
    req.agent!.audit.folder = 'INBOX';
    const res = await needsAttention(req.agent!.account, since, intArg(q.limit, 'limit', 50, 1, 200)!);
    return { untrusted: true, source: 'external email', since: since.toISOString(), ...res };
  });

  fastify.get(`${P}/message`, route('get_message', 'read'), async (req) => {
    const ref = messageRef((req.query ?? {}) as Obj);
    const ctx = req.agent!;
    ctx.audit.messageId = ref.messageId ? normaliseMessageId(ref.messageId) : null;
    const where = await locate(ctx.account, ref);
    ctx.audit.folder = where.folder;
    const msg = await loadMessage(ctx.account, where.folder, where.uid);
    const view = messageView(msg, agentConfig.maxTextChars);
    ctx.audit.messageId = view.message_id;
    return view;
  });

  fastify.get(`${P}/attachment`, route('get_attachment', 'read'), async (req) => {
    const q = (req.query ?? {}) as Obj;
    const ref = messageRef(q);
    const index = intArg(q.index, 'index', undefined, 0, 10_000);
    if (index === undefined) fail(400, 'INVALID_INPUT', 'index is required (from the message attachments list).');
    const ctx = req.agent!;
    const where = await locate(ctx.account, ref);
    ctx.audit.folder = where.folder;
    const msg = await loadMessage(ctx.account, where.folder, where.uid);
    ctx.audit.messageId = msg.parsed.messageId ? normaliseMessageId(msg.parsed.messageId) : null;
    const att = msg.parsed.attachments?.[index];
    if (!att) fail(404, 'ATTACHMENT_NOT_FOUND', 'No attachment with that index.');
    const size = att.content?.length ?? att.size ?? 0;
    if (size > agentConfig.maxAttachmentBytes) {
      fail(413, 'ATTACHMENT_TOO_LARGE', `This attachment is ${size} bytes; the limit is ${agentConfig.maxAttachmentBytes}.`);
    }
    const meta = attachmentList(msg.parsed)[index]!;
    return {
      untrusted: true,
      source: 'external email',
      ...meta,
      size,
      content_base64: att.content.toString('base64')
    };
  });

  // ---------------------------------------------------------------- send

  interface Built {
    mail: OutgoingMail;
    original?: { folder: string; uid: number; messageId: string | null };
  }

  async function handleSend(req: FastifyRequest, reply: FastifyReply, build: (body: Obj) => Promise<Built>) {
    const ctx = req.agent!;
    const body = ((req.body ?? {}) as Obj) || {};
    if (typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_INPUT', 'Send a JSON object.');
    const idemRaw = body.idempotency_key ?? headerText(req, 'idempotency-key') ?? undefined;
    if (typeof idemRaw !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(idemRaw)) {
      fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'idempotency_key is required (1-200 visible ASCII characters, unique per mail).');
    }
    const { idempotency_key: _drop, ...rest } = body;
    const tool = req.routeOptions.config?.agentTool || 'send';

    const begin = store.beginIdempotent(ctx.record.id, idemRaw, { tool, rest });
    if (begin.state === 'replay') {
      ctx.audit.result = 'replayed';
      const b = begin.body as Obj;
      ctx.audit.sentMessageId = (b.message_id as string) ?? null;
      return reply.status(begin.status).send({ ...b, idempotent_replay: true });
    }
    if (begin.state === 'in_progress') fail(409, 'IN_PROGRESS', 'A send with this idempotency_key is still running (or ended without a result). Do not resend; check Sent.');
    if (begin.state === 'mismatch') fail(422, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency_key was used for a different mail in the last 24 hours.');

    let sent = false;
    try {
      const { mail, original } = await build(rest);
      const all = [...mail.to, ...mail.cc, ...mail.bcc];
      ctx.audit.recipients = all;
      ctx.audit.subject = mail.subject;
      if (original) {
        ctx.audit.folder = original.folder;
        ctx.audit.messageId = original.messageId;
      }
      if (mail.to.length + mail.cc.length + mail.bcc.length === 0) fail(400, 'NO_RECIPIENTS', 'The mail has no recipients.');
      if (all.length > agentConfig.maxRecipients) {
        fail(400, 'TOO_MANY_RECIPIENTS', `At most ${agentConfig.maxRecipients} recipients per mail.`);
      }
      const waitMs = store.takeSendSlot(ctx.record.id, agentConfig.sendsPerHour);
      if (waitMs > 0) {
        store.abortIdempotent(ctx.record.id, idemRaw);
        ctx.audit.result = 'RATE_LIMITED';
        reply.header('Retry-After', String(Math.ceil(waitMs / 1000)));
        return reply.status(429).send({ code: 'RATE_LIMITED', error: `This key may send ${agentConfig.sendsPerHour} mails per hour.` });
      }
      mail.headers['X-Mailloom-Agent'] = ctx.record.prefix;

      let result;
      try {
        result = await sendForAgent(ctx.account, mail);
        sent = true;
      } catch (err) {
        if (err instanceof AllRecipientsRejectedError) {
          const out = { sent: false, code: 'ALL_RECIPIENTS_REJECTED', error: 'The mail server refused every recipient; nothing was sent.', accepted: [], rejected: err.rejected, saved_to_sent: false, message_id: null };
          store.finishIdempotent(ctx.record.id, idemRaw, 422, out);
          sent = true;
          ctx.audit.result = 'ALL_RECIPIENTS_REJECTED';
          return reply.status(422).send({ ...out, idempotent_replay: false });
        }
        throw err;
      }

      if (original && tool === 'reply') {
        await setFlag(ctx.account, original.folder, original.uid, '\\Answered', true).catch(() => undefined);
      }
      const out = {
        sent: true,
        message_id: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
        saved_to_sent: result.savedToSent,
        sent_folder: result.sentFolder
      };
      store.finishIdempotent(ctx.record.id, idemRaw, 200, out);
      ctx.audit.sentMessageId = result.messageId;
      ctx.audit.result = result.rejected.length ? 'sent (some rejected)' : 'sent';
      return { ...out, idempotent_replay: false };
    } finally {
      // Nothing left the server: forget the key so the caller can retry with it.
      if (!sent) store.abortIdempotent(ctx.record.id, idemRaw);
    }
  }

  function bodyText(rest: Obj): { text: string; html?: string } {
    const text = str(rest.text, 'text', { max: 2_000_000 }) ?? '';
    const htmlIn = str(rest.html, 'html', { max: 5_000_000 });
    return { text, html: htmlIn ? cleanEmailHtml(htmlIn) : undefined };
  }

  const sendOpts = (tool: string) => ({ ...route(tool, 'send'), bodyLimit: 12 * 1024 * 1024 });

  fastify.post(`${P}/send`, sendOpts('send'), async (req, reply) =>
    handleSend(req, reply, async (rest) => {
      const subject = oneLine(str(rest.subject, 'subject', { max: 998 }) ?? '');
      const { text, html } = bodyText(rest);
      if (!text && !html) fail(400, 'INVALID_INPUT', 'text (or html) is required.');
      const to = addressListArg(rest.to, 'to');
      if (to.length === 0) fail(400, 'NO_RECIPIENTS', 'to needs at least one address.');
      return {
        mail: {
          to: to.map(fmt),
          cc: addressListArg(rest.cc, 'cc').map(fmt),
          bcc: addressListArg(rest.bcc, 'bcc').map(fmt),
          subject,
          text,
          html,
          headers: {}
        }
      };
    })
  );

  fastify.post(`${P}/reply`, sendOpts('reply'), async (req, reply) =>
    handleSend(req, reply, async (rest) => {
      const ctx = req.agent!;
      const messageId = str(rest.message_id, 'message_id', { max: 998, required: true })!;
      const where = await locate(ctx.account, { messageId, folder: folderArg(rest.folder) });
      const orig = await loadMessage(ctx.account, where.folder, where.uid);
      const p = orig.parsed;
      const origId = p.messageId ? normaliseMessageId(p.messageId) : normaliseMessageId(messageId);
      const a = messageAddresses(p);
      const me = ctx.record.email.toLowerCase();
      const self = new Set([me]);
      const fromIsMe = a.from?.address.toLowerCase() === me;
      let to = fromIsMe ? a.to : a.reply_to.length ? a.reply_to : a.from ? [a.from] : [];
      to = dedupe(to, fromIsMe ? new Set() : self);
      let cc: Address[] = [];
      if (boolArg(rest.reply_all, 'reply_all')) {
        const toSet = new Set([...to.map((x) => x.address.toLowerCase()), me]);
        cc = dedupe([...(fromIsMe ? [] : a.to), ...a.cc], toSet);
      }
      cc = dedupe([...cc, ...addressListArg(rest.cc, 'cc')], new Set(to.map((x) => x.address.toLowerCase())));
      const bcc = addressListArg(rest.bcc, 'bcc');
      if (to.length === 0) fail(422, 'NO_REPLY_ADDRESS', 'The original message has no address to reply to.');

      const { text, html } = bodyText(rest);
      if (!text && !html) fail(400, 'INVALID_INPUT', 'text (or html) is required.');
      const origSubject = p.subject || '';
      const subject = /^\s*re\s*:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
      let fullText = text;
      if (boolArg(rest.quote, 'quote') !== false) {
        const origText = (p.html ? htmlToAgentText(p.html).text : p.text || '').slice(0, 50_000);
        const who = a.from ? fmt(a.from) : 'the sender';
        const when = (p.date || new Date()).toUTCString();
        fullText = `${text}\n\nOn ${when}, ${who} wrote:\n${origText.split('\n').map((l) => `> ${l}`).join('\n')}`;
      }
      const references = [...referencesOf(p).filter((r) => r !== origId), origId].slice(-50);
      return {
        mail: {
          to: to.map(fmt),
          cc: cc.map(fmt),
          bcc: bcc.map(fmt),
          subject: oneLine(subject),
          text: fullText,
          html,
          inReplyTo: origId,
          references,
          headers: {}
        },
        original: { folder: where.folder, uid: where.uid, messageId: origId }
      };
    })
  );

  fastify.post(`${P}/forward`, sendOpts('forward'), async (req, reply) =>
    handleSend(req, reply, async (rest) => {
      const ctx = req.agent!;
      const messageId = str(rest.message_id, 'message_id', { max: 998, required: true })!;
      const to = addressListArg(rest.to, 'to');
      if (to.length === 0) fail(400, 'NO_RECIPIENTS', 'to needs at least one address.');
      const where = await locate(ctx.account, { messageId, folder: folderArg(rest.folder) });
      const orig = await loadMessage(ctx.account, where.folder, where.uid);
      const p = orig.parsed;
      const origId = p.messageId ? normaliseMessageId(p.messageId) : normaliseMessageId(messageId);
      const a = messageAddresses(p);
      const intro = str(rest.text, 'text', { max: 2_000_000 }) ?? '';
      const headerLines = [
        '---------- Forwarded message ----------',
        `From: ${a.from ? fmt(a.from) : ''}`,
        `Date: ${(p.date || new Date()).toUTCString()}`,
        `Subject: ${p.subject || ''}`,
        `To: ${a.to.map(fmt).join(', ')}`,
        ...(a.cc.length ? [`Cc: ${a.cc.map(fmt).join(', ')}`] : [])
      ];
      const origText = p.text || (p.html ? htmlToAgentText(p.html).text : '');
      const text = `${intro}\n\n${headerLines.join('\n')}\n\n${origText}`;
      const html = p.html
        ? `<div>${escapeHtml(intro).replace(/\n/g, '<br>')}</div><br><div>${headerLines.map(escapeHtml).join('<br>')}</div><br>${cleanEmailHtml(p.html)}`
        : undefined;
      const includeAttachments = boolArg(rest.include_attachments, 'include_attachments') !== false;
      const attachments = includeAttachments
        ? (p.attachments || []).map((att, i) => ({
            filename: att.filename || `attachment-${i + 1}`,
            content: att.content,
            contentType: att.contentType,
            cid: att.cid
          }))
        : [];
      const total = attachments.reduce((n, x) => n + x.content.length, 0) + text.length + (html?.length ?? 0);
      if (total > appConfig.maxMessageBytes) {
        fail(413, 'MESSAGE_TOO_LARGE', `The forwarded mail would be ${total} bytes; the limit is ${appConfig.maxMessageBytes}.`);
      }
      const origSubject = p.subject || '';
      const subject = /^\s*(fwd?|fw)\s*:/i.test(origSubject) ? origSubject : `Fwd: ${origSubject}`;
      return {
        mail: {
          to: to.map(fmt),
          cc: addressListArg(rest.cc, 'cc').map(fmt),
          bcc: addressListArg(rest.bcc, 'bcc').map(fmt),
          subject: oneLine(subject),
          text,
          html,
          attachments,
          references: [origId],
          headers: {}
        },
        original: { folder: where.folder, uid: where.uid, messageId: origId }
      };
    })
  );

  // ---------------------------------------------------------------- organise

  async function target(req: FastifyRequest) {
    const ctx = req.agent!;
    const body = (req.body ?? {}) as Obj;
    const ref = messageRef(body);
    ctx.audit.messageId = ref.messageId ? normaliseMessageId(ref.messageId) : null;
    const where = await locate(ctx.account, ref);
    ctx.audit.folder = where.folder;
    return { ctx, body, where };
  }

  fastify.post(`${P}/move`, route('move', 'organise'), async (req) => {
    const { ctx, body, where } = await target(req);
    const dest = folderArg(body.to_folder, 'to_folder', true)!;
    const moved = await moveMessage(ctx.account, where.folder, where.uid, dest);
    return { ok: true, from_folder: where.folder, folder: moved.folder, uid: moved.uid };
  });

  fastify.post(`${P}/flag`, route('flag', 'organise'), async (req) => {
    const { ctx, body, where } = await target(req);
    const flagged = boolArg(body.flagged, 'flagged');
    if (flagged === undefined) fail(400, 'INVALID_INPUT', 'flagged (true or false) is required.');
    await setFlag(ctx.account, where.folder, where.uid, '\\Flagged', flagged);
    return { ok: true, folder: where.folder, uid: where.uid, flagged };
  });

  fastify.post(`${P}/mark-read`, route('mark_read', 'organise'), async (req) => {
    const { ctx, body, where } = await target(req);
    const read = boolArg(body.read, 'read');
    if (read === undefined) fail(400, 'INVALID_INPUT', 'read (true or false) is required.');
    await setFlag(ctx.account, where.folder, where.uid, '\\Seen', read);
    return { ok: true, folder: where.folder, uid: where.uid, read };
  });

  fastify.post(`${P}/delete`, route('delete', 'organise'), async (req) => {
    const { ctx, where } = await target(req);
    const trash = await trashFolder(ctx.account);
    if (where.folder === trash) {
      fail(409, 'ALREADY_IN_TRASH', 'The message is already in Trash. The agent API never deletes permanently.');
    }
    const moved = await moveMessage(ctx.account, where.folder, where.uid, trash);
    return { ok: true, from_folder: where.folder, folder: moved.folder, uid: moved.uid };
  });
}
