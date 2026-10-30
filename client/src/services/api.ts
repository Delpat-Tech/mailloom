import type { MailboxFolder, MessageHeader, ParsedEmailMessage, UserAccount, StoredAccountProfile } from '../types.js';

const ACTIVE_TOKEN_KEY = 'mailloom_active_token';
const ACCOUNTS_KEY = 'mailloom_saved_accounts';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function getStoredAccounts(): StoredAccountProfile[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed: StoredAccountProfile[] = JSON.parse(raw);
    const now = Date.now();
    // Filter out expired accounts
    const valid = parsed.filter((acc) => !acc.rememberMe || (acc.lastActive + THIRTY_DAYS_MS > now));
    if (valid.length !== parsed.length) {
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(valid));
    }
    return valid;
  } catch {
    return [];
  }
}

export function saveAccountProfile(profile: StoredAccountProfile): void {
  try {
    const accounts = getStoredAccounts();
    const existingIdx = accounts.findIndex((a) => a.email.toLowerCase() === profile.email.toLowerCase());
    if (existingIdx >= 0) {
      accounts[existingIdx] = { ...accounts[existingIdx], ...profile, lastActive: Date.now() };
    } else {
      // Max 3 saved accounts
      if (accounts.length >= 3) {
        accounts.pop(); // remove oldest
      }
      accounts.unshift({ ...profile, lastActive: Date.now() });
    }
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
    localStorage.setItem(ACTIVE_TOKEN_KEY, profile.token);
  } catch {
    // Ignore localStorage quota errors
  }
}

export function removeStoredAccount(email: string): void {
  try {
    const accounts = getStoredAccounts().filter((a) => a.email.toLowerCase() !== email.toLowerCase());
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
    // If active account was removed, switch to next available or clear
    if (accounts.length > 0) {
      localStorage.setItem(ACTIVE_TOKEN_KEY, accounts[0].token);
    } else {
      localStorage.removeItem(ACTIVE_TOKEN_KEY);
    }
  } catch {
    // Ignore
  }
}

export function switchStoredAccount(email: string): StoredAccountProfile | null {
  const accounts = getStoredAccounts();
  const target = accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
  if (target) {
    target.lastActive = Date.now();
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
    localStorage.setItem(ACTIVE_TOKEN_KEY, target.token);
    return target;
  }
  return null;
}

export function updateStoredAccountUnread(email: string, unreadCount: number): void {
  try {
    const accounts = getStoredAccounts();
    const target = accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (target) {
      target.unreadCount = unreadCount;
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
    }
  } catch {
    // Ignore
  }
}

export function getStoredToken(): string | null {
  return localStorage.getItem(ACTIVE_TOKEN_KEY) || localStorage.getItem('roundcube_session_token');
}

export function setStoredToken(token: string) {
  localStorage.setItem(ACTIVE_TOKEN_KEY, token);
}

export function clearStoredToken() {
  localStorage.removeItem(ACTIVE_TOKEN_KEY);
  localStorage.removeItem('roundcube_session_token');
}

const API_BASE =
  typeof window !== 'undefined' && window.location.pathname.startsWith('/mail')
    ? '/mail/api'
    : '/api';

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    credentials: 'include'
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(errorBody.error || `Request failed with status ${res.status}`);
  }

  return res.json();
}

export const api = {
  // Auth
  connect: async (data: Record<string, unknown>): Promise<{ token: string; account: UserAccount }> => {
    const res = await request<{ token: string; account: UserAccount }>('/auth/connect', {
      method: 'POST',
      body: JSON.stringify(data)
    });
    setStoredToken(res.token);
    return res;
  },

  getCurrentUser: async (): Promise<{ account: UserAccount }> => {
    return request<{ account: UserAccount }>('/auth/me');
  },

  logout: async (): Promise<void> => {
    await request('/auth/logout', { method: 'POST' }).catch(() => {});
    clearStoredToken();
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
    search = ''
  ): Promise<{ messages: MessageHeader[]; total: number }> => {
    const encoded = encodeURIComponent(folderPath);
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search.trim()) query.set('search', search.trim());
    return request<{ messages: MessageHeader[]; total: number }>(`/mailboxes/${encoded}/messages?${query}`);
  },

  getMessageDetail: async (folderPath: string, uid: number): Promise<ParsedEmailMessage> => {
    const encoded = encodeURIComponent(folderPath);
    return request<ParsedEmailMessage>(`/mailboxes/${encoded}/messages/${uid}`);
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

  deleteMessage: async (folderPath: string, uid: number): Promise<{ success: boolean }> => {
    const encoded = encodeURIComponent(folderPath);
    return request<{ success: boolean }>(`/mailboxes/${encoded}/messages/${uid}`, {
      method: 'DELETE'
    });
  },

  sendEmail: async (payload: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    text?: string;
    html?: string;
    attachments?: Array<{ filename: string; content: string; contentType?: string }>;
  }): Promise<{ success: boolean }> => {
    return request<{ success: boolean }>('/messages/send', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  getAttachmentUrl: (folderPath: string, uid: number, partId: string): string => {
    return `${API_BASE}/mailboxes/${encodeURIComponent(folderPath)}/messages/${uid}/attachments/${partId}`;
  }
};
