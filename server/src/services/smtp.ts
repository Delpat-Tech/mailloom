import nodemailer from 'nodemailer';
import type { AccountConfig, SendEmailPayload } from '../types.js';
import { getPooledImapClient } from './imap.js';

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
    tls: {
      rejectUnauthorized: false
    }
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

export async function sendLiveEmail(config: AccountConfig, payload: SendEmailPayload) {
  const transport = createSmtpTransport(config);
  const fromName = config.name ? `"${config.name}"` : '';
  const from = fromName ? `${fromName} <${config.email}>` : config.email;

  const mailOptions: nodemailer.SendMailOptions = {
    from,
    to: payload.to.join(', '),
    cc: payload.cc && payload.cc.length > 0 ? payload.cc.join(', ') : undefined,
    bcc: payload.bcc && payload.bcc.length > 0 ? payload.bcc.join(', ') : undefined,
    subject: payload.subject,
    text: payload.text,
    html: payload.html || payload.text,
    attachments: (payload.attachments || []).map((att) => ({
      filename: att.filename,
      content: Buffer.from(att.content, 'base64'),
      contentType: att.contentType
    }))
  };

  const result = await transport.sendMail(mailOptions);

  // Attempt to append to IMAP Sent folder using pooled connection
  try {
    const imapClient = await getPooledImapClient(config);
    const sentMailboxes = ['Sent', 'Sent Items', 'INBOX.Sent', 'Sent Messages'];
    let targetPath = 'Sent';
    const list = await imapClient.list();
    for (const mb of list) {
      if (mb.specialUse === '\\Sent' || sentMailboxes.includes(mb.name)) {
        targetPath = mb.path;
        break;
      }
    }

    // Generate raw message to append
    const MailComposer = (await import('nodemailer/lib/mail-composer/index.js')).default;
    const composer = new MailComposer(mailOptions);
    const rawBuffer = await composer.compile().build();
    await imapClient.append(targetPath, rawBuffer, ['\\Seen']);
  } catch (appendErr) {
    console.warn('[SMTP] Could not append to IMAP Sent folder:', (appendErr as Error).message);
  }

  return result;
}
