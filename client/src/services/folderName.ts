import { folderTitle } from './time.js';
import type { MailboxFolder } from '../types.js';

/** What a folder is called on screen: "Inbox" not "INBOX", and Junk is "Spam". */
export function folderLabel(f: Pick<MailboxFolder, 'name' | 'specialUse'>): string {
  if (f.specialUse === 'Junk') return 'Spam';
  return folderTitle(f.name);
}
