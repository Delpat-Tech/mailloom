import type { ImapFlow } from 'imapflow';
import { detectSpecialUse } from './imap.js';

export const SNOOZED_FOLDER = 'Snoozed';

export interface Folders {
  inbox: string;
  sent?: string;
  archive?: string;
  snoozed?: string;
  /** Selectable folders other than Trash, Junk and Snoozed. */
  viewable: string[];
  all: string[];
}

export async function resolveFolders(client: ImapFlow): Promise<Folders> {
  const list = await client.list();
  const selectable = list.filter((m) => !(m.flags?.has('\\Noselect') || m.flags?.has('\\NonExistent')));
  const kindOf = (m: (typeof list)[number]) => detectSpecialUse(m.name, m.specialUse, m.path);
  const byKind = (kind: string) =>
    (selectable.find((m) => m.specialUse && kindOf(m) === kind) || selectable.find((m) => kindOf(m) === kind))?.path;
  const snoozed = selectable.find((m) => m.path === SNOOZED_FOLDER || m.name.toLowerCase() === 'snoozed')?.path;
  const inbox = byKind('Inbox') || 'INBOX';
  return {
    inbox,
    sent: byKind('Sent'),
    archive: byKind('Archive'),
    snoozed,
    viewable: selectable.filter((m) => m.path !== snoozed && kindOf(m) !== 'Trash' && kindOf(m) !== 'Junk').map((m) => m.path),
    all: selectable.map((m) => m.path)
  };
}

/** The folders a conversation spans (and threadCount counts): Inbox, Sent, Archive. */
export function conversationFolders(f: Folders): string[] {
  return [f.inbox, f.sent, f.archive].filter((x): x is string => Boolean(x));
}
