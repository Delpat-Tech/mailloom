import { createHash } from 'node:crypto';

/**
 * Conversation ids. A message's thread is named after its root Message-ID: the first entry of
 * References, otherwise In-Reply-To, otherwise its own Message-ID. The id is normalised
 * (no angle brackets, lower case) and hashed short, so it is safe in URLs and carries no address.
 */

export const THREAD_ID_RE = /^[A-Za-z0-9_-]{16}$/;

/** "<Abc@Host>" or " abc@host " -> "abc@host". Empty when there is nothing usable. */
export function normaliseMsgId(raw: string | undefined | null): string {
  if (!raw) return '';
  const m = /<([^<>\s]+)>/.exec(raw);
  const bare = (m ? m[1]! : raw).trim().replace(/^<|>$/g, '');
  return /\s/.test(bare) ? '' : bare.toLowerCase();
}

/** All Message-IDs in a References (or In-Reply-To) header value, in order. */
export function parseIdList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return (raw.match(/<[^<>\s]+>/g) || []).map((x) => normaliseMsgId(x)).filter(Boolean);
}

function hashId(root: string): string {
  return createHash('sha256').update(root, 'utf8').digest('base64url').slice(0, 16);
}

/**
 * The thread id of one message. `fallbackKey` names a message without any Message-ID (for example
 * "<folder>:<uidvalidity>:<uid>") so it becomes a conversation of its own.
 */
export function threadIdFor(input: {
  messageId?: string | null;
  references?: string | null;
  inReplyTo?: string | null;
  fallbackKey: string;
}): string {
  const refs = parseIdList(input.references);
  const root = refs[0] || parseIdList(input.inReplyTo)[0] || normaliseMsgId(input.inReplyTo) || normaliseMsgId(input.messageId);
  return hashId(root ? `mid:${root}` : `nomid:${input.fallbackKey}`);
}

/** The References header value from a fetched header block ("References: <a> <b>"), unfolded. */
export function referencesFromHeaderBlock(block: Buffer | string | undefined): string {
  if (!block) return '';
  const text = (typeof block === 'string' ? block : block.toString('utf8')).replace(/\r?\n[ \t]+/g, ' ');
  const m = /^references:\s*(.*)$/im.exec(text);
  return m ? m[1]!.trim() : '';
}

/** "Re: Fwd: AW: Budget" -> "Budget". */
export function baseSubject(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const next = s.replace(/^\s*(re|fwd?|aw|wg|sv|tr)(\[\d+\])?\s*:\s*/i, '');
    if (next === s) return s;
    s = next;
  }
}
