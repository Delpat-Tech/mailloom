import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { AccountConfig, SendEmailPayload, SendResult } from '../types.js';
import { prepareRichBody, RichBodyError } from './richbody.js';
import { getPooledImapClient, getLiveMessageAttachments, MessageTooLargeError, ImapAuthError } from './imap.js';

export function createSmtpTransport(config: AccountConfig) {
  const user = config.smtpUser || config.imapUser;
  const pass = config.smtpPass || config.imapPass;

  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user,
      pass
    },
    // Same certificate rules as IMAP; the password is never sent over an unencrypted SMTP connection
    // unless the server config explicitly allows it (local testing).
    requireTLS: config.smtpRequireTLS ?? !config.smtpSecure,
    tls: {
      rejectUnauthorized: config.tls?.rejectUnauthorized ?? true,
      ...(config.tls?.servername ? { servername: config.tls.servername } : {})
    },
    connectionTimeout: 5000, // 5s connection timeout
    greetingTimeout: 5000,   // 5s greeting timeout
    socketTimeout: 10000     // 10s socket timeout
  });
}

export async function testSmtpConnection(config: AccountConfig): Promise<boolean> {
  const transport = createSmtpTransport(config);
  try {
    await transport.verify();
    return true;
  } catch (err) {
    throw new Error(`SMTP Connection Failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------
// Limits
// ---------------------------------------------------------------
const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/** Per-file and total attachment limit in bytes (AppConfig.maxMessageBytes, default 10 MB). */
export function getMaxMessageBytes(config: { maxMessageBytes?: number }): number {
  const n = config.maxMessageBytes;
  return n && Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_MESSAGE_BYTES;
}

function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.floor(bytes / 1024 / 1024)} MB` : `${Math.floor(bytes / 1024)} KB`;
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br/>\n');
}

function bracket(id: string): string {
  const t = id.trim();
  return t.startsWith('<') ? t : `<${t}>`;
}

/** An error whose message is safe to show to the user (no SMTP transcript). */
export class SendError extends Error {
  constructor(
    message: string,
    public status = 502
  ) {
    super(message);
    this.name = 'SendError';
  }
}

function toSendError(err: unknown): Error {
  if (err instanceof SendError) return err;
  const code = (err as { code?: string })?.code;
  console.warn('[SMTP] send failed:', code || '', (err as Error)?.message?.split('\n')[0]);
  switch (code) {
    case 'EAUTH':
      // Stored credentials were refused: end the session like an IMAP auth failure (route -> SESSION_EXPIRED).
      return new ImapAuthError();
    case 'EENVELOPE':
      return new SendError('The mail server rejected every recipient. Check the addresses.');
    case 'ECONNECTION':
    case 'ETIMEDOUT':
    case 'ESOCKET':
    case 'EDNS':
    case 'ECONNREFUSED':
      return new SendError('Could not reach the outgoing mail server.');
    default:
      return new SendError('The message could not be sent.');
  }
}

// ---------------------------------------------------------------
// Idempotency: remember results of recent send requests for 24 h
// ---------------------------------------------------------------
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const idempotencyStore = new Map<string, { at: number; promise: Promise<SendResult> }>();

function pruneIdempotency(now: number) {
  for (const [k, v] of idempotencyStore) {
    if (now - v.at > IDEMPOTENCY_TTL_MS) idempotencyStore.delete(k);
  }
}

const IDEMPOTENCY_MAX_PER_ACCOUNT = 500;
const IDEMPOTENCY_MAX_TOTAL = 50_000;

/** Evict oldest entries (Map keeps insertion order) beyond the per-account and overall caps. */
function enforceIdempotencyCaps(account: string) {
  const prefix = `${account}|`;
  let mine = 0;
  for (const k of idempotencyStore.keys()) if (k.startsWith(prefix)) mine++;
  for (const k of idempotencyStore.keys()) {
    if (mine <= IDEMPOTENCY_MAX_PER_ACCOUNT) break;
    if (k.startsWith(prefix)) {
      idempotencyStore.delete(k);
      mine--;
    }
  }
  for (const k of idempotencyStore.keys()) {
    if (idempotencyStore.size <= IDEMPOTENCY_MAX_TOTAL) break;
    idempotencyStore.delete(k);
  }
}

/** For tests. */
export function clearIdempotencyStore() {
  idempotencyStore.clear();
}

export async function sendLiveEmail(config: AccountConfig, payload: SendEmailPayload): Promise<SendResult> {
  const key = payload.idempotencyKey?.trim();
  if (!key) return doSend(config, payload);

  const now = Date.now();
  pruneIdempotency(now);
  const storeKey = `${config.email.toLowerCase()}|${key}`;
  const existing = idempotencyStore.get(storeKey);
  if (existing) return existing.promise;

  const promise = doSend(config, payload);
  idempotencyStore.set(storeKey, { at: now, promise });
  enforceIdempotencyCaps(config.email.toLowerCase());
  // A failed send stays retryable under the same key.
  promise.catch(() => {
    if (idempotencyStore.get(storeKey)?.promise === promise) idempotencyStore.delete(storeKey);
  });
  return promise;
}

async function doSend(config: AccountConfig, payload: SendEmailPayload): Promise<SendResult> {
  const max = getMaxMessageBytes(config);
  const attachments = [...(payload.attachments || [])];

  if (payload.forwardOf) {
    try {
      attachments.push(
        ...(await getLiveMessageAttachments(config, payload.forwardOf.folder, payload.forwardOf.uid, max))
      );
    } catch (err) {
      if (err instanceof MessageTooLargeError) {
        throw new SendError(
          `The original message is larger than the ${formatLimit(max)} limit, so it cannot be forwarded with its attachments.`,
          413
        );
      }
      throw new SendError('The original attachments could not be loaded, so nothing was sent.', 502);
    }
  }

  let total = 0;
  for (const a of attachments) {
    if (a.content.length > max) {
      throw new SendError(`"${a.filename}" is larger than the ${formatLimit(max)} limit.`, 413);
    }
    total += a.content.length;
  }
  if (total > max) {
    throw new SendError(`Attachments together are larger than the ${formatLimit(max)} limit.`, 413);
  }

  const domain = config.email.split('@')[1] || 'localhost';

  // Rich body: sanitise, turn images into inline (cid) parts, generate the text alternative.
  let rich: ReturnType<typeof prepareRichBody> | undefined;
  if (payload.html && payload.html.trim() !== '') {
    try {
      rich = prepareRichBody(payload.html, domain, { supplied: payload.inlineImages, maxTotal: max });
    } catch (err) {
      if (err instanceof RichBodyError) throw new SendError(err.message, err.status);
      throw err;
    }
    const inlineTotal = rich.inline.reduce((n, i) => n + i.content.length, 0);
    if (total + inlineTotal > max) {
      throw new SendError(`Attachments and pictures together are larger than the ${formatLimit(max)} limit.`, 413);
    }
  }

  const messageId = `<${randomUUID()}@${domain}>`;

  const mailOptions: nodemailer.SendMailOptions = {
    // Always the signed-in account, never a value from the request.
    from: { name: config.name || '', address: config.email },
    to: payload.to,
    cc: payload.cc && payload.cc.length > 0 ? payload.cc : undefined,
    bcc: payload.bcc && payload.bcc.length > 0 ? payload.bcc : undefined,
    subject: payload.subject,
    messageId,
    date: new Date(),
    inReplyTo: payload.inReplyTo ? bracket(payload.inReplyTo) : undefined,
    references:
      payload.references && payload.references.length > 0 ? payload.references.map(bracket) : undefined,
    attachments: attachments.map((att) => ({
      filename: att.filename,
      content: att.content,
      contentType: att.contentType
    }))
  };
  if (rich) {
    mailOptions.html = rich.html;
    mailOptions.text = rich.text;
    mailOptions.attachments = [
      ...(mailOptions.attachments as nodemailer.SendMailOptions['attachments'] & unknown[]),
      ...rich.inline.map((i) => ({
        filename: i.filename,
        content: i.content,
        contentType: i.contentType,
        cid: i.cid,
        contentDisposition: 'inline' as const
      }))
    ];
  } else if (payload.text !== undefined) {
    mailOptions.text = payload.text;
    mailOptions.html = textToHtml(payload.text);
  } else {
    mailOptions.html = payload.html || '';
  }

  const transport = createSmtpTransport(config);
  let info: { accepted: unknown[]; rejected: unknown[] };
  try {
    info = await transport.sendMail(mailOptions);
  } catch (err) {
    throw toSendError(err);
  } finally {
    transport.close();
  }

  const addr = (x: unknown) => (typeof x === 'string' ? x : (x as { address?: string })?.address || '');
  const accepted = info.accepted.map(addr);
  const rejected = info.rejected.map(addr);
  if (accepted.length === 0) {
    throw new SendError('The mail server rejected every recipient. Check the addresses.');
  }

  const result: SendResult = { messageId, accepted, rejected, sentCopySaved: false };

  // Save a copy (same Message-ID, Bcc kept) in the Sent folder.
  try {
    const imapClient = await getPooledImapClient(config);
    const sentNames = ['Sent', 'Sent Items', 'INBOX.Sent', 'Sent Messages'];
    const list = await imapClient.list();
    let targetPath = list.find((mb) => mb.specialUse === '\\Sent')?.path;
    targetPath ||= list.find((mb) => sentNames.includes(mb.name))?.path;
    if (!targetPath) {
      await imapClient.mailboxCreate('Sent');
      targetPath = 'Sent';
    }
    const MailComposer = (await import('nodemailer/lib/mail-composer/index.js')).default;
    const node = new MailComposer(mailOptions).compile();
    node.keepBcc = true;
    const raw = await node.build();
    const appended = await imapClient.append(targetPath, raw, ['\\Seen']);
    if (!appended) throw new Error('append returned no result');
    result.sentCopySaved = true;
  } catch (appendErr) {
    console.warn('[SMTP] Could not save Sent copy:', (appendErr as Error).message);
    result.sentCopyError = 'The message was sent, but a copy could not be saved to the Sent folder.';
  }

  return result;
}
