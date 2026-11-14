/**
 * Splits typed recipient text on commas and semicolons into single entries, keeping a comma or
 * semicolon inside a quoted name ("Doe, Jo" <jo@x.com>) or an angle-bracket address together.
 */
export function splitRecipients(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\' && quoted && i + 1 < text.length) {
      cur += ch + text[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle = true;
    else if (!quoted && ch === '>') angle = false;
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Existing entries plus the newly typed ones, without duplicates. */
export function mergeRecipients(list: string[], typed: string): string[] {
  const out = [...list];
  for (const r of splitRecipients(typed)) if (!out.includes(r)) out.push(r);
  return out;
}

const ADDRESS_RE =
  /^[^\s@<>(),;:"[\]\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** The bare address of one entry ("Name <a@b.c>" or "a@b.c"). */
export function addressOf(entry: string): string {
  const m = /^[^<>]*<([^<>]*)>$/.exec(entry.trim());
  return (m ? m[1]! : entry).trim();
}

/** True when the entry is one plain address the server will accept. */
export function isValidRecipient(entry: string): boolean {
  const a = addressOf(entry);
  return a.length <= 254 && ADDRESS_RE.test(a);
}

/** Every chip plus the half-typed text, valid or not: what "unsaved changes" compares. */
export function recipientSnapshot(list: string[], typed: string): string[] {
  return mergeRecipients(list, typed);
}

/** "Sent to Priya Shah", "Sent to Ann and Ben", "Sent to Ann and 2 others". */
export function sentToText(to?: string[]): string {
  const list = (to ?? []).filter(Boolean);
  if (list.length === 0) return 'Message sent';
  if (list.length === 1) return `Sent to ${list[0]}`;
  if (list.length === 2) return `Sent to ${list[0]} and ${list[1]}`;
  return `Sent to ${list[0]} and ${list.length - 1} others`;
}
