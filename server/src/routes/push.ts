import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from './auth.js';
import { verifyReentry } from './connections.js';
import type { PushConfig } from '../push/config.js';
import { MAX_DEVICES_PER_MAILBOX, type PushDevice, type PushStore } from '../push/store.js';
import type { PushWatcher } from '../push/watcher.js';

/**
 * New-mail notifications per device (Web Push). Session auth via requireAuth; every lookup is
 * filtered by the session's mailbox, so another mailbox's device id answers 404 like an unknown id.
 *
 *   GET    /api/push/config                  { enabled, public_key }
 *   POST   /api/push/device                  { endpoint } -> this device's row for this mailbox, or null
 *   POST   /api/push/subscribe               { subscription, password, show_details, quiet, label }
 *   PATCH  /api/push/devices/:id             { show_details?, quiet? }
 *   DELETE /api/push/devices/:id             turn off on one device (secrets deleted)
 *   DELETE /api/push/devices                 turn off on every device of this mailbox
 *   POST   /api/push/devices/:id/test        send a test notification
 */

export interface PushContext {
  config: PushConfig;
  store: PushStore;
  watcher: PushWatcher | null;
  /** Which endpoints the server may send to (push services only; tests widen it). */
  endpointAllowed: (endpoint: string) => boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    mailloomPush: PushContext;
  }
}

function bad(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.status(status).send({ code, error });
}

function publicDevice(d: PushDevice) {
  return {
    id: d.id,
    label: d.label,
    show_details: d.showDetails,
    quiet: d.quiet,
    created_at: new Date(d.createdAt).toISOString(),
    last_push_at: d.lastPushAt ? new Date(d.lastPushAt).toISOString() : null,
    disabled_at: d.disabledAt ? new Date(d.disabledAt).toISOString() : null,
    disabled_reason: d.disabledReason,
    status: d.disabledAt ? 'stopped' : 'on'
  };
}

function b64urlLen(v: unknown): number {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(v) || v.length > 200) return -1;
  return Buffer.from(v.replace(/=+$/, ''), 'base64url').length;
}

interface CleanSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function cleanSubscription(v: unknown, allowed: (e: string) => boolean): CleanSubscription | string {
  const s = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string' || s.endpoint.length > 2048) return 'This browser sent an unusable push subscription.';
  if (!allowed(s.endpoint)) return 'This browser\'s push service is not one Mailloom can send to.';
  const p256dh = s.keys?.p256dh;
  const auth = s.keys?.auth;
  // p256dh: uncompressed P-256 point (65 bytes). auth: 16 random bytes.
  if (b64urlLen(p256dh) !== 65 || b64urlLen(auth) !== 16) return 'This browser sent an unusable push subscription.';
  return { endpoint: s.endpoint, p256dh: (p256dh as string).replace(/=+$/, ''), auth: (auth as string).replace(/=+$/, '') };
}

function cleanLabel(v: unknown, ua: string | undefined): string {
  if (typeof v === 'string') {
    const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    if (s) return s;
  }
  const u = ua || '';
  if (/iPhone/.test(u)) return 'iPhone';
  if (/iPad/.test(u)) return 'iPad';
  if (/Android/.test(u)) return 'Android';
  if (/Windows/.test(u)) return 'Windows';
  if (/Macintosh/.test(u)) return 'Mac';
  return 'This device';
}

function bool(v: unknown, def: boolean): boolean | null {
  if (v === undefined) return def;
  return typeof v === 'boolean' ? v : null;
}

function endpointFromBody(req: FastifyRequest): string | null {
  const e = (req.body as { endpoint?: unknown } | undefined)?.endpoint;
  return typeof e === 'string' && e.length > 0 && e.length <= 2048 ? e : null;
}

export async function pushRoutes(fastify: FastifyInstance) {
  const auth = { preHandler: [requireAuth] };

  fastify.addHook('onSend', async (req, reply) => {
    if (req.url.includes('/api/push/')) reply.header('Cache-Control', 'no-store');
  });

  fastify.get('/api/push/config', auth, async () => {
    const { config } = fastify.mailloomPush;
    return { enabled: config.enabled, public_key: config.enabled ? config.publicKey : null, max_devices: MAX_DEVICES_PER_MAILBOX };
  });

  fastify.post('/api/push/device', auth, async (req, reply) => {
    const endpoint = endpointFromBody(req);
    if (!endpoint) return bad(reply, 400, 'INVALID_INPUT', 'No device was named.');
    const { store } = fastify.mailloomPush;
    const device = store.findByEndpoint(req.accountConfig!.email, endpoint);
    // The device confirmed it is still signed in here: signing out in this session will remove it.
    if (device && !device.disabledAt) store.bindSession(device.id, req.mailSession!.key);
    return { device: device ? publicDevice(device) : null };
  });

  fastify.post('/api/push/subscribe', auth, async (req, reply) => {
    const { config, store, watcher, endpointAllowed } = fastify.mailloomPush;
    if (!config.enabled || !watcher) return bad(reply, 409, 'PUSH_OFF', 'Notifications while Mailloom is closed are not set up on this server yet.');
    const account = req.accountConfig!;
    if (account.isDemo) return bad(reply, 403, 'DEMO_ACCOUNT', 'Notifications are not available for the demo account.');
    const body = (req.body ?? {}) as { subscription?: unknown; show_details?: unknown; quiet?: unknown; label?: unknown };
    const sub = cleanSubscription(body.subscription, endpointAllowed);
    if (typeof sub === 'string') return bad(reply, 400, 'BAD_SUBSCRIPTION', sub);
    const showDetails = bool(body.show_details, false);
    const quiet = bool(body.quiet, false);
    if (showDetails === null || quiet === null) return bad(reply, 400, 'INVALID_INPUT', 'Settings must be on or off.');
    if (!store.hasEndpoint(account.email, sub.endpoint) && store.countForMailbox(account.email) >= MAX_DEVICES_PER_MAILBOX) {
      return bad(reply, 409, 'TOO_MANY_DEVICES', `Notifications are on for ${MAX_DEVICES_PER_MAILBOX} devices already. Turn one off first.`);
    }
    const password = await verifyReentry(req, reply);
    if (password === null) return reply;
    const device = store.upsert({
      email: account.email,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      password,
      sessionKey: req.mailSession!.key,
      label: cleanLabel(body.label, req.headers['user-agent']),
      showDetails,
      quiet
    });
    watcher.ensure(account.email);
    return reply.status(201).send({ device: publicDevice(device) });
  });

  fastify.get('/api/push/devices', auth, async (req) => {
    return { devices: fastify.mailloomPush.store.list(req.accountConfig!.email).map(publicDevice) };
  });

  fastify.patch('/api/push/devices/:id', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { show_details?: unknown; quiet?: unknown };
    const showDetails = body.show_details === undefined ? undefined : bool(body.show_details, false);
    const quiet = body.quiet === undefined ? undefined : bool(body.quiet, false);
    if (showDetails === null || quiet === null) return bad(reply, 400, 'INVALID_INPUT', 'Settings must be on or off.');
    const device = fastify.mailloomPush.store.updateSettings(id, req.accountConfig!.email, {
      showDetails: showDetails ?? undefined,
      quiet: quiet ?? undefined
    });
    if (!device) return bad(reply, 404, 'DEVICE_NOT_FOUND', 'Device not found.');
    return { device: publicDevice(device) };
  });

  fastify.delete('/api/push/devices/:id', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { store, watcher } = fastify.mailloomPush;
    const email = req.accountConfig!.email;
    if (!store.deleteOwned(id, email)) return bad(reply, 404, 'DEVICE_NOT_FOUND', 'Device not found.');
    await watcher?.refresh(email);
    return { deleted: true };
  });

  fastify.delete('/api/push/devices', auth, async (req) => {
    const { store, watcher } = fastify.mailloomPush;
    const email = req.accountConfig!.email;
    const deleted = store.deleteAllForMailbox(email);
    await watcher?.refresh(email);
    return { deleted };
  });

  fastify.post('/api/push/devices/:id/test', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { store, watcher } = fastify.mailloomPush;
    const email = req.accountConfig!.email;
    const device = store.active(email).find((d) => d.id === id);
    if (!device || !watcher) return bad(reply, 404, 'DEVICE_NOT_FOUND', 'Device not found or notifications are stopped on it.');
    const outcome = await watcher.send({
      endpoint: device.endpoint,
      p256dh: device.secrets.p256dh,
      auth: device.secrets.auth,
      payload: {
        v: 1,
        kind: 'test',
        mailbox: email,
        title: 'Mailloom',
        body: 'Test notification: notifications work on this device.',
        silent: device.quiet,
        tag: `test:${email}`
      }
    });
    if (outcome === 'gone') {
      store.delete(device.id);
      await watcher.refresh(email);
      return bad(reply, 410, 'DEVICE_GONE', 'This device no longer accepts notifications. Turn them on again.');
    }
    if (outcome === 'failed') return bad(reply, 502, 'PUSH_FAILED', 'The push service did not accept the notification. Try again later.');
    store.markPushed(device.id);
    return { sent: true };
  });
}
