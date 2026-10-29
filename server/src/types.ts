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
  date: string;
  flags: string[];
  isSeen: boolean;
  isFlagged: boolean;
  html?: string;
  text?: string;
  attachments: EmailAttachment[];
  headers?: Record<string, string | string[]>;
}

export interface SendEmailPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: string; // base64 encoded
    contentType?: string;
  }>;
}
