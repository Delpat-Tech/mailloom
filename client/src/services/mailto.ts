/*
 * mailto: links. Mailloom registers as the handler for them (manifest protocol_handlers, and
 * navigator.registerProtocolHandler in a browser tab), so a link opens the app as "?mailto=<link>".
 * The Write shortcut of the installed app opens it as "?compose=1".
 */

export interface ComposeLaunch {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

const MAX_SUBJECT = 998;
const MAX_BODY = 20000;

function addresses(list: string | null | undefined): string[] {
  if (!list) return [];
  return list
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/** Reads a mailto: link (as the browser passes it, already decoded once) into composer fields. */
export function parseMailto(link: string): ComposeLaunch | null {
  const trimmed = link.trim();
  if (!/^mailto:/i.test(trimmed)) return null;
  const rest = trimmed.slice('mailto:'.length);
  const q = rest.indexOf('?');
  const path = q >= 0 ? rest.slice(0, q) : rest;
  const params = new URLSearchParams(q >= 0 ? rest.slice(q + 1).replace(/\+/g, '%2B') : '');
  let toPart = path;
  try {
    toPart = decodeURIComponent(path);
  } catch {
    // Leave it as typed: the composer shows any address that is not valid.
  }
  const get = (k: string) => {
    for (const [key, value] of params) if (key.toLowerCase() === k) return value;
    return null;
  };
  return {
    to: [...addresses(toPart), ...addresses(get('to'))],
    cc: addresses(get('cc')),
    bcc: addresses(get('bcc')),
    subject: (get('subject') ?? '').slice(0, MAX_SUBJECT),
    body: (get('body') ?? '').slice(0, MAX_BODY)
  };
}

/** What the page was opened for: a mailto link, the Write shortcut, or nothing. */
export function composeLaunchFromSearch(search: string): ComposeLaunch | null {
  const p = new URLSearchParams(search);
  const link = p.get('mailto');
  if (link) return parseMailto(link.startsWith('mailto:') || link.startsWith('MAILTO:') ? link : `mailto:${link}`);
  if (p.get('compose') === '1') return { to: [], cc: [], bcc: [], subject: '', body: '' };
  return null;
}

/** Removes ?mailto= and ?compose= from the address bar (no history entry). */
export function clearComposeLaunch(): void {
  if (typeof window === 'undefined') return;
  const p = new URLSearchParams(window.location.search);
  if (!p.has('mailto') && !p.has('compose')) return;
  p.delete('mailto');
  p.delete('compose');
  const search = p.toString();
  history.replaceState(history.state, '', window.location.pathname + (search ? `?${search}` : '') + window.location.hash);
}

/** Asks the browser to open mailto: links in Mailloom (where supported; needs https). */
export function registerMailtoHandler(): void {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.registerProtocolHandler !== 'function') return;
    if (window.location.protocol !== 'https:') return;
    navigator.registerProtocolHandler('mailto', `${window.location.origin}${window.location.pathname}?mailto=%s`);
  } catch {
    // Not allowed here (private window, policy): the installed app's manifest entry still works.
  }
}
