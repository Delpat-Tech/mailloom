import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SendEmailPayload, SendAttachment } from '../types.js';
import { parseRecipientsLenient, parseRecipients, RecipientError, type Recipient } from '../utils/recipients.js';
import { endSession, requireAuth, sendSessionExpired } from './auth.js';
import { demoMailService } from '../services/demo-mail.js';
import {
  getLiveMailboxes,
  getLiveMessages,
  getLiveMessageDetail,
  setLiveMessageFlags,
  moveLiveMessage,
  deleteLiveMessage,
  markLiveMessageSpam,
  streamLiveAttachment,
  emptyLiveFolder,
  restoreLiveMessage,
  isImapAuthError,
  LIST_FILTERS,
  buildSearchCriteria,
  type ListFilter
} from '../services/imap.js';
import { BATCH_ACTIONS, BatchError, MAX_BATCH_UIDS, markAllRead, runBatch, type BatchAction, type BatchSelection } from '../services/batch.js';
import { enrichList, searchAllFolders } from '../services/organise.js';
import { saveLiveDraft, deleteLiveDraft, DraftError } from '../services/drafts.js';
import { acquireSlot } from '../utils/limiter.js';
import { contentDisposition } from '../utils/mime.js';
import { sniffImage } from '../services/richbody.js';
import { renderEmail } from '../utils/sanitize.js';
import { fetchRemoteImage, ImageProxyError, proxyImageUrl, verifyImageSignature, type ImageFetchOptions } from '../services/image-proxy.js';
import { AgentError, locate } from '../agent/mail.js';
import { sendLiveEmail, SendError, getMaxMessageBytes } from '../services/smtp.js';

type AuthenticatedRequest = FastifyRequest;

const CSP_ATTACHMENT = "default-src 'none'; sandbox";
// Chrome's built-in PDF viewer does not start under a CSP `sandbox` directive, so PDFs shown inline get
// `default-src 'none'` alone (still no scripts, frames or network from the document itself).
const CSP_INLINE_PDF = "default-src 'none'";

/** Reads the first bytes of a stream; `stream` is a replacement that still delivers every byte. */
async function peekStream(source: NodeJS.ReadableStream, want = 16): Promise<{ head: Buffer; stream: Readable }> {
  const s = source as Readable;
  let head = Buffer.alloc(0);
  while (head.length < want) {
    const chunk = s.read() as Buffer | null;
    if (chunk) {
      head = Buffer.concat([head, chunk]);
      continue;
    }
    const ended = await new Promise<boolean>((resolve) => {
      const onReadable = () => done(false);
      const onEnd = () => done(true);
      const done = (v: boolean) => {
        s.off('readable', onReadable);
        s.off('end', onEnd);
        s.off('close', onEnd);
        resolve(v);
      };
      s.once('readable', onReadable);
      s.once('end', onEnd);
      s.once('close', onEnd);
    });
    if (ended) break;
  }
  async function* replay() {
    if (head.length) yield head;
    for await (const c of s) yield c;
  }
  return { head, stream: Readable.from(replay(), { objectMode: false }) };
}

/** What an attachment may be shown as inline: a real png/jpeg/gif/webp or PDF, judged by its bytes. */
function inlineKind(head: Buffer): { type: string; csp: string } | undefined {
  const image = sniffImage(head);
  if (image) return { type: image, csp: CSP_ATTACHMENT };
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return { type: 'application/pdf', csp: CSP_INLINE_PDF };
  return undefined;
}

/**
 * Answers a failed mail operation. If the mail server refused the session's stored credentials,
 * the session is ended and the browser gets 401 SESSION_EXPIRED. Otherwise the client only
 * sees a fixed plain message; the technical reason goes to the server log (error code only,
 * never message content, subjects or addresses).
 */
export async function failMail(req: FastifyRequest, reply: FastifyReply, err: unknown, message: string) {
  if (isImapAuthError(err)) {
    await endSession(req, reply);
    return sendSessionExpired(reply);
  }
  const e = err as { code?: string; responseStatus?: string; name?: string } | null;
  req.log.warn({ route: req.routeOptions?.url, errName: e?.name, errCode: e?.code, status: e?.responseStatus }, message);
  return reply.status(500).send({ error: message });
}

const MAX_CONCURRENT_SENDS = 2;
export const MAX_IMAGE_FETCHES_PER_SESSION = 6;
export const MAX_IMAGE_FETCHES_GLOBAL = 16;

/** A message UID from a URL: a positive integer, else 0 (callers answer 400). */
function parseUid(raw: string): number {
  return /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : 0;
}

// Mail routes. Sign-in, sign-out and session checks live in ./auth.ts; requireAuth
// sets req.accountConfig (server-configured mail host plus the session's credentials).
export async function mailRoutes(
  fastify: FastifyInstance,
  opts: { maxMessageBytes?: number; sessionSecret?: string; imageFetch?: ImageFetchOptions } = {}
) {
  const draftBodyLimit = Math.ceil((opts.maxMessageBytes || 10 * 1024 * 1024) * 1.4) + 256 * 1024;
  // 4. List Mailbox Folders
  fastify.get('/api/mailboxes', { onRequest: [requireAuth] }, async (req: AuthenticatedRequest, reply) => {
    const config = req.accountConfig!;
    if (config.isDemo) {
      return { folders: demoMailService.getMailboxes() };
    }
    try {
      const folders = await getLiveMailboxes(config);
      return { folders };
    } catch (err) {
      return failMail(req, reply, err, 'Could not load folders');
    }
  });

  // Find one message of the signed-in mailbox by its Message-ID (INBOX first, then every other folder).
  // Used by deep links (#/m/<Message-ID>). Only ever searches the session's own account.
  fastify.get('/api/messages/locate', { onRequest: [requireAuth] }, async (req: AuthenticatedRequest, reply) => {
    const config = req.accountConfig!;
    const raw = String((req.query as { message_id?: string }).message_id ?? '').trim();
    if (!raw || raw.length > 998 || /[\s\u0000-\u001f\u007f]/.test(raw)) return reply.status(400).send({ error: 'Invalid Message-ID' });
    if (config.isDemo) return reply.status(404).send({ code: 'MESSAGE_NOT_FOUND', error: 'Message not found' });
    try {
      const where = await locate(config, { messageId: raw });
      return { folder: where.folder, uid: where.uid };
    } catch (err) {
      if (err instanceof AgentError && err.code === 'MESSAGE_NOT_FOUND') {
        return reply.status(404).send({ code: 'MESSAGE_NOT_FOUND', error: 'Message not found' });
      }
      return failMail(req, reply, err, 'Could not search for this message');
    }
  });

  // 5. List Messages in Mailbox
  fastify.get(
    '/api/mailboxes/:path/messages',
    { onRequest: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { path } = req.params as { path: string };
      const {
        page = '1',
        limit = '50',
        search = '',
        from = '',
        to = '',
        cc = '',
        body = '',
        subject = '',
        since = '',
        before = '',
        filter = 'all',
        scope = ''
      } = req.query as {
        scope?: string;
        cc?: string;
        body?: string;
        filter?: string;
        page?: string;
        limit?: string;
        search?: string;
        from?: string;
        to?: string;
        subject?: string;
        since?: string;
        before?: string;
      };

      for (const [name, value] of Object.entries({ search, from, to, cc, subject, body })) {
        if (typeof value !== 'string' || value.length > 200) {
          return reply.status(400).send({ code: 'INVALID_INPUT', error: `${name} may be at most 200 characters.` });
        }
      }
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
      const folderPath = path;
      if (!(LIST_FILTERS as readonly string[]).includes(filter)) {
        return reply.status(400).send({ code: 'INVALID_INPUT', error: `filter must be one of: ${LIST_FILTERS.join(', ')}` });
      }
      const listFilter = filter as ListFilter;
      const { store, indexer } = fastify.mailloomOrganise;

      const filters = {
        search: search.trim() || undefined,
        from: from.trim() || undefined,
        to: to.trim() || undefined,
        cc: cc.trim() || undefined,
        body: body.trim() || undefined,
        subject: subject.trim() || undefined,
        since: since.trim() || undefined,
        before: before.trim() || undefined
      };

      // scope=all: one search over every folder except Trash and Junk (Snoozed included), newest first.
      // Each result carries its folder in `mailbox`. Anything else keeps the single-folder behaviour.
      if (scope === 'all') {
        if (listFilter === 'attachments') {
          return reply.status(400).send({ code: 'INVALID_INPUT', error: 'The attachments filter cannot be combined with scope=all.' });
        }
        if (config.isDemo) {
          const names = demoMailService.getMailboxes().map((f) => f.path).filter((n) => !['trash', 'junk', 'spam'].includes(n.toLowerCase()));
          const merged = names.flatMap((n) => demoMailService.getMessages(n, 1, 10_000, search, filters).messages.map((m) => ({ ...m, mailbox: n })));
          merged.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
          const slice = merged.slice((pageNum - 1) * limitNum, pageNum * limitNum);
          return { messages: await enrichList(store, indexer, config, slice), total: merged.length };
        }
        try {
          const r = await searchAllFolders(config, buildSearchCriteria(filters, listFilter), pageNum, limitNum);
          return { ...r, messages: await enrichList(store, indexer, config, r.messages, req.log) };
        } catch (err) {
          return failMail(req, reply, err, 'Could not search');
        }
      }

      if (config.isDemo) {
        const keep = (m: { isSeen: boolean; isFlagged: boolean; hasAttachments: boolean }) =>
          listFilter === 'unread' ? !m.isSeen : listFilter === 'starred' ? m.isFlagged : listFilter === 'attachments' ? m.hasAttachments : true;
        const all = demoMailService.getMessages(folderPath, 1, 10_000, search, filters).messages.filter(keep);
        const pageItems = all.slice((pageNum - 1) * limitNum, pageNum * limitNum);
        return { messages: await enrichList(store, indexer, config, pageItems), total: all.length };
      }

      try {
        const cache = (folder: string, uidValidity: string, uids: number[]) => store.attachmentFlags(config.email, folder, uidValidity, uids);
        const r = await getLiveMessages(config, folderPath, pageNum, limitNum, filters, listFilter, cache);
        return { ...r, messages: await enrichList(store, indexer, config, r.messages, req.log) };
      } catch (err) {
        return failMail(req, reply, err, 'Could not load messages');
      }
    }
  );

  // 6. Get Message Detail
  fastify.get(
    '/api/mailboxes/:path/messages/:uid',
    { onRequest: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { path, uid } = req.params as { path: string; uid: string };
      const folderPath = path;
      const messageUid = parseUid(uid);
      if (!messageUid) return reply.status(400).send({ error: 'Invalid message id' });
      // images=1: the reader chose "show images" (direct https). images=auto: through the signed proxy
      // (never in Junk). Anything else, or nothing: blocked.
      const imagesParam = String((req.query as { images?: string }).images || '');
      const images = ['1', 'true'].includes(imagesParam);
      const proxyImage =
        imagesParam === 'auto' && opts.sessionSecret
          ? (u: string) =>
              proxyImageUrl(opts.sessionSecret!, u, {
                prefix: req.url.startsWith('/mail/') ? '/mail' : '',
                account: req.mailSession?.handle
              })
          : undefined;
      // peek=1: read without marking as read (the client prefetches neighbouring messages this way).
      const peek = ['1', 'true'].includes(String((req.query as { peek?: string }).peek || ''));

      if (config.isDemo) {
        const msg = demoMailService.getMessageDetail(folderPath, messageUid);
        if (!msg) return reply.status(404).send({ error: 'Message not found' });
        if (!msg.html) return msg;
        const shown = renderEmail(msg.html, {
          allowRemoteImages: images,
          proxyImage: folderPath.toLowerCase() === 'junk' ? undefined : proxyImage
        });
        return { ...msg, html: shown.html, blockedImages: shown.blockedImages };
      }

      try {
        const msg = await getLiveMessageDetail(config, folderPath, messageUid, { allowRemoteImages: images, peek, proxyImage });
        if (!msg) return reply.status(404).send({ error: 'Message not found' });
        return msg;
      } catch (err) {
        return failMail(req, reply, err, 'Could not load this message');
      }
    }
  );

  // 6b. Remote image proxy. Signed URLs only (see services/image-proxy.ts); needs a signed-in session.
  fastify.get('/api/image-proxy', { onRequest: [requireAuth] }, async (req: AuthenticatedRequest, reply) => {
    const q = req.query as { u?: unknown; sig?: unknown };
    const url = typeof q.u === 'string' ? q.u : '';
    const sig = typeof q.sig === 'string' ? q.sig : '';
    if (!url || url.length > 4096 || !opts.sessionSecret) return reply.status(400).send({ error: 'Invalid image address' });
    if (!verifyImageSignature(opts.sessionSecret, url, sig)) return reply.status(403).send({ error: 'Image address not signed' });
    // Caps on in-flight fetches: per session first, then for the whole server.
    const releaseSession = acquireSlot(`img|${req.mailSession!.key}`, MAX_IMAGE_FETCHES_PER_SESSION);
    if (!releaseSession) return reply.status(429).send({ error: 'Too many images at once' });
    const releaseGlobal = acquireSlot('img|global', MAX_IMAGE_FETCHES_GLOBAL);
    if (!releaseGlobal) {
      releaseSession();
      reply.header('Retry-After', '2');
      return reply.status(503).send({ error: 'The image service is busy' });
    }
    const release = () => {
      releaseSession();
      releaseGlobal();
    };
    try {
      const img = await fetchRemoteImage(url, opts.imageFetch);
      reply.header('Content-Type', img.contentType);
      reply.header('Content-Length', img.body.length);
      reply.header('Content-Disposition', 'inline');
      reply.header('Content-Security-Policy', "default-src 'none'");
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, max-age=86400');
      return reply.send(img.body);
    } catch (err) {
      const e = err instanceof ImageProxyError ? err : new ImageProxyError('UPSTREAM_ERROR');
      return reply.status(e.status).send({ code: e.code, error: 'The image could not be loaded' });
    } finally {
      release();
    }
  });

  // 7. Download Attachment
  fastify.get(
    '/api/mailboxes/:path/messages/:uid/attachments/:partId',
    { onRequest: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { uid, partId } = req.params as { path: string; uid: string; partId: string };
      const messageUid = parseUid(uid);
      if (!messageUid) return reply.status(400).send({ error: 'Invalid message id' });

      // ?inline=1 asks to show the file in the browser; only sniffed images and PDFs are allowed that.
      const wantInline = ['1', 'true'].includes(String((req.query as { inline?: string }).inline || ''));

      if (config.isDemo) {
        const att = demoMailService.getAttachmentData(messageUid, partId);
        if (!att) return reply.status(404).send({ error: 'Attachment not found' });
        const kind = wantInline ? inlineKind(att.buffer.subarray(0, 16)) : undefined;
        reply.header('Content-Type', kind ? kind.type : att.contentType);
        reply.header('Content-Disposition', contentDisposition(att.filename, kind ? 'inline' : 'attachment'));
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Content-Security-Policy', kind ? kind.csp : CSP_ATTACHMENT);
        return reply.send(att.buffer);
      }

      // For real IMAP: stream attachment directly to HTTP response socket with zero RAM buffering
      const folderPath = (req.params as { path: string }).path;
      let attData;
      try {
        attData = await streamLiveAttachment(config, folderPath, messageUid, partId);
      } catch (err) {
        return failMail(req, reply, err, 'Could not download the attachment');
      }
      if (!attData) return reply.status(404).send({ error: 'Attachment not found' });

      let kind: { type: string; csp: string } | undefined;
      let body: NodeJS.ReadableStream = attData.stream;
      if (wantInline) {
        try {
          const peeked = await peekStream(attData.stream);
          kind = inlineKind(peeked.head);
          body = peeked.stream;
        } catch (err) {
          return failMail(req, reply, err, 'Could not download the attachment');
        }
      }
      reply.header('Content-Type', kind ? kind.type : attData.contentType);
      reply.header('Content-Disposition', contentDisposition(attData.filename, kind ? 'inline' : 'attachment'));
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', kind ? kind.csp : CSP_ATTACHMENT);
      return reply.send(body);
    }
  );

  // 8. Toggle Message Flags (Seen / Flagged)
  fastify.post(
    '/api/mailboxes/:path/messages/:uid/flags',
    { onRequest: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { path, uid } = req.params as { path: string; uid: string };
      const { flag, value } = req.body as { flag: 'isSeen' | 'isFlagged'; value: boolean };
      const messageUid = parseUid(uid);
      if (!messageUid) return reply.status(400).send({ error: 'Invalid message id' });
      const folderPath = path;

      if (config.isDemo) {
        const success = demoMailService.toggleFlag(messageUid, flag, value);
        return { success };
      }

      try {
        const success = await setLiveMessageFlags(config, folderPath, messageUid, flag, value);
        return { success };
      } catch (err) {
        return failMail(req, reply, err, 'Could not update the message');
      }
    }
  );

  // 9. Move Message
  fastify.post(
    '/api/mailboxes/:path/messages/:uid/move',
    { onRequest: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { path, uid } = req.params as { path: string; uid: string };
      const { targetFolder } = req.body as { targetFolder: string };
      const messageUid = parseUid(uid);
      if (!messageUid) return reply.status(400).send({ error: 'Invalid message id' });
      const folderPath = path;

      if (config.isDemo) {
        const success = demoMailService.moveMessage(messageUid, targetFolder);
        if (!success) return reply.status(404).send({ error: 'Message not found' });
        return { success };
      }

      try {
        const success = await moveLiveMessage(config, folderPath, messageUid, targetFolder);
        return { success };
      } catch (err) {
        return failMail(req, reply, err, 'Could not move the message');
      }
    }
  );

  // 10. Delete Message
  fastify.delete(
    '/api/mailboxes/:path/messages/:uid',
    { onRequest: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { path, uid } = req.params as { path: string; uid: string };
      const messageUid = parseUid(uid);
      if (!messageUid) return reply.status(400).send({ error: 'Invalid message id' });
      const folderPath = path;

      if (config.isDemo) {
        const success = demoMailService.deleteMessage(messageUid);
        if (!success) return reply.status(404).send({ error: 'Message not found' });
        return { success, permanent: folderPath === 'Trash' };
      }

      try {
        const r = await deleteLiveMessage(config, folderPath, messageUid);
        return { success: true, permanent: r.permanent, movedTo: r.movedTo };
      } catch (err) {
        return failMail(req, reply, err, 'Could not delete the message');
      }
    }
  );

  // 11. Mark Message as Spam (Move to Junk & Mark Read)
  fastify.post(
    '/api/mailboxes/:path/messages/:uid/spam',
    { onRequest: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { path, uid } = req.params as { path: string; uid: string };
      const { junkFolder } = (req.body as { junkFolder?: string }) || {};
      const messageUid = parseUid(uid);
      if (!messageUid) return reply.status(400).send({ error: 'Invalid message id' });
      const folderPath = path;

      if (config.isDemo) {
        const success = demoMailService.markAsSpam(messageUid, junkFolder || 'Junk');
        return { success };
      }

      try {
        const success = await markLiveMessageSpam(config, folderPath, messageUid, junkFolder);
        return { success };
      } catch (err) {
        return failMail(req, reply, err, 'Could not mark the message as spam');
      }
    }
  );

  // 11b. Restore from Trash / Not spam (back to the Inbox)
  for (const [suffix, from] of [['restore', 'Trash'], ['not-spam', 'Junk']] as const) {
    fastify.post(
      `/api/mailboxes/:path/messages/:uid/${suffix}`,
      { onRequest: [requireAuth] },
      async (req: AuthenticatedRequest, reply) => {
        const config = req.accountConfig!;
        const { path, uid } = req.params as { path: string; uid: string };
        const messageUid = parseUid(uid);
      if (!messageUid) return reply.status(400).send({ error: 'Invalid message id' });
        if (config.isDemo) {
          const ok = demoMailService.moveMessage(messageUid, 'INBOX');
          if (!ok) return reply.status(404).send({ error: 'Message not found' });
          return { success: true, movedTo: 'INBOX' };
        }
        try {
          const movedTo = await restoreLiveMessage(config, path, messageUid, from);
          return { success: true, movedTo };
        } catch (err) {
          return failMail(req, reply, err, 'Could not complete that action');
        }
      }
    );
  }

  // 11c. Empty Trash / Junk (permanent)
  fastify.post(
    '/api/mailboxes/:path/empty',
    { onRequest: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { path } = req.params as { path: string };
      if (config.isDemo) {
        const deleted = demoMailService.emptyFolder(path);
        return { success: true, deleted };
      }
      try {
        const deleted = await emptyLiveFolder(config, path);
        return { success: true, deleted };
      } catch (err) {
        return failMail(req, reply, err, 'Could not complete that action');
      }
    }
  );

  // 11e. Batch actions: many messages (or the whole folder) in one request, one IMAP command per action.
  // Body: { action, uids?: number[], all?: true, targetFolder?, junkFolder? }.
  fastify.post('/api/mailboxes/:path/batch', { onRequest: [requireAuth] }, async (req: AuthenticatedRequest, reply) => {
    const config = req.accountConfig!;
    const { path } = req.params as { path: string };
    const body = (req.body ?? {}) as { action?: unknown; uids?: unknown; all?: unknown; targetFolder?: unknown; junkFolder?: unknown };
    const invalid = (error: string) => reply.status(400).send({ code: 'INVALID_INPUT', error });
    if (typeof body.action !== 'string' || !(BATCH_ACTIONS as readonly string[]).includes(body.action)) {
      return invalid(`action must be one of: ${BATCH_ACTIONS.join(', ')}`);
    }
    const wantsAll = body.all === true;
    if (wantsAll === (body.uids !== undefined)) return invalid('Give either uids or all: true.');
    let selection: BatchSelection;
    if (wantsAll) {
      selection = { all: true };
    } else {
      const u = body.uids;
      if (!Array.isArray(u) || u.length === 0 || u.length > MAX_BATCH_UIDS || !u.every((x) => Number.isInteger(x) && x > 0 && x < 2 ** 32)) {
        return invalid(`uids must be 1 to ${MAX_BATCH_UIDS} message ids.`);
      }
      selection = { uids: [...new Set(u as number[])] };
    }
    if (body.action === 'move' && (typeof body.targetFolder !== 'string' || !body.targetFolder)) return invalid('Give a targetFolder.');
    if (config.isDemo) return reply.status(400).send({ code: 'DEMO_ACCOUNT', error: 'This is not available in the demo.' });
    try {
      const r = await runBatch(config, path, body.action as BatchAction, selection, {
        targetFolder: typeof body.targetFolder === 'string' ? body.targetFolder : undefined,
        junkFolder: typeof body.junkFolder === 'string' ? body.junkFolder : undefined
      });
      return { success: true, ...r };
    } catch (err) {
      if (err instanceof BatchError) return reply.status(err.status).send({ code: err.code, error: err.message });
      return failMail(req, reply, err, 'Could not complete that action');
    }
  });

  // 11f. Mark every message of a folder as read.
  fastify.post('/api/mailboxes/:path/mark-all-read', { onRequest: [requireAuth] }, async (req: AuthenticatedRequest, reply) => {
    const config = req.accountConfig!;
    const { path } = req.params as { path: string };
    if (config.isDemo) return reply.status(400).send({ code: 'DEMO_ACCOUNT', error: 'This is not available in the demo.' });
    try {
      return { success: true, affected: await markAllRead(config, path) };
    } catch (err) {
      return failMail(req, reply, err, 'Could not mark the messages as read');
    }
  });

  // 11d. Drafts: save (create or replace) and delete
  fastify.post('/api/drafts', { onRequest: [requireAuth], bodyLimit: draftBodyLimit }, async (req: AuthenticatedRequest, reply) => {
    const config = req.accountConfig!;
    const raw = (req.body as Record<string, unknown>) || {};
    const strList = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
    if (config.isDemo) return reply.status(400).send({ error: 'Drafts are not available in the demo.' });
    const dTo = parseRecipientsLenient(raw.to, 'To');
    const dCc = parseRecipientsLenient(raw.cc, 'Cc');
    const dBcc = parseRecipientsLenient(raw.bcc, 'Bcc');
    const droppedRecipients = [...dTo.dropped, ...dCc.dropped, ...dBcc.dropped];
    try {
      const saved = await saveLiveDraft(
        config,
        {
          to: dTo.kept,
          cc: dCc.kept,
          bcc: dBcc.kept,
          subject: typeof raw.subject === 'string' ? raw.subject : '',
          text: typeof raw.text === 'string' ? raw.text : '',
          html: typeof raw.html === 'string' ? raw.html : undefined,
          inReplyTo: typeof raw.inReplyTo === 'string' ? raw.inReplyTo : undefined,
          references: strList(raw.references)
        },
        Number.isInteger(raw.replaceUid) ? (raw.replaceUid as number) : undefined
      );
      return { success: true, uid: saved.uid, folder: saved.folder, droppedRecipients };
    } catch (err) {
      if (err instanceof DraftError) return reply.status(err.status).send({ error: err.message });
      return failMail(req, reply, err, 'The draft could not be saved');
    }
  });

  fastify.delete('/api/drafts/:uid', { onRequest: [requireAuth] }, async (req: AuthenticatedRequest, reply) => {
    const config = req.accountConfig!;
    const uid = parseUid((req.params as { uid: string }).uid);
    if (!uid) return reply.status(400).send({ error: 'Invalid draft id' });
    if (config.isDemo) return reply.status(400).send({ error: 'Drafts are not available in the demo.' });
    try {
      const deleted = await deleteLiveDraft(config, uid);
      if (!deleted) return reply.status(404).send({ error: 'Draft not found' });
      return { success: true };
    } catch (err) {
      return failMail(req, reply, err, 'Could not complete that action');
    }
  });

  // 12. Send Outgoing Message (multipart/form-data: JSON field "payload" + file parts, or plain JSON without files)
  fastify.post(
    '/api/messages/send',
    { onRequest: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const release = acquireSlot(`send|${config.email.toLowerCase()}|${config.imapHost}`, MAX_CONCURRENT_SENDS);
      if (!release) {
        return reply.status(429).send({ error: 'Two messages are already being sent. Wait a moment and try again.' });
      }
      reply.raw.once('close', release);
      const max = getMaxMessageBytes(config);
      let raw: Record<string, unknown> = {};
      const attachments: SendAttachment[] = [];

      // Too big: answer, then close the connection so the rest of the upload is discarded, not buffered.
      const tooLarge = (message: string) => {
        reply.header('connection', 'close');
        reply.raw.once('finish', () => req.raw.destroy());
        return reply.status(413).send({ error: message });
      };

      try {
        if (req.isMultipart()) {
          let total = 0;
          for await (const part of req.parts({ limits: { fileSize: max + 1, files: 30, fieldSize: Math.ceil(max * 1.4) + 256 * 1024 } })) {
            if (part.type === 'file') {
              const buf = await part.toBuffer();
              if (part.file.truncated || buf.length > max) {
                return tooLarge(`"${part.filename}" is larger than the allowed size.`);
              }
              total += buf.length;
              if (total > max) {
                return tooLarge('Attachments together are larger than the allowed size.');
              }
              if (part.fieldname.toLowerCase().startsWith('cid:')) {
                // Pictures travel only as data: images in the HTML; a client-chosen Content-ID is never accepted.
                return reply.status(400).send({ error: 'Pictures must be part of the message, not separate uploads.' });
              }
              attachments.push({
                filename: part.filename || 'attachment',
                content: buf,
                contentType: part.mimetype || 'application/octet-stream'
              });
            } else if (part.fieldname === 'payload' && typeof part.value === 'string') {
              raw = JSON.parse(part.value);
            }
          }
        } else {
          raw = (req.body as Record<string, unknown>) || {};
        }
      } catch (err) {
        // The multipart plugin throws (instead of returning a truncated file) when a file passes its size limit.
        if ((err as { code?: string })?.code === 'FST_REQ_FILE_TOO_LARGE') {
          return tooLarge('An attachment is larger than the allowed size.');
        }
        return reply.status(400).send({ error: 'The message could not be read.' });
      }

      const strList = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
      let recipients: { to: Recipient[]; cc: Recipient[]; bcc: Recipient[] };
      try {
        recipients = { to: parseRecipients(raw.to, 'To'), cc: parseRecipients(raw.cc, 'Cc'), bcc: parseRecipients(raw.bcc, 'Bcc') };
      } catch (err) {
        if (err instanceof RecipientError) return reply.status(400).send({ error: err.message });
        throw err;
      }
      const fo = raw.forwardOf as { folder?: unknown; uid?: unknown } | undefined;
      const payload: SendEmailPayload = {
        ...recipients,
        subject: typeof raw.subject === 'string' && raw.subject ? raw.subject : '(No Subject)',
        text: typeof raw.text === 'string' ? raw.text : undefined,
        html: typeof raw.html === 'string' ? raw.html : undefined,
        attachments,
        inReplyTo: typeof raw.inReplyTo === 'string' ? raw.inReplyTo : undefined,
        references: strList(raw.references),
        forwardOf:
          fo && typeof fo.folder === 'string' && Number.isInteger(fo.uid)
            ? { folder: fo.folder, uid: fo.uid as number }
            : undefined,
        draftUid: Number.isInteger(raw.draftUid) ? (raw.draftUid as number) : undefined,
        idempotencyKey:
          (typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined) ||
          (typeof raw.idempotencyKey === 'string' ? raw.idempotencyKey : undefined)
      };
      // A free-form "from" in the request is deliberately ignored: sendLiveEmail uses the signed-in account.

      if (payload.to.length === 0) {
        return reply.status(400).send({ error: 'At least one recipient (To) is required' });
      }

      if (config.isDemo) {
        const header = demoMailService.sendEmail(payload, config.email, config.name);
        return { success: true, message: header };
      }

      try {
        const r = await sendLiveEmail(config, payload);
        // The Sent copy is stored by now: refresh the recipient suggestions.
        if (r.accepted.length > 0) fastify.mailloomContacts.indexer.kick(config, true);
        let draftDeleted: boolean | undefined;
        if (payload.draftUid && r.accepted.length > 0) {
          draftDeleted = await deleteLiveDraft(config, payload.draftUid).catch(() => false);
        }
        return {
          draftDeleted,
          success: r.rejected.length === 0,
          messageId: r.messageId,
          accepted: r.accepted,
          rejected: r.rejected,
          sentCopySaved: r.sentCopySaved,
          warning: r.sentCopyError,
          ...(r.rejected.length > 0
            ? { error: `Not delivered to: ${r.rejected.join(', ')}. The others were sent.` }
            : {})
        };
      } catch (err) {
        if (err instanceof SendError) {
          return reply.status(err.status).send({ error: err.message });
        }
        return failMail(req, reply, err, 'The message could not be sent.');
      }
    }
  );
}
