import { request } from './api.js';
import type { ParsedEmailMessage } from '../types.js';

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
