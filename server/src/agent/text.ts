/**
 * Turns an email body into plain text for an agent: no markup, images dropped,
 * links replaced by "label [n]" with the addresses listed separately as plain strings.
 */

import { renderEmail } from '../utils/sanitize.js';
export interface AgentLink {
  n: number;
  text: string;
  url: string;
}

export interface AgentText {
  text: string;
  links: AgentLink[];
  imagesRemoved: number;
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '(c)',
  reg: '(R)',
  trade: '(TM)',
  hellip: '...',
  mdash: '-',
  ndash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  bull: '*',
  middot: '*',
  zwnj: '',
  zwj: ''
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
      if (code === 0x200b || code === 0x200c || code === 0xfeff || code === 0x34f || code === 0xad) return '';
      return String.fromCodePoint(code);
    }
    const v = NAMED[body.toLowerCase()];
    return v === undefined ? whole : v;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

/** Removes zero-width and bidi control characters often used to hide text. */
export function stripInvisible(s: string): string {
  return s.replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g, '');
}

function tidy(s: string): string {
  return stripInvisible(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToAgentText(html: string): AgentText {
  const links: AgentLink[] = [];
  let imagesRemoved = 0;
  let s = html;
  // Content that is never shown to a reader.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|head|title|template|noscript|svg|object|iframe)\b[\s\S]*?<\/\1\s*>/gi, '');
  // Elements hidden with inline styles (common trick for text only a machine would read).
  s = s.replace(
    /<(\w+)\b[^>]*\sstyle\s*=\s*(["'])[^"']*?(display\s*:\s*none|visibility\s*:\s*hidden)[^"']*\2[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ''
  );
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    imagesRemoved++;
    const alt = attr(tag, 'alt');
    return alt && alt.trim() ? ` [image: ${alt.trim()}] ` : ' ';
  });
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_whole, attrs: string, inner: string) => {
    const label = tidy(decodeEntities(inner.replace(/<[^>]+>/g, ' ')));
    const href = attr(` ${attrs}`, 'href');
    if (!href || /^\s*(javascript|data|vbscript):/i.test(href) || href.startsWith('#')) return label;
    const url = stripInvisible(href.trim());
    if (/^mailto:/i.test(url)) {
      const addr = url.replace(/^mailto:/i, '').split('?')[0];
      return label && label !== addr ? `${label} (${addr})` : addr || label;
    }
    const n = links.length + 1;
    links.push({ n, text: label, url });
    return `${label || 'link'} [${n}]`;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote|pre|section|article|header|footer)\s*>/gi, '\n');
  s = s.replace(/<(p|div|h[1-6]|tr|table|blockquote|pre|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/t[dh]\s*>/gi, ' ');
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/<|>/g, (c) => (c === '<' ? '‹' : '›'));
  return { text: tidy(decodeEntities(s)), links, imagesRemoved };
}

/** Plain-text bodies: text kept as is (it cannot be clickable), web addresses also listed. */
export function plainToAgentText(text: string): AgentText {
  const links: AgentLink[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/gi)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ n: links.length + 1, text: '', url });
  }
  return { text: tidy(text), links, imagesRemoved: 0 };
}

/**
 * Sanitises HTML the agent writes or forwards, using the same renderer as the reading view.
 * Returns only the body fragment: remote and inline-cid images are dropped, links keep a safe target.
 */
export function safeHtmlFragment(html: string): string {
  const doc = renderEmail(html, { allowRemoteImages: false }).html;
  const m = /<body>([\s\S]*)<\/body><\/html>$/.exec(doc);
  return m ? m[1] : '';
}
