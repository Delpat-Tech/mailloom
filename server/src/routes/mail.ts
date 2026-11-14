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
  type ListFilter
} from '../services/imap.js';
import { enrichList } from '../services/organise.js';
import { saveLiveDraft, deleteLiveDraft, DraftError } from '../services/drafts.js';
import { acquireSlot } from '../utils/limiter.js';
import { contentDisposition } from '../utils/mime.js';
import { renderEmail } from '../utils/sanitize.js';
import { AgentError, locate } from '../agent/mail.js';
import { sendLiveEmail, SendError, getMaxMessageBytes } from '../services/smtp.js';

type AuthenticatedRequest = FastifyRequest;

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

/** A message UID from a URL: a positive integer, else 0 (callers answer 400). */
function parseUid(raw: string): number {
  return /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : 0;
}

// Mail routes. Sign-in, sign-out and session checks live in ./auth.ts; requireAuth
// sets req.accountConfig (server-configured mail host plus the session's credentials).
export async function mailRoutes(fastify: FastifyInstance, opts: { maxMessageBytes?: number } = {}) {
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
        subject = '',
        since = '',
        before = '',
        filter = 'all'
      } = req.query as {
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
        subject: subject.trim() || undefined,
        since: since.trim() || undefined,
        before: before.trim() || undefined
      };

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
      const images = ['1', 'true'].includes(String((req.query as { images?: string }).images || ''));
      // peek=1: read without marking as read (the client prefetches neighbouring messages this way).
      const peek = ['1', 'true'].includes(String((req.query as { peek?: string }).peek || ''));

      if (config.isDemo) {
        const msg = demoMailService.getMessageDetail(folderPath, messageUid);
        if (!msg) return reply.status(404).send({ error: 'Message not found' });
        if (!msg.html) return msg;
        const shown = renderEmail(msg.html, { allowRemoteImages: images });
        return { ...msg, html: shown.html, blockedImages: shown.blockedImages };
      }

      try {
        const msg = await getLiveMessageDetail(config, folderPath, messageUid, { allowRemoteImages: images, peek });
        if (!msg) return reply.status(404).send({ error: 'Message not found' });
        return msg;
      } catch (err) {
        return failMail(req, reply, err, 'Could not load this message');
      }
    }
  );

  // 7. Download Attachment
  fastify.get(
    '/api/mailboxes/:path/messages/:uid/attachments/:partId',
    { onRequest: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { uid, partId } = req.params as { path: string; uid: string; partId: string };
      const messageUid = parseUid(uid);
      if (!messageUid) return reply.status(400).send({ error: 'Invalid message id' });

      if (config.isDemo) {
        const att = demoMailService.getAttachmentData(messageUid, partId);
        if (!att) return reply.status(404).send({ error: 'Attachment not found' });
        reply.header('Content-Type', att.contentType);
        reply.header('Content-Disposition', contentDisposition(att.filename));
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
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

      reply.header('Content-Type', attData.contentType);
      reply.header('Content-Disposition', contentDisposition(attData.filename));
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
      return reply.send(attData.stream);
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
