import crypto from 'node:crypto';
import type nodemailer from 'nodemailer';
import type { AccountConfig } from '../types.js';
import { createSmtpTransport } from '../services/smtp.js';
import { getPooledImapClient } from '../services/imap.js';

/**
 * The agent API's single way to send mail.
 *
 * MERGE NOTE: this is built on main's smtp.ts (createSmtpTransport) because the send logic on
 * builder-b (idempotency, threading headers, honest results) is not on main yet. After that
 * merge, this function can call builder-b's send function instead, as long as it still:
 *   - uses the Message-ID given here (so the idempotent result and the Sent copy match),
 *   - adds the extra headers (X-Mailloom-Agent),
 *   - reports accepted/rejected recipients and whether the Sent copy was saved.
 * Idempotency and rate limits for the agent API live in routes/agent.ts, not here.
 */

export interface OutgoingMail {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string; cid?: string }>;
  headers: Record<string, string>;
}

export interface AgentSendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  savedToSent: boolean;
  sentFolder: string | null;
}

/** The SMTP server refused every recipient: nothing was sent. */
export class AllRecipientsRejectedError extends Error {
  constructor(public rejected: string[]) {
    super('All recipients were rejected');
    this.name = 'AllRecipientsRejectedError';
  }
}

export function isSmtpAuthError(err: unknown): boolean {
  const e = err as { code?: string; responseCode?: number } | null;
  return !!e && (e.code === 'EAUTH' || e.responseCode === 535);
}

export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1) || 'mailloom.local';
  return `<${crypto.randomBytes(16).toString('hex')}@${domain}>`;
}

function addressList(list: Array<string | { address?: string }> | undefined): string[] {
  return (list || []).map((a) => (typeof a === 'string' ? a : a.address || '')).filter(Boolean);
}

async function saveToSent(account: AccountConfig, raw: Buffer): Promise<{ saved: boolean; folder: string | null }> {
  try {
    const client = await getPooledImapClient(account);
    const list = await client.list();
    let target = list.find((mb) => mb.specialUse === '\\Sent')?.path;
    if (!target) {
      const names = ['sent', 'sent items', 'sent messages', 'inbox.sent'];
      target = list.find((mb) => names.includes(mb.path.toLowerCase()) || names.includes(mb.name.toLowerCase()))?.path;
    }
    if (!target) {
      target = 'Sent';
      await client.mailboxCreate(target);
    }
    const res = await client.append(target, raw, ['\\Seen']);
    return { saved: res !== false, folder: target };
  } catch {
    return { saved: false, folder: null };
  }
}

export async function sendForAgent(account: AccountConfig, mail: OutgoingMail, messageId?: string): Promise<AgentSendResult> {
  const id = messageId ?? newMessageId(account.email);
  const from = account.name ? { name: account.name, address: account.email } : account.email;
  const options: nodemailer.SendMailOptions = {
    from,
    to: mail.to,
    cc: mail.cc.length ? mail.cc : undefined,
    bcc: mail.bcc.length ? mail.bcc : undefined,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    messageId: id,
    date: new Date(),
    inReplyTo: mail.inReplyTo,
    references: mail.references && mail.references.length ? mail.references : undefined,
    headers: mail.headers,
    attachments: (mail.attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
      ...(a.cid ? { cid: a.cid } : {})
    })),
    disableFileAccess: true,
    disableUrlAccess: true
  };

  const transport = createSmtpTransport(account);
  let info: { accepted?: Array<string | { address?: string }>; rejected?: Array<string | { address?: string }> };
  try {
    info = await transport.sendMail(options);
  } catch (err) {
    const e = err as { code?: string; rejected?: string[] };
    if (e.code === 'EENVELOPE' && Array.isArray(e.rejected) && e.rejected.length) {
      throw new AllRecipientsRejectedError(e.rejected);
    }
    throw err;
  } finally {
    transport.close();
  }

  // The Sent copy is the same message (same Message-ID and headers), with Bcc kept for the sender's record.
  const MailComposer = (await import('nodemailer/lib/mail-composer/index.js')).default;
  const node = new MailComposer(options).compile();
  (node as unknown as { keepBcc: boolean }).keepBcc = true;
  const raw = await node.build();
  const sent = await saveToSent(account, raw);

  return {
    messageId: id,
    accepted: addressList(info.accepted),
    rejected: addressList(info.rejected),
    savedToSent: sent.saved,
    sentFolder: sent.folder
  };
}
