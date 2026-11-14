import { friendlyError } from './errors.js';
import type { MailboxFolder, MessageHeader, ParsedEmailMessage, UserAccount, StoredAccountProfile } from '../types.js';

/*
 * Sessions live on the server. The browser holds one httpOnly cookie per signed-in
 * account (JavaScript cannot read it). This module only keeps:
 *  - the active account's public handle (which account a request is for), and
 *  - a cache of account names and unread counts for the account switcher.
 * Neither is a secret. Every API call names its account with X-Mailloom-Account.
 */

const ACCOUNTS_KEY = 'mailloom_accounts_v2';
const ACTIVE_HANDLE_KEY = 'mailloom_active_handle';
const LEGACY_KEYS = ['mailloom_active_token', 'mailloom_saved_accounts', 'roundcube_session_token'];
export const SESSION_EXPIRED_EVENT = 'mailloom:session-expired';

export interface SessionExpiredDetail {
  handle: string;
  email?: string;
}

// Remove credential-bearing tokens stored by older versions.
try {
  for (const key of LEGACY_KEYS) localStorage.removeItem(key);
} catch {
  // Storage unavailable (private mode): nothing to clean.
}

function readAccounts(): StoredAccountProfile[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as StoredAccountProfile[]) : [];
    return Array.isArray(parsed) ? parsed.filter((a) => a && typeof a.handle === 'string') : [];
  } catch {
    return [];
  }
}

function writeAccounts(accounts: StoredAccountProfile[]): void {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    // Ignore storage quota errors: the server is the source of truth.
  }
}

// Per tab: switching accounts in one tab does not change the account another tab uses.
let activeHandle: string | null = (() => {
  try {
    return sessionStorage.getItem(ACTIVE_HANDLE_KEY) || localStorage.getItem(ACTIVE_HANDLE_KEY);
  } catch {
    return null;
  }
})();

export function getActiveHandle(): string | null {
  return activeHandle;
}

export function setActiveHandle(handle: string | null): void {
  activeHandle = handle;
  try {
    if (handle) {
      sessionStorage.setItem(ACTIVE_HANDLE_KEY, handle);
      localStorage.setItem(ACTIVE_HANDLE_KEY, handle);
    } else {
      sessionStorage.removeItem(ACTIVE_HANDLE_KEY);
      localStorage.removeItem(ACTIVE_HANDLE_KEY);
    }
  } catch {
    // Ignore
  }
}

export function getStoredAccounts(): StoredAccountProfile[] {
  return readAccounts();
}

/** Replace the cached list with the server's view, keeping cached unread counts. */
export function syncStoredAccounts(accounts: UserAccount[]): StoredAccountProfile[] {
  const cached = readAccounts();
  const next: StoredAccountProfile[] = accounts.map((acc) => {
    const old = cached.find((c) => c.handle === acc.handle || c.email.toLowerCase() === acc.email.toLowerCase());
    return {
      handle: acc.handle,
      email: acc.email,
      name: acc.name,
      isDemo: acc.isDemo,
      rememberMe: acc.rememberMe,
      unreadCount: old?.unreadCount,
      lastActive: old?.lastActive ?? Date.now()
    };
  });
  next.sort((a, b) => b.lastActive - a.lastActive);
  writeAccounts(next);
  return next;
}

export function saveAccountProfile(acc: UserAccount): void {
  const accounts = readAccounts().filter(
    (a) => a.handle !== acc.handle && a.email.toLowerCase() !== acc.email.toLowerCase()
  );
  accounts.unshift({
    handle: acc.handle,
    email: acc.email,
    name: acc.name,
    isDemo: acc.isDemo,
    rememberMe: acc.rememberMe,
    lastActive: Date.now()
  });
  writeAccounts(accounts);
}

export function removeStoredAccount(handle: string): void {
  writeAccounts(readAccounts().filter((a) => a.handle !== handle));
  if (activeHandle === handle) setActiveHandle(null);
}

export function findStoredAccount(email: string): StoredAccountProfile | undefined {
  return readAccounts().find((a) => a.email.toLowerCase() === email.toLowerCase());
}

export function touchStoredAccount(handle: string): void {
  const accounts = readAccounts();
  const target = accounts.find((a) => a.handle === handle);
  if (target) {
    target.lastActive = Date.now();
    writeAccounts(accounts);
  }
}

export function updateStoredAccountUnread(email: string, unreadCount: number): void {
  const accounts = readAccounts();
  const target = accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
  if (target) {
    target.unreadCount = unreadCount;
    writeAccounts(accounts);
  }
}

const API_BASE =
  typeof window !== 'undefined' && window.location.pathname.startsWith('/mail')
    ? '/mail/api'
    : '/api';

/** Error from the API, with the HTTP status and the server's error code when it sent one. */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isSessionEndedError(err: unknown): boolean {
  return (
    err instanceof ApiError && err.status === 401 && (err.code === 'SESSION_EXPIRED' || err.code === 'NOT_SIGNED_IN')
  );
}

interface RequestOptions extends RequestInit {
  /** Account to act as; defaults to the active account. null sends no account. */
  account?: string | null;
}

export async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { account, ...init } = options;
  const handle = account === undefined ? activeHandle : account;
  const headers = new Headers(init.headers || {});
  if (handle) {
    headers.set('X-Mailloom-Account', handle);
  }
  // Only declare JSON when there is a JSON body (an empty JSON body is a 400 on Fastify).
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${endpoint}`, {
      ...init,
      headers,
      credentials: 'same-origin'
    });
  } catch {
    throw new ApiError('Cannot reach Mailloom. Check your connection and try again.', 0, 'NETWORK');
  }

  if (!res.ok) {
    const errorBody = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    // Anything technical the server (or a proxy) sent is replaced by a plain sentence; status and code stay on the error.
    const fallback =
      res.status === 401
        ? 'You have been signed out. Sign in again to continue.'
        : res.status === 404
          ? 'That is no longer there.'
          : res.status === 429
            ? 'Too many requests at once. Wait a moment and try again.'
            : res.status >= 500
              ? 'The mail server is having trouble. Try again in a moment.'
              : 'That did not work. Please try again.';
    const err = new ApiError(friendlyError(errorBody.error || '', fallback), res.status, errorBody.code);
    if (handle && isSessionEndedError(err)) {
      const email = readAccounts().find((a) => a.handle === handle)?.email;
      window.dispatchEvent(
        new CustomEvent<SessionExpiredDetail>(SESSION_EXPIRED_EVENT, { detail: { handle, email } })
      );
    }
    throw err;
  }

  return res.json() as Promise<T>;
}

/** Subscribe to "this account's session has ended" (401). Returns an unsubscribe function. */
export function onSessionExpired(listener: (detail: SessionExpiredDetail) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<SessionExpiredDetail>).detail);
  window.addEventListener(SESSION_EXPIRED_EVENT, handler);
  return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
}

export interface SendEmailResponse {
  /** true only when every recipient accepted the mail */
  success: boolean;
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  sentCopySaved?: boolean;
  /** sent, but the Sent copy could not be saved */
  warning?: string;
  /** set when some recipients did not receive the mail */
  error?: string;
}

export type ListFilter = 'all' | 'unread' | 'starred' | 'attachments';

export interface SearchFilterParams {
  search?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  before?: string;
}

export const api = {
  /** Finds a message of the active mailbox by Message-ID. Resolves null when it is not there (moved away or deleted). */
  locateMessage: async (messageId: string): Promise<{ folder: string; uid: number } | null> => {
    try {
      return await request<{ folder: string; uid: number }>(`/messages/locate?message_id=${encodeURIComponent(messageId)}`);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  },

  // Auth
  /** Signs in. The server sets this account's session cookie; nothing secret is returned. */
  connect: async (data: { email: string; password: string; rememberMe: boolean }): Promise<{ account: UserAccount }> => {
    const res = await request<{ account: UserAccount }>('/auth/connect', {
      method: 'POST',
      body: JSON.stringify(data),
      account: null
    });
    saveAccountProfile(res.account);
    setActiveHandle(res.account.handle);
    return res;
  },

  getCurrentUser: async (handle?: string): Promise<{ account: UserAccount }> => {
    return request<{ account: UserAccount }>('/auth/me', handle ? { account: handle } : {});
  },

  /** All accounts signed in in this browser, according to the server. */
  getAccounts: async (): Promise<{ accounts: UserAccount[] }> => {
    return request<{ accounts: UserAccount[] }>('/auth/accounts', { account: null });
  },

  /** Signs one account out (this browser only). Throws if the server could not be told. */
  logout: async (handle: string | null = activeHandle, pushEndpoint: string | null = null): Promise<void> => {
    if (!handle) return;
    // The device's push endpoint lets the server drop its notification rows even if the session already expired.
    await request('/auth/logout', { method: 'POST', account: handle, ...(pushEndpoint ? { body: JSON.stringify({ endpoint: pushEndpoint }) } : {}) });
    removeStoredAccount(handle);
  },

  // Mailboxes
  getMailboxes: async (): Promise<{ folders: MailboxFolder[] }> => {
    return request<{ folders: MailboxFolder[] }>('/mailboxes');
  },

  // Messages
  getMessages: async (
    folderPath: string,
    page = 1,
    limit = 50,
    search = '',
    filters?: SearchFilterParams,
    filter: ListFilter = 'all'
  ): Promise<{ messages: MessageHeader[]; total: number }> => {
    const encoded = encodeURIComponent(folderPath);
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filter !== 'all') query.set('filter', filter);
    if (search.trim()) query.set('search', search.trim());
    if (filters?.from?.trim()) query.set('from', filters.from.trim());
    if (filters?.to?.trim()) query.set('to', filters.to.trim());
    if (filters?.subject?.trim()) query.set('subject', filters.subject.trim());
    if (filters?.since?.trim()) query.set('since', filters.since.trim());
    if (filters?.before?.trim()) query.set('before', filters.before.trim());
    return request<{ messages: MessageHeader[]; total: number }>(`/mailboxes/${encoded}/messages?${query}`);
  },

  markSpam: async (
    folderPath: string,
    uid: number,
    junkFolder?: string
  ): Promise<{ success: boolean }> => {
    const encoded = encodeURIComponent(folderPath);
    return request<{ success: boolean }>(`/mailboxes/${encoded}/messages/${uid}/spam`, {
      method: 'POST',
      body: JSON.stringify({ junkFolder })
    });
  },

  getMessageDetail: async (
    folderPath: string,
    uid: number,
    options: { showImages?: boolean; peek?: boolean } = {}
  ): Promise<ParsedEmailMessage> => {
    const encoded = encodeURIComponent(folderPath);
    const params = new URLSearchParams();
    if (options.showImages) params.set('images', '1');
    // peek: read without marking as read (prefetching neighbours).
    if (options.peek) params.set('peek', '1');
    const q = params.toString() ? `?${params}` : '';
    return request<ParsedEmailMessage>(`/mailboxes/${encoded}/messages/${uid}${q}`);
  },

  toggleFlag: async (
    folderPath: string,
    uid: number,
    flag: 'isSeen' | 'isFlagged',
    value: boolean
  ): Promise<{ success: boolean }> => {
    const encoded = encodeURIComponent(folderPath);
    return request<{ success: boolean }>(`/mailboxes/${encoded}/messages/${uid}/flags`, {
      method: 'POST',
      body: JSON.stringify({ flag, value })
    });
  },

  moveMessage: async (
    folderPath: string,
    uid: number,
    targetFolder: string
  ): Promise<{ success: boolean }> => {
    const encoded = encodeURIComponent(folderPath);
    return request<{ success: boolean }>(`/mailboxes/${encoded}/messages/${uid}/move`, {
      method: 'POST',
      body: JSON.stringify({ targetFolder })
    });
  },

  /** Moves to Trash; inside Trash it deletes for good (permanent: true). */
  deleteMessage: async (
    folderPath: string,
    uid: number
  ): Promise<{ success: boolean; permanent?: boolean; movedTo?: string }> => {
    const encoded = encodeURIComponent(folderPath);
    return request(`/mailboxes/${encoded}/messages/${uid}`, { method: 'DELETE' });
  },

  /** Trash -> Inbox */
  restoreMessage: async (folderPath: string, uid: number): Promise<{ success: boolean }> => {
    const encoded = encodeURIComponent(folderPath);
    return request(`/mailboxes/${encoded}/messages/${uid}/restore`, { method: 'POST' });
  },

  /** Junk -> Inbox */
  notSpam: async (folderPath: string, uid: number): Promise<{ success: boolean }> => {
    const encoded = encodeURIComponent(folderPath);
    return request(`/mailboxes/${encoded}/messages/${uid}/not-spam`, { method: 'POST' });
  },

  /** Permanently deletes everything in Trash or Junk. */
  emptyFolder: async (folderPath: string): Promise<{ success: boolean; deleted: number }> => {
    const encoded = encodeURIComponent(folderPath);
    return request(`/mailboxes/${encoded}/empty`, { method: 'POST' });
  },

  saveDraft: async (draft: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    text?: string;
    /** Rich body (editor HTML); the server stores it with its pictures. Replaces `text`. */
    html?: string;
    inReplyTo?: string;
    references?: string[];
    replaceUid?: number;
  }): Promise<{ success: boolean; uid: number; folder: string; droppedRecipients?: string[] }> => {
    return request('/drafts', { method: 'POST', body: JSON.stringify(draft) });
  },

  deleteDraft: async (uid: number): Promise<{ success: boolean }> => {
    return request(`/drafts/${uid}`, { method: 'DELETE' });
  },

  sendEmail: async (payload: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    /** Plain-text mail. Leave out when `html` is given. */
    text?: string;
    /** Rich mail (editor HTML, pictures as data: URIs; the server turns them into inline parts). */
    html?: string;
    inReplyTo?: string;
    references?: string[];
    forwardOf?: { folder: string; uid: number };
    idempotencyKey?: string;
    draftUid?: number;
    files?: File[];
  }): Promise<SendEmailResponse> => {
    const { files = [], ...fields } = payload;
    const form = new FormData();
    form.append('payload', JSON.stringify(fields));
    for (const f of files) form.append('attachments', f, f.name);
    return request<SendEmailResponse>('/messages/send', {
      method: 'POST',
      headers: payload.idempotencyKey ? { 'Idempotency-Key': payload.idempotencyKey } : undefined,
      body: form
    });
  },

  getAttachmentUrl: (folderPath: string, uid: number, partId: string): string => {
    // Links cannot send headers, so the account goes in the query (the server allows that for GET only).
    // Uses the account active when the message was rendered, not whichever signed in last.
    const account = activeHandle ? `?account=${encodeURIComponent(activeHandle)}` : '';
    return `${API_BASE}/mailboxes/${encodeURIComponent(folderPath)}/messages/${uid}/attachments/${encodeURIComponent(partId)}${account}`;
  }
};
