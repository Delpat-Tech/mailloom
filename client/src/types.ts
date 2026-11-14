export interface EmailAddress {
  name: string;
  address: string;
}

export type SpecialUseFolder = 'Inbox' | 'Sent' | 'Drafts' | 'Trash' | 'Junk' | 'Archive' | 'All';

export interface MailboxFolder {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  specialUse?: SpecialUseFolder;
  unreadCount: number;
  totalCount: number;
  depth?: number;
  parentPath?: string;
}

export interface MessageHeader {
  uid: number;
  seq?: number;
  id?: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject: string;
  date: string;
  flags: string[];
  isSeen: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  /** How many files, and the first one's name (for the list chip). */
  attachmentCount?: number;
  attachmentName?: string;
  size: number;
  snippet: string;
  /** Label ids (server contract: labels, threads, views). */
  labels?: string[];
  threadId?: string;
  threadCount?: number;
  /** Set on items from views that span folders (Starred, Snoozed, a label). */
  mailbox?: string;
  snoozedUntil?: string;
  /** A "message not delivered" report: what was sent and why it failed. */
  bounce?: BounceInfo;
}

export interface BounceInfo {
  originalSubject: string;
  recipient: string;
  reason: string;
  /** True when the original can be reopened from Sent (then `original` is set). */
  retryable?: boolean;
  original?: { mailbox: string; uid: number };
}

export interface EmailAttachment {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  isInline: boolean;
}

export interface ParsedEmailMessage {
  uid: number;
  id?: string;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  messageId?: string;
  references?: string[];
  date: string;
  flags: string[];
  isSeen: boolean;
  isFlagged: boolean;
  html?: string;
  text?: string;
  attachments: EmailAttachment[];
  blockedImages?: number;
}

export interface UserAccount {
  /** Public per-browser account handle; names this account in API calls (X-Mailloom-Account). */
  handle: string;
  email: string;
  name?: string;
  isDemo?: boolean;
  rememberMe?: boolean;
  expiresAt?: string;
}

/** Cached, non-secret account info for the switcher. The session itself is an httpOnly cookie. */
export interface StoredAccountProfile {
  handle: string;
  email: string;
  name?: string;
  isDemo?: boolean;
  rememberMe?: boolean;
  unreadCount?: number;
  lastActive: number;
}

export interface ComposerDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: Array<{
    filename: string;
    content: string; // base64
    size: number;
    contentType?: string;
  }>;
  replyToMessage?: ParsedEmailMessage;
}
