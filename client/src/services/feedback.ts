import { BUILD_ID } from './updater.js';
import { isPwaInstalled } from './pwa.js';

/** "Report a problem": what the form may send along. Folder names only, never message content or subjects. */
export interface FeedbackDetails {
  version: string;
  userAgent: string;
  screen: string;
  display: string;
  view: string;
  time: string;
  errors: string[];
}

const MAX_ERRORS = 5;
const recent: string[] = [];
let installed = false;

/** Remembers the last few error messages shown to the person (or thrown by the page), newest last. */
export function recordClientError(message: string): void {
  const m = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!m) return;
  recent.push(m);
  while (recent.length > MAX_ERRORS) recent.shift();
}

export function recentClientErrors(): string[] {
  return [...recent];
}

export function clearClientErrors(): void {
  recent.length = 0;
}

/** Listens for uncaught errors once; only the message text is kept. */
export function installErrorCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => recordClientError(e.message));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as unknown;
    recordClientError(r instanceof Error ? r.message : typeof r === 'string' ? r : 'Unhandled promise rejection');
  });
}

export function collectDetails(view: string): FeedbackDetails {
  const w = typeof window !== 'undefined' ? window : undefined;
  return {
    version: BUILD_ID,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    screen: w ? `${w.innerWidth}x${w.innerHeight} window, ${w.screen?.width ?? 0}x${w.screen?.height ?? 0} screen` : '',
    display: isPwaInstalled() ? 'installed app' : 'browser tab',
    view,
    time: new Date().toISOString(),
    errors: recentClientErrors()
  };
}

/** The same details as readable lines, for the expandable block in the form. */
export function detailLines(d: FeedbackDetails): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['App version', d.version],
    ['Browser and system', d.userAgent],
    ['Screen', d.screen],
    ['Opened as', d.display],
    ['Current view', d.view],
    ['Time', d.time]
  ];
  rows.push(['Recent errors', d.errors.length ? d.errors.join(' | ') : 'none']);
  return rows;
}
