import { request } from './api.js';
import type { MessageHeader } from '../types.js';
import { keyFor } from './uidKey.js';

/**
 * Views that span folders. They are shown in the folder list as virtual paths:
 *   "@starred", "@snoozed", "@label:<id>".
 * Items from a view carry `mailbox` (the real folder) so that actions go to the right place.
 */
export type ViewRef = { kind: 'starred' } | { kind: 'snoozed' } | { kind: 'label'; id: string };

export const STARRED_PATH = '@starred';
export const SNOOZED_PATH = '@snoozed';
export const labelPath = (id: string) => `@label:${id}`;

export function parseViewPath(path: string): ViewRef | null {
  if (path === STARRED_PATH) return { kind: 'starred' };
  if (path === SNOOZED_PATH) return { kind: 'snoozed' };
  if (path.startsWith('@label:') && path.length > 7) return { kind: 'label', id: path.slice(7) };
  return null;
}

export interface ViewPage {
  messages: MessageHeader[];
  total: number;
}

export async function loadView(ref: ViewRef, page: number, limit: number): Promise<ViewPage> {
  const q = new URLSearchParams({ page: String(page), limit: String(limit) });
  const url =
    ref.kind === 'starred'
      ? `/views/starred?${q}`
      : ref.kind === 'snoozed'
        ? `/views/snoozed?${q}`
        : `/labels/${encodeURIComponent(ref.id)}/messages?${q}`;
  const res = await request<{ messages: MessageHeader[]; total: number }>(url);
  const messages = (res.messages ?? []).map((m) => (m.mailbox ? { ...m, uid: keyFor(m.mailbox, m.uid) } : m));
  return { messages, total: res.total ?? messages.length };
}

/**
 * The count for a list's header, following optimistic changes: rows that are leaving (archived, deleted,
 * snoozed, moved) stop counting at once, and rows added in the meantime (a snooze shown in the Snoozed view) count.
 */
export function shownTotal(serverTotal: number, loaded: MessageHeader[], visible: MessageHeader[], isHidden: (m: MessageHeader) => boolean): number {
  const removed = loaded.filter(isHidden).length;
  const added = visible.length - (loaded.length - removed);
  return Math.max(visible.length, serverTotal - removed + added);
}
