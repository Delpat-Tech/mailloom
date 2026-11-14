import type { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../types.js';
import { findFolderPath, getFolderKind, getPooledImapClient } from './imap.js';

/**
 * Batch actions on many messages of one folder. Each action is one IMAP command on one UID set
 * (STORE for flags, MOVE for moves, STORE+EXPUNGE for permanent deletes), not a command per
 * message. `all` selects the whole folder with the set "1:*".
 */

export const BATCH_ACTIONS = ['read', 'unread', 'flag', 'unflag', 'move', 'delete', 'archive', 'spam'] as const;
export type BatchAction = (typeof BATCH_ACTIONS)[number];
export const MAX_BATCH_UIDS = 5000;

export type BatchSelection = { uids: number[] } | { all: true };

export interface BatchResult {
  /** How many messages the action applied to. */
  affected: number;
  /** Where moved messages went (move, delete into Trash, archive, spam). */
  movedTo?: string;
  /** true when messages were deleted for good (delete inside Trash). */
  permanent?: boolean;
}

export class BatchError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'BatchError';
  }
}

/** [1,2,3,5,6,9] becomes "1:3,5:6,9": short commands for big selections. */
export function uidSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}:${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(',');
}

async function ensureFolder(client: ImapFlow, kind: 'Trash' | 'Junk' | 'Archive'): Promise<string> {
  const found = await findFolderPath(client, kind);
  if (found) return found;
  await client.mailboxCreate(kind);
  return kind;
}

async function moveSet(client: ImapFlow, set: string, count: number, target: string): Promise<void> {
  const res = await client.messageMove(set, target, { uid: true });
  if (!res || (res.uidMap && res.uidMap.size < count)) {
    throw new Error(`Only some of the messages could be moved to "${target}".`);
  }
}

export async function runBatch(
  config: AccountConfig,
  folderPath: string,
  action: BatchAction,
  selection: BatchSelection,
  options: { targetFolder?: string; junkFolder?: string } = {}
): Promise<BatchResult> {
  const client = await getPooledImapClient(config);
  const kind = await getFolderKind(client, folderPath);

  // Resolve destinations before locking the source (they may create a folder).
  let target: string | undefined;
  if (action === 'move') {
    target = options.targetFolder;
    if (!target) throw new BatchError(400, 'INVALID_INPUT', 'Give a targetFolder.');
    if (target === folderPath) throw new BatchError(400, 'INVALID_INPUT', 'The messages are already in that folder.');
  } else if (action === 'archive') {
    if (kind === 'Archive') throw new BatchError(400, 'INVALID_INPUT', 'The messages are already in Archive.');
    target = await ensureFolder(client, 'Archive');
  } else if (action === 'spam') {
    target = options.junkFolder || (await ensureFolder(client, 'Junk'));
    if (target === folderPath) throw new BatchError(400, 'INVALID_INPUT', 'The messages are already in Junk.');
  } else if (action === 'delete' && kind !== 'Trash') {
    target = await ensureFolder(client, 'Trash');
  }

  const lock = await client.getMailboxLock(folderPath);
  try {
    const query = 'all' in selection ? { all: true } : { uid: uidSet(selection.uids) };
    const present = ((await client.search(query, { uid: true })) || []) as number[];
    if (present.length === 0) {
      if ('all' in selection) return { affected: 0 };
      throw new BatchError(404, 'MESSAGE_NOT_FOUND', 'The messages were not found. They may have been moved or deleted.');
    }
    // One UID set for everything that exists (a message gone since the list was drawn is skipped).
    const set = 'all' in selection ? '1:*' : uidSet(present);
    const affected = present.length;

    switch (action) {
      case 'read':
      case 'unread':
      case 'flag':
      case 'unflag': {
        const flag = action === 'read' || action === 'unread' ? '\\Seen' : '\\Flagged';
        const ok =
          action === 'read' || action === 'flag'
            ? await client.messageFlagsAdd(set, [flag], { uid: true })
            : await client.messageFlagsRemove(set, [flag], { uid: true });
        if (!ok) throw new Error('The flag could not be changed.');
        return { affected };
      }
      case 'spam':
        if (!(await client.messageFlagsAdd(set, ['\\Seen'], { uid: true }))) throw new Error('The messages could not be marked read.');
        await moveSet(client, set, affected, target!);
        return { affected, movedTo: target };
      case 'move':
      case 'archive':
        await moveSet(client, set, affected, target!);
        return { affected, movedTo: target };
      case 'delete':
        if (kind === 'Trash') {
          if (!(await client.messageDelete(set, { uid: true }))) throw new Error('The messages could not be deleted.');
          const left = ((await client.search({ uid: set }, { uid: true })) || []) as number[];
          if (left.length > 0) throw new Error(`Only ${affected - left.length} of ${affected} messages could be deleted.`);
          return { affected, permanent: true };
        }
        await moveSet(client, set, affected, target!);
        return { affected, movedTo: target, permanent: false };
    }
  } finally {
    lock.release();
  }
}

/** Marks every unread message of the folder as read with one STORE. Returns how many were unread. */
export async function markAllRead(config: AccountConfig, folderPath: string): Promise<number> {
  const client = await getPooledImapClient(config);
  const lock = await client.getMailboxLock(folderPath);
  try {
    const unseen = ((await client.search({ seen: false }, { uid: true })) || []) as number[];
    if (unseen.length === 0) return 0;
    if (!(await client.messageFlagsAdd('1:*', ['\\Seen'], { uid: true }))) throw new Error('The messages could not be marked read.');
    return unseen.length;
  } finally {
    lock.release();
  }
}
