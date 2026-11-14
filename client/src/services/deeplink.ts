/**
 * Stable link to one message: "#/m/<url-encoded Message-ID>".
 * The id is the RFC 5322 Message-ID header (with or without the angle brackets), so the link
 * survives the message being moved between folders. Work OS tasks and agents build these links.
 */

/** Returns the Message-ID (always with angle brackets) from a location hash, or null if it is not a message link. */
export function parseMessageLinkHash(hash: string): string | null {
  const m = /^#\/m\/([^/?#]+)\/?$/.exec(hash);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]!).trim();
  } catch {
    return null;
  }
  id = id.replace(/^<|>$/g, '');
  // A Message-ID has no spaces or control characters and needs an "@" in practice.
  if (!id || id.length > 996 || /[\s\x00-\x1f\x7f<>]/.test(id)) return null;
  return `<${id}>`;
}

/** The hash for a message link (the inverse of parseMessageLinkHash). */
export function messageLinkHash(messageId: string): string {
  return `#/m/${encodeURIComponent(`<${messageId.trim().replace(/^<|>$/g, '')}>`)}`;
}

/** Removes the link from the address bar without adding a history entry. */
export function clearMessageLinkHash(): void {
  if (typeof window === 'undefined' || !/^#\/m\//.test(window.location.hash)) return;
  history.replaceState(null, '', window.location.pathname + window.location.search);
}
