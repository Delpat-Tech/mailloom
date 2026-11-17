// Small MIME helpers: transfer decoding, charsets, encoded words, Content-Disposition.

export function decodeCharset(buf: Buffer, charset?: string): string {
  const label = (charset || 'utf-8').trim().toLowerCase();
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export function decodeQuotedPrintable(input: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === 0x3d /* = */) {
      const next = input[i + 1];
      if (next === 0x0d && input[i + 2] === 0x0a) {
        i += 2;
        continue;
      }
      if (next === 0x0a) {
        i += 1;
        continue;
      }
      const hex = input.subarray(i + 1, i + 3).toString('latin1');
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(c);
  }
  return Buffer.from(out);
}

export function decodeTransfer(buf: Buffer, encoding?: string): Buffer {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'base64') {
    const s = buf.toString('latin1').replace(/[^A-Za-z0-9+/]/g, ''); // unpadded is fine, and a cut-off tail only affects the last byte
    return Buffer.from(s, 'base64');
  }
  if (enc === 'quoted-printable') return decodeQuotedPrintable(buf);
  return buf;
}

/** Decode RFC 2047 encoded words ("=?utf-8?B?...?=") inside a header value. */
export function decodeEncodedWords(value: string): string {
  if (!value || !value.includes('=?')) return value;
  const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return joined.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
    try {
      const bytes =
        enc.toLowerCase() === 'b'
          ? Buffer.from(text, 'base64')
          : decodeQuotedPrintable(Buffer.from(text.replace(/_/g, ' '), 'latin1'));
      return decodeCharset(bytes, charset.split('*')[0]);
    } catch {
      return text;
    }
  });
}

/** Filename from structure parameters, decoded (RFC 2047, and %XX left by some clients is NOT touched). */
export function cleanFilename(raw: string | undefined, fallback: string): string {
  const name = decodeEncodedWords(raw || '').replace(/[\r\n\0]/g, ' ').trim();
  // A path from a Windows client: keep only the file name.
  const base = name.split(/[\\/]/).pop() || '';
  return base || fallback;
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback and the real UTF-8 name. */
export function contentDisposition(filename: string, type: 'attachment' | 'inline' = 'attachment'): string {
  const safe = filename.replace(/[\r\n\0]/g, ' ');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!--[\s\S]*$/, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, ' $1 ')
    .replace(/<!\[CDATA\[[\s\S]*$/, ' ')
    // Blocks whose content is never prose; an unterminated one runs to the end (the input may be cut short).
    .replace(/<(style|script|head|title|noscript)(?=[\s>/])[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:style|script|head|title|noscript)(?=[\s>/])[\s\S]*$/i, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/<[^>]*$/, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** True when text that should be prose still looks like CSS/script (a preview would show code, so show nothing). */
export function looksLikeCode(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^[{}@]/.test(t) || /^(\.|#)[\w-]+\s*\{/.test(t)) return true;
  return /\{[^{}]*:[^{}]*;[^{}]*\}/.test(t) || /[\w-]+\s*:\s*[^;{}]+;\s*[\w-]+\s*:\s*[^;{}]+;/.test(t);
}

export function makeSnippet(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}
