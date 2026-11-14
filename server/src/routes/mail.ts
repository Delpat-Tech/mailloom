import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SendEmailPayload } from '../types.js';
import { requireAuth } from './auth.js';
import { demoMailService } from '../services/demo-mail.js';
import {
  getLiveMailboxes,
  getLiveMessages,
  getLiveMessageDetail,
  setLiveMessageFlags,
  moveLiveMessage,
  deleteLiveMessage,
  markLiveMessageSpam,
  streamLiveAttachment
} from '../services/imap.js';
import { sendLiveEmail } from '../services/smtp.js';

type AuthenticatedRequest = FastifyRequest;

// Mail routes. Sign-in, sign-out and session checks live in ./auth.ts; requireAuth
// sets req.accountConfig (server-configured mail host plus the session's credentials).
export async function mailRoutes(fastify: FastifyInstance) {
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
      const folderPath = decodeURIComponent(path);

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
      const folderPath = decodeURIComponent(path);
      const messageUid = parseInt(uid, 10);

      if (config.isDemo) {
        const msg = demoMailService.getMessageDetail(folderPath, messageUid);
        if (!msg) return reply.status(404).send({ error: 'Message not found' });
        return msg;
      }

      try {
        const msg = await getLiveMessageDetail(config, folderPath, messageUid);
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
        reply.header('Content-Disposition', `attachment; filename="${att.filename}"`);
        return reply.send(att.buffer);
      }

      // For real IMAP: stream attachment directly to HTTP response socket with zero RAM buffering
      const folderPath = decodeURIComponent((req.params as { path: string }).path);
      const attData = await streamLiveAttachment(config, folderPath, messageUid, partId);
      if (!attData) return reply.status(404).send({ error: 'Attachment not found' });

      reply.header('Content-Type', attData.contentType);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(attData.filename)}"`);
      reply.header('Transfer-Encoding', 'chunked');
      return reply.send(attData.stream);
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
      const folderPath = decodeURIComponent(path);

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
      const folderPath = decodeURIComponent(path);

      if (config.isDemo) {
        const success = demoMailService.moveMessage(messageUid, targetFolder);
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
      const folderPath = decodeURIComponent(path);

      if (config.isDemo) {
        const success = demoMailService.deleteMessage(messageUid);
        return { success };
      }

      try {
        const success = await deleteLiveMessage(config, folderPath, messageUid);
        return { success };
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
      const folderPath = decodeURIComponent(path);

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

  // 12. Send Outgoing Message
  fastify.post(
    '/api/messages/send',
    { preHandler: [requireAuth] },
    async (req: AuthenticatedRequest, reply) => {
      const config = req.accountConfig!;
      const payload = req.body as SendEmailPayload;

      if (!payload.to || payload.to.length === 0) {
        return reply.status(400).send({ error: 'At least one recipient (To) is required' });
      }
      if (!payload.subject) {
        payload.subject = '(No Subject)';
      }

      if (config.isDemo) {
        const header = demoMailService.sendEmail(payload, config.email, config.name);
        return { success: true, message: header };
      }

      try {
        const info = await sendLiveEmail(config, payload);
        return { success: true, info };
      } catch (err) {
        return reply.status(500).send({ error: `Failed to send email: ${(err as Error).message}` });
      }
    }
  );
}
