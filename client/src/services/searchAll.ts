import { searchAllFolders } from './mailExtras.js';
import { keyFor } from './uidKey.js';
import type { ListFilter, SearchFilterParams } from './api.js';
import type { MessageHeader } from '../types.js';

/** True when a typed search or any filter field is in use. */
export function hasSearch(term: string, filters: SearchFilterParams = {}): boolean {
  return Boolean(term.trim() || filters.from?.trim() || filters.to?.trim() || filters.subject?.trim() || filters.since?.trim() || filters.before?.trim());
}

/**
 * One page of a search over every folder. Rows get the folder-aware key used in views, so two messages
 * with the same uid in different folders stay apart and actions go to the right folder.
 */
export async function searchEverywhere(
  term: string,
  filters: SearchFilterParams,
  filter: ListFilter,
  page: number,
  limit: number
): Promise<{ messages: MessageHeader[]; total: number }> {
  const res = await searchAllFolders({
    search: term.trim(),
    from: filters.from?.trim(),
    to: filters.to?.trim(),
    subject: filters.subject?.trim(),
    since: filters.since?.trim(),
    before: filters.before?.trim(),
    filter: filter === 'unread' || filter === 'starred' ? filter : 'all',
    page,
    limit
  });
  const messages = res.messages.map((m) => (m.mailbox ? { ...m, uid: keyFor(m.mailbox, m.uid) } : m));
  return { messages, total: res.total ?? messages.length };
}

export const SEARCH_EVENT = 'mailloom:search';
/** Time for the reader layer to finish closing (its history entry) before the search layer opens. */
export const SEARCH_AFTER_READER_MS = 80;

/** Opens the search box from anywhere: the reader (if open) closes first, then the box opens. */
export function openSearch(closeReader: () => void, readerOpen: boolean): void {
  closeReader();
  setTimeout(() => window.dispatchEvent(new Event(SEARCH_EVENT)), readerOpen ? SEARCH_AFTER_READER_MS : 0);
}
