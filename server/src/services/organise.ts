import type { ImapFlow, SearchObject } from 'imapflow';
import type { AccountConfig, MessageHeader } from '../types.js';
import { fetchListItems, getPooledImapClient, isImapAuthError, LABEL_KEYWORD_PREFIX, detectSpecialUse } from './imap.js';
import type { OrganiseStore } from './organise-store.js';
import { baseSubject, normaliseMsgId, referencesFromHeaderBlock, threadIdFor } from './threading.js';

/**
 * Labels, starred and label views across folders, snooze and conversations: the IMAP side.
 * Every function works on the mailbox of the AccountConfig it is given and keys its sqlite rows
 * by that mailbox's address, so nothing crosses between accounts.
 */

export class OrganiseError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'OrganiseError';
  }
}

export const SNOOZED_FOLDER = 'Snoozed';
export const LABELS_UNSUPPORTED =
  'This mail server cannot store labels on messages (it does not allow custom keywords), so labels are not available.';

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
    viewable: selectable
      .filter((m) => m.path !== snoozed && kindOf(m) !== 'Trash' && kindOf(m) !== 'Junk')
      .map((m) => m.path),
    all: selectable.map((m) => m.path)
  };
}

/** The folders a conversation spans (and threadCount counts): Inbox, Sent, Archive. */
export function conversationFolders(f: Folders): string[] {
  return [f.inbox, f.sent, f.archive].filter((x): x is string => Boolean(x));
}

// -------------------------------------------------------------
// CONVERSATION INDEX (sqlite, updated incrementally by UID)
// -------------------------------------------------------------
const syncing = new Map<string, Promise<void>>();

async function syncFolder(client: ImapFlow, store: OrganiseStore, email: string, folder: string): Promise<void> {
  const st = await client.status(folder, { uidNext: true, uidValidity: true, messages: true });
  const uidValidity = String(st.uidValidity ?? '');
  let state = store.syncState(email, folder);
  if (!state || state.uidValidity !== uidValidity) {
    store.resetFolder(email, folder, uidValidity);
    state = { uidValidity, lastUid: 0 };
  }
  const messages = Number(st.messages ?? 0);
  const uidNext = Number(st.uidNext ?? 0);
  const hasNew = messages > 0 && (uidNext === 0 || uidNext - 1 > state.lastUid);
  const indexedCount = store.indexedUids(email, folder).length;
  if (!hasNew && indexedCount <= messages) return;

  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    if (hasNew) {
      const rows: Array<{ uid: number; threadId: string }> = [];
      let maxUid = state.lastUid;
      const where = `${folder}:${uidValidity}`;
      for await (const msg of client.fetch(`${state.lastUid + 1}:*`, { uid: true, envelope: true, headers: ['references'] }, { uid: true })) {
        if (msg.uid <= state.lastUid) continue;
        rows.push({
          uid: msg.uid,
          threadId: threadIdFor({
            messageId: msg.envelope?.messageId,
            inReplyTo: msg.envelope?.inReplyTo,
            references: referencesFromHeaderBlock(msg.headers),
            fallbackKey: `${where}:${msg.uid}`
          })
        });
        maxUid = Math.max(maxUid, msg.uid);
      }
      store.addToIndex(email, folder, rows, Math.max(maxUid, uidNext > 0 ? uidNext - 1 : 0));
    }
    // Mail moved or deleted since: drop index rows whose UID is gone (one UID SEARCH, no fetch).
    const indexed = store.indexedUids(email, folder);
    if (indexed.length > messages) {
      const present = new Set(((await client.search({ all: true }, { uid: true })) || []) as number[]);
      store.removeFromIndex(email, folder, indexed.filter((u) => !present.has(u)));
    }
  } finally {
    lock.release();
  }
}

/** Brings the index of the given folders up to date. Concurrent calls for one mailbox share the work. */
export async function syncThreadIndex(store: OrganiseStore, config: AccountConfig, folders: string[]): Promise<void> {
  const key = `${config.email.toLowerCase()}|${folders.join('\u0000')}`;
  const running = syncing.get(key);
  if (running) return running;
  const p = (async () => {
    const client = await getPooledImapClient(config);
    for (const f of folders) await syncFolder(client, store, config.email, f);
  })().finally(() => syncing.delete(key));
  syncing.set(key, p);
  return p;
}

/**
 * Finishes list items for the browser: labels limited to this mailbox's label ids, threadCount from the
 * index (at least 1), and defaults for anything missing (demo mail).
 */
export function finishItems(store: OrganiseStore, email: string, items: MessageHeader[], counted: string[]): MessageHeader[] {
  const known = new Set(store.labels(email).map((l) => l.id));
  for (const it of items) {
    it.labels = (it.labels || []).filter((id) => known.has(id));
    it.threadId ||= threadIdFor({ messageId: it.id, fallbackKey: `${it.mailbox || ''}:${it.uid}` });
    it.hasAttachments = Boolean(it.hasAttachments);
  }
  const counts = store.threadCounts(email, counted, items.map((i) => i.threadId!));
  for (const it of items) it.threadCount = Math.max(1, counts.get(it.threadId!) || 0);
  return items;
}

/** Sync the conversation folders and finish the items; a failing sync never fails the list. */
export async function enrichList(
  store: OrganiseStore,
  config: AccountConfig,
  items: MessageHeader[],
  log?: { warn: (o: object, m: string) => void }
): Promise<MessageHeader[]> {
  let counted: string[] = [];
  if (!config.isDemo) {
    try {
      const client = await getPooledImapClient(config);
      counted = conversationFolders(await resolveFolders(client));
      await syncThreadIndex(store, config, counted);
    } catch (err) {
      if (isImapAuthError(err)) throw err;
      log?.warn({ errCode: (err as { code?: string })?.code, errName: (err as Error)?.name }, 'Conversation index not updated');
    }
  }
  return finishItems(store, config.email, items, counted);
}

// -------------------------------------------------------------
// VIEWS ACROSS FOLDERS (starred, one label)
// -------------------------------------------------------------
export async function crossFolderView(
  config: AccountConfig,
  criteria: SearchObject,
  folders: string[],
  page: number,
  limit: number
): Promise<{ messages: MessageHeader[]; total: number }> {
  const client = await getPooledImapClient(config);
  const hits: Array<{ folder: string; uid: number; date: number }> = [];
  for (const folder of folders) {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const uids = ((await client.search(criteria, { uid: true })) || []) as number[];
      if (uids.length === 0) continue;
      for await (const m of client.fetch(uids, { uid: true, internalDate: true }, { uid: true })) {
        hits.push({ folder, uid: m.uid, date: new Date(m.internalDate || 0).getTime() });
      }
    } finally {
      lock.release();
    }
  }
  hits.sort((a, b) => b.date - a.date || b.uid - a.uid);
  const pageHits = hits.slice((page - 1) * limit, (page - 1) * limit + limit);
  const out = new Map<string, MessageHeader>();
  const byFolder = new Map<string, number[]>();
  for (const h of pageHits) byFolder.set(h.folder, [...(byFolder.get(h.folder) || []), h.uid]);
  for (const [folder, uids] of byFolder) {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      for (const item of await fetchListItems(client, uids, config.email)) {
        item.mailbox = folder;
        out.set(`${folder}\u0000${item.uid}`, item);
      }
    } finally {
      lock.release();
    }
  }
  return {
    messages: pageHits.map((h) => out.get(`${h.folder}\u0000${h.uid}`)).filter((x): x is MessageHeader => Boolean(x)),
    total: hits.length
  };
}

// -------------------------------------------------------------
// LABELS (IMAP keywords)
// -------------------------------------------------------------
export const keywordFor = (id: string) => `${LABEL_KEYWORD_PREFIX}${id}`;

/** The folder the caller has locked read-write accepts custom keywords (PERMANENTFLAGS has \*). */
function keywordsAllowed(client: ImapFlow): boolean {
  const flags = client.mailbox ? client.mailbox.permanentFlags : undefined;
  return Boolean(flags && flags.has('\\*'));
}

export async function assertKeywordsSupported(config: AccountConfig): Promise<void> {
  const client = await getPooledImapClient(config);
  const folders = await resolveFolders(client);
  const lock = await client.getMailboxLock(folders.inbox);
  try {
    if (!keywordsAllowed(client)) throw new OrganiseError(501, 'LABELS_UNSUPPORTED', LABELS_UNSUPPORTED);
  } finally {
    lock.release();
  }
}

export async function changeLabels(config: AccountConfig, mailbox: string, uids: number[], add: string[], remove: string[]): Promise<void> {
  const client = await getPooledImapClient(config);
  const lock = await client.getMailboxLock(mailbox);
  try {
    if (!keywordsAllowed(client)) throw new OrganiseError(501, 'LABELS_UNSUPPORTED', LABELS_UNSUPPORTED);
    const found = ((await client.search({ uid: uids.join(',') }, { uid: true })) || []) as number[];
    if (found.length === 0) throw new OrganiseError(404, 'MESSAGE_NOT_FOUND', 'The messages were not found. They may have been moved or deleted.');
    if (add.length > 0 && !(await client.messageFlagsAdd(found, add.map(keywordFor), { uid: true }))) {
      throw new Error('Labels could not be added.');
    }
    if (remove.length > 0 && !(await client.messageFlagsRemove(found, remove.map(keywordFor), { uid: true }))) {
      throw new Error('Labels could not be removed.');
    }
  } finally {
    lock.release();
  }
}

/** Unread messages in the Inbox carrying each label. */
export async function unreadPerLabel(config: AccountConfig, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const client = await getPooledImapClient(config);
  const folders = await resolveFolders(client);
  const lock = await client.getMailboxLock(folders.inbox, { readOnly: true });
  try {
    for (const id of ids) {
      const uids = ((await client.search({ seen: false, keyword: keywordFor(id) }, { uid: true })) || []) as number[];
      out.set(id, uids.length);
    }
  } finally {
    lock.release();
  }
  return out;
}

/** Removes a label's keyword from every message. Inbox and Archive must succeed; other folders are best effort. */
export async function stripLabelEverywhere(config: AccountConfig, id: string): Promise<void> {
  const client = await getPooledImapClient(config);
  const folders = await resolveFolders(client);
  const required = new Set([folders.inbox, folders.archive].filter(Boolean));
  for (const folder of folders.all) {
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = ((await client.search({ keyword: keywordFor(id) }, { uid: true })) || []) as number[];
        if (uids.length > 0 && !(await client.messageFlagsRemove(uids, [keywordFor(id)], { uid: true }))) {
          throw new Error('Label could not be removed from messages.');
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      if (required.has(folder) || isImapAuthError(err)) throw err;
    }
  }
}

// -------------------------------------------------------------
// SNOOZE
// -------------------------------------------------------------
async function ensureSnoozedFolder(client: ImapFlow): Promise<string> {
  const f = await resolveFolders(client);
  if (f.snoozed) return f.snoozed;
  await client.mailboxCreate(SNOOZED_FOLDER).catch(async (err) => {
    // Another request may have created it a moment ago.
    if (!(await resolveFolders(client)).snoozed) throw err;
  });
  return (await resolveFolders(client)).snoozed || SNOOZED_FOLDER;
}

/** Message-IDs (normalised) of the given UIDs in the locked folder. */
async function messageIdsOf(client: ImapFlow, uids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (uids.length === 0) return out;
  for await (const m of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
    out.set(m.uid, normaliseMsgId(m.envelope?.messageId));
  }
  return out;
}

/** UIDs in the locked folder whose Message-ID is exactly this one. */
async function findByMessageId(client: ImapFlow, messageId: string): Promise<number[]> {
  const found = ((await client.search({ header: { 'message-id': messageId } }, { uid: true })) || []) as number[];
  if (found.length === 0) return [];
  const ids = await messageIdsOf(client, found);
  return found.filter((u) => ids.get(u) === messageId);
}

export async function snooze(
  store: OrganiseStore,
  config: AccountConfig,
  mailbox: string,
  uids: number[],
  until: number
): Promise<{ folder: string; count: number }> {
  const client = await getPooledImapClient(config);
  const snoozedPath = await ensureSnoozedFolder(client);
  const lock = await client.getMailboxLock(mailbox);
  try {
    const ids = await messageIdsOf(client, uids);
    const missing = uids.filter((u) => !ids.has(u));
    if (missing.length > 0) throw new OrganiseError(404, 'MESSAGE_NOT_FOUND', 'The messages were not found. They may have been moved or deleted.');
    if ([...ids.values()].some((id) => !id)) {
      throw new OrganiseError(422, 'NO_MESSAGE_ID', 'This message cannot be snoozed because it has no Message-ID.');
    }
    if (mailbox === snoozedPath) {
      // Already snoozed: only the wake time changes.
      for (const id of ids.values()) store.putSnooze(config.email, id, until);
      return { folder: snoozedPath, count: ids.size };
    }
    const before = new Map(store.snoozes(config.email).map((r) => [r.messageId, r.until]));
    // Record first, then move: a crash in between leaves a record whose message is still in place,
    // which the wake-up simply drops. Mail is never in Snoozed without a record.
    for (const id of ids.values()) store.putSnooze(config.email, id, until);
    let moved = false;
    try {
      const res = await client.messageMove(uids, snoozedPath, { uid: true });
      moved = Boolean(res && (!res.uidMap || res.uidMap.size > 0));
    } finally {
      if (!moved) {
        for (const id of ids.values()) {
          if (before.has(id)) store.putSnooze(config.email, id, before.get(id)!);
          else store.deleteSnooze(config.email, id);
        }
      }
    }
    if (!moved) throw new Error('The messages could not be moved to Snoozed.');
    return { folder: snoozedPath, count: ids.size };
  } finally {
    lock.release();
  }
}

/** Back to the Inbox now (cancel a snooze). Moves first, then forgets the records. */
export async function unsnooze(store: OrganiseStore, config: AccountConfig, uids: number[]): Promise<{ movedTo: string; count: number }> {
  const client = await getPooledImapClient(config);
  const folders = await resolveFolders(client);
  if (!folders.snoozed) throw new OrganiseError(404, 'MESSAGE_NOT_FOUND', 'The messages were not found. They may have been moved or deleted.');
  const lock = await client.getMailboxLock(folders.snoozed);
  try {
    const ids = await messageIdsOf(client, uids);
    const present = uids.filter((u) => ids.has(u));
    if (present.length === 0) throw new OrganiseError(404, 'MESSAGE_NOT_FOUND', 'The messages were not found. They may have been moved or deleted.');
    const res = await client.messageMove(present, folders.inbox, { uid: true });
    if (!res || (res.uidMap && res.uidMap.size === 0)) throw new Error('The messages could not be moved to the Inbox.');
    for (const id of ids.values()) if (id) store.deleteSnooze(config.email, id);
    return { movedTo: folders.inbox, count: present.length };
  } finally {
    lock.release();
  }
}

export async function snoozedView(
  store: OrganiseStore,
  config: AccountConfig,
  page: number,
  limit: number
): Promise<{ messages: MessageHeader[]; total: number }> {
  const client = await getPooledImapClient(config);
  const folders = await resolveFolders(client);
  if (!folders.snoozed) return { messages: [], total: 0 };
  const untilById = new Map(store.snoozes(config.email).map((r) => [r.messageId, r.until]));
  const lock = await client.getMailboxLock(folders.snoozed, { readOnly: true });
  try {
    const uids = ((await client.search({ all: true }, { uid: true })) || []) as number[];
    const ids = await messageIdsOf(client, uids);
    const ordered = uids
      .map((uid) => ({ uid, until: untilById.get(ids.get(uid) || '') }))
      .sort((a, b) => (a.until ?? Infinity) - (b.until ?? Infinity) || b.uid - a.uid);
    const pageRows = ordered.slice((page - 1) * limit, (page - 1) * limit + limit);
    const items = await fetchListItems(client, pageRows.map((r) => r.uid), config.email);
    const untilByUid = new Map(pageRows.map((r) => [r.uid, r.until]));
    for (const it of items) {
      it.mailbox = folders.snoozed;
      const u = untilByUid.get(it.uid);
      if (u !== undefined) it.snoozedUntil = new Date(u).toISOString();
    }
    return { messages: items, total: ordered.length };
  } finally {
    lock.release();
  }
}

export interface WakeResult {
  woken: number;
  dropped: number;
}

/**
 * Moves every due snooze of this mailbox from Snoozed to the Inbox, unread. Safe to repeat and to
 * interrupt: \Seen is cleared before the move, the record is deleted only after it, and a record whose
 * message is no longer in Snoozed is dropped (the message is wherever the person put it).
 */
export async function wakeDue(
  store: OrganiseStore,
  config: AccountConfig,
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }
): Promise<WakeResult> {
  const due = store.dueSnoozes(config.email);
  const result: WakeResult = { woken: 0, dropped: 0 };
  if (due.length === 0) return result;
  const client = await getPooledImapClient(config);
  const folders = await resolveFolders(client);
  if (!folders.snoozed) {
    for (const r of due) store.deleteSnooze(config.email, r.messageId);
    log.warn({ code: 'SNOOZE_FOLDER_MISSING', count: due.length }, 'Snoozed folder missing; snooze records dropped');
    return { woken: 0, dropped: due.length };
  }
  const lock = await client.getMailboxLock(folders.snoozed);
  try {
    for (const r of due) {
      const uids = await findByMessageId(client, r.messageId);
      if (uids.length === 0) {
        store.deleteSnooze(config.email, r.messageId);
        log.warn({ code: 'SNOOZE_MESSAGE_GONE' }, 'Snoozed message no longer in Snoozed; record dropped');
        result.dropped++;
        continue;
      }
      await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
      const res = await client.messageMove(uids, folders.inbox, { uid: true });
      if (!res || (res.uidMap && res.uidMap.size === 0)) throw new Error('Snoozed message could not be moved to the Inbox.');
      store.deleteSnooze(config.email, r.messageId);
      result.woken += uids.length;
    }
  } finally {
    lock.release();
  }
  if (result.woken > 0) log.info({ code: 'SNOOZE_WOKEN', count: result.woken }, 'Snoozed mail returned to the Inbox');
  return result;
}

// -------------------------------------------------------------
// CONVERSATIONS
// -------------------------------------------------------------
export interface ThreadView {
  subject: string;
  participants: Array<{ name: string; address: string }>;
  messages: Array<{ mailbox: string; uid: number; from: { name: string; address: string }; date: string; snippet: string; isOwn: boolean }>;
}

export async function getThread(store: OrganiseStore, config: AccountConfig, threadId: string, extraFolder?: string): Promise<ThreadView | null> {
  const client = await getPooledImapClient(config);
  const folders = await resolveFolders(client);
  const span = conversationFolders(folders);
  if (extraFolder && folders.all.includes(extraFolder) && !span.includes(extraFolder)) span.push(extraFolder);
  await syncThreadIndex(store, config, span);
  const members = store.threadMembers(config.email, threadId, span);
  if (members.length === 0) return null;

  const byFolder = new Map<string, number[]>();
  for (const m of members) byFolder.set(m.folder, [...(byFolder.get(m.folder) || []), m.uid]);
  const items: MessageHeader[] = [];
  for (const [folder, uids] of byFolder) {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      for (const it of await fetchListItems(client, uids.sort((a, b) => a - b), config.email)) {
        it.mailbox = folder;
        items.push(it);
      }
    } finally {
      lock.release();
    }
  }
  if (items.length === 0) return null;
  items.sort((a, b) => a.date.localeCompare(b.date) || a.uid - b.uid);

  const own = config.email.toLowerCase();
  const participants = new Map<string, { name: string; address: string }>();
  for (const it of items) {
    for (const p of [it.from, ...it.to, ...(it.cc || [])]) {
      const key = (p.address || '').toLowerCase();
      if (!key) continue;
      const known = participants.get(key);
      if (!known || (!known.name && p.name)) participants.set(key, { name: p.name && p.name !== p.address ? p.name : '', address: p.address });
    }
  }
  return {
    subject: baseSubject(items[0]!.subject) || items[0]!.subject,
    participants: [...participants.values()],
    messages: items.map((it) => ({
      mailbox: it.mailbox!,
      uid: it.uid,
      from: it.from,
      date: it.date,
      snippet: it.snippet,
      isOwn: (it.from.address || '').toLowerCase() === own
    }))
  };
}
