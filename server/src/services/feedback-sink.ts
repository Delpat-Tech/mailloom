import type { FeedbackRow } from './feedback-store.js';

/**
 * The adapter to Work OS's intake (the only place that knows its shape).
 *
 *   POST ${WORKOS_INTAKE_URL}  Authorization: Bearer ${WORKOS_INTAKE_TOKEN}
 *   { report_id, reporter, title, description_markdown, details: { version, device, browser, view, errors } }
 *   200/201 { ref, url } = delivered. The same report_id always gives the same task, so retries are safe.
 *
 * https only (http only for localhost), redirects never followed, 10 s timeout, 1 MB reply cap.
 * The token and the report text are never logged or thrown in an error.
 */

export interface IntakeConfig {
  url: string;
  token: string;
}

export type SinkResult =
  | { kind: 'ok'; ref: string }
  | { kind: 'permanent'; code: string }
  | { kind: 'retry'; code: string; afterMs?: number; configProblem?: boolean };

const TIMEOUT_MS = 10_000;
const MAX_REPLY_BYTES = 1024 * 1024;
export const MIN_TOKEN_CHARS = 32;

/** The two variables, or null (with the reason, never the values) when the feature must stay off. */
export function loadIntakeConfig(env: Record<string, string | undefined>): { config: IntakeConfig | null; warning?: string } {
  const url = (env.WORKOS_INTAKE_URL || '').trim();
  const token = (env.WORKOS_INTAKE_TOKEN || '').trim();
  if (!url && !token) return { config: null };
  if (!url || !token) return { config: null, warning: 'Report a problem is off: WORKOS_INTAKE_URL and WORKOS_INTAKE_TOKEN must both be set.' };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { config: null, warning: 'Report a problem is off: WORKOS_INTAKE_URL is not a web address.' };
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    return { config: null, warning: 'Report a problem is off: WORKOS_INTAKE_URL must start with https:// (http:// only for localhost).' };
  }
  if (u.username || u.password || u.hash) return { config: null, warning: 'Report a problem is off: WORKOS_INTAKE_URL must not contain a login or # part.' };
  if (token.length < MIN_TOKEN_CHARS) return { config: null, warning: `Report a problem is off: WORKOS_INTAKE_TOKEN must be at least ${MIN_TOKEN_CHARS} characters.` };
  return { config: { url: u.toString(), token } };
}

const cut = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** The JSON body, trimmed to the intake's limits. */
export function buildIntakeBody(r: FeedbackRow): Record<string, unknown> {
  const d = r.details;
  const title = cut(r.text.split('\n').find((l) => l.trim())?.trim() || r.text.trim(), 200) || 'Problem report';
  const description = [`**What happened**\n\n${r.text}`, ...(r.expected ? [`**What did you expect**\n\n${r.expected}`] : [])].join('\n\n').slice(0, 10000);
  const device = [cut(d.display, 60), cut(d.screen, 120)].filter(Boolean).join(', ');
  const errors = Array.isArray(d.errors) ? d.errors.slice(0, 20).map((e) => cut(e, 500)).filter(Boolean) : [];
  return {
    report_id: r.id,
    reporter: r.mailbox.slice(0, 320),
    title,
    description_markdown: description,
    details: { version: cut(d.version, 100), device: device.slice(0, 200), browser: cut(d.userAgent, 200), view: cut(d.view, 300), errors }
  };
}

async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_REPLY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Retry-After as milliseconds (seconds or an HTTP date), or undefined. */
function retryAfter(res: Response, now: number): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  if (/^\d+$/.test(h.trim())) return Number(h) * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export async function deliverReport(
  cfg: IntakeConfig,
  report: FeedbackRow,
  opts: { fetch?: typeof fetch; now?: () => number } = {}
): Promise<SinkResult> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    res = await doFetch(cfg.url, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(buildIntakeBody(report))
    });
  } catch (err) {
    void err;
    return { kind: 'retry', code: signal.aborted ? 'TIMEOUT' : 'NETWORK' };
  }
  const s = res.status;
  if (s === 200 || s === 201) {
    const text = await readCapped(res).catch(() => null);
    let ref = '';
    try {
      const j = text ? (JSON.parse(text) as { ref?: unknown }) : {};
      ref = typeof j.ref === 'string' || typeof j.ref === 'number' ? String(j.ref).slice(0, 100) : '';
    } catch {
      /* unreadable reply: treated below */
    }
    // The task may exist, but without a ref we cannot be sure: ask again (the same report_id returns the same task).
    return ref ? { kind: 'ok', ref } : { kind: 'retry', code: 'BAD_REPLY' };
  }
  await res.body?.cancel().catch(() => undefined);
  if (s === 400 || s === 413) return { kind: 'permanent', code: `HTTP_${s}` };
  if (s === 429) return { kind: 'retry', code: 'HTTP_429', afterMs: retryAfter(res, (opts.now ?? Date.now)()) };
  if (s === 401 || s === 503 || (s >= 300 && s < 500)) return { kind: 'retry', code: `HTTP_${s}`, configProblem: true };
  return { kind: 'retry', code: `HTTP_${s}` };
}
