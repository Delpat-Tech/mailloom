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
