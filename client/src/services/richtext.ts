// Pure helpers for the rich-text composer (no React, no editor): URLs, pasted HTML, images, plain text.

/** The size limit for one picture in a message (the server enforces the same). */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---- Links ----

/**
 * A safe link address from what the user typed, or null. Accepts http(s), mailto and tel;
 * a bare "example.com" becomes https://example.com, a bare "a@b.com" becomes mailto:.
 * Anything with another scheme (javascript:, data:, file: ...) is refused.
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === 'http' || s === 'https') {
      try {
        const u = new URL(raw);
        return u.hostname.includes('.') || u.hostname === 'localhost' ? u.href : null;
      } catch {
        return null;
      }
    }
    if (s === 'mailto') return /^mailto:[^@\s]+@[^@\s]+\.[^@\s]+/i.test(raw) ? raw : null;
    if (s === 'tel') return /^tel:\+?[0-9()\-.\s]{3,}$/i.test(raw) ? raw : null;
    return null; // javascript:, data:, file:, vbscript: ...
  }
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) return `mailto:${raw}`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]\S*)?$/i.test(raw)) {
    try {
      return new URL(`https://${raw}`).href;
    } catch {
      return null;
    }
  }
  return null;
}

// ---- Pasted HTML (Word, Gmail, web pages) ----

const KEEP_TAGS = new Set([
  'P', 'BR', 'STRONG', 'EM', 'U', 'S', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A', 'IMG', 'H1', 'H2', 'H3', 'PRE', 'CODE'
]);
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'XML', 'OBJECT', 'IFRAME', 'NOSCRIPT', 'TEMPLATE']);

/**
 * Reduce pasted HTML to the subset the editor and the server allow: paragraphs, line breaks,
 * bold, italic, underline, strike, lists, quotes, links, code and data: pictures. Word's
 * mso-* markup, classes, inline styles, comments and remote images are removed. Gmail and Google
 * Docs wrap everything in <b style="font-weight:normal">; that is unwrapped, not treated as bold.
 */
export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = document.implementation.createHTMLDocument('');
  const root = out.createElement('div');

  const styleOf = (el: Element) => (el.getAttribute('style') || '').toLowerCase();

  const walk = (node: Node, into: Node, ctx: { inPre?: boolean }) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent || '';
      into.appendChild(out.createTextNode(ctx.inPre ? t : t.replace(/[\r\n\t ]+/g, ' ')));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return; // comments, conditional comments
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (DROP_WITH_CONTENT.has(tag) || /^O:|^W:|^V:/.test(tag)) {
      // <o:p> only holds an empty paragraph mark in Word; its text is kept, drawing/VML parts are not.
      if (tag === 'O:P') el.childNodes.forEach((c) => walk(c, into, ctx));
      return;
    }

    const style = styleOf(el);
    let target: Node = into;
    const wrap = (name: string) => {
      const w = out.createElement(name);
      target.appendChild(w);
      target = w;
    };

    if (tag === 'IMG') {
      const src = el.getAttribute('src') || '';
      if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) {
        const img = out.createElement('img');
        img.setAttribute('src', src);
        const alt = el.getAttribute('alt');
        if (alt) img.setAttribute('alt', alt);
        into.appendChild(img);
      }
      return; // remote and file: pictures never come in through paste
    }
    if (tag === 'A') {
      const href = normalizeUrl(el.getAttribute('href') || '');
      if (href) {
        const a = out.createElement('a');
        a.setAttribute('href', href);
        into.appendChild(a);
        target = a;
      }
    } else if (tag === 'B' || tag === 'STRONG') {
      if (!/font-weight\s*:\s*(normal|[1-4]00)\b/.test(style)) wrap('strong');
    } else if (tag === 'I' || tag === 'EM') {
      if (!/font-style\s*:\s*normal/.test(style)) wrap('em');
    } else if (tag === 'DIV' || tag === 'H4' || tag === 'H5' || tag === 'H6' || tag === 'TR' || tag === 'TABLE') {
      // blocks we do not keep as such become paragraphs (headings 4-6) or flow through
      if (tag === 'H4' || tag === 'H5' || tag === 'H6') wrap('p');
    } else if (KEEP_TAGS.has(tag)) {
      wrap(tag.toLowerCase());
    } else if (tag === 'TD' || tag === 'TH') {
      // table cells: keep text, separated
    }

    // Style-based emphasis (Word and Google Docs use spans, not <b>)
    if (tag === 'SPAN' || tag === 'FONT' || tag === 'P' || tag === 'DIV' || tag === 'LI') {
      if (/font-weight\s*:\s*(bold|[6-9]00)\b/.test(style) && tag === 'SPAN') wrap('strong');
      if (/font-style\s*:\s*italic/.test(style) && tag === 'SPAN') wrap('em');
      if (/text-decoration[^;]*underline/.test(style) && tag === 'SPAN') wrap('u');
      if (/text-decoration[^;]*line-through/.test(style) && tag === 'SPAN') wrap('s');
    }

    const preNow = ctx.inPre || tag === 'PRE';
    el.childNodes.forEach((c) => walk(c, target, { inPre: preNow }));
    // rows and cells read as separate lines
    if (tag === 'TR') into.appendChild(out.createElement('br'));
  };

  doc.body.childNodes.forEach((c) => walk(c, root, {}));

  // Word wraps list items in <p> and pads with empty paragraphs and nbsp: tidy.
  root.querySelectorAll('li > p').forEach((p) => {
    while (p.firstChild) p.parentNode!.insertBefore(p.firstChild, p);
    p.remove();
  });
  root.querySelectorAll('p').forEach((p) => {
    if (!p.textContent?.replace(/[\s\u00a0]+/g, '') && !p.querySelector('img')) p.remove();
  });
  // Loose text directly in the root becomes a paragraph, so the editor keeps its lines.
  const result = out.createElement('div');
  let loose: HTMLElement | null = null;
  root.childNodes.forEach((n) => {
    const blockish = n.nodeType === Node.ELEMENT_NODE && /^(P|UL|OL|BLOCKQUOTE|H1|H2|H3|PRE)$/.test((n as Element).tagName);
    if (blockish) {
      loose = null;
      result.appendChild(n.cloneNode(true));
    } else {
      if (!loose) {
        loose = out.createElement('p');
        result.appendChild(loose);
      }
      loose.appendChild(n.cloneNode(true));
    }
  });
  result.querySelectorAll('p').forEach((p) => {
    if (!p.textContent?.replace(/[\s\u00a0]+/g, '') && !p.querySelector('img')) p.remove();
  });
  return result.innerHTML;
}

// ---- Plain text <-> HTML ----

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text as editor HTML: one paragraph per line block, line breaks kept. */
export function plainTextToHtml(text: string): string {
  const t = text.replace(/\r\n?/g, '\n').trim();
  if (!t) return '';
  return t
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** A quoted original (a reply or forward) as a blockquote. */
export function quoteHtml(text: string): string {
  const inner = plainTextToHtml(text || '');
  return `<blockquote>${inner || '<p></p>'}</blockquote>`;
}

/** The plain text of editor HTML: blocks on their own lines, lists as "- ", quotes as "> ". */
export function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lines: string[] = [];
  const inline = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent || '';
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'img') return el.getAttribute('alt') ? `[${el.getAttribute('alt')}]` : '';
    const inner = Array.from(el.childNodes).map(inline).join('');
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      return !href || inner.trim() === href || inner.trim() === href.replace(/^mailto:/, '') ? inner : `${inner} (${href})`;
    }
    return inner;
  };
  const block = (el: Element, prefix: string) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      Array.from(el.children).forEach((li, i) => {
        const marker = tag === 'ol' ? `${i + 1}. ` : '- ';
        lines.push(...inline(li).trim().split('\n').map((l, j) => `${prefix}${j === 0 ? marker : '   '}${l}`));
      });
      lines.push('');
    } else if (tag === 'blockquote') {
      const start = lines.length;
      Array.from(el.children).forEach((c) => block(c, '> ' + prefix.replace(/^> /, '')));
      if (el.children.length === 0) lines.push(`> ${inline(el).trim()}`);
      if (lines.length === start) lines.push('');
    } else {
      inline(el)
        .split('\n')
        .forEach((l) => lines.push(`${prefix}${l}`.trimEnd()));
      lines.push(prefix.trimEnd());
    }
  };
  Array.from(doc.body.children).forEach((c) => block(c, ''));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The part inside <body> of a full HTML document (what the reader returns for a draft). */
export function bodyOfHtmlDocument(html: string): string {
  if (!/<body[\s>]/i.test(html)) return html;
  return new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
}

/** True when the editor HTML holds formatting or pictures that plain text would lose. */
export function hasRichContent(html: string): boolean {
  return /<(strong|em|u|s|a|img|ul|ol|blockquote|h[1-3]|pre|code)\b/i.test(html);
}

export function isEmptyHtml(html: string): boolean {
  return !/<img\b/i.test(html) && html.replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '') === '';
}

/** Read a picture file as a data: URI after checking its type and size. Throws a plain-language Error. */
export function readImageFile(file: File, maxBytes = MAX_IMAGE_BYTES): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) {
    return Promise.reject(new Error(`"${file.name || 'That file'}" is not a PNG, JPEG, GIF or WebP picture.`));
  }
  if (file.size > maxBytes) {
    return Promise.reject(
      new Error(`"${file.name || 'The picture'}" is ${formatBytes(file.size)}. A picture can be at most ${formatBytes(maxBytes)}.`)
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`"${file.name || 'The picture'}" could not be read.`));
    reader.readAsDataURL(file);
  });
}

/** Approximate decoded size of every data: picture in the HTML. */
export function inlineImageBytes(html: string): number {
  let n = 0;
  for (const m of html.matchAll(/src="data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)"/g)) {
    n += Math.floor((m[1].length * 3) / 4);
  }
  return n;
}
