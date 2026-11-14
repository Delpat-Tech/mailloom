import { ImapFlow, SearchObject, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createHash } from 'node:crypto';
import type { AccountConfig, MailboxFolder, MessageHeader, ParsedEmailMessage, SpecialUseFolder } from '../types.js';
import { renderEmail, findCidReferences } from '../utils/sanitize.js';
import { sniffImage } from './richbody.js';
import { classifyParts, findPart, isValidPartId, type LeafPart, type MessageParts } from './mailparts.js';
import { cleanFilename, decodeCharset, decodeTransfer, htmlToText, makeSnippet } from '../utils/mime.js';
import { bounceCandidate, parseDsn, parsePlainBounce, type BounceCandidate } from './bounce.js';
import { referencesFromHeaderBlock, threadIdFor } from './threading.js';

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

export function createImapClient(
  config: AccountConfig,
  extra: { connectionTimeout?: number; greetingTimeout?: number; maxIdleTime?: number; autoIdleDelay?: number; disableAutoIdle?: boolean } = {}
): ImapFlow {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: {
      user: config.imapUser,
      pass: config.imapPass
    },
    logger: false,
    // Certificate checks are on unless the server config explicitly turns them off for local testing.
    tls: {
      rejectUnauthorized: config.tls?.rejectUnauthorized ?? true,
      ...(config.tls?.servername ? { servername: config.tls.servername } : {})
    },
    connectionTimeout: extra.connectionTimeout ?? 15000,
    greetingTimeout: extra.greetingTimeout ?? 10000,
    ...(extra.maxIdleTime ? { maxIdleTime: extra.maxIdleTime } : {}),
    ...(extra.autoIdleDelay ? { autoIdleDelay: extra.autoIdleDelay } : {}),
    ...(extra.disableAutoIdle ? { disableAutoIdle: true } : {})
  });
}

// -------------------------------------------------------------
// CONNECTION POOL, ONE CONNECTION PER SIGNED-IN SESSION
// Keyed by the session (config.sessionKey), never by user@host, so a
// connection opened with one session's password is only ever used by that
// session. Concurrent requests share one in-flight connect (no duplicate
// connections). Idle connections close after 60s (Dovecot connection limits).
// -------------------------------------------------------------
interface PoolEntry {
  client?: ImapFlow;
  connecting?: Promise<ImapFlow>;
  timer?: NodeJS.Timeout;
  lastUsed: number;
  /** When the connection was opened; connections are replaced after MAX_AGE_MS. */
  connectedAt: number;
}

/** The mail server refused the stored credentials (password changed or mailbox closed). */
export class ImapAuthError extends Error {
  constructor() {
    super('IMAP authentication failed');
    this.name = 'ImapAuthError';
  }
}

/**
 * True when the server refused the password: response code AUTHENTICATIONFAILED, or a plain NO to
 * LOGIN with no response code. imapflow sets authenticationFailed on every NO to LOGIN, so a NO that
 * carries any other code (`[UNAVAILABLE] Temporary authentication failure`, `[SERVERBUG]`, ...) is
 * "server trouble", never a wrong password.
 */
export function isPasswordRefused(err: unknown): boolean {
  const e = err as { authenticationFailed?: boolean; serverResponseCode?: string } | null;
  if (!e) return false;
  if (e.serverResponseCode === 'AUTHENTICATIONFAILED') return true;
  return e.authenticationFailed === true && !e.serverResponseCode;
}

/** The server said AUTHENTICATIONFAILED outright (a plain NO could still be a server hiccup). */
export function isDefinitePasswordRefusal(err: unknown): boolean {
  return (err as { serverResponseCode?: string } | null)?.serverResponseCode === 'AUTHENTICATIONFAILED';
}

export function isImapAuthError(err: unknown): boolean {
  return err instanceof ImapAuthError || isPasswordRefused(err);
}

const connectionPool = new Map<string, PoolEntry>();
const IDLE_TIMEOUT_MS = 60 * 1000; // Auto-close connection after 60s of inactivity
// A connection never lives longer than this, so a password change or a closed mailbox shows up
// within minutes even for a busy session. The replacement uses the session's stored credentials.
let maxConnectionAgeMs = 10 * 60 * 1000;

/** Test hook: shorten the connection age cap. Returns the previous value. */
export function setMaxConnectionAgeMs(ms: number): number {
  const previous = maxConnectionAgeMs;
  maxConnectionAgeMs = ms;
  return previous;
}

function getPoolKey(config: AccountConfig): string {
  if (config.sessionKey) return `s:${config.sessionKey}`;
  // No session (e.g. a direct call in a test): key on everything that
  // authenticates the connection, including the password, so nothing is shared
  // between different credentials.
  const passHash = createHash('sha256').update(config.imapPass, 'utf8').digest('hex');
  return `c:${config.imapUser}@${config.imapHost}:${config.imapPort}:${passHash}`;
}

function armIdleTimer(key: string, entry: PoolEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.lastUsed = Date.now();
  entry.timer = setTimeout(() => {
    void closePooledClient(key);
  }, IDLE_TIMEOUT_MS);
  entry.timer.unref();
}

export async function closePooledClient(key: string): Promise<void> {
  const entry = connectionPool.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  connectionPool.delete(key);
  let client = entry.client;
  if (!client && entry.connecting) {
    client = await entry.connecting.catch(() => undefined);
  }
  try {
    if (client?.usable) {
      await client.logout();
    } else {
      client?.close();
    }
  } catch {
    // Ignore disconnect errors during reaper
  }
}

/** Closes the pooled IMAP connection of one session (sign-out, expiry). */
export async function closeUserSession(config: AccountConfig): Promise<void> {
  await closePooledClient(getPoolKey(config));
}

/** Closes the pooled IMAP connection for a session key (see AccountConfig.sessionKey). */
export async function closeSessionConnection(sessionKey: string): Promise<void> {
  await closePooledClient(`s:${sessionKey}`);
}

/** Closes every pooled connection (server shutdown). */
export async function closeAllPooledClients(): Promise<void> {
  await Promise.all([...connectionPool.keys()].map((key) => closePooledClient(key)));
}

export async function getPooledImapClient(config: AccountConfig): Promise<ImapFlow> {
  const key = getPoolKey(config);
  let existing = connectionPool.get(key);

  if (existing?.client?.usable && Date.now() - existing.connectedAt >= maxConnectionAgeMs) {
    // Too old: close it and open a fresh one below (another request may have done so meanwhile).
    await closePooledClient(key);
    existing = connectionPool.get(key);
  }
  if (existing?.client?.usable) {
    armIdleTimer(key, existing);
    return existing.client;
  }
  if (existing?.connecting) {
    // Another request is already opening this session's connection: share it.
    return existing.connecting;
  }
  if (existing) {
    // Stale entry (connection dropped): discard before reconnecting.
    if (existing.timer) clearTimeout(existing.timer);
    connectionPool.delete(key);
  }

  const entry: PoolEntry = { lastUsed: Date.now(), connectedAt: Date.now() };
  const client = createImapClient(config);

  const forget = () => {
    // Only remove the entry if it still belongs to this client.
    const current = connectionPool.get(key);
    if (current === entry) {
      if (entry.timer) clearTimeout(entry.timer);
      connectionPool.delete(key);
    }
  };
  // Prevent unhandled error event crash on socket timeouts or disconnects
  client.on('error', forget);
  client.on('close', forget);

  entry.connecting = client.connect().then(
    () => {
      entry.client = client;
      entry.connecting = undefined;
      entry.connectedAt = Date.now();
      if (connectionPool.get(key) === entry) {
        armIdleTimer(key, entry);
      }
      return client;
    },
    (err: unknown) => {
      forget();
      throw isImapAuthError(err) ? new ImapAuthError() : err;
    }
  );
  connectionPool.set(key, entry);
  return entry.connecting;
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
export type ListFilter = 'all' | 'unread' | 'starred' | 'attachments';
export const LIST_FILTERS: readonly ListFilter[] = ['all', 'unread', 'starred', 'attachments'];

/** Labels are IMAP keywords "$label_<id>", so they live on the mailbox and show in other clients. */
export const LABEL_KEYWORD_PREFIX = '$label_';

const LIST_FETCH = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
  headers: ['references']
};

interface ListItem {
  header: MessageHeader;
  parts: MessageParts;
  bounce?: BounceCandidate | null;
}

/** `where` names the folder and UIDVALIDITY, for messages without a Message-ID (their own thread). */
function toHeader(msg: FetchMessageObject, where = ''): ListItem {
  const env = msg.envelope;
  const fromAddr = env?.from?.[0] || { name: 'Unknown', address: 'unknown@example.com' };
  const toAddrs = (env?.to || []).map((t) => ({ name: t.name || '', address: t.address || '' }));
  const ccAddrs = (env?.cc || []).map((t) => ({ name: t.name || '', address: t.address || '' }));
  const flagsArr = Array.from(msg.flags || []);
  const parts = classifyParts(msg.bodyStructure);
  return {
    parts,
    bounce: bounceCandidate(fromAddr.address || '', env?.subject || '', msg.bodyStructure, parts.all),
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
      // First file name and how many, for the list's attachment chip (the file list itself is in the reader).
      attachmentCount: parts.attachments.length,
      attachmentName: (parts.attachments[0]?.filename || '').slice(0, 120) || undefined,
      size: msg.size || 0,
      snippet: '',
      labels: flagsArr.filter((f) => f.startsWith(LABEL_KEYWORD_PREFIX)).map((f) => f.slice(LABEL_KEYWORD_PREFIX.length)),
      threadId: threadIdFor({
        messageId: env?.messageId,
        inReplyTo: env?.inReplyTo,
        references: referencesFromHeaderBlock(msg.headers),
        fallbackKey: `${where}:${msg.uid}`
      })
    }
  };
}

/** Fill `snippet` (first ~140 characters of text) with one small partial fetch per distinct text part number. */
async function addSnippets(client: ImapFlow, items: ListItem[]): Promise<void> {
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

const BOUNCE_PART_BYTES = 16 * 1024;

/** Bounces get `bounce` (original subject, recipient, reason) from a small partial fetch of their report parts. */
async function addBounces(client: ImapFlow, items: ListItem[], ownEmail: string): Promise<void> {
  for (const it of items) {
    const c = it.bounce;
    if (!c) continue;
    const wanted = [c.kind === 'dsn' ? c.statusPart : undefined, c.kind === 'dsn' ? c.originalPart : undefined, c.textPart].filter(
      (p): p is LeafPart => Boolean(p)
    );
    if (wanted.length === 0) continue;
    try {
      const m = await client.fetchOne(
        String(it.header.uid),
        { uid: true, bodyParts: wanted.map((p) => ({ key: p.partId, start: 0, maxLength: BOUNCE_PART_BYTES })) },
        { uid: true }
      );
      const read = (p?: LeafPart): string => {
        if (!p || !m) return '';
        const raw = m.bodyParts?.get(p.partId);
        return raw ? decodeCharset(decodeTransfer(raw, p.encoding), p.charset) : '';
      };
      it.header.bounce =
        c.kind === 'dsn'
          ? await parseDsn(read(c.statusPart), read(c.originalPart), read(c.textPart))
          : await parsePlainBounce(read(c.textPart), ownEmail);
    } catch {
      // Shown as an ordinary message when the report cannot be read.
    }
  }
}

/**
 * List entries for the given UIDs of the folder the caller has locked, in the order given:
 * header, snippet, labels, threadId and (for bounces) the bounce summary.
 */
export async function fetchListItems(client: ImapFlow, uids: number[], ownEmail: string): Promise<MessageHeader[]> {
  if (uids.length === 0) return [];
  const mb = client.mailbox;
  const where = mb ? `${mb.path}:${mb.uidValidity}` : '';
  const byUid = new Map<number, ListItem>();
  for await (const msg of client.fetch(uids, LIST_FETCH, { uid: true })) byUid.set(msg.uid, toHeader(msg, where));
  const items = uids.map((u) => byUid.get(u)).filter((x): x is ListItem => Boolean(x));
  await addSnippets(client, items);
  await addBounces(client, items, ownEmail);
  return items.map((i) => i.header);
}

/** IMAP SEARCH criteria for the list filters (attachments is narrowed further by BODYSTRUCTURE). */
function filterCriteria(filter: ListFilter): SearchObject {
  if (filter === 'unread') return { seen: false };
  if (filter === 'starred') return { flagged: true };
  if (filter === 'attachments') {
    // Cheap server-side pre-filter: mail with attachments is multipart/mixed (or a bare application/* part).
    return { or: [{ header: { 'content-type': 'multipart/mixed' } }, { header: { 'content-type': 'application/' } }] };
  }
  return {};
}

/** Cached has-attachments per UID for a folder at a UIDVALIDITY (the conversation index). */
export type AttachmentCache = (folder: string, uidValidity: string, uids: number[]) => Map<number, boolean>;

/** Keep only the UIDs whose BODYSTRUCTURE lists a real attachment; cached answers skip the fetch. */
async function withAttachments(client: ImapFlow, uids: number[], cache?: AttachmentCache): Promise<number[]> {
  if (uids.length === 0) return [];
  const mb = client.mailbox;
  const known = cache && mb ? cache(mb.path, String(mb.uidValidity ?? ''), uids) : new Map<number, boolean>();
  const unknown = uids.filter((u) => !known.has(u));
  if (unknown.length > 0) {
    for await (const msg of client.fetch(unknown, { uid: true, bodyStructure: true }, { uid: true })) {
      known.set(msg.uid, classifyParts(msg.bodyStructure).attachments.length > 0);
    }
  }
  return uids.filter((u) => known.get(u) === true);
}

export async function getLiveMessages(
  config: AccountConfig,
  folderPath: string,
  page = 1,
  limit = 50,
  filters?: SearchFilters,
  filter: ListFilter = 'all',
  attachmentCache?: AttachmentCache
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

    if (hasFilters || filter !== 'all') {
      const searchCriteria: SearchObject = filterCriteria(filter);
      if (filters?.from?.trim()) searchCriteria.from = filters.from.trim();
      if (filters?.to?.trim()) searchCriteria.to = filters.to.trim();
      if (filters?.subject?.trim()) searchCriteria.subject = filters.subject.trim();
      if (filters?.since?.trim()) {
        const d = new Date(filters.since.trim());
        if (!isNaN(d.getTime())) searchCriteria.since = d;
      }
      if (filters?.before?.trim()) {
        const d = new Date(filters.before.trim());
        if (!isNaN(d.getTime())) searchCriteria.before = d;
      }
      if (filters?.search?.trim()) {
        searchCriteria.text = filters.search.trim();
      }
      if (Object.keys(searchCriteria).length === 0) searchCriteria.all = true;

      const searchResult = await client.search(searchCriteria, { uid: true });
      if (!searchResult || !Array.isArray(searchResult) || searchResult.length === 0) {
        return { messages: [], total: 0 };
      }

      // Sort descending (newest UID first)
      let sortedUids = [...searchResult].sort((a, b) => b - a);
      if (filter === 'attachments') sortedUids = await withAttachments(client, sortedUids, attachmentCache);
      const total = sortedUids.length;
      const startIdx = (page - 1) * limit;
      const pagedUids = sortedUids.slice(startIdx, startIdx + limit);
      if (pagedUids.length === 0) return { messages: [], total };
      return { messages: await fetchListItems(client, pagedUids, config.email), total };
    }

    // Fast range pagination for default view
    const total = mailboxTotal;
    const startSeq = Math.max(1, total - (page * limit) + 1);
    const endSeq = Math.max(1, total - ((page - 1) * limit));
    if ((page - 1) * limit >= total) return { messages: [], total };
    const range = `${startSeq}:${endSeq}`;

    const uids: number[] = [];
    for await (const msg of client.fetch(range, { uid: true })) uids.push(msg.uid);
    uids.sort((a, b) => b - a);
    return { messages: await fetchListItems(client, uids, config.email), total };
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
  /** Do not mark the message as read (used for prefetching). */
  peek?: boolean;
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
    if (!flags.includes('\\Seen') && !options.peek) {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      flags.push('\\Seen');
    }

    let parts = classifyParts(msg.bodyStructure);

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
      parts = classifyParts(msg.bodyStructure, wanted);
      const cids = new Map<string, string>();
      let budget = MAX_INLINE_TOTAL_BYTES;
      for (const p of parts.inline) {
        const key = p.cid?.toLowerCase();
        if (!key || !wanted.has(key) || cids.has(key)) continue;
        if (p.size > MAX_INLINE_IMAGE_BYTES * 1.4 || budget <= 0) continue;
        try {
          const buf = await readPart(client, uid, p, MAX_INLINE_IMAGE_BYTES);
          if (!buf || buf.length === 0 || buf.length >= MAX_INLINE_IMAGE_BYTES) continue;
          // Only real png/jpeg/gif/webp bytes become data: URIs, labelled by what they are, not by the sender's claim.
          const realType = sniffImage(buf);
          if (!realType) continue;
          budget -= buf.length;
          cids.set(key, `data:${realType};base64,${buf.toString('base64')}`);
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
  // imapflow fetches the chunks after the first 64 KB by UID in whichever mailbox is selected at that
  // moment, so the lock must stay held until the stream has been fully consumed (end, error or close).
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lock.release();
  };
  try {
    const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
    if (!msg) {
      release();
      return null;
    }
    const part = findPart(msg.bodyStructure, partId);
    if (!part) {
      release();
      return null;
    }

    const dl = await client.download(String(uid), partId, { uid: true });
    if (!dl || !dl.content) {
      release();
      return null;
    }
    dl.content.once('end', release);
    dl.content.once('error', release);
    dl.content.once('close', release);

    const ext = part.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
    return {
      stream: dl.content,
      filename: cleanFilename(part.filename, `attachment-${partId}.${ext}`),
      contentType: part.type
    };
  } catch (err) {
    release();
    throw err;
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
    const uids = ((await client.search({ all: true }, { uid: true })) || []) as number[];
    if (uids.length === 0) return 0;
    const ok = await client.messageDelete(uids, { uid: true });
    const remaining = ((await client.search({ uid: uids.join(',') }, { uid: true })) || []) as number[];
    if (!ok || remaining.length > 0) {
      throw new Error(`Only ${uids.length - remaining.length} of ${uids.length} messages could be deleted.`);
    }
    return uids.length;
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
