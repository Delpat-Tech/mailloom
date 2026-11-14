import sanitizeHtml from 'sanitize-html';

export interface RenderOptions {
  /** cid (lower-case, without angle brackets) -> data: URI of the inline image */
  cids?: Map<string, string>;
  /** Load remote (https) images. Default: blocked. */
  allowRemoteImages?: boolean;
}

export interface RenderedEmail {
  /** A complete, self-contained HTML document for the message iframe. */
  html: string;
  /** Number of remote images that were blocked (0 when images are allowed). */
  blockedImages: number;
}

const BASE_CSS = `
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:4px 2px 16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.55;color:#1e293b;background:#fff;overflow-wrap:anywhere;word-wrap:break-word}
img{max-width:100%;height:auto}
table{max-width:100%}
a{color:#0369a1}
pre{white-space:pre-wrap}
blockquote{margin:.5em 0;padding-left:12px;border-left:3px solid #cbd5e1;color:#475569}
.ml-warn{display:inline-block;margin-left:4px;padding:0 4px;border-radius:3px;background:#fef3c7;color:#92400e;font-size:11px;line-height:1.5;font-weight:600}
`;

const STYLE_VALUE = /^(?!.*(url\s*\(|expression|javascript:|@import|behavior|binding|<|\\)).*$/i;
const STYLE_PROPS = [
  'color', 'background', 'background-color', 'font', 'font-family', 'font-size', 'font-style', 'font-weight',
  'text-align', 'text-decoration', 'text-indent', 'text-transform', 'line-height', 'letter-spacing',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style',
  'border-width', 'border-collapse', 'border-spacing', 'border-radius',
  'width', 'height', 'max-width', 'min-width', 'max-height', 'min-height',
  'display', 'vertical-align', 'white-space', 'list-style', 'list-style-type', 'float', 'clear',
  'table-layout', 'word-break', 'overflow-wrap'
];
const allowedStyles: Record<string, Record<string, RegExp[]>> = {
  '*': Object.fromEntries(STYLE_PROPS.map((p) => [p, [STYLE_VALUE]]))
};

/** Keep a CSS subset: no @import/@font-face/@charset, no url(), no legacy script hooks. */
export function scrubCss(css: string): string {
  let out = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<\/?[a-z!][^>]*>?/gi, '')
    .replace(/@(import|charset|namespace)[^;]*;?/gi, '')
    .replace(/@font-face\s*\{[^}]*\}/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none')
    .replace(/expression\s*\([^)]*\)/gi, 'none')
    .replace(/(-moz-binding|behavior)\s*:[^;}]*/gi, '')
    .replace(/javascript:/gi, '');
  // Mail CSS must not float over the page.
  out = out.replace(/position\s*:\s*fixed/gi, 'position:static');
  return out;
}

function pxValue(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(v);
  return m ? parseFloat(m[1]) : undefined;
}

function styleDim(style: string | undefined, prop: 'width' | 'height'): number | undefined {
  if (!style) return undefined;
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(style);
  return m ? pxValue(m[1]) : undefined;
}

/** A 1x1 (or 0x0) image: a tracking pixel. */
export function isTrackingPixel(attribs: Record<string, string>): boolean {
  const w = pxValue(attribs.width) ?? styleDim(attribs.style, 'width');
  const h = pxValue(attribs.height) ?? styleDim(attribs.style, 'height');
  return (w !== undefined && w <= 1) || (h !== undefined && h <= 1);
}

function hostOf(u: string): string | undefined {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/gi, '/').replace(/&amp;/g, '&');

/** Add a small warning after links whose visible text is a URL pointing at another host. */
export function markMisleadingLinks(html: string): string {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs: string, inner: string) => {
    const hrefMatch = /\bhref="([^"]*)"/i.exec(attrs);
    if (!hrefMatch) return whole;
    const visible = unescapeHtml(inner.replace(/<[^>]*>/g, '')).trim();
    if (!/^(https?:\/\/|www\.)\S+$/i.test(visible)) return whole;
    const shown = hostOf(visible);
    const real = hostOf(unescapeHtml(hrefMatch[1]));
    if (!shown || !real || shown === real) return whole;
    return `${whole}<span class="ml-warn" title="This link goes to a different site than the text says">&#9888; goes to ${escapeHtml(real)}</span>`;
  });
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Cid references in a piece of mail HTML (lower-cased, without cid: and brackets). */
export function findCidReferences(html: string): string[] {
  const found = new Set<string>();
  const re = /cid:([^"'\s)>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) found.add(decodeURIComponentSafe(m[1]).replace(/^<|>$/g, '').toLowerCase());
  return [...found];
}

const SAFE_DATA_IMG = /^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,[a-z0-9+/=\s]+$/i;

export function renderEmail(dirtyHtml: string, opts: RenderOptions = {}): RenderedEmail {
  const cids = opts.cids || new Map<string, string>();
  const allowRemote = Boolean(opts.allowRemoteImages);
  let blocked = 0;

  // Pull the mail's own <style> blocks out; they are scrubbed and re-added in <head>.
  const styles: string[] = [];
  const withoutStyles = (dirtyHtml || '').replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_m, css: string) => {
    const clean = scrubCss(css).trim();
    if (clean) styles.push(clean);
    return '';
  });

  const body = sanitizeHtml(withoutStyles, {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol', 'li', 'b', 'i', 'u', 's',
      'strong', 'em', 'strike', 'code', 'hr', 'br', 'div', 'table', 'thead', 'tfoot', 'caption', 'tbody',
      'tr', 'th', 'td', 'colgroup', 'col', 'pre', 'span', 'img', 'sub', 'sup', 'font', 'center', 'small',
      'big', 'abbr', 'cite', 'dl', 'dt', 'dd', 'section', 'article', 'header', 'footer', 'main'
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height', 'style'],
      font: ['face', 'size', 'color'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      '*': ['style', 'class', 'align', 'valign', 'bgcolor', 'color', 'border', 'cellpadding', 'cellspacing', 'width', 'height', 'dir']
    },
    allowedStyles,
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['data', 'https'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (_tag, attribs) => ({
        tagName: 'a',
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' }
      }),
      img: (_tag, attribs) => {
        const out = { ...attribs };
        const src = (out.src || '').trim();
        if (/^cid:/i.test(src)) {
          const key = decodeURIComponentSafe(src.slice(4)).replace(/^<|>$/g, '').toLowerCase();
          const uri = cids.get(key);
          if (uri) out.src = uri;
          else delete out.src;
        } else if (/^data:/i.test(src)) {
          if (!SAFE_DATA_IMG.test(src)) delete out.src;
        } else if (/^(https?:)?\/\//i.test(src)) {
          if (isTrackingPixel(out)) {
            delete out.src; // the tag itself is dropped below
          } else if (allowRemote) {
            out.src = src.replace(/^http:/i, 'https:').replace(/^\/\//, 'https://');
          } else {
            delete out.src;
            blocked++;
          }
        } else {
          delete out.src;
        }
        return { tagName: 'img', attribs: out };
      }
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && isTrackingPixel(frame.attribs as Record<string, string>)
  });

  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${allowRemote ? ' https:' : ''}`;
  const doc =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<base target="_blank"><style>${BASE_CSS}</style>` +
    styles.map((s) => `<style>${s}</style>`).join('') +
    `</head><body>${markMisleadingLinks(body)}</body></html>`;

  return { html: doc, blockedImages: blocked };
}
