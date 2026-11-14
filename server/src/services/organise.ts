import type { ImapFlow, SearchObject } from 'imapflow';
import type { AccountConfig, MessageHeader } from '../types.js';
import { fetchListItems, getPooledImapClient, isImapAuthError, LABEL_KEYWORD_PREFIX } from './imap.js';
import type { OrganiseStore } from './organise-store.js';
import type { ConversationIndexer } from './conv-index.js';
import type { BounceInfo } from './bounce.js';
import { conversationFolders, resolveFolders, SNOOZED_FOLDER, type Folders } from './folders.js';
import { baseSubject, normaliseMsgId, referencesFromHeaderBlock, threadIdFor } from './threading.js';

export { resolveFolders, conversationFolders, SNOOZED_FOLDER, type Folders };

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

export const LABELS_UNSUPPORTED =
  'This mail server cannot store labels on messages (it does not allow custom keywords), so labels are not available.';
const NOT_FOUND = 'The messages were not found. They may have been moved or deleted.';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

// -------------------------------------------------------------
// LIST ITEMS: labels, threadCount, bounce originals
// -------------------------------------------------------------

/**
 * Finishes list items for the browser: labels limited to this mailbox's label ids, threadCount from
 * whatever the index already holds (at least 1), and defaults for anything missing (demo mail).
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

/** UIDs in the locked folder whose Message-ID is exactly this one (normalised). */
async function findByMessageId(client: ImapFlow, messageId: string): Promise<number[]> {
  const found = ((await client.search({ header: { 'message-id': messageId } }, { uid: true })) || []) as number[];
  if (found.length === 0) return [];
  const ids = await messageIdsOf(client, found);
  return found.filter((u) => ids.get(u) === messageId);
}

/** Bounces whose original is in Sent become retryable and point at that copy. */
async function resolveBounceOriginals(store: OrganiseStore, config: AccountConfig, items: MessageHeader[], sent: string | undefined): Promise<void> {
  const bounces = items.map((i) => i.bounce as BounceInfo | undefined).filter((b): b is BounceInfo => Boolean(b));
  for (const b of bounces) {
    const mid = b.originalMessageId;
    delete b.originalMessageId;
    b.retryable = false;
    if (!mid || !sent) continue;
    let uid = store.uidByMessageId(config.email, sent, mid);
    if (uid === null && !store.syncState(config.email, sent)?.complete) {
      // Index not complete yet: ask the server (bounces are few).
      const client = await getPooledImapClient(config);
      const lock = await client.getMailboxLock(sent, { readOnly: true });
      try {
        uid = (await findByMessageId(client, mid)).pop() ?? null;
      } finally {
        lock.release();
      }
    }
    if (uid !== null) {
      b.retryable = true;
      b.original = { mailbox: sent, uid };
    }
  }
}

/** Refresh the index (never waiting on a backfill) and finish the items; index trouble never fails the list. */
export async function enrichList(
  store: OrganiseStore,
  indexer: ConversationIndexer,
  config: AccountConfig,
  items: MessageHeader[],
  log?: { warn: (o: object, m: string) => void }
): Promise<MessageHeader[]> {
  let folders: Folders | undefined;
  if (!config.isDemo) {
    try {
      folders = await indexer.refresh(config);
    } catch (err) {
      if (isImapAuthError(err)) throw err;
      log?.warn({ errCode: (err as { code?: string })?.code, errName: (err as Error)?.name }, 'Conversation index not updated');
    }
  }
  finishItems(store, config.email, items, folders ? conversationFolders(folders) : []);
  try {
    await resolveBounceOriginals(store, config, items, config.isDemo ? undefined : folders?.sent);
  } catch (err) {
    if (isImapAuthError(err)) throw err;
    for (const it of items) if (it.bounce) delete (it.bounce as BounceInfo).originalMessageId;
  }
  return items;
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
    // A KEYWORD search needs a read-write select: a read-only one reports no PERMANENTFLAGS, and the
    // search library then silently drops the keyword term (every message would match).
    const lock = await client.getMailboxLock(folder, { readOnly: !criteria.keyword });
    try {
      if (criteria.keyword && !keywordSearchable(client, criteria.keyword)) continue;
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

/** One search over every selectable folder except Trash and Junk (Snoozed counts), merged newest first. */
export async function searchAllFolders(
  config: AccountConfig,
  criteria: SearchObject,
  page: number,
  limit: number
): Promise<{ messages: MessageHeader[]; total: number }> {
  const client = await getPooledImapClient(config);
  const folders = await resolveFolders(client);
  const searched = [...folders.viewable, ...(folders.snoozed ? [folders.snoozed] : [])];
  return crossFolderView(config, criteria, searched, page, limit);
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
    if (found.length === 0) throw new OrganiseError(404, 'MESSAGE_NOT_FOUND', NOT_FOUND);
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

/**
 * True when a KEYWORD search for this keyword is meaningful in the locked folder: the folder accepts
 * custom keywords (PERMANENTFLAGS has \*) or already lists it. Otherwise nothing can carry it, and the
 * caller must answer "none" rather than run a search whose keyword term would be dropped.
 */
export function keywordSearchable(client: ImapFlow, keyword: string): boolean {
  const mb = client.mailbox;
  if (!mb) return false;
  return Boolean(mb.permanentFlags?.has('\\*') || mb.flags?.has(keyword));
}

export interface LabelCount {
  unread: number;
  total: number;
}

/**
 * Messages carrying each label, counted over the folders a label view shows (everything except Trash,
 * Junk and Snoozed): `total` all of them, `unread` those without \Seen.
 */
export async function labelCounts(config: AccountConfig, ids: string[]): Promise<Map<string, LabelCount>> {
  const out = new Map<string, LabelCount>(ids.map((id) => [id, { unread: 0, total: 0 }]));
  if (ids.length === 0) return out;
  const client = await getPooledImapClient(config);
  const folders = await resolveFolders(client);
  for (const folder of folders.viewable) {
    // Read-write select (nothing is changed): see crossFolderView.
    const lock = await client.getMailboxLock(folder);
    try {
      for (const id of ids) {
        const keyword = keywordFor(id);
        if (!keywordSearchable(client, keyword)) continue;
        const all = ((await client.search({ keyword }, { uid: true })) || []) as number[];
        if (all.length === 0) continue;
        const unseen = ((await client.search({ seen: false, keyword }, { uid: true })) || []) as number[];
        const c = out.get(id)!;
        c.total += all.length;
        c.unread += unseen.length;
      }
    } finally {
      lock.release();
    }
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
// SNOOZE (records keyed by mailbox + Message-ID + UID in Snoozed)
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

export async function snooze(
  store: OrganiseStore,
  config: AccountConfig,
  mailbox: string,
  uids: number[],
  until: number
): Promise<{ folder: string; count: number }> {
  const client = await getPooledImapClient(config);
  const snoozedPath = await ensureSnoozedFolder(client);
  let unmapped: string[] = [];
  const lock = await client.getMailboxLock(mailbox);
  try {
    const ids = await messageIdsOf(client, uids);
    if (uids.some((u) => !ids.has(u))) throw new OrganiseError(404, 'MESSAGE_NOT_FOUND', NOT_FOUND);
    if ([...ids.values()].some((id) => !id)) {
      throw new OrganiseError(422, 'NO_MESSAGE_ID', 'This message cannot be snoozed because it has no Message-ID.');
    }
    if (mailbox === snoozedPath) {
      // Already snoozed: only the wake time changes (a copy without a record gets one).
      for (const [uid, id] of ids) if (!store.setSnoozeUntilByUid(config.email, uid, until)) store.putSnooze(config.email, id, uid, until);
      return { folder: snoozedPath, count: ids.size };
    }
    // Record first (pending, uid 0), then move, then settle each record on its new UID. A crash
    // in between leaves a pending record, which the wake-up resolves by Message-ID or drops.
    for (const id of new Set(ids.values())) store.putSnooze(config.email, id, 0, until);
    let res: Awaited<ReturnType<ImapFlow['messageMove']>> | undefined;
    try {
      res = await client.messageMove(uids, snoozedPath, { uid: true });
    } finally {
      if (!res || (res.uidMap && res.uidMap.size === 0)) {
        for (const id of new Set(ids.values())) store.deleteSnooze(config.email, id, 0);
      }
    }
    if (!res || (res.uidMap && res.uidMap.size === 0)) throw new Error('The messages could not be moved to Snoozed.');
    if (res.uidMap) {
      for (const [src, dst] of res.uidMap) store.settleSnooze(config.email, ids.get(src)!, dst, until);
    }
    unmapped = [...new Set([...ids].filter(([src]) => !res!.uidMap?.has(src)).map(([, id]) => id))];
  } finally {
    lock.release();
  }
  if (unmapped.length > 0) {
    // No UIDPLUS answer: find the new copies in Snoozed by Message-ID (those not tracked yet).
    const tracked = new Set(store.snoozes(config.email).map((r) => r.uid));
    const lockS = await client.getMailboxLock(snoozedPath);
    try {
      for (const id of unmapped) {
        for (const uid of await findByMessageId(client, id)) if (!tracked.has(uid)) store.settleSnooze(config.email, id, uid, until);
      }
    } finally {
      lockS.release();
    }
  }
  return { folder: snoozedPath, count: uids.length };
}

/** Back to the Inbox now (cancel a snooze). Moves first, then forgets the records. */
export async function unsnooze(store: OrganiseStore, config: AccountConfig, uids: number[]): Promise<{ movedTo: string; count: number }> {
  const client = await getPooledImapClient(config);
  const folders = await resolveFolders(client);
  if (!folders.snoozed) throw new OrganiseError(404, 'MESSAGE_NOT_FOUND', NOT_FOUND);
  const lock = await client.getMailboxLock(folders.snoozed);
  try {
    const ids = await messageIdsOf(client, uids);
    const present = uids.filter((u) => ids.has(u));
    if (present.length === 0) throw new OrganiseError(404, 'MESSAGE_NOT_FOUND', NOT_FOUND);
    const res = await client.messageMove(present, folders.inbox, { uid: true });
    if (!res || (res.uidMap && res.uidMap.size === 0)) throw new Error('The messages could not be moved to the Inbox.');
    for (const uid of present) store.deleteSnooze(config.email, ids.get(uid)!, uid);
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
  const records = store.snoozes(config.email);
  const untilByUid = new Map(records.filter((r) => r.uid > 0).map((r) => [r.uid, r.until]));
  const pendingById = new Map(records.filter((r) => r.uid === 0).map((r) => [r.messageId, r.until]));
  const lock = await client.getMailboxLock(folders.snoozed, { readOnly: true });
  try {
    const uids = ((await client.search({ all: true }, { uid: true })) || []) as number[];
    const needIds = uids.filter((u) => !untilByUid.has(u));
    const ids = pendingById.size > 0 ? await messageIdsOf(client, needIds) : new Map<number, string>();
    const untilOf = (uid: number) => untilByUid.get(uid) ?? pendingById.get(ids.get(uid) || '');
    const ordered = uids.map((uid) => ({ uid, until: untilOf(uid) })).sort((a, b) => (a.until ?? Infinity) - (b.until ?? Infinity) || b.uid - a.uid);
    const pageRows = ordered.slice((page - 1) * limit, (page - 1) * limit + limit);
    const items = await fetchListItems(client, pageRows.map((r) => r.uid), config.email);
    const untilFor = new Map(pageRows.map((r) => [r.uid, r.until]));
    for (const it of items) {
      it.mailbox = folders.snoozed;
      const u = untilFor.get(it.uid);
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
 * Moves every due snooze of this mailbox from Snoozed to the Inbox, unread. Each record names one
 * copy (its UID in Snoozed, checked against the Message-ID). Safe to repeat and to interrupt:
 * \Seen is cleared before the move and the record is deleted only after it. A record whose copy is
 * no longer in Snoozed is dropped (the message is wherever the person put it).
 */
export async function wakeDue(store: OrganiseStore, config: AccountConfig, log: Log): Promise<WakeResult> {
  const due = store.dueSnoozes(config.email);
  const result: WakeResult = { woken: 0, dropped: 0 };
  if (due.length === 0) return result;
  const client = await getPooledImapClient(config);
  const folders = await resolveFolders(client);
  if (!folders.snoozed) {
    for (const r of due) store.deleteSnooze(config.email, r.messageId, r.uid);
    log.warn({ code: 'SNOOZE_FOLDER_MISSING', count: due.length }, 'Snoozed folder missing; snooze records dropped');
    return { woken: 0, dropped: due.length };
  }
  const lock = await client.getMailboxLock(folders.snoozed);
  try {
    const tracked = new Set(store.snoozes(config.email).filter((r) => r.uid > 0).map((r) => r.uid));
    const settled = due.filter((r) => r.uid > 0);
    const ids = await messageIdsOf(client, settled.map((r) => r.uid));
    for (const r of due) {
      let uids: number[];
      if (r.uid > 0) {
        uids = ids.get(r.uid) === r.messageId ? [r.uid] : [];
      } else {
        // Pending record from an interrupted snooze: the untracked copies with this Message-ID.
        uids = (await findByMessageId(client, r.messageId)).filter((u) => !tracked.has(u));
      }
      if (uids.length === 0) {
        store.deleteSnooze(config.email, r.messageId, r.uid);
        log.warn({ code: 'SNOOZE_MESSAGE_GONE' }, 'Snoozed message no longer in Snoozed; record dropped');
        result.dropped++;
        continue;
      }
      await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
      const res = await client.messageMove(uids, folders.inbox, { uid: true });
      if (!res || (res.uidMap && res.uidMap.size === 0)) throw new Error('Snoozed message could not be moved to the Inbox.');
      store.deleteSnooze(config.email, r.messageId, r.uid);
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

/** How long the thread view waits for a running background index before answering with what it has. */
const THREAD_INDEX_WAIT_MS = 3000;

export async function getThread(
  store: OrganiseStore,
  indexer: ConversationIndexer,
  config: AccountConfig,
  threadId: string,
  extraFolder?: string
): Promise<ThreadView | null> {
  const folders = await indexer.refresh(config);
  if (indexer.running(config.email)) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([indexer.idle(config.email), new Promise<void>((r) => (timer = setTimeout(r, THREAD_INDEX_WAIT_MS)))]);
    clearTimeout(timer);
  }
  const span = conversationFolders(folders);
  const members = store.threadMembers(config.email, threadId, span);
  const client = await getPooledImapClient(config);

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
  // A folder outside the index (e.g. opened from Snoozed or a custom folder): match by thread id there.
  if (extraFolder && folders.all.includes(extraFolder) && !span.includes(extraFolder)) {
    const lock = await client.getMailboxLock(extraFolder, { readOnly: true });
    try {
      const all = ((await client.search({ all: true }, { uid: true })) || []) as number[];
      const recent = all.sort((a, b) => b - a).slice(0, 500);
      const where = `${extraFolder}:${client.mailbox ? client.mailbox.uidValidity : ''}`;
      const matches: number[] = [];
      if (recent.length > 0) {
        for await (const m of client.fetch(recent, { uid: true, envelope: true, headers: ['references'] }, { uid: true })) {
          const id = threadIdFor({
            messageId: m.envelope?.messageId,
            inReplyTo: m.envelope?.inReplyTo,
            references: referencesFromHeaderBlock(m.headers),
            fallbackKey: `${where}:${m.uid}`
          });
          if (id === threadId) matches.push(m.uid);
        }
      }
      for (const it of await fetchListItems(client, matches, config.email)) {
        it.mailbox = extraFolder;
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
