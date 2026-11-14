import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { AccountConfig } from '../../src/types.js';

export const GM = {
  host: process.env.GM_HOST || '127.0.0.1',
  imapsPort: Number(process.env.GM_IMAPS_PORT || 2993),
  smtpPort: Number(process.env.GM_SMTP_PORT || 2587),
  password: process.env.GM_PASSWORD || 'testpass123',
  tester: 'tester@delpat.test',
  colleague: 'colleague@delpat.test'
};

export function accountFor(email: string, name = 'Test User'): AccountConfig {
  return {
    email,
    name,
    imapHost: GM.host,
    imapPort: GM.imapsPort,
    imapSecure: true,
    imapUser: email,
    imapPass: GM.password,
    smtpHost: GM.host,
    smtpPort: GM.smtpPort,
    smtpSecure: false,
    smtpUser: email,
    smtpPass: GM.password
  };
}

export async function withImap<T>(email: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({
    host: GM.host,
    port: GM.imapsPort,
    secure: true,
    auth: { user: email, pass: GM.password },
    logger: false,
    tls: { rejectUnauthorized: false }
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout().catch(() => {});
  }
}

/** Create Sent, Drafts, Trash, Junk if missing, and empty every folder. */
export async function resetAccount(email: string): Promise<void> {
  await withImap(email, async (c) => {
    for (const name of ['Sent', 'Drafts', 'Trash', 'Junk']) {
      await c.mailboxCreate(name).catch(() => {});
    }
    for (const mb of await c.list()) {
      if (mb.flags?.has('\Noselect')) continue;
      const lock = await c.getMailboxLock(mb.path);
      try {
        await c.messageDelete('1:*').catch(() => {});
      } finally {
        lock.release();
      }
    }
  });
}

export async function seedMail(opts: {
  from: string;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  text?: string;
  messageId?: string;
  references?: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
}): Promise<void> {
  const t = nodemailer.createTransport({
    host: GM.host,
    port: GM.smtpPort,
    secure: false,
    auth: { user: opts.from, pass: GM.password },
    tls: { rejectUnauthorized: false }
  });
  await t.sendMail({
    from: opts.from,
    to: opts.to,
    cc: opts.cc,
    replyTo: opts.replyTo,
    subject: opts.subject,
    text: opts.text ?? 'seed',
    messageId: opts.messageId,
    references: opts.references,
    attachments: opts.attachments
  });
  t.close();
}

export async function fetchAll(email: string, folder: string): Promise<Array<{ uid: number; mail: ParsedMail; raw: string }>> {
  return withImap(email, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const out: Array<{ uid: number; mail: ParsedMail; raw: string }> = [];
      const exists = typeof c.mailbox === 'object' ? c.mailbox.exists : 0;
      if (exists > 0) {
        for await (const m of c.fetch('1:*', { uid: true, source: true })) {
          out.push({ uid: m.uid, mail: await simpleParser(m.source as Buffer), raw: (m.source as Buffer).toString('utf8') });
        }
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

/** Wait until the folder holds at least n messages (GreenMail delivers asynchronously). */
export async function waitForMail(email: string, folder: string, n = 1, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const all = await fetchAll(email, folder);
    if (all.length >= n || Date.now() > end) return all;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Store a raw RFC 822 message directly in a folder (no SMTP); returns its UID. */
export async function appendRaw(email: string, folder: string, raw: string | Buffer, flags: string[] = []): Promise<number> {
  return withImap(email, async (c) => {
    const r = await c.append(folder, raw, flags);
    if (!r || !r.uid) throw new Error('append failed or gave no uid');
    return r.uid;
  });
}

/** Build a MIME message with nodemailer's composer (attachments, inline cids, alternatives). */
export async function buildMime(opts: Record<string, unknown>): Promise<Buffer> {
  const MailComposer = (await import('nodemailer/lib/mail-composer/index.js')).default;
  return (await new MailComposer({ from: 'colleague@delpat.test', to: 'tester@delpat.test', ...opts } as never).compile().build()) as Buffer;
}
