import { request } from './api.js';
import type { MessageHeader } from '../types.js';

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
  return { messages: res.messages ?? [], total: res.total ?? res.messages?.length ?? 0 };
}
