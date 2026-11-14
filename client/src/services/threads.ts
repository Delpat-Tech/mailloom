import { request } from './api.js';
import type { EmailAddress } from '../types.js';

export interface ThreadMessage {
  mailbox: string;
  uid: number;
  from: EmailAddress;
  date: string;
  snippet: string;
  isOwn: boolean;
}

export interface ThreadInfo {
  subject: string;
  participants: EmailAddress[];
  messages: ThreadMessage[];
}

export const threadsApi = {
  get: (threadId: string, mailbox: string) =>
    request<ThreadInfo>(`/threads/${encodeURIComponent(threadId)}?mailbox=${encodeURIComponent(mailbox)}`)
};

/** "N messages with Ann and Ben" (the person is left out when they can be told apart). */
export function threadSummary(info: ThreadInfo, myAddress?: string): string {
  const n = info.messages.length;
  const others = info.participants.filter((p) => !myAddress || p.address.toLowerCase() !== myAddress.toLowerCase());
  const names = (others.length ? others : info.participants).map((p) => p.name || p.address);
  const who =
    names.length === 0
      ? ''
      : names.length === 1
        ? names[0]
        : names.length === 2
          ? `${names[0]} and ${names[1]}`
          : `${names[0]}, ${names[1]} and ${names.length - 2} more`;
  return `${n} message${n === 1 ? '' : 's'}${who ? ` with ${who}` : ''}`;
}
