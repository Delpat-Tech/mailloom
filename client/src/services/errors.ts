// Turns whatever went wrong into one short sentence a non-technical person can act on.
// The server already words most of its messages plainly; anything that looks technical is replaced.

const NETWORK = /^(failed to fetch|networkerror.*|network request failed|load failed|fetch failed|the operation was aborted.*)$/i;
const TIMEOUT = /timed? ?out|etimedout/i;
const TECHNICAL = [
  /\b(ECONN\w*|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EAUTH|EPROTO|ESOCKET|ECONNECTION)\b/,
  /\b(IMAP|SMTP|TLS|SSL|socket|stack|undefined|null|NaN|exception|JSON|HTTP)\b/i,
  /syntax ?error|unexpected token|command failed|\[object|\bat \w+\.\w+|\w*Error:/i,
  /\bstatus \d{3}\b|\b\d{3} [A-Z][a-z]+/,
  /[{}<>]/
];

export function friendlyError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const msg = raw.trim();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return "You're offline. Try again when you're back online.";
  }
  if (!msg) return fallback;
  if (NETWORK.test(msg)) {
    return "Couldn't reach the mail server. Check your connection and try again.";
  }
  if (/unauthorized|invalid or expired session|no session token/i.test(msg)) {
    return 'You have been signed out. Sign in again to continue.';
  }
  if (/\b429\b|too many/i.test(msg)) return 'Too many requests at once. Wait a moment and try again.';
  if (/status 5\d\d|status 502|status 503|bad gateway|service unavailable|internal server error/i.test(msg)) {
    return 'The mail server is having trouble. Try again in a moment.';
  }
  if (/status 404/i.test(msg)) return 'That message is no longer there.';
  if (TIMEOUT.test(msg)) return 'The mail server took too long to answer. Try again.';
  // "Failed to fetch messages: <technical detail>" -> keep nothing after the colon
  if (TECHNICAL.some((re) => re.test(msg)) || /^failed to [^:]*:/i.test(msg)) return fallback;
  // Server prefixes like "Failed to fetch messages: Something plain" are fine to keep whole when plain.
  if (msg.length > 200) return fallback;
  return /[.!?]$/.test(msg) ? msg : `${msg}.`;
}
