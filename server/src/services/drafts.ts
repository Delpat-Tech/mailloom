import { randomUUID } from 'node:crypto';
import type { AccountConfig } from '../types.js';
import { getPooledImapClient, findFolderPath } from './imap.js';

export interface DraftInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface SavedDraft {
  uid: number;
  folder: string;
}

const bracket = (id: string) => (id.startsWith('<') ? id : `<${id}>`);

async function draftsPath(config: AccountConfig, create: boolean): Promise<string | undefined> {
  const client = await getPooledImapClient(config);
  let path = await findFolderPath(client, 'Drafts');
  if (!path && create) {
    await client.mailboxCreate('Drafts');
    path = 'Drafts';
  }
  return path;
}

/**
 * Save a draft in the Drafts folder (APPEND with \Draft). When `replaceUid` is given, the old
 * version is removed only after the new one is safely stored, so a failure never loses a draft.
 * Throws when the draft could not be stored.
 */
export async function saveLiveDraft(
  config: AccountConfig,
  input: DraftInput,
  replaceUid?: number
): Promise<SavedDraft> {
  const client = await getPooledImapClient(config);
  const folder = (await draftsPath(config, true))!;

  const MailComposer = (await import('nodemailer/lib/mail-composer/index.js')).default;
  const domain = config.email.split('@')[1] || 'mailloom.local';
  const messageId = `<${randomUUID()}@${domain}>`;
  const node = new MailComposer({
    from: { name: config.name || '', address: config.email },
    to: input.to?.length ? input.to : undefined,
    cc: input.cc?.length ? input.cc : undefined,
    bcc: input.bcc?.length ? input.bcc : undefined,
    subject: input.subject || '',
    text: input.text ?? '',
    messageId,
    date: new Date(),
    inReplyTo: input.inReplyTo ? bracket(input.inReplyTo) : undefined,
    references: input.references?.length ? input.references.map(bracket) : undefined
  }).compile();
  node.keepBcc = true;
  const raw = await node.build();

  const appended = await client.append(folder, raw, ['\\Draft', '\\Seen']);
  if (!appended) throw new Error('The draft could not be saved to the Drafts folder.');

  let uid = appended.uid;
  if (!uid) {
    // Server without UIDPLUS: find it by the Message-ID we just made.
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const found = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      uid = found && found.length ? Math.max(...found) : undefined;
    } finally {
      lock.release();
    }
  }
  if (!uid) throw new Error('The draft was saved but could not be located.');

  if (replaceUid && replaceUid !== uid) {
    try {
      await deleteLiveDraft(config, replaceUid);
    } catch {
      // The new version is stored; an old copy left behind is the safe failure.
    }
  }
  return { uid, folder };
}

/** Remove a draft for good (it is replaced or sent, not "deleted" by the user). */
export async function deleteLiveDraft(config: AccountConfig, uid: number): Promise<boolean> {
  const client = await getPooledImapClient(config);
  const folder = await draftsPath(config, false);
  if (!folder) return false;
  const lock = await client.getMailboxLock(folder);
  try {
    const found = await client.search({ uid: String(uid) }, { uid: true });
    if (!found || found.length === 0) return false;
    return await client.messageDelete(String(uid), { uid: true });
  } finally {
    lock.release();
  }
}
