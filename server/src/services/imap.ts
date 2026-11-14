import { ImapFlow, SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createHash } from 'node:crypto';
import type { AccountConfig, MailboxFolder, MessageHeader, ParsedEmailMessage, SpecialUseFolder } from '../types.js';
import { cleanEmailHtml } from '../utils/sanitize.js';

export interface SearchFilters {
  search?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  before?: string;
}

function detectSpecialUse(name: string, specialUse?: string): SpecialUseFolder {
  if (specialUse) {
    const s = specialUse.replace(/^\\/, '').toLowerCase();
    if (s.includes('inbox')) return 'Inbox';
    if (s.includes('sent')) return 'Sent';
    if (s.includes('draft')) return 'Drafts';
    if (s.includes('trash')) return 'Trash';
    if (s.includes('junk') || s.includes('spam')) return 'Junk';
    if (s.includes('archive')) return 'Archive';
    if (s.includes('all')) return 'All';
  }
  const n = name.toLowerCase();
  if (n === 'inbox') return 'Inbox';
  if (n.includes('sent')) return 'Sent';
  if (n.includes('draft')) return 'Drafts';
  if (n.includes('trash') || n.includes('bin') || n.includes('deleted')) return 'Trash';
  if (n.includes('spam') || n.includes('junk')) return 'Junk';
  if (n.includes('archive')) return 'Archive';
  return 'Inbox';
}

export function createImapClient(
  config: AccountConfig,
  extra: { connectionTimeout?: number; greetingTimeout?: number } = {}
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
    greetingTimeout: extra.greetingTimeout ?? 10000
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

export function isImapAuthError(err: unknown): boolean {
  if (err instanceof ImapAuthError) return true;
  const e = err as { authenticationFailed?: boolean; serverResponseCode?: string } | null;
  return !!e && (e.authenticationFailed === true || e.serverResponseCode === 'AUTHENTICATIONFAILED');
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

    folders.push({
      path: mb.path,
      name: mb.name,
      delimiter: mb.delimiter,
      flags: Array.from(mb.flags || []),
      specialUse: detectSpecialUse(mb.name, mb.specialUse),
      unreadCount,
      totalCount
    });
  }

  return folders;
}

export async function getLiveMessages(
  config: AccountConfig,
  folderPath: string,
  page = 1,
  limit = 50,
  filters?: SearchFilters
): Promise<{ messages: MessageHeader[]; total: number }> {
  const client = await getPooledImapClient(config);
  const headers: MessageHeader[] = [];

  const lock = await client.getMailboxLock(folderPath, { readOnly: true });
  try {
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

      const messagesGen = client.fetch(pagedUids, {
        uid: true,
        flags: true,
        envelope: true,
        internalDate: true,
        size: true
      }, { uid: true });

      const uidToHeader = new Map<number, MessageHeader>();
      for await (const msg of messagesGen) {
        const env = msg.envelope;
        const fromAddr = env?.from?.[0] || { name: 'Unknown', address: 'unknown@example.com' };
        const toAddrs = (env?.to || []).map((t) => ({ name: t.name || '', address: t.address || '' }));
        const ccAddrs = (env?.cc || []).map((t) => ({ name: t.name || '', address: t.address || '' }));
        const flagsArr = Array.from(msg.flags || []);

        uidToHeader.set(msg.uid, {
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
          hasAttachments: false,
          size: msg.size || 0,
          snippet: ''
        });
      }

      const orderedHeaders = pagedUids.map((uid) => uidToHeader.get(uid)).filter(Boolean) as MessageHeader[];
      return { messages: orderedHeaders, total };
    }

    // Fast range pagination for default view
    const total = mailboxTotal;
    const startSeq = Math.max(1, total - (page * limit) + 1);
    const endSeq = Math.max(1, total - ((page - 1) * limit));
    const range = `${startSeq}:${endSeq}`;

    const messagesGen = client.fetch(range, {
      uid: true,
      flags: true,
      envelope: true,
      internalDate: true,
      size: true
    });

    for await (const msg of messagesGen) {
      const env = msg.envelope;
      const fromAddr = env?.from?.[0] || { name: 'Unknown', address: 'unknown@example.com' };
      const toAddrs = (env?.to || []).map((t) => ({ name: t.name || '', address: t.address || '' }));
      const ccAddrs = (env?.cc || []).map((t) => ({ name: t.name || '', address: t.address || '' }));
      const flagsArr = Array.from(msg.flags || []);

      headers.push({
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
        hasAttachments: false,
        size: msg.size || 0,
        snippet: ''
      });
    }

    headers.reverse();
    return { messages: headers, total };
  } finally {
    lock.release();
  }
}

export async function getLiveMessageDetail(
  config: AccountConfig,
  folderPath: string,
  uid: number
): Promise<ParsedEmailMessage | null> {
  const client = await getPooledImapClient(config);

  const lock = await client.getMailboxLock(folderPath);
  try {
    // Mark as seen
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });

    const rawMsg = await client.download(String(uid), undefined, { uid: true });
    if (!rawMsg || !rawMsg.content) return null;

    const parsed = await simpleParser(rawMsg.content);
    const flagsArr = ['\\Seen'];

    const attachments = (parsed.attachments || []).map((att, i) => ({
      partId: String(i + 1),
      filename: att.filename || `attachment-${i + 1}`,
      contentType: att.contentType || 'application/octet-stream',
      size: att.size || att.content?.length || 0,
      contentId: att.cid,
      isInline: Boolean(att.related)
    }));

    const fromFirst = parsed.from?.value?.[0] || { name: '', address: '' };
    const toArr = (parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : []).flatMap((t) =>
      (t.value || []).map((v) => ({ name: v.name || '', address: v.address || '' }))
    );
    const ccArr = (parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]) : []).flatMap((t) =>
      (t.value || []).map((v) => ({ name: v.name || '', address: v.address || '' }))
    );

    const htmlBody = parsed.html ? cleanEmailHtml(parsed.html) : parsed.textAsHtml ? cleanEmailHtml(parsed.textAsHtml) : undefined;

    return {
      uid,
      id: parsed.messageId || String(uid),
      subject: parsed.subject || '(No Subject)',
      from: { name: fromFirst.name || fromFirst.address || 'Unknown', address: fromFirst.address || '' },
      to: toArr,
      cc: ccArr,
      date: (parsed.date || new Date()).toISOString(),
      flags: flagsArr,
      isSeen: true,
      isFlagged: false,
      html: htmlBody,
      text: parsed.text || '',
      attachments
    };
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
  partId?: string
): Promise<{ stream: NodeJS.ReadableStream; filename: string; contentType: string } | null> {
  const client = await getPooledImapClient(config);
  const lock = await client.getMailboxLock(folderPath, { readOnly: true });
  try {
    const rawMsg = await client.download(String(uid), partId, { uid: true });
    if (!rawMsg || !rawMsg.content) return null;

    return {
      stream: rawMsg.content,
      filename: rawMsg.meta?.filename || `attachment-${partId || uid}`,
      contentType: rawMsg.meta?.contentType || 'application/octet-stream'
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
    if (value) {
      await client.messageFlagsAdd(String(uid), [imapFlag], { uid: true });
    } else {
      await client.messageFlagsRemove(String(uid), [imapFlag], { uid: true });
    }
    return true;
  } finally {
    lock.release();
  }
}

export async function moveLiveMessage(
  config: AccountConfig,
  folderPath: string,
  uid: number,
  targetFolder: string
): Promise<boolean> {
  const client = await getPooledImapClient(config);

  const lock = await client.getMailboxLock(folderPath);
  try {
    await client.messageMove(String(uid), targetFolder, { uid: true });
    return true;
  } finally {
    lock.release();
  }
}

export async function deleteLiveMessage(
  config: AccountConfig,
  folderPath: string,
  uid: number
): Promise<boolean> {
  const client = await getPooledImapClient(config);

  const lock = await client.getMailboxLock(folderPath);
  try {
    await client.messageDelete(String(uid), { uid: true });
    return true;
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
    const list = await client.list();
    const junkMb = list.find(
      (m) =>
        m.specialUse === '\\Junk' ||
        detectSpecialUse(m.name, m.specialUse) === 'Junk' ||
        m.name.toLowerCase() === 'junk' ||
        m.name.toLowerCase() === 'spam'
    );
    targetFolder = junkMb ? junkMb.path : 'Junk';
  }

  const lock = await client.getMailboxLock(folderPath);
  try {
    // 1. Mark as \Seen
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    // 2. Move to junk folder if not already in junk
    if (folderPath.toLowerCase() !== targetFolder.toLowerCase()) {
      await client.messageMove(String(uid), targetFolder, { uid: true });
    }
    return true;
  } finally {
    lock.release();
  }
}
