import type { FastifyInstance } from 'fastify';
import type { FeedbackStore } from '../services/feedback-store.js';
import type { FeedbackDelivery } from '../services/feedback-delivery.js';
import { requireAuth } from './auth.js';

/**
 * "Report a problem" (text only). GET /api/feedback says whether it is switched on (WORKOS_INTAKE_URL and
 * WORKOS_INTAKE_TOKEN are set). POST /api/feedback stores the report in Mailloom's own database and answers
 * at once; a background job delivers it to Work OS (services/feedback-delivery.ts) and keeps trying until it
 * has. Session auth through requireAuth + X-Mailloom-Account (also the CSRF guard); at most 5 reports per hour
 * per mailbox; the demo mailbox is refused. Nothing here reaches the log or the browser console.
 */

declare module 'fastify' {
  interface FastifyInstance {
    mailloomFeedback: { store: FeedbackStore; delivery: FeedbackDelivery | null; hits: Map<string, number[]> };
  }
}

export const FEEDBACK_PER_HOUR = 5;
export const MAX_WHAT = 4000;
export const MAX_EXPECTED = 2000;
const HOUR = 3_600_000;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;

const clean = (v: unknown, max: number, multiline = false): string => {
  if (typeof v !== 'string') return '';
  let s = v.replace(CONTROL, '');
  s = multiline ? s.replace(/\r\n?/g, '\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max);
};

const DETAIL_KEYS: Array<[string, number]> = [
  ['version', 100],
  ['userAgent', 300],
  ['screen', 120],
  ['display', 60],
  ['view', 300],
  ['time', 40]
];

export async function feedbackRoutes(fastify: FastifyInstance, opts: { enabled: boolean; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const auth = { onRequest: [requireAuth] };

  fastify.get('/api/feedback', auth, async () => ({ enabled: opts.enabled }));

  fastify.post('/api/feedback', { ...auth, bodyLimit: 64 * 1024 }, async (req, reply) => {
    if (!opts.enabled) return reply.status(404).send({ error: 'Reporting a problem is not switched on.' });
    const config = req.accountConfig!;
    if (config.isDemo) return reply.status(403).send({ error: 'Reports cannot be sent from the demo mailbox.' });

    const raw = req.body as Record<string, unknown> | undefined;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return reply.status(400).send({ error: 'The report could not be read.' });

    const what = clean(raw.what, MAX_WHAT + 1, true);
    const expected = clean(raw.expected, MAX_EXPECTED + 1, true);
    if (!what) return reply.status(400).send({ error: 'Tell us what happened.' });
    if (what.length > MAX_WHAT) return reply.status(400).send({ error: `"What happened" is too long (at most ${MAX_WHAT} characters).` });
    if (expected.length > MAX_EXPECTED) return reply.status(400).send({ error: `"What did you expect" is too long (at most ${MAX_EXPECTED} characters).` });

    // Technical details: only the known keys, trimmed; the client sends them only when the person left them on.
    const details: Record<string, unknown> = {};
    const d = raw.details;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const o = d as Record<string, unknown>;
      for (const [k, max] of DETAIL_KEYS) {
        const v = clean(o[k], max);
        if (v) details[k] = v;
      }
      if (Array.isArray(o.errors)) {
        const errs = o.errors.slice(0, 5).map((e) => clean(e, 300)).filter(Boolean);
        if (errs.length) details.errors = errs;
      }
    }

    // Rate limit: per mailbox, after the report itself has been checked.
    const { store, delivery, hits } = fastify.mailloomFeedback;
    const key = config.email.toLowerCase();
    const t = now();
    const recent = (hits.get(key) || []).filter((x) => t - x < HOUR);
    if (recent.length >= FEEDBACK_PER_HOUR) {
      hits.set(key, recent);
      const wait = Math.max(1, Math.ceil((recent[0]! + HOUR - t) / 60_000));
      reply.header('Retry-After', String(wait * 60));
      return reply.status(429).send({ error: `You have sent ${FEEDBACK_PER_HOUR} reports in the last hour. Try again in about ${wait} minute${wait === 1 ? '' : 's'}.` });
    }
    recent.push(t);
    hits.set(key, recent);

    store.add({ mailbox: config.email, text: what, expected, details });
    delivery?.kick();
    return { success: true };
  });
}
