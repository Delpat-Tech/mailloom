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
  date: string;
  flags: string[];
  isSeen: boolean;
  isFlagged: boolean;
  html?: string;
  text?: string;
  attachments: EmailAttachment[];
}

export interface UserAccount {
  email: string;
  name?: string;
  imapHost?: string;
  smtpHost?: string;
  isDemo?: boolean;
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
