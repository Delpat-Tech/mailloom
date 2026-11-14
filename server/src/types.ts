import type { Recipient } from './utils/recipients.js';
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
  // Refuse to send credentials unless the SMTP connection is encrypted (STARTTLS or implicit TLS).
  smtpRequireTLS?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  // TLS options for IMAP and SMTP, from server config (MAIL_TLS_*). Never from the browser.
  tls?: {
    rejectUnauthorized: boolean;
    servername?: string;
  };
  // Server-side session this config belongs to; keys the IMAP connection pool.
  sessionKey?: string;
  // Largest outgoing message / attachment total in bytes, from server config (MAIL_MAX_MESSAGE_BYTES).
  maxMessageBytes?: number;
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
  /** How many files, and the first one's name (for the list chip). */
  attachmentCount?: number;
  attachmentName?: string;
  size: number;
  snippet: string;
  /** Label ids (IMAP keywords $label_<id>) known to this mailbox. */
  labels?: string[];
  /** Conversation id: hashed root Message-ID (see services/threading.ts). */
  threadId?: string;
  /** Messages with this threadId across INBOX, Sent and Archive (at least 1). */
  threadCount?: number;
  /** Set when the message is a bounce (non-delivery report). */
  bounce?: {
    originalSubject: string;
    recipient: string;
    reason: string;
    /** True only when the original was found in Sent. */
    retryable: boolean;
    /** The original in Sent (present when retryable). */
    original?: { mailbox: string; uid: number };
  };
  /** Folder of the message, on views that span folders (starred, labels, snoozed). */
  mailbox?: string;
  /** ISO time the message returns to the Inbox (snoozed view). */
  snoozedUntil?: string;
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
  /** Bare addresses or {name,address}; always passed on to nodemailer as objects. */
  to: Array<string | Recipient>;
  cc?: Array<string | Recipient>;
  bcc?: Array<string | Recipient>;
  subject: string;
  text?: string;
  /**
   * Rich body from the composer. When given (and not empty) it is sanitised, its images become inline
   * (cid) parts and the text alternative is generated from it; `text` is then ignored.
   * When absent, `text` is sent and the HTML is built from the escaped text.
   */
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
