import type { MessageStructureObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { LeafPart } from './mailparts.js';

/**
 * Bounces (non-delivery reports). Two shapes are recognised:
 *  - RFC 3464 DSNs: multipart/report; report-type=delivery-status, with a message/delivery-status
 *    part and usually the original message or its headers;
 *  - plain bounces from MAILER-DAEMON or postmaster (Postfix, Exim, Exchange text notices).
 * The result is three short fields for the list; the full report stays readable in the message.
 */

export interface BounceInfo {
  originalSubject: string;
  recipient: string;
  reason: string;
  /** True only when the original was found in Sent (see `original`), so it can be sent again. */
  retryable: boolean;
  /** Where the original is in Sent, so the client reopens the real message, not the bounce text. */
  original?: { mailbox: string; uid: number };
  /** Normalised Message-ID of the bounced message. Server-side only; removed before responding. */
  originalMessageId?: string;
}

export const MAX_ORIGINAL_SUBJECT = 300;
export const MAX_RECIPIENT = 320;

function capped(info: { originalSubject: string; recipient: string; reason: string; originalMessageId?: string }): BounceInfo {
  return {
    originalSubject: info.originalSubject.slice(0, MAX_ORIGINAL_SUBJECT),
    recipient: info.recipient.slice(0, MAX_RECIPIENT),
    reason: info.reason,
    retryable: false,
    ...(info.originalMessageId ? { originalMessageId: info.originalMessageId } : {})
  };
}

/** The Message-ID of the returned original: first Message-ID header after the copy marker, else anywhere. */
function originalMessageIdIn(text: string): string {
  const m = /^[ \t>]*message-id:[ \t]*(<[^<>\s]+>)/im.exec(text);
  return m ? m[1]!.slice(1, -1).toLowerCase() : '';
}

export type BounceCandidate =
  | { kind: 'dsn'; statusPart?: LeafPart; originalPart?: LeafPart; textPart?: LeafPart }
  | { kind: 'plain'; textPart?: LeafPart };

const REASONS = {
  full: 'mailbox full',
  noAddress: 'address does not exist',
  spam: 'rejected as spam',
  unreachable: 'server could not be reached',
  other: 'could not be delivered'
} as const;

const SENDER_RE = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)$/i;
const SUBJECT_RE =
  /^(undeliver|undelivered mail|delivery status notification \((failure|delay)\)|returned mail|mail delivery (failed|failure|system)|delivery failure|failure notice|non[- ]?delivery)/i;

function param(node: MessageStructureObject, name: string): string {
  const p = (node.parameters || {}) as Record<string, string>;
  for (const [k, v] of Object.entries(p)) if (k.toLowerCase() === name) return String(v);
  return '';
}

/** Is this message a bounce, and which parts hold the details? Decided from envelope + BODYSTRUCTURE only. */
export function bounceCandidate(
  fromAddress: string,
  subject: string,
  root: MessageStructureObject | undefined,
  leaves: LeafPart[]
): BounceCandidate | null {
  const rootType = (root?.type || '').toLowerCase();
  const textPart = leaves.find((p) => p.type === 'text/plain' && p.disposition !== 'attachment');
  if (root && rootType === 'multipart/report' && /delivery-status/i.test(param(root, 'report-type'))) {
    return {
      kind: 'dsn',
      statusPart: leaves.find((p) => p.type === 'message/delivery-status' || p.type === 'message/global-delivery-status'),
      originalPart: leaves.find((p) =>
        ['text/rfc822-headers', 'message/rfc822', 'message/global', 'message/global-headers'].includes(p.type)
      ),
      textPart
    };
  }
  const local = fromAddress.split('@')[0] || '';
  if (SENDER_RE.test(local) || (SUBJECT_RE.test(subject.trim()) && /daemon|postmaster|system/i.test(fromAddress))) {
    return { kind: 'plain', textPart };
  }
  return null;
}

/** A plain-English reason from an enhanced status code (5.1.1) and/or the server's diagnostic text. */
export function reasonFor(status: string | undefined, diagnostic = ''): string {
  const s = (status || '').trim();
  if (/^[45]\.2\.2$/.test(s)) return REASONS.full;
  if (/^[45]\.1\.(0|1|3|6|10)$/.test(s)) return REASONS.noAddress;
  if (/^[45]\.7\.\d+$/.test(s)) return REASONS.spam;
  if (/^[45]\.4\.\d+$/.test(s) || /^[45]\.1\.2$/.test(s)) return REASONS.unreachable;
  const t = diagnostic.toLowerCase();
  if (/quota|mailbox (is )?full|over ?quota|insufficient (storage|space)|storage (limit|exceeded)/.test(t)) return REASONS.full;
  if (/spam|blocked|block ?list|black ?list|listed (at|in|on)|reputation|content rejected|policy/.test(t)) return REASONS.spam;
  if (
    /user unknown|unknown user|no such (user|mailbox|recipient|address)|does ?n[o']t exist|recipient not found|invalid (recipient|mailbox|address)|address rejected|unknown (local part|recipient)|mailbox (not found|unavailable)|not a valid mailbox/.test(
      t
    )
  )
    return REASONS.noAddress;
  if (/host not found|name service error|domain not found|no mx|connection (refused|timed out)|timed out|unreachable|could not be reached|unable to connect|network/.test(t))
    return REASONS.unreachable;
  // Plain SMTP replies without an enhanced code.
  if (/\b552\b/.test(t)) return REASONS.full;
  if (/\b55[03]\b/.test(t)) return REASONS.noAddress;
  return REASONS.other;
}

/** Header-style fields ("Name: value", folded lines joined). Repeated names keep the first value. */
function fieldBlocks(text: string): Array<Map<string, string>> {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');
  return unfolded
    .split(/\n\s*\n/)
    .map((block) => {
      const m = new Map<string, string>();
      for (const line of block.split('\n')) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        if (!m.has(k)) m.set(k, line.slice(i + 1).trim());
      }
      return m;
    })
    .filter((m) => m.size > 0);
}

function addressOf(field: string | undefined): string {
  if (!field) return '';
  const v = field.replace(/^[a-z0-9-]+\s*;\s*/i, '').trim();
  const m = /<?([^<>\s;]+@[^<>\s;]+)>?/.exec(v);
  return m ? m[1]!.replace(/[>.,]+$/, '') : '';
}

/** The Subject of an embedded original message (headers or whole message), MIME words decoded. */
export async function subjectFromHeaders(raw: string): Promise<string> {
  const head = raw.replace(/\r\n/g, '\n').split(/\n\n/)[0] || '';
  if (!/^subject:/im.test(head)) return '';
  try {
    const parsed = await simpleParser(Buffer.from(head + '\n\n', 'utf8'), { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
    return (parsed.subject || '').trim();
  } catch {
    return '';
  }
}

/** RFC 3464 report: first failed (or first) recipient, its status and diagnostic. */
export async function parseDsn(statusText: string, originalText: string, fallbackText = ''): Promise<BounceInfo> {
  const blocks = fieldBlocks(statusText);
  const perRecipient = blocks.filter((b) => b.has('final-recipient') || b.has('original-recipient'));
  const chosen =
    perRecipient.find((b) => /failed/i.test(b.get('action') || '')) ||
    perRecipient.find((b) => /delayed/i.test(b.get('action') || '')) ||
    perRecipient[0];
  const recipient = addressOf(chosen?.get('original-recipient')) || addressOf(chosen?.get('final-recipient'));
  const status = /\d\.\d{1,3}\.\d{1,3}/.exec(chosen?.get('status') || '')?.[0];
  const diag = chosen?.get('diagnostic-code') || '';
  let originalSubject = originalText ? await subjectFromHeaders(originalText) : '';
  if (!originalSubject && fallbackText) originalSubject = await subjectInText(fallbackText);
  const fromText = !recipient && fallbackText ? await parsePlainBounce(fallbackText, '') : null;
  return capped({
    originalSubject,
    recipient: recipient || fromText?.recipient || '',
    reason: status || diag ? reasonFor(status, diag) : fromText?.reason || REASONS.other,
    originalMessageId: originalMessageIdIn(originalText) || fromText?.originalMessageId
  });
}

async function subjectInText(text: string): Promise<string> {
  const lines = text.replace(/\r\n/g, '\n');
  // Prefer the Subject: inside the returned copy ("--- original message ---", "headers follow" ...).
  const marker = /(original message|copy of the message|message headers|returned message|headers? (of the )?original|undelivered message)/i.exec(lines);
  const tail = marker ? lines.slice(marker.index) : lines;
  const m = /^[ \t>]*subject:[ \t]*(.+(?:\n[ \t]+.+)*)$/im.exec(tail) || /^[ \t>]*subject:[ \t]*(.+)$/im.exec(lines);
  if (!m) return '';
  return subjectFromHeaders(`Subject: ${m[1]!.replace(/\n[ \t]+/g, ' ').trim()}`);
}

/** Text bounce from MAILER-DAEMON or postmaster: best-effort recipient, reason and original subject. */
export async function parsePlainBounce(text: string, ownAddress: string): Promise<BounceInfo> {
  const own = ownAddress.toLowerCase();
  const body = text.replace(/\r\n/g, '\n');
  const marker = /(original message|copy of the message|message headers|returned message|headers? (of the )?original)/i.exec(body);
  const report = marker ? body.slice(0, marker.index) : body;
  const addresses = (report.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).filter((a) => {
    const l = a.toLowerCase();
    return l !== own && !/^(mailer-daemon|postmaster)@/.test(l);
  });
  // Not part of an IP address or version number ("10.4.5.6").
  const status = /(?<![\d.])([45]\.\d{1,3}\.\d{1,3})(?![\d.])/.exec(report)?.[1];
  return capped({
    originalSubject: await subjectInText(body),
    recipient: addresses[0] || '',
    reason: reasonFor(status, report),
    originalMessageId: marker ? originalMessageIdIn(body.slice(marker.index)) : ''
  });
}
