import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AccountConfig, SendEmailPayload, SendAttachment } from '../types.js';
import { decryptSession, encryptSession } from '../utils/crypto.js';
import { demoMailService } from '../services/demo-mail.js';
import {
  getLiveMailboxes,
  getLiveMessages,
  getLiveMessageDetail,
  setLiveMessageFlags,
  moveLiveMessage,
  deleteLiveMessage,
  markLiveMessageSpam,
  testImapConnection,
  streamLiveAttachment,
  emptyLiveFolder,
  restoreLiveMessage,
  closeUserSession
} from '../services/imap.js';
import { saveLiveDraft, deleteLiveDraft } from '../services/drafts.js';
import { acquireSlot } from '../utils/limiter.js';
import { contentDisposition } from '../utils/mime.js';
import { renderEmail } from '../utils/sanitize.js';
import { sendLiveEmail, testSmtpConnection, SendError, getMaxMessageBytes } from '../services/smtp.js';

interface AuthenticatedRequest extends FastifyRequest {
  accountConfig?: AccountConfig;
}

const MAX_CONCURRENT_SENDS = 2;

export async function mailRoutes(fastify: FastifyInstance) {
  // Authentication middleware
  const requireAuth = async (req: AuthenticatedRequest, reply: FastifyReply) => {
    const authHeader = req.headers.authorization;
    const cookieToken = req.cookies.session_token;
    const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : cookieToken;

    if (!token) {
      reply.status(401).send({ error: 'Unauthorized: No session token provided' });
      return;
    }

    const config = decryptSession(token);
    if (!config) {
      reply.status(401).send({ error: 'Unauthorized: Invalid or expired session' });
      return;
    }

    req.accountConfig = config;
  };

  // 1. Connect Account
  fastify.post('/api/auth/connect', async (req, reply) => {
    const body = req.body as Partial<AccountConfig> & { isDemo?: boolean };

    if (body.isDemo) {
      const demoConfig: AccountConfig = {
        email: 'sales@poojafasteners.example',
        name: 'Ramesh Dave (Pooja Fasteners)',
        imapHost: 'demo.local',
        imapPort: 993,
        imapSecure: true,
        imapUser: 'demo',
        imapPass: 'demo',
        smtpHost: 'demo.local',
        smtpPort: 587,
        smtpSecure: false,
        isDemo: true
      };
      const token = encryptSession(demoConfig);
      reply.setCookie('session_token', token, { path: '/', httpOnly: true, sameSite: 'lax' });
      return { token, account: { email: demoConfig.email, name: demoConfig.name, isDemo: true } };
    }

    // Real IMAP/SMTP connection validation
    const incomingPass = body.imapPass || (body as { password?: string }).password || '';
    const config: AccountConfig = {
      email: body.email || '',
      name: body.name || body.email?.split('@')[0],
      imapHost: body.imapHost || '',
      imapPort: Number(body.imapPort || 993),
      imapSecure: body.imapSecure !== false,
      imapUser: body.imapUser || body.email || '',
      imapPass: incomingPass,
      smtpHost: body.smtpHost || '',
      smtpPort: Number(body.smtpPort || 587),
      smtpSecure: Boolean(body.smtpSecure),
      smtpUser: body.smtpUser || body.imapUser || body.email || '',
      smtpPass: body.smtpPass || incomingPass,
      isDemo: false
    };

    if (!config.email || !config.imapHost || !config.imapPass) {
      return reply.status(400).send({ error: 'Email, IMAP host, and password are required' });
    }

    try {
      await testImapConnection(config);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    // Test SMTP with non-blocking timeout fallback so login never hangs
    if (config.smtpHost) {
      try {
        await Promise.race([
          testSmtpConnection(config),
          new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP connection timed out')), 5000))
        ]);
      } catch (smtpErr) {
        fastify.log.warn(`[AUTH] SMTP verification notice for ${config.email}: ${(smtpErr as Error).message}`);
        // Allow login to succeed even if SMTP port has an issue so user can access mail
      }
    }

    const token = encryptSession(config);
    reply.setCookie('session_token', token, { path: '/', httpOnly: true, sameSite: 'lax' });
    return { token, account: { email: config.email, name: config.name, isDemo: false } };
  });

  // 2. Current Session User
  fastify.get('/api/auth/me', { preHandler: [requireAuth] }, async (req: AuthenticatedRequest) => {
    const config = req.accountConfig!;
    return {
      account: {
        email: config.email,
        name: config.name,
        imapHost: config.imapHost,
        smtpHost: config.smtpHost,
        isDemo: config.isDemo
      }
    };
  });

  // 3. Logout
  fastify.post('/api/auth/logout', async (req, reply) => {
    try {
      const authHeader = req.headers.authorization;
      const cookieToken = req.cookies.session_token;
      const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : cookieToken;
      if (token) {
        const config = decryptSession(token);
        if (config && !config.isDemo) {
          await closeUserSession(config);
        }
      }
    } catch {
      // Ignore cleanup error
    }
    reply.clearCookie('session_token', { path: '/' });
    return { success: true };
  });

  // 4. List Mailbox Folders
  fastify.get('/api/mailboxes', { preHandler: [requireAuth] }, async (req: AuthenticatedRequest) => {
    const config = req.accountConfig!;
    if (config.isDemo) {
      return { folders: demoMailService.getMailboxes() };
    }
    const folders = await getLiveMailboxes(config);
    return { folders };
  });

  // 5. List Messages in Mailbox
  fastify.get(
    '/api/mailboxes/:path/messages',
    { preHandler: [requireAuth] },
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
        before = ''
      } = req.query as {
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

      const filters = {
        search: search.trim() || undefined,
        from: from.trim() || undefined,
        to: to.trim() || undefined,
        subject: subject.trim() || undefined,
        since: since.trim() || undefined,
        before: before.trim() || undefined
      };

      if (config.isDemo) {
        return demoMailService.getMessages(folderPath, pageNum, limitNum, search, filters);
      }

      try {
        return await getLiveMessages(config, folderPath, pageNum, limitNum, filters);
      } catch (err) {
        return reply.status(500).send({ error: `Failed to fetch messages: ${(err as Error).message}` });
      }
    }
  );

  // 6. Get Message Detail
  fastify.get(
    '/api/mailboxes/:path/messages/:uid',
    { preHandler: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { path, uid } = req.params as { path: string; uid: string };
      const folderPath = path;
      const messageUid = parseInt(uid, 10);
      const images = ['1', 'true'].includes(String((req.query as { images?: string }).images || ''));

      if (config.isDemo) {
        const msg = demoMailService.getMessageDetail(folderPath, messageUid);
        if (!msg) return reply.status(404).send({ error: 'Message not found' });
        if (!msg.html) return msg;
        const shown = renderEmail(msg.html, { allowRemoteImages: images });
        return { ...msg, html: shown.html, blockedImages: shown.blockedImages };
      }

      try {
        const msg = await getLiveMessageDetail(config, folderPath, messageUid, { allowRemoteImages: images });
        if (!msg) return reply.status(404).send({ error: 'Message not found' });
        return msg;
      } catch (err) {
        return reply.status(500).send({ error: `Failed to fetch message detail: ${(err as Error).message}` });
      }
    }
  );

  // 7. Download Attachment
  fastify.get(
    '/api/mailboxes/:path/messages/:uid/attachments/:partId',
    { preHandler: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { uid, partId } = req.params as { path: string; uid: string; partId: string };
      const messageUid = parseInt(uid, 10);

      if (config.isDemo) {
        const att = demoMailService.getAttachmentData(messageUid, partId);
        if (!att) return reply.status(404).send({ error: 'Attachment not found' });
        reply.header('Content-Type', att.contentType);
        reply.header('Content-Disposition', contentDisposition(att.filename));
        return reply.send(att.buffer);
      }

      // For real IMAP: stream attachment directly to HTTP response socket with zero RAM buffering
      const folderPath = (req.params as { path: string }).path;
      try {
        const attData = await streamLiveAttachment(config, folderPath, messageUid, partId);
        if (!attData) return reply.status(404).send({ error: 'Attachment not found' });

        reply.header('Content-Type', attData.contentType);
        reply.header('Content-Disposition', contentDisposition(attData.filename));
        reply.header('X-Content-Type-Options', 'nosniff');
        return reply.send(attData.stream);
      } catch (err) {
        return reply.status(500).send({ error: `The attachment could not be downloaded: ${(err as Error).message}` });
      }
    }
  );

  // 8. Toggle Message Flags (Seen / Flagged)
  fastify.post(
    '/api/mailboxes/:path/messages/:uid/flags',
    { preHandler: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { path, uid } = req.params as { path: string; uid: string };
      const { flag, value } = req.body as { flag: 'isSeen' | 'isFlagged'; value: boolean };
      const messageUid = parseInt(uid, 10);
      const folderPath = path;

      if (config.isDemo) {
        const success = demoMailService.toggleFlag(messageUid, flag, value);
        return { success };
      }

      try {
        const success = await setLiveMessageFlags(config, folderPath, messageUid, flag, value);
        return { success };
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // 9. Move Message
  fastify.post(
    '/api/mailboxes/:path/messages/:uid/move',
    { preHandler: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { path, uid } = req.params as { path: string; uid: string };
      const { targetFolder } = req.body as { targetFolder: string };
      const messageUid = parseInt(uid, 10);
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
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // 10. Delete Message
  fastify.delete(
    '/api/mailboxes/:path/messages/:uid',
    { preHandler: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { path, uid } = req.params as { path: string; uid: string };
      const messageUid = parseInt(uid, 10);
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
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // 11. Mark Message as Spam (Move to Junk & Mark Read)
  fastify.post(
    '/api/mailboxes/:path/messages/:uid/spam',
    { preHandler: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const { path, uid } = req.params as { path: string; uid: string };
      const { junkFolder } = (req.body as { junkFolder?: string }) || {};
      const messageUid = parseInt(uid, 10);
      const folderPath = path;

      if (config.isDemo) {
        const success = demoMailService.markAsSpam(messageUid, junkFolder || 'Junk');
        return { success };
      }

      try {
        const success = await markLiveMessageSpam(config, folderPath, messageUid, junkFolder);
        return { success };
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // 11b. Restore from Trash / Not spam (back to the Inbox)
  for (const [suffix, from] of [['restore', 'Trash'], ['not-spam', 'Junk']] as const) {
    fastify.post(
      `/api/mailboxes/:path/messages/:uid/${suffix}`,
      { preHandler: [requireAuth] },
      async (req: AuthenticatedRequest, reply) => {
        const config = req.accountConfig!;
        const { path, uid } = req.params as { path: string; uid: string };
        const messageUid = parseInt(uid, 10);
        if (config.isDemo) {
          const ok = demoMailService.moveMessage(messageUid, 'INBOX');
          if (!ok) return reply.status(404).send({ error: 'Message not found' });
          return { success: true, movedTo: 'INBOX' };
        }
        try {
          const movedTo = await restoreLiveMessage(config, path, messageUid, from);
          return { success: true, movedTo };
        } catch (err) {
          return reply.status(500).send({ error: (err as Error).message });
        }
      }
    );
  }

  // 11c. Empty Trash / Junk (permanent)
  fastify.post(
    '/api/mailboxes/:path/empty',
    { preHandler: [requireAuth] },
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
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // 11d. Drafts: save (create or replace) and delete
  fastify.post('/api/drafts', { preHandler: [requireAuth] }, async (req: AuthenticatedRequest, reply) => {
    const config = req.accountConfig!;
    const raw = (req.body as Record<string, unknown>) || {};
    const strList = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
    if (config.isDemo) return reply.status(400).send({ error: 'Drafts are not available in the demo.' });
    try {
      const saved = await saveLiveDraft(
        config,
        {
          to: strList(raw.to),
          cc: strList(raw.cc),
          bcc: strList(raw.bcc),
          subject: typeof raw.subject === 'string' ? raw.subject : '',
          text: typeof raw.text === 'string' ? raw.text : '',
          inReplyTo: typeof raw.inReplyTo === 'string' ? raw.inReplyTo : undefined,
          references: strList(raw.references)
        },
        Number.isInteger(raw.replaceUid) ? (raw.replaceUid as number) : undefined
      );
      return { success: true, uid: saved.uid, folder: saved.folder };
    } catch (err) {
      return reply.status(500).send({ error: `The draft could not be saved: ${(err as Error).message}` });
    }
  });

  fastify.delete('/api/drafts/:uid', { preHandler: [requireAuth] }, async (req: AuthenticatedRequest, reply) => {
    const config = req.accountConfig!;
    const uid = parseInt((req.params as { uid: string }).uid, 10);
    if (config.isDemo) return { success: true };
    try {
      const deleted = await deleteLiveDraft(config, uid);
      if (!deleted) return reply.status(404).send({ error: 'Draft not found' });
      return { success: true };
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // 12. Send Outgoing Message (multipart/form-data: JSON field "payload" + file parts, or plain JSON without files)
  fastify.post(
    '/api/messages/send',
    { preHandler: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const release = acquireSlot(`send|${config.email.toLowerCase()}|${config.imapHost}`, MAX_CONCURRENT_SENDS);
      if (!release) {
        return reply.status(429).send({ error: 'Two messages are already being sent. Wait a moment and try again.' });
      }
      reply.raw.once('close', release);
      const max = getMaxMessageBytes();
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
          for await (const part of req.parts({ limits: { fileSize: max + 1, files: 30, fieldSize: 2 * 1024 * 1024 } })) {
            if (part.type === 'file') {
              const buf = await part.toBuffer();
              if (part.file.truncated || buf.length > max) {
                return tooLarge(`"${part.filename}" is larger than the allowed size.`);
              }
              total += buf.length;
              if (total > max) {
                return tooLarge('Attachments together are larger than the allowed size.');
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
      const fo = raw.forwardOf as { folder?: unknown; uid?: unknown } | undefined;
      const payload: SendEmailPayload = {
        to: strList(raw.to),
        cc: strList(raw.cc),
        bcc: strList(raw.bcc),
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
        return reply.status(500).send({ error: 'The message could not be sent.' });
      }
    }
  );
}
