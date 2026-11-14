import { ImapFlow, SearchObject, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { AccountConfig, MailboxFolder, MessageHeader, ParsedEmailMessage, SpecialUseFolder } from '../types.js';
import { renderEmail, findCidReferences } from '../utils/sanitize.js';
import { classifyParts, findPart, isValidPartId, type LeafPart, type MessageParts } from './mailparts.js';
import { cleanFilename, decodeCharset, decodeTransfer, htmlToText, makeSnippet } from '../utils/mime.js';

export interface SearchFilters {
  search?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  before?: string;
}

const NAME_KINDS: Record<string, SpecialUseFolder> = {
  sent: 'Sent', 'sent items': 'Sent', 'sent mail': 'Sent', 'sent messages': 'Sent',
  drafts: 'Drafts', draft: 'Drafts',
  trash: 'Trash', 'deleted items': 'Trash', 'deleted messages': 'Trash', bin: 'Trash',
  junk: 'Junk', spam: 'Junk', 'junk e-mail': 'Junk', 'junk email': 'Junk',
  archive: 'Archive', archives: 'Archive'
};

/** Which well-known folder this is. Unknown folders return undefined and keep their own name. */
export function detectSpecialUse(name: string, specialUse?: string, path?: string): SpecialUseFolder | undefined {
  if ((path || name).toUpperCase() === 'INBOX') return 'Inbox';
  if (specialUse) {
    const s = specialUse.replace(/^\\/, '').toLowerCase();
    if (s === 'inbox') return 'Inbox';
    if (s === 'sent') return 'Sent';
    if (s === 'drafts') return 'Drafts';
    if (s === 'trash') return 'Trash';
    if (s === 'junk') return 'Junk';
    if (s === 'archive') return 'Archive';
    if (s === 'all') return 'All';
  }
  return NAME_KINDS[name.trim().toLowerCase()];
}

export function createImapClient(config: AccountConfig): ImapFlow {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: {
      user: config.imapUser,
      pass: config.imapPass
    },
    logger: false,
    tls: {
      rejectUnauthorized: false // support self-signed certs or local loopback Dovecot
    }
  });
}

// -------------------------------------------------------------
// CONNECTION POOLING WITH INACTIVITY REAPER (DOVECOT SAFE)
// Prevents max_user_connections socket exhaustion on EC2
// -------------------------------------------------------------
interface PoolEntry {
  client: ImapFlow;
  timer: NodeJS.Timeout;
  lastUsed: number;
}

const connectionPool = new Map<string, PoolEntry>();
const IDLE_TIMEOUT_MS = 60 * 1000; // Auto-close connection after 60s of inactivity

function getPoolKey(config: AccountConfig): string {
  return `${config.imapUser}@${config.imapHost}:${config.imapPort}`;
}

export async function closePooledClient(key: string): Promise<void> {
  const entry = connectionPool.get(key);
  if (entry) {
    clearTimeout(entry.timer);
    connectionPool.delete(key);
    try {
      if (entry.client.usable) {
        await entry.client.logout();
      }
    } catch {
      // Ignore disconnect errors during reaper
    }
  }
}

export async function closeUserSession(config: AccountConfig): Promise<void> {
  const key = getPoolKey(config);
  await closePooledClient(key);
}

export async function getPooledImapClient(config: AccountConfig): Promise<ImapFlow> {
  const key = getPoolKey(config);
  const existing = connectionPool.get(key);

  if (existing && existing.client.usable) {
    clearTimeout(existing.timer);
    existing.lastUsed = Date.now();
    existing.timer = setTimeout(() => closePooledClient(key), IDLE_TIMEOUT_MS);
    return existing.client;
  }

  // Create new connection
  const client = createImapClient(config);
  await client.connect();

  const timer = setTimeout(() => closePooledClient(key), IDLE_TIMEOUT_MS);
  connectionPool.set(key, { client, timer, lastUsed: Date.now() });

  client.on('error', (err) => {
    // Prevent unhandled error event crash on socket timeouts or disconnects
    const entry = connectionPool.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      connectionPool.delete(key);
    }
  });

  client.on('close', () => {
    const entry = connectionPool.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      connectionPool.delete(key);
    }
  });

  return client;
}

export async function testImapConnection(config: AccountConfig): Promise<boolean> {
  const client = createImapClient(config);
  try {
    await client.connect();
    await client.logout();
    return true;
  } catch (err) {
    throw new Error(`IMAP Connection Failed: ${(err as Error).message}`);
  }
}

// -------------------------------------------------------------
// FOLDERS
// -------------------------------------------------------------
type ListedMailbox = Awaited<ReturnType<ImapFlow['list']>>[number];

function kindOfMailbox(mb: ListedMailbox): SpecialUseFolder | undefined {
  return detectSpecialUse(mb.name, mb.specialUse, mb.path);
}

/** Path of the folder of the given kind (Trash, Junk, Drafts, Inbox ...), if the server has one. */
export async function findFolderPath(client: ImapFlow, kind: SpecialUseFolder): Promise<string | undefined> {
  const list = await client.list();
  const flagged = list.find((m) => m.specialUse && detectSpecialUse(m.name, m.specialUse, m.path) === kind);
  if (flagged) return flagged.path;
  return list.find((m) => kindOfMailbox(m) === kind)?.path;
}

export async function getFolderKind(client: ImapFlow, folderPath: string): Promise<SpecialUseFolder | undefined> {
  const list = await client.list();
  const mb = list.find((m) => m.path === folderPath);
  return mb ? kindOfMailbox(mb) : detectSpecialUse(folderPath.split(/[./]/).pop() || folderPath, undefined, folderPath);
}

export async function getLiveMailboxes(config: AccountConfig): Promise<MailboxFolder[]> {
  const client = await getPooledImapClient(config);
  const folders: MailboxFolder[] = [];

  const list = await client.list();
  for (const mb of list) {
    let unreadCount = 0;
    let totalCount = 0;
    const isNoSelect = mb.flags && (mb.flags.has('\\Noselect') || mb.flags.has('\\NonExistent'));

    if (!isNoSelect) {
      try {
        const status = await Promise.race([
          client.status(mb.path, { unseen: true, messages: true }),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
        ]);
        if (status) {
          unreadCount = status.unseen || 0;
          totalCount = status.messages || 0;
        }
      } catch {
        // Status might fail or timeout on non-selectable parent folders, continue gracefully
      }
    }

    const delimiter = mb.delimiter || '/';
    const segments = mb.path.split(delimiter);
    folders.push({
      path: mb.path,
      name: mb.name,
      delimiter,
      flags: Array.from(mb.flags || []),
      specialUse: kindOfMailbox(mb),
      unreadCount,
      totalCount,
      depth: Math.max(0, segments.length - 1),
      parentPath: segments.length > 1 ? segments.slice(0, -1).join(delimiter) : undefined
    });
  }

  return folders;
}

// -------------------------------------------------------------
// MESSAGE LIST
// -------------------------------------------------------------
const LIST_FETCH = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true
} as const;

function toHeader(msg: FetchMessageObject): { header: MessageHeader; parts: MessageParts } {
  const env = msg.envelope;
  const fromAddr = env?.from?.[0] || { name: 'Unknown', address: 'unknown@example.com' };
  const toAddrs = (env?.to || []).map((t) => ({ name: t.name || '', address: t.address || '' }));
  const ccAddrs = (env?.cc || []).map((t) => ({ name: t.name || '', address: t.address || '' }));
  const flagsArr = Array.from(msg.flags || []);
  const parts = classifyParts(msg.bodyStructure);
  return {
    parts,
    header: {
      uid: msg.uid,
      seq: msg.seq,
      id: env?.messageId || String(msg.uid),
      from: { name: fromAddr.name || fromAddr.address || 'Unknown', address: fromAddr.address || '' },
      to: toAddrs,
      cc: ccAddrs,
      subject: env?.subject || '(No Subject)',
      date: new Date(msg.internalDate || Date.now()).toISOString(),
      flags: flagsArr,
      isSeen: flagsArr.includes('\\Seen'),
      isFlagged: flagsArr.includes('\\Flagged'),
      hasAttachments: parts.attachments.length > 0,
      size: msg.size || 0,
      snippet: ''
    }
  };
}

/** Fill `snippet` (first ~140 characters of text) with one small partial fetch per distinct text part number. */
async function addSnippets(
  client: ImapFlow,
  items: Array<{ header: MessageHeader; parts: MessageParts }>
): Promise<void> {
  const groups = new Map<string, { part: LeafPart; uids: number[] }>();
  for (const it of items) {
    const part = it.parts.text?.[0] || it.parts.html?.[0];
    if (!part) continue;
    const key = `${part.partId}|${part.type}|${part.encoding}|${part.charset}`;
    const g = groups.get(key) || { part, uids: [] };
    g.uids.push(it.header.uid);
    groups.set(key, g);
  }
  const byUid = new Map(items.map((i) => [i.header.uid, i.header]));
  for (const { part, uids } of groups.values()) {
    try {
      const gen = client.fetch(uids, { uid: true, bodyParts: [{ key: part.partId, start: 0, maxLength: 4096 }] }, { uid: true });
      for await (const m of gen) {
        const raw = m.bodyParts?.get(part.partId) || m.bodyParts?.values().next().value;
        const header = byUid.get(m.uid);
        if (!raw || !header) continue;
        const text = decodeCharset(decodeTransfer(raw, part.encoding), part.charset);
        header.snippet = makeSnippet(part.type === 'text/html' ? htmlToText(text) : text);
      }
    } catch {
      // A preview is a nicety; the list still works without it.
    }
  }
}

export async function getLiveMessages(
  config: AccountConfig,
  folderPath: string,
  page = 1,
  limit = 50,
  filters?: SearchFilters
): Promise<{ messages: MessageHeader[]; total: number }> {
  const client = await getPooledImapClient(config);

  const lock = await client.getMailboxLock(folderPath, { readOnly: true });
  try {
    // A pooled connection keeps the folder selected and may not know about mail that arrived since:
    // select it afresh so the count and sequence numbers are current.
    await client.mailboxClose();
    await client.mailboxOpen(folderPath, { readOnly: true });
    const mailbox = client.mailbox;
    const mailboxTotal = mailbox ? (mailbox.exists || 0) : 0;
    if (mailboxTotal === 0) return { messages: [], total: 0 };

    const hasFilters = Boolean(
      filters && (
        filters.search?.trim() ||
        filters.from?.trim() ||
        filters.to?.trim() ||
        filters.subject?.trim() ||
        filters.since?.trim() ||
        filters.before?.trim()
      )
    );

    if (hasFilters && filters) {
      const searchCriteria: SearchObject = {};
      if (filters.from?.trim()) searchCriteria.from = filters.from.trim();
      if (filters.to?.trim()) searchCriteria.to = filters.to.trim();
      if (filters.subject?.trim()) searchCriteria.subject = filters.subject.trim();
      if (filters.since?.trim()) {
        const d = new Date(filters.since.trim());
        if (!isNaN(d.getTime())) searchCriteria.since = d;
      }
      if (filters.before?.trim()) {
        const d = new Date(filters.before.trim());
        if (!isNaN(d.getTime())) searchCriteria.before = d;
      }
      if (filters.search?.trim()) {
        searchCriteria.text = filters.search.trim();
      }

      const searchResult = await client.search(searchCriteria, { uid: true });
      if (!searchResult || !Array.isArray(searchResult) || searchResult.length === 0) {
        return { messages: [], total: 0 };
      }

      // Sort descending (newest UID first)
      const sortedUids = [...searchResult].sort((a, b) => b - a);
      const total = sortedUids.length;
      const startIdx = (page - 1) * limit;
      const pagedUids = sortedUids.slice(startIdx, startIdx + limit);
      if (pagedUids.length === 0) return { messages: [], total };

      const uidToItem = new Map<number, { header: MessageHeader; parts: MessageParts }>();
      for await (const msg of client.fetch(pagedUids, LIST_FETCH, { uid: true })) {
        uidToItem.set(msg.uid, toHeader(msg));
      }
      const items = pagedUids.map((uid) => uidToItem.get(uid)).filter(Boolean) as Array<{
        header: MessageHeader;
        parts: MessageParts;
      }>;
      await addSnippets(client, items);
      return { messages: items.map((i) => i.header), total };
    }

    // Fast range pagination for default view
    const total = mailboxTotal;
    const startSeq = Math.max(1, total - (page * limit) + 1);
    const endSeq = Math.max(1, total - ((page - 1) * limit));
    if ((page - 1) * limit >= total) return { messages: [], total };
    const range = `${startSeq}:${endSeq}`;

    const items: Array<{ header: MessageHeader; parts: MessageParts }> = [];
    for await (const msg of client.fetch(range, LIST_FETCH)) {
      items.push(toHeader(msg));
    }
    items.reverse();
    await addSnippets(client, items);
    return { messages: items.map((i) => i.header), total };
  } finally {
    lock.release();
  }
}

// -------------------------------------------------------------
// MESSAGE DETAIL
// -------------------------------------------------------------
const MAX_TEXT_PART_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 4 * 1024 * 1024;

/** One body part, transfer-decoded (base64 / quoted-printable). Charset is not applied. Null when absent or over the cap. */
async function readPart(client: ImapFlow, uid: number, part: LeafPart, maxBytes: number): Promise<Buffer | null> {
  const wire = Math.ceil(maxBytes * 1.4) + 1024;
  const m = await client.fetchOne(
    String(uid),
    { uid: true, bodyParts: [{ key: part.partId, start: 0, maxLength: wire }] },
    { uid: true }
  );
  if (!m) return null;
  const raw = m.bodyParts?.get(part.partId) || m.bodyParts?.values().next().value;
  if (!raw) return null;
  if (raw.length >= wire) return null; // too big to show inline
  const decoded = m.binaryParts?.has(part.partId) ? raw : decodeTransfer(raw, part.encoding);
  return decoded.length > maxBytes ? null : decoded;
}

function addrList(list: Array<{ name?: string; address?: string }> | undefined) {
  return (list || []).map((v) => ({ name: v.name || '', address: v.address || '' }));
}

export interface DetailOptions {
  /** Load remote images referenced by the message (default: blocked). */
  allowRemoteImages?: boolean;
}

export async function getLiveMessageDetail(
  config: AccountConfig,
  folderPath: string,
  uid: number,
  options: DetailOptions = {}
): Promise<ParsedEmailMessage | null> {
  const client = await getPooledImapClient(config);

  const lock = await client.getMailboxLock(folderPath);
  try {
    const msg = await client.fetchOne(
      String(uid),
      { uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true, headers: ['references'] },
      { uid: true }
    );
    if (!msg) return null;

    const flags = Array.from(msg.flags || []);
    const wasFlagged = flags.includes('\\Flagged');
    if (!flags.includes('\\Seen')) {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      flags.push('\\Seen');
    }

    const parts = classifyParts(msg.bodyStructure);

    // Only the text parts are fetched; attachments are never read here .
    let text = '';
    for (const p of parts.text || []) {
      const buf = await readPart(client, uid, p, MAX_TEXT_PART_BYTES);
      if (buf) text += (text ? '\n' : '') + decodeCharset(buf, p.charset);
    }
    let rawHtml = '';
    for (const p of parts.html || []) {
      const buf = await readPart(client, uid, p, MAX_TEXT_PART_BYTES);
      if (buf) rawHtml += decodeCharset(buf, p.charset);
    }
    if (!text && rawHtml) text = htmlToText(rawHtml).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

    let html: string | undefined;
    let blockedImages = 0;
    if (rawHtml) {
      const wanted = new Set(findCidReferences(rawHtml));
      const cids = new Map<string, string>();
      let budget = MAX_INLINE_TOTAL_BYTES;
      for (const p of parts.inline) {
        const key = p.cid?.toLowerCase();
        if (!key || !wanted.has(key) || cids.has(key)) continue;
        if (p.size > MAX_INLINE_IMAGE_BYTES * 1.4 || budget <= 0) continue;
        try {
          const buf = await readPart(client, uid, p, MAX_INLINE_IMAGE_BYTES);
          if (!buf || buf.length === 0 || buf.length >= MAX_INLINE_IMAGE_BYTES) continue;
          budget -= buf.length;
          cids.set(key, `data:${p.type};base64,${buf.toString('base64')}`);
        } catch {
          // The image stays hidden; the rest of the mail is still shown.
        }
      }
      const rendered = renderEmail(rawHtml, { cids, allowRemoteImages: options.allowRemoteImages });
      html = rendered.html;
      blockedImages = rendered.blockedImages;
    }

    const env = msg.envelope;
    const fromFirst = env?.from?.[0] || { name: '', address: '' };
    const refsHeader = msg.headers ? msg.headers.toString('utf8') : '';
    const references = refsHeader.match(/<[^<>\s]+>/g) || [];

    const attachments = parts.attachments.map((p, i) => ({
      partId: p.partId,
      filename: cleanFilename(p.filename, `attachment-${i + 1}`),
      contentType: p.type,
      size: p.encoding?.toLowerCase() === 'base64' ? Math.floor(p.size * 0.75) : p.size,
      contentId: p.cid,
      isInline: false
    }));

    return {
      uid,
      id: env?.messageId || String(uid),
      subject: env?.subject || '(No Subject)',
      from: { name: fromFirst.name || fromFirst.address || 'Unknown', address: fromFirst.address || '' },
      to: addrList(env?.to),
      cc: addrList(env?.cc),
      bcc: addrList(env?.bcc),
      replyTo: addrList(env?.replyTo),
      messageId: env?.messageId,
      references,
      date: new Date(env?.date || msg.internalDate || Date.now()).toISOString(),
      flags,
      isSeen: true,
      isFlagged: wasFlagged,
      html,
      text,
      attachments,
      blockedImages
    };
  } finally {
    lock.release();
  }
}

// Real (non-inline) attachments of a stored message, for forwarding.
export class MessageTooLargeError extends Error {
  constructor(public size: number, public limit: number) {
    super('The original message is larger than the allowed size.');
    this.name = 'MessageTooLargeError';
  }
}

export async function getLiveMessageAttachments(
  config: AccountConfig,
  folderPath: string,
  uid: number,
  maxBytes?: number
): Promise<Array<{ filename: string; content: Buffer; contentType: string }>> {
  const client = await getPooledImapClient(config);
  const lock = await client.getMailboxLock(folderPath, { readOnly: true });
  try {
    // Check the size first so an oversized original is never downloaded into memory.
    const head = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
    if (!head) throw new Error('Original message not found');
    if (maxBytes !== undefined && (head.size ?? 0) > maxBytes) {
      throw new MessageTooLargeError(head.size ?? 0, maxBytes);
    }
    const rawMsg = await client.download(String(uid), undefined, { uid: true });
    if (!rawMsg || !rawMsg.content) throw new Error('Original message not found');
    const parsed = await simpleParser(rawMsg.content);
    return (parsed.attachments || [])
      .filter((a) => !a.related && a.contentDisposition !== 'inline')
      .map((a, i) => ({
        filename: a.filename || `attachment-${i + 1}`,
        content: a.content,
        contentType: a.contentType || 'application/octet-stream'
      }));
  } finally {
    lock.release();
  }
}

// -------------------------------------------------------------
// STREAMING ATTACHMENT DOWNLOAD (ZERO BUFFERING IN NODE RAM)
// -------------------------------------------------------------
export async function streamLiveAttachment(
  config: AccountConfig,
  folderPath: string,
  uid: number,
  partId: string
): Promise<{ stream: NodeJS.ReadableStream; filename: string; contentType: string } | null> {
  if (!isValidPartId(partId)) return null;
  const client = await getPooledImapClient(config);
  const lock = await client.getMailboxLock(folderPath, { readOnly: true });
  try {
    const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
    if (!msg) return null;
    const part = findPart(msg.bodyStructure, partId);
    if (!part) return null;

    const dl = await client.download(String(uid), partId, { uid: true });
    if (!dl || !dl.content) return null;

    const ext = part.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
    return {
      stream: dl.content,
      filename: cleanFilename(part.filename, `attachment-${partId}.${ext}`),
      contentType: part.type
    };
  } finally {
    lock.release();
  }
}

export async function setLiveMessageFlags(
  config: AccountConfig,
  folderPath: string,
  uid: number,
  flag: 'isSeen' | 'isFlagged',
  value: boolean
): Promise<boolean> {
  const client = await getPooledImapClient(config);

  const lock = await client.getMailboxLock(folderPath);
  try {
    const imapFlag = flag === 'isSeen' ? '\\Seen' : '\\Flagged';
    let ok: boolean;
    if (value) {
      ok = await client.messageFlagsAdd(String(uid), [imapFlag], { uid: true });
    } else {
      ok = await client.messageFlagsRemove(String(uid), [imapFlag], { uid: true });
    }
    if (!ok) throw new Error('The flag could not be changed.');
    return true;
  } finally {
    lock.release();
  }
}

// -------------------------------------------------------------
// ORGANISING: MOVE, DELETE, EMPTY (honest results: failure throws)
// -------------------------------------------------------------
async function requireMessage(client: ImapFlow, uid: number): Promise<void> {
  const found = await client.search({ uid: String(uid) }, { uid: true });
  if (!found || found.length === 0) throw new Error('The message was not found. It may already have been moved or deleted.');
}

/** Move one message and prove it moved; throws when nothing moved. Caller holds the lock on the source. */
async function moveChecked(client: ImapFlow, uid: number, target: string): Promise<void> {
  await requireMessage(client, uid);
  const res = await client.messageMove(String(uid), target, { uid: true });
  if (!res || (res.uidMap && res.uidMap.size === 0)) {
    throw new Error(`The message could not be moved to "${target}".`);
  }
}

export async function moveLiveMessage(
  config: AccountConfig,
  folderPath: string,
  uid: number,
  targetFolder: string
): Promise<boolean> {
  const client = await getPooledImapClient(config);
  if (folderPath === targetFolder) throw new Error('The message is already in that folder.');

  const lock = await client.getMailboxLock(folderPath);
  try {
    await moveChecked(client, uid, targetFolder);
    return true;
  } finally {
    lock.release();
  }
}

export interface DeleteResult {
  /** true when the message is gone for good (deleted inside Trash) */
  permanent: boolean;
  /** Where it went when it was moved to Trash */
  movedTo?: string;
}

/** Delete = move to Trash. Inside Trash it is deleted permanently. */
export async function deleteLiveMessage(
  config: AccountConfig,
  folderPath: string,
  uid: number
): Promise<DeleteResult> {
  const client = await getPooledImapClient(config);
  const kind = await getFolderKind(client, folderPath);

  if (kind === 'Trash') {
    const lock = await client.getMailboxLock(folderPath);
    try {
      await requireMessage(client, uid);
      const ok = await client.messageDelete(String(uid), { uid: true });
      if (!ok) throw new Error('The message could not be deleted.');
      return { permanent: true };
    } finally {
      lock.release();
    }
  }

  let trash = await findFolderPath(client, 'Trash');
  if (!trash) {
    await client.mailboxCreate('Trash');
    trash = 'Trash';
  }
  const lock = await client.getMailboxLock(folderPath);
  try {
    await moveChecked(client, uid, trash);
    return { permanent: false, movedTo: trash };
  } finally {
    lock.release();
  }
}

/** Permanently delete everything in Trash or Junk. Returns how many messages were removed. */
export async function emptyLiveFolder(config: AccountConfig, folderPath: string): Promise<number> {
  const client = await getPooledImapClient(config);
  const kind = await getFolderKind(client, folderPath);
  if (kind !== 'Trash' && kind !== 'Junk') {
    throw new Error('Only the Trash and Junk folders can be emptied.');
  }
  const lock = await client.getMailboxLock(folderPath);
  try {
    const before = client.mailbox ? client.mailbox.exists || 0 : 0;
    if (before === 0) return 0;
    const ok = await client.messageDelete('1:*');
    const status = await client.status(folderPath, { messages: true });
    const left = status.messages || 0;
    if (!ok || left > 0) {
      throw new Error(`Only ${before - left} of ${before} messages could be deleted.`);
    }
    return before;
  } finally {
    lock.release();
  }
}

/** Move a message out of Trash or Junk back to the Inbox. */
export async function restoreLiveMessage(
  config: AccountConfig,
  folderPath: string,
  uid: number,
  from: 'Trash' | 'Junk'
): Promise<string> {
  const client = await getPooledImapClient(config);
  const kind = await getFolderKind(client, folderPath);
  if (kind !== from) throw new Error(from === 'Trash' ? 'Only messages in Trash can be restored.' : 'Only messages in Junk can be marked as not spam.');
  const inbox = (await findFolderPath(client, 'Inbox')) || 'INBOX';
  const lock = await client.getMailboxLock(folderPath);
  try {
    await moveChecked(client, uid, inbox);
    return inbox;
  } finally {
    lock.release();
  }
}

export async function markLiveMessageSpam(
  config: AccountConfig,
  folderPath: string,
  uid: number,
  junkFolder?: string
): Promise<boolean> {
  const client = await getPooledImapClient(config);

  let targetFolder = junkFolder;
  if (!targetFolder) {
    targetFolder = await findFolderPath(client, 'Junk');
    if (!targetFolder) {
      await client.mailboxCreate('Junk');
      targetFolder = 'Junk';
    }
  }
  if (folderPath === targetFolder) throw new Error('The message is already in Junk.');

  const lock = await client.getMailboxLock(folderPath);
  try {
    await requireMessage(client, uid);
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    await moveChecked(client, uid, targetFolder);
    return true;
  } finally {
    lock.release();
  }
}
