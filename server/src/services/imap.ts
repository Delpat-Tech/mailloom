import { ImapFlow, SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';
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

export async function getLiveMailboxes(config: AccountConfig): Promise<MailboxFolder[]> {
  const client = await getPooledImapClient(config);
  const folders: MailboxFolder[] = [];

  const list = await client.list();
  for (const mb of list) {
    let unreadCount = 0;
    let totalCount = 0;
    try {
      const status = await client.status(mb.path, { unseen: true, messages: true });
      unreadCount = status.unseen || 0;
      totalCount = status.messages || 0;
    } catch {
      // Status might fail on non-selectable parent folders
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
