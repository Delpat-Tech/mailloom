import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { sanitizeOutgoingHtml } from '../utils/outgoing.js';
import { sniffImage } from '../services/richbody.js';
import { defaultSettings, type SettingsFields, type SettingsStore, type SettingsTemplate } from '../services/settings-store.js';

/**
 * GET/PATCH /api/settings: per-mailbox settings (see services/settings-store.ts). Session auth through
 * requireAuth + X-Mailloom-Account (the header is also the CSRF guard); the store is keyed by the
 * signed-in mailbox, so one account never sees another's document.
 */

declare module 'fastify' {
  interface FastifyInstance {
    mailloomSettings: SettingsStore;
  }
}

export const MAX_SIGNATURE_HTML = 20 * 1024;
export const MAX_LOGO_BYTES = 200 * 1024;
export const MAX_TEMPLATES = 50;
const MAX_TEMPLATE_HTML = 20 * 1024;
const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const LOGO_RE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const TOP_KEYS = ['version', 'loadPictures', 'signature', 'templates', 'theme', 'defaultReply', 'importLocal'];

class Invalid extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function only(o: Record<string, unknown>, keys: string[], where: string) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Invalid(`Unknown field ${where}${k}`);
}

function html(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string') throw new Invalid(`${what} must be text`);
  if (Buffer.byteLength(v) > max) throw new Invalid(`${what} is too large`);
  const clean = sanitizeOutgoingHtml(v);
  if (Buffer.byteLength(clean) > max) throw new Invalid(`${what} is too large`);
  return clean;
}

function logo(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new Invalid('logo must be a data: image or null');
  if (v.length > Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 64) throw new Invalid('logo is too large');
  const m = LOGO_RE.exec(v);
  if (!m) throw new Invalid('logo must be a png, jpeg, gif or webp data: image');
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > MAX_LOGO_BYTES) throw new Invalid('logo is too large');
  if (sniffImage(bytes) !== m[1]) throw new Invalid('logo is not the image type it claims to be');
  return v;
}

function signature(v: unknown): SettingsFields['signature'] {
  if (!isObj(v)) throw new Invalid('signature must be an object');
  only(v, ['html', 'logo'], 'signature.');
  return {
    html: 'html' in v ? html(v.html, MAX_SIGNATURE_HTML, 'signature') : '',
    logo: 'logo' in v ? logo(v.logo) : null
  };
}

function templates(v: unknown): SettingsTemplate[] {
  if (!Array.isArray(v)) throw new Invalid('templates must be a list');
  if (v.length > MAX_TEMPLATES) throw new Invalid(`At most ${MAX_TEMPLATES} templates`);
  const seen = new Set<string>();
  return v.map((t) => {
    if (!isObj(t)) throw new Invalid('Each template must be an object');
    only(t, ['id', 'name', 'subject', 'html'], 'templates[].');
    const id = typeof t.id === 'string' && TEMPLATE_ID_RE.test(t.id) ? t.id : null;
    if (!id || seen.has(id)) throw new Invalid('Template ids must be unique, 1-64 letters, digits, - or _');
    seen.add(id);
    const name = typeof t.name === 'string' ? t.name.trim() : '';
    if (!name || name.length > 80 || CONTROL_RE.test(name)) throw new Invalid('Template name must be 1-80 characters');
    const subject = typeof t.subject === 'string' ? t.subject : '';
    if (subject.length > 200 || CONTROL_RE.test(subject)) throw new Invalid('Template subject must be at most 200 characters');
    return { id, name, subject, html: html(t.html ?? '', MAX_TEMPLATE_HTML, 'template') };
  });
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new Invalid(`${what} must be true or false`);
  return v;
}

export async function settingsRoutes(fastify: FastifyInstance) {
  const auth = { onRequest: [requireAuth] };
  const store = () => fastify.mailloomSettings;

  fastify.get('/api/settings', auth, async (req) => store().get(req.accountConfig!.email));

  fastify.patch('/api/settings', { ...auth, bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    const email = req.accountConfig!.email;
    const body = req.body;
    const conflict = () =>
      reply.status(409).send({ code: 'VERSION_CONFLICT', error: 'Settings changed elsewhere. Reload and try again.', settings: store().get(email) });
    try {
      if (!isObj(body)) throw new Invalid('Send a JSON object');
      only(body, TOP_KEYS, '');
      if (!Number.isInteger(body.version) || (body.version as number) < 0) throw new Invalid('version is required');
      const current = store().get(email);
      if (body.version !== current.version) return conflict();
      const next: SettingsFields = {
        loadPictures: current.loadPictures,
        signature: { ...current.signature },
        templates: current.templates,
        theme: current.theme,
        defaultReply: current.defaultReply
      };
      if ('loadPictures' in body) next.loadPictures = bool(body.loadPictures, 'loadPictures');
      if ('signature' in body) {
        const s = body.signature;
        if (!isObj(s)) throw new Invalid('signature must be an object');
        only(s, ['html', 'logo'], 'signature.');
        if ('html' in s) next.signature.html = html(s.html, MAX_SIGNATURE_HTML, 'signature');
        if ('logo' in s) next.signature.logo = logo(s.logo);
      }
      if ('templates' in body) next.templates = templates(body.templates);
      if ('theme' in body) {
        if (body.theme !== 'system' && body.theme !== 'light' && body.theme !== 'dark') throw new Invalid('theme must be system, light or dark');
        next.theme = body.theme;
      }
      if ('defaultReply' in body) {
        if (body.defaultReply !== 'reply' && body.defaultReply !== 'replyAll') throw new Invalid('defaultReply must be reply or replyAll');
        next.defaultReply = body.defaultReply;
      }
      if ('importLocal' in body) {
        const imp = body.importLocal;
        if (!isObj(imp)) throw new Invalid('importLocal must be an object');
        only(imp, ['signature', 'templates', 'loadPictures'], 'importLocal.');
        const def = defaultSettings();
        if ('signature' in imp && next.signature.html === def.signature.html && next.signature.logo === def.signature.logo) {
          next.signature = signature(imp.signature);
        }
        if ('templates' in imp && next.templates.length === 0) next.templates = templates(imp.templates);
        if ('loadPictures' in imp) {
          const v = bool(imp.loadPictures, 'importLocal.loadPictures');
          if (next.loadPictures === def.loadPictures) next.loadPictures = v;
        }
      }
      const saved = store().save(email, current.version, next);
      return saved ?? conflict();
    } catch (err) {
      if (err instanceof Invalid) return reply.status(400).send({ code: 'INVALID_SETTINGS', error: err.message });
      throw err;
    }
  });
}
