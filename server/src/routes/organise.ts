import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from './auth.js';
import { failMail } from './mail.js';
import { LABEL_COLOURS, LABEL_ID_RE, MAX_LABELS, type LabelColour, type OrganiseStore } from '../services/organise-store.js';
import type { Snoozer } from '../services/snoozer.js';
import type { ConversationIndexer } from '../services/conv-index.js';
import {
  OrganiseError,
  assertKeywordsSupported,
  changeLabels,
  crossFolderView,
  enrichList,
  getThread,
  keywordFor,
  resolveFolders,
  snooze,
  snoozedView,
  stripLabelEverywhere,
  labelCounts,
  unsnooze
} from '../services/organise.js';
import { getPooledImapClient } from '../services/imap.js';
import { THREAD_ID_RE } from '../services/threading.js';
import { demoMailService } from '../services/demo-mail.js';

/**
 * Labels, starred and label views, snooze and conversations. All session-auth (requireAuth +
 * X-Mailloom-Account); every store query is keyed by the signed-in mailbox.
 */

export interface OrganiseContext {
  store: OrganiseStore;
  snoozer: Snoozer;
  indexer: ConversationIndexer;
  now: () => number;
}

declare module 'fastify' {
  interface FastifyInstance {
    mailloomOrganise: OrganiseContext;
  }
}

const DEMO = 'This is not available in the demo.';
const MAX_UIDS = 500;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function bad(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.status(status).send({ code, error });
}

function paging(q: unknown): { page: number; limit: number } {
  const { page = '1', limit = '50' } = (q || {}) as { page?: string; limit?: string };
  return {
    page: Math.max(1, parseInt(String(page), 10) || 1),
    limit: Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50))
  };
}

function folderName(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 1000 && !CONTROL_RE.test(v) ? v : null;
}

function uidList(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_UIDS) return null;
  if (!v.every((u) => Number.isInteger(u) && u > 0 && u < 2 ** 32)) return null;
  return [...new Set(v as number[])];
}

function labelName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= 40 && !CONTROL_RE.test(name) ? name : null;
}

function isColour(v: unknown): v is LabelColour {
  return typeof v === 'string' && (LABEL_COLOURS as readonly string[]).includes(v);
}

async function fail(req: FastifyRequest, reply: FastifyReply, err: unknown, message: string) {
  if (err instanceof OrganiseError) return bad(reply, err.status, err.code, err.message);
  return failMail(req, reply, err, message);
}

export async function organiseRoutes(fastify: FastifyInstance) {
  const auth = { onRequest: [requireAuth] };
  const ctx = () => fastify.mailloomOrganise;

  // ---------------- views across folders ----------------
  fastify.get('/api/views/starred', auth, async (req, reply) => {
    const config = req.accountConfig!;
    const { page, limit } = paging(req.query);
    if (config.isDemo) {
      const r = demoMailService.getMessages('starred', page, limit);
      return { ...r, messages: (await enrichList(ctx().store, ctx().indexer, config, r.messages)).map((m) => ({ ...m, mailbox: m.mailbox || 'INBOX' })) };
    }
    try {
      const folders = await resolveFolders(await getPooledImapClient(config));
      const r = await crossFolderView(config, { flagged: true }, folders.viewable, page, limit);
      return { ...r, messages: await enrichList(ctx().store, ctx().indexer, config, r.messages, req.log) };
    } catch (err) {
      return fail(req, reply, err, 'Could not load starred messages');
    }
  });

  fastify.get('/api/views/snoozed', auth, async (req, reply) => {
    const config = req.accountConfig!;
    const { page, limit } = paging(req.query);
    if (config.isDemo) return { messages: [], total: 0 };
    try {
      const r = await snoozedView(ctx().store, config, page, limit);
      return { ...r, messages: await enrichList(ctx().store, ctx().indexer, config, r.messages, req.log) };
    } catch (err) {
      return fail(req, reply, err, 'Could not load snoozed messages');
    }
  });

  // ---------------- labels ----------------
  // count is the unread number (kept for older clients); unread and total cover the folders a label view shows.
  const publicLabel = (l: { id: string; name: string; colour: string }, c: { unread: number; total: number } = { unread: 0, total: 0 }) => ({
    id: l.id,
    name: l.name,
    colour: l.colour,
    count: c.unread,
    unread: c.unread,
    total: c.total
  });

  fastify.get('/api/labels', auth, async (req, reply) => {
    const config = req.accountConfig!;
    let defs = ctx().store.labels(config.email);
    if (config.isDemo) return defs.map((l) => publicLabel(l));
    try {
      const counts = await labelCounts(config, defs.map((l) => l.id));
      // Mailboxes that were given the old default labels lose the ones nothing uses (once).
      const removed = ctx().store.pruneLegacyDefaults(config.email, new Map([...counts].map(([id, c]) => [id, c.total])));
      if (removed.length > 0) defs = defs.filter((l) => !removed.includes(l.id));
      return defs.map((l) => publicLabel(l, counts.get(l.id)));
    } catch (err) {
      return fail(req, reply, err, 'Could not load labels');
    }
  });

  fastify.post('/api/labels', auth, async (req, reply) => {
    const config = req.accountConfig!;
    if (config.isDemo) return bad(reply, 400, 'DEMO_ACCOUNT', DEMO);
    const body = (req.body ?? {}) as { name?: unknown; colour?: unknown };
    const name = labelName(body.name);
    if (!name) return bad(reply, 400, 'INVALID_INPUT', 'Give the label a name of up to 40 characters.');
    if (!isColour(body.colour)) return bad(reply, 400, 'INVALID_INPUT', `Pick a colour: ${LABEL_COLOURS.join(', ')}.`);
    const defs = ctx().store.labels(config.email);
    if (defs.length >= MAX_LABELS) return bad(reply, 400, 'TOO_MANY_LABELS', `A mailbox can have at most ${MAX_LABELS} labels.`);
    if (defs.some((l) => l.name.toLowerCase() === name.toLowerCase())) return bad(reply, 409, 'LABEL_EXISTS', 'A label with this name already exists.');
    try {
      await assertKeywordsSupported(config);
    } catch (err) {
      return fail(req, reply, err, 'Could not create the label');
    }
    const label = ctx().store.createLabel(config.email, name, body.colour);
    return reply.status(201).send(publicLabel(label));
  });

  fastify.patch('/api/labels/:id', auth, async (req, reply) => {
    const config = req.accountConfig!;
    if (config.isDemo) return bad(reply, 400, 'DEMO_ACCOUNT', DEMO);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: unknown; colour?: unknown; order?: unknown };
    if (!LABEL_ID_RE.test(id) || !ctx().store.label(config.email, id)) return bad(reply, 404, 'LABEL_NOT_FOUND', 'Label not found.');
    const patch: { name?: string; colour?: LabelColour; order?: number } = {};
    if (body.name !== undefined) {
      const name = labelName(body.name);
      if (!name) return bad(reply, 400, 'INVALID_INPUT', 'Give the label a name of up to 40 characters.');
      if (ctx().store.labels(config.email).some((l) => l.id !== id && l.name.toLowerCase() === name.toLowerCase())) {
        return bad(reply, 409, 'LABEL_EXISTS', 'A label with this name already exists.');
      }
      patch.name = name;
    }
    if (body.colour !== undefined) {
      if (!isColour(body.colour)) return bad(reply, 400, 'INVALID_INPUT', `Pick a colour: ${LABEL_COLOURS.join(', ')}.`);
      patch.colour = body.colour;
    }
    if (body.order !== undefined) {
      if (!Number.isInteger(body.order) || (body.order as number) < 0 || (body.order as number) > 10_000) {
        return bad(reply, 400, 'INVALID_INPUT', 'order must be a whole number from 0.');
      }
      patch.order = body.order as number;
    }
    const label = ctx().store.updateLabel(config.email, id, patch)!;
    return publicLabel(label);
  });

  fastify.delete('/api/labels/:id', auth, async (req, reply) => {
    const config = req.accountConfig!;
    if (config.isDemo) return bad(reply, 400, 'DEMO_ACCOUNT', DEMO);
    const { id } = req.params as { id: string };
    if (!LABEL_ID_RE.test(id) || !ctx().store.label(config.email, id)) return bad(reply, 404, 'LABEL_NOT_FOUND', 'Label not found.');
    try {
      // Messages first: if this fails the label stays, so deleting again finishes the job.
      await stripLabelEverywhere(config, id);
    } catch (err) {
      return fail(req, reply, err, 'Could not delete the label');
    }
    ctx().store.deleteLabel(config.email, id);
    return { success: true };
  });

  fastify.get('/api/labels/:id/messages', auth, async (req, reply) => {
    const config = req.accountConfig!;
    const { id } = req.params as { id: string };
    const { page, limit } = paging(req.query);
    if (!LABEL_ID_RE.test(id) || !ctx().store.label(config.email, id)) return bad(reply, 404, 'LABEL_NOT_FOUND', 'Label not found.');
    if (config.isDemo) return { messages: [], total: 0 };
    try {
      const folders = await resolveFolders(await getPooledImapClient(config));
      const r = await crossFolderView(config, { keyword: keywordFor(id) }, folders.viewable, page, limit);
      return { ...r, messages: await enrichList(ctx().store, ctx().indexer, config, r.messages, req.log) };
    } catch (err) {
      return fail(req, reply, err, 'Could not load messages');
    }
  });

  fastify.post('/api/messages/labels', auth, async (req, reply) => {
    const config = req.accountConfig!;
    if (config.isDemo) return bad(reply, 400, 'DEMO_ACCOUNT', DEMO);
    const body = (req.body ?? {}) as { mailbox?: unknown; uids?: unknown; add?: unknown; remove?: unknown };
    const mailbox = folderName(body.mailbox);
    const uids = uidList(body.uids);
    if (!mailbox || !uids) return bad(reply, 400, 'INVALID_INPUT', `Give mailbox and uids (1 to ${MAX_UIDS} message ids).`);
    const ids = (v: unknown): string[] | null =>
      v === undefined ? [] : Array.isArray(v) && v.length <= MAX_LABELS && v.every((x) => typeof x === 'string') ? [...new Set(v as string[])] : null;
    const add = ids(body.add);
    const remove = ids(body.remove);
    if (!add || !remove || add.length + remove.length === 0) return bad(reply, 400, 'INVALID_INPUT', 'Give label ids to add or remove.');
    const known = new Set(ctx().store.labels(config.email).map((l) => l.id));
    if ([...add, ...remove].some((x) => !known.has(x))) return bad(reply, 400, 'UNKNOWN_LABEL', 'One of the labels does not exist.');
    try {
      await changeLabels(config, mailbox, uids, add, remove.filter((x) => !add.includes(x)));
      return { success: true };
    } catch (err) {
      return fail(req, reply, err, 'Could not change the labels');
    }
  });

  // ---------------- snooze ----------------
  fastify.post('/api/messages/snooze', auth, async (req, reply) => {
    const config = req.accountConfig!;
    if (config.isDemo) return bad(reply, 400, 'DEMO_ACCOUNT', DEMO);
    const body = (req.body ?? {}) as { mailbox?: unknown; uids?: unknown; until?: unknown };
    const mailbox = folderName(body.mailbox);
    const uids = uidList(body.uids);
    if (!mailbox || !uids) return bad(reply, 400, 'INVALID_INPUT', `Give mailbox and uids (1 to ${MAX_UIDS} message ids).`);
    const until = typeof body.until === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(body.until) ? Date.parse(body.until) : NaN;
    if (!Number.isFinite(until)) return bad(reply, 400, 'INVALID_INPUT', 'until must be a date and time (ISO 8601).');
    const now = ctx().now();
    const max = new Date(now);
    max.setUTCFullYear(max.getUTCFullYear() + 1);
    if (until <= now) return bad(reply, 400, 'INVALID_INPUT', 'Pick a time in the future.');
    if (until > max.getTime()) return bad(reply, 400, 'INVALID_INPUT', 'Mail can be snoozed for at most a year.');
    try {
      const r = await snooze(ctx().store, config, mailbox, uids, until);
      return { success: true, folder: r.folder, count: r.count, until: new Date(until).toISOString() };
    } catch (err) {
      return fail(req, reply, err, 'Could not snooze the message');
    }
  });

  fastify.delete('/api/messages/snooze', auth, async (req, reply) => {
    const config = req.accountConfig!;
    if (config.isDemo) return bad(reply, 400, 'DEMO_ACCOUNT', DEMO);
    const uids = uidList(((req.body ?? {}) as { uids?: unknown }).uids);
    if (!uids) return bad(reply, 400, 'INVALID_INPUT', `Give uids (1 to ${MAX_UIDS} message ids in Snoozed).`);
    try {
      const r = await unsnooze(ctx().store, config, uids);
      return { success: true, movedTo: r.movedTo, count: r.count };
    } catch (err) {
      return fail(req, reply, err, 'Could not move the message back to the Inbox');
    }
  });

  // ---------------- conversations ----------------
  fastify.get('/api/threads/:threadId', auth, async (req, reply) => {
    const config = req.accountConfig!;
    const { threadId } = req.params as { threadId: string };
    if (!THREAD_ID_RE.test(threadId)) return bad(reply, 400, 'INVALID_INPUT', 'Invalid conversation id.');
    const rawMailbox = (req.query as { mailbox?: unknown }).mailbox;
    const mailbox = rawMailbox === undefined || rawMailbox === '' ? undefined : folderName(rawMailbox);
    if (mailbox === null) return bad(reply, 400, 'INVALID_INPUT', 'Invalid mailbox.');
    if (config.isDemo) return bad(reply, 404, 'THREAD_NOT_FOUND', 'Conversation not found.');
    try {
      const thread = await getThread(ctx().store, ctx().indexer, config, threadId, mailbox);
      if (!thread) return bad(reply, 404, 'THREAD_NOT_FOUND', 'Conversation not found.');
      return thread;
    } catch (err) {
      return fail(req, reply, err, 'Could not load the conversation');
    }
  });
}
