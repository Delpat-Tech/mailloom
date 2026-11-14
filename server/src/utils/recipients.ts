/** One recipient. Always handed to nodemailer as an object, so a display name can never add recipients. */
export interface Recipient {
  name: string;
  address: string;
}

const ADDRESS_RE =
  /^[^\s@<>(),;:"[\]\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export class RecipientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipientError';
  }
}

function cleanName(name: string): string {
  // No control or invisible characters; quoting is nodemailer's job.
  const spaced = Array.from(name, (ch) => {
    const c = ch.codePointAt(0)!;
    const bad = c < 32 || c === 127 || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || c === 0x2060 || c === 0xfeff;
    return bad ? ' ' : ch;
  }).join('');
  return spaced.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function isValidAddress(address: string): boolean {
  return address.length <= 254 && ADDRESS_RE.test(address);
}

/**
 * Strict recipient list: each entry is one mailbox, either an object {name, address} or a single
 * string "a@b.c" / "Name <a@b.c>". A string holding several addresses (commas, semicolons, groups)
 * is refused, never reinterpreted. Returns {name,address} objects.
 */
export function parseRecipients(value: unknown, field: string): Recipient[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RecipientError(`${field} must be a list of addresses.`);
  const out: Recipient[] = [];
  for (const item of value) {
    let name = '';
    let address = '';
    if (typeof item === 'string') {
      const s = item.trim();
      if (!s) continue;
      const m = /^([^<>]*?)\s*<([^<>]*)>$/.exec(s);
      if (m) {
        name = m[1]!.replace(/^"(.*)"$/s, '$1').replace(/[\\](.)/g, '$1');
        address = m[2]!.trim();
      } else {
        address = s;
      }
    } else if (item && typeof item === 'object') {
      const o = item as { name?: unknown; address?: unknown };
      if (typeof o.address !== 'string' || (o.name !== undefined && typeof o.name !== 'string')) {
        throw new RecipientError(`${field} has an entry that is not an address.`);
      }
      name = o.name ?? '';
      address = o.address.trim();
    } else {
      throw new RecipientError(`${field} has an entry that is not an address.`);
    }
    if (!isValidAddress(address)) {
      throw new RecipientError(`"${address.slice(0, 100)}" is not a single email address in ${field}.`);
    }
    out.push({ name: cleanName(name), address });
  }
  return out;
}

/** Draft variant: entries that are not a single address are dropped (and reported), never an error. */
export function parseRecipientsLenient(value: unknown, field: string): { kept: Recipient[]; dropped: string[] } {
  const kept: Recipient[] = [];
  const dropped: string[] = [];
  if (!Array.isArray(value)) return { kept, dropped };
  for (const item of value) {
    try {
      kept.push(...parseRecipients([item], field));
    } catch {
      const text = typeof item === 'string' ? item : (item as { address?: unknown } | null)?.address;
      if (typeof text === 'string' && text.trim()) dropped.push(text.trim().slice(0, 100));
    }
  }
  return { kept, dropped };
}
