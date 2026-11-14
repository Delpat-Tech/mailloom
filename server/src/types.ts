export interface EmailAddress {
  name: string;
  address: string;
}

export interface AccountConfig {
  email: string;
  name?: string;
  // IMAP
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPass: string;
  // SMTP
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  // Mode flag
  isDemo?: boolean;
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
  /** 0 for top-level folders, 1 for a child, ... */
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
  size: number;
  snippet: string;
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
  /** Remote images that were blocked in this view (0 or missing: none). */
  blockedImages?: number;
  headers?: Record<string, string | string[]>;
}

export interface SendAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendEmailPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  /** Ignored by the server when text is given: HTML is built from the escaped text. */
  html?: string;
  attachments?: SendAttachment[];
  /** Message-ID of the mail being answered (with or without angle brackets). */
  inReplyTo?: string;
  /** References header of the mail being answered. */
  references?: string[];
  /** Forward: attach the original attachments of this message. */
  forwardOf?: { folder: string; uid: number };
  /** Client-chosen key; a retry with the same key never sends twice. */
  idempotencyKey?: string;
  /** Draft to delete once the mail is sent. */
  draftUid?: number;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  sentCopySaved: boolean;
  sentCopyError?: string;
}
