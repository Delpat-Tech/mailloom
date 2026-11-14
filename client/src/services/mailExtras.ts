import { request } from './api.js';
import type { MessageHeader, ParsedEmailMessage } from '../types.js';

/*
 * Client calls for the newer server endpoints (kept apart from api.ts).
 */

/**
 * Message detail with remote images shown through the server's signed image proxy (images=auto).
 * The returned HTML already holds same-origin /api/image-proxy URLs; Junk mail stays blocked.
 */
export function getMessageDetailProxied(folderPath: string, uid: number, options: { peek?: boolean } = {}): Promise<ParsedEmailMessage> {
  const params = new URLSearchParams({ images: 'auto' });
  if (options.peek) params.set('peek', '1');
  return request<ParsedEmailMessage>(`/mailboxes/${encodeURIComponent(folderPath)}/messages/${uid}?${params}`);
}

export interface ContactSuggestion {
  name: string;
  email: string;
  count: number;
  lastUsed: string;
}

/** Recipient suggestions for a typed prefix, best first (GET /api/contacts/suggest). */
export function suggestContacts(q: string, limit = 8): Promise<ContactSuggestion[]> {
  return request<ContactSuggestion[]>(`/contacts/suggest?q=${encodeURIComponent(q)}&limit=${limit}`);
}

export interface SearchAllParams {
  search?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  since?: string;
  before?: string;
  filter?: 'all' | 'unread' | 'starred';
  page?: number;
  limit?: number;
}

/**
 * Search every folder except Trash and Junk (Snoozed included), newest first. Each message carries
 * the folder it lives in as `mailbox`. Uses the INBOX list route with scope=all.
 */
export function searchAllFolders(params: SearchAllParams): Promise<{ messages: MessageHeader[]; total: number }> {
  const q = new URLSearchParams({ scope: 'all' });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  return request<{ messages: MessageHeader[]; total: number }>(`/mailboxes/INBOX/messages?${q}`);
}

export interface LabelWithCounts {
  id: string;
  name: string;
  colour: 'mint' | 'coral' | 'lilac' | 'marigold' | 'blue';
  /** Unread messages carrying the label (same as `unread`; kept for older clients). */
  count: number;
  unread: number;
  /** All messages carrying the label, over the folders a label view shows (not Trash, Junk or Snoozed). */
  total: number;
}

/** GET /api/labels: every label with correct unread and total counts. */
export function listLabelsWithCounts(): Promise<LabelWithCounts[]> {
  return request<LabelWithCounts[]>('/labels');
}

export type BatchAction = 'read' | 'unread' | 'flag' | 'unflag' | 'move' | 'delete' | 'archive' | 'spam';

export interface BatchResponse {
  success: boolean;
  affected: number;
  movedTo?: string;
  permanent?: boolean;
}

/**
 * One action on many messages of a folder (or the whole folder with all: true), as one IMAP command.
 * `move` needs targetFolder. Up to 5000 uids per call.
 */
export function batchAction(
  folderPath: string,
  action: BatchAction,
  selection: { uids: number[] } | { all: true },
  options: { targetFolder?: string; junkFolder?: string } = {}
): Promise<BatchResponse> {
  return request<BatchResponse>(`/mailboxes/${encodeURIComponent(folderPath)}/batch`, {
    method: 'POST',
    body: JSON.stringify({ action, ...selection, ...options })
  });
}

/** Marks every message of a folder read; `affected` is how many were unread. */
export function markAllRead(folderPath: string): Promise<{ success: boolean; affected: number }> {
  return request<{ success: boolean; affected: number }>(`/mailboxes/${encodeURIComponent(folderPath)}/mark-all-read`, { method: 'POST' });
}
