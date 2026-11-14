import sanitizeHtml from 'sanitize-html';

/** The tags the composer can produce. Nothing else is ever sent. */
export const OUTGOING_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'a', 'img',
  'div', 'span', 'h1', 'h2', 'h3', 'pre', 'code', 'hr'
];

const SAFE_DATA_IMG = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/**
 * Clean HTML written in the composer before it is sent or stored in a draft.
 *  - only the composer's tag subset; no scripts, styles, event handlers, classes or inline CSS
 *  - links: http, https, mailto, tel only
 *  - images: only `data:image/{png,jpeg,gif,webp};base64` (cid: images are removed);
 *    remote images and anything else are removed
 */
export function sanitizeOutgoingHtml(dirty: string): string {
  return sanitizeHtml(dirty || '', {
    allowedTags: OUTGOING_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      img: ['src', 'alt', 'width', 'height']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (_tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, rel: 'noopener noreferrer' } })
    },
    exclusiveFilter: (frame) => {
      if (frame.tag !== 'img') return false;
      const src = String((frame.attribs as Record<string, string>).src || '').trim();
      return !SAFE_DATA_IMG.test(src);
    }
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** A readable plain-text version of sanitised composer HTML (the text/plain alternative). */
export function htmlToPlainText(cleanHtml: string): string {
  let s = cleanHtml
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_m, alt: string) => (alt ? `[${alt}]` : ''))
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const text = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim();
      const url = decodeEntities(href);
      if (/^mailto:/i.test(url) && text === url.replace(/^mailto:/i, '')) return text;
      return !text || text === url ? url : `${text} (${url})`;
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-3]|ul|ol|pre)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n--\n');
  // Quote blocks (innermost first): prefix every line of the quoted text with "> ".
  for (let i = 0; i < 8; i++) {
    const next = s.replace(/<blockquote\b[^>]*>((?:(?!<blockquote)[\s\S])*?)<\/blockquote>/gi, (_m, inner: string) => {
      const plain = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim();
      return '\n' + plain.split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join('\n') + '\n\n';
    });
    if (next === s) break;
    s = next;
  }
  s = decodeEntities(s.replace(/<[^>]*>/g, ''));
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
