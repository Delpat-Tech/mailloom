import crypto from 'node:crypto';
import type { SendMailOptions } from 'nodemailer';
import type { AccountConfig } from '../types.js';
import { createSmtpTransport } from '../services/smtp.js';
import { getPooledImapClient } from '../services/imap.js';

/**
 * The agent API's single way to send mail.
 *
 * It mirrors sendLiveEmail in services/smtp.ts (same Message-ID in the delivered and Sent copies, Bcc
 * kept out of delivered mail and only in the Sent copy) but takes {name,address} recipients, an
 * explicit Message-ID, extra headers (X-Mailloom-Agent) and reports accepted/rejected and Sent-copy status.
 * Idempotency and rate limits for the agent API live in routes/agent.ts, not here.
 */

/** One recipient. Always passed to nodemailer as an object, so a display name can never add recipients. */
export interface MailAddress {
  name: string;
  address: string;
}

export interface OutgoingMail {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
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

/** Tests replace the transport here to simulate server failures; never set in production. */
export const sendHooks: { createTransport?: typeof createSmtpTransport } = {};

/**
 * True only when the error proves no message data reached the server (connection, TLS, sign-in,
 * envelope or recipient stage). Anything else, such as a drop during or after DATA, may mean the
 * mail was delivered, so the caller must not send it again.
 */
export function failedBeforeData(err: unknown): boolean {
  const e = err as { code?: string; command?: string } | null;
  if (!e) return false;
  if (e.code === 'EENVELOPE' || e.code === 'EAUTH' || e.code === 'EDNS' || e.code === 'ETLS') return true;
  return typeof e.command === 'string' && /^(CONN|EHLO|HELO|STARTTLS|AUTH.*|MAIL FROM|RCPT TO)$/i.test(e.command);
}

export function isSmtpAuthError(err: unknown): boolean {
  const e = err as { code?: string; responseCode?: number } | null;
  // A 4xx answer (for example 454 temporary authentication failure) is not a refused password.
  return !!e && (e.responseCode === 535 || (e.code === 'EAUTH' && !(e.responseCode !== undefined && e.responseCode < 500)));
}

export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1) || 'mailloom.local';
  return `<${crypto.randomBytes(16).toString('hex')}@${domain}>`;
}

function addressList(list: Array<string | { address?: string }> | undefined): string[] {
  return (list || []).map((a) => (typeof a === 'string' ? a : a.address || '')).filter(Boolean);
}

function asObject(a: MailAddress): { name: string; address: string } {
  return { name: a.name, address: a.address };
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
  const options: SendMailOptions = {
    from,
    to: mail.to.map(asObject),
    cc: mail.cc.length ? mail.cc.map(asObject) : undefined,
    bcc: mail.bcc.length ? mail.bcc.map(asObject) : undefined,
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

  const transport = (sendHooks.createTransport ?? createSmtpTransport)(account);
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
  // The mail is already sent here: nothing below may throw.
  let sent: { saved: boolean; folder: string | null } = { saved: false, folder: null };
  try {
    const MailComposer = (await import('nodemailer/lib/mail-composer')).default;
    const node = new MailComposer(options).compile();
    (node as unknown as { keepBcc: boolean }).keepBcc = true;
    const raw = await node.build();
    sent = await saveToSent(account, raw);
  } catch {
    // reported as savedToSent: false
  }

  return {
    messageId: id,
    accepted: addressList(info.accepted),
    rejected: addressList(info.rejected),
    savedToSent: sent.saved,
    sentFolder: sent.folder
  };
}
