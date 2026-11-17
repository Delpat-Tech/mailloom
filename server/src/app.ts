import Fastify, { type FastifyError, type FastifyReply, type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mailRoutes } from './routes/mail.js';
import { ACCOUNT_HEADER, authRoutes } from './routes/auth.js';
import { loadConfig } from './config.js';
import { SessionStore } from './services/sessions.js';
import { LoginThrottle } from './services/login-throttle.js';
import { closeAllPooledClients, closeSessionConnection } from './services/imap.js';
import { loadAgentConfig } from './agent/config.js';
import { AgentStore } from './agent/store.js';
import { connectionRoutes } from './routes/connections.js';
import { agentRoutes } from './routes/agent.js';
import { agentOAuthRoutes, oauthRoutes } from './routes/oauth.js';
import { ConnectStore } from './agent/connect-store.js';
import { pushRoutes } from './routes/push.js';
import { isAllowedPushEndpoint, loadPushConfig } from './push/config.js';
import { PushStore } from './push/store.js';
import { createPushSender, type PushSendFn } from './push/sender.js';
import { DEFAULT_TIMING, PushWatcher, type WatcherTiming } from './push/watcher.js';
import { organiseRoutes } from './routes/organise.js';
import { OrganiseStore } from './services/organise-store.js';
import { SettingsStore } from './services/settings-store.js';
import { settingsRoutes } from './routes/settings.js';
import { Snoozer } from './services/snoozer.js';
import { ConversationIndexer, type IndexerOptions } from './services/conv-index.js';
import { ContactIndexer, ContactStore, type ContactIndexerOptions } from './services/contacts.js';
import { contactRoutes } from './routes/contacts.js';
import type { ImageFetchOptions } from './services/image-proxy.js';

export interface BuildAppOptions {
  /** Environment to read configuration from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Fastify logger option. Defaults to false (tests); index.ts passes true. */
  logger?: FastifyServerOptions['logger'];
  /** Folder with the built client. null disables static serving. */
  clientDist?: string | null;
  /** Clock override for tests (session expiry, login throttle). */
  now?: () => number;
  /** Test hooks for push notifications (never set in production). */
  push?: {
    timing?: Partial<WatcherTiming>;
    send?: PushSendFn;
    endpointAllowed?: (endpoint: string) => boolean;
  };
  /** Test hooks for the conversation index (never set in production). */
  /** Test hook for the remote image proxy: injectable resolver/address check (never set in production). */
  imageProxy?: ImageFetchOptions;
  /** Test hooks for the recipient-suggestion index (never set in production). */
  contacts?: Pick<ContactIndexerOptions, 'batchSize' | 'minIntervalMs'>;
  organise?: Pick<IndexerOptions, 'batchSize' | 'retryMs' | 'onBatch'> & { snoozeIntervalMs?: number };
}

/**
 * The build this server runs, for GET /api/version: a commit short hash. Order: MAILLOOM_VERSION (override, used by
 * tests), the first line of the VERSION file beside the server (written by `pnpm release`), else 'dev'.
 */
function resolveVersion(env: Record<string, string | undefined>): string {
  const clean = (v: string) => v.trim().replace(/^mailloom-/, '').slice(0, 40);
  if (env.MAILLOOM_VERSION) return clean(env.MAILLOOM_VERSION);
  try {
    const first = fs.readFileSync(path.resolve(__dirname, 'VERSION'), 'utf8').split(/\r?\n/)[0] ?? '';
    if (/^mailloom-[0-9a-f]{7,40}(-dirty)?$/.test(first.trim())) return clean(first);
  } catch {
    // No VERSION file: a development run.
  }
  return 'dev';
}

function isApiUrl(url: string): boolean {
  return url.startsWith('/api/') || url.startsWith('/mail/api/');
}

function isSameOrigin(origin: string, req: FastifyRequest): boolean {
  try {
    // req.host is the Host header (or X-Forwarded-Host when TRUST_PROXY is set), with port.
    return new URL(origin).host.toLowerCase() === String(req.host || '').toLowerCase();
  } catch {
    return false;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MIME type dictionary for native static serving
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

/**
 * Headers for the app shell (HTML and static files). Nginx may repeat them; they are set here so the
 * app is protected without it. The mail iframe uses srcdoc and inherits this CSP, which is why
 * styles may be inline, images may be data:/https:/blob:, and scripts and connections stay 'self'.
 * Inter comes from Google Fonts (stylesheet + font files), nothing else is allowed off-site.
 */
export const APP_SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');

function setShellHeaders(reply: FastifyReply): void {
  reply.header('Content-Security-Policy', APP_SHELL_CSP);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function resolveClientDist(env: Record<string, string | undefined>): string {
  const defaultClientDist = path.resolve(__dirname, '../../client/dist');
  const altClientDist = path.resolve(__dirname, './public');
  return env.CLIENT_DIST || (fs.existsSync(altClientDist) ? altClientDist : defaultClientDist);
}

/** Builds the Fastify app without listening. Call app.listen() or app.inject(). */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? process.env;
  // Throws ConfigError (with every problem listed) when secrets or mail settings are missing.
  const config = loadConfig(env);
  const now = opts.now ?? Date.now;

  // Request logs never carry the query string (search words, Message-IDs) or other URL data beyond the path.
  const logSerializers = {
    req: (r: FastifyRequest) => ({
      method: r.method,
      url: String(r.url).split('?')[0],
      host: r.headers?.host,
      remoteAddress: r.ip
    })
  };
  const logger: FastifyServerOptions['logger'] =
    opts.logger === true
      ? { serializers: logSerializers }
      : opts.logger && typeof opts.logger === 'object'
        ? { ...opts.logger, serializers: { ...opts.logger.serializers, ...logSerializers } }
        : (opts.logger ?? false);

  const fastify = Fastify({ logger, trustProxy: config.trustProxy as string | boolean });

  const sessions = new SessionStore(
    config.sessionDbPath,
    config.sessionSecret,
    { idleMs: config.sessionIdleMs, shortMaxMs: config.sessionShortMaxMs, rememberMs: config.sessionRememberMs, rememberMaxMs: config.sessionRememberMaxMs },
    now
  );
  const throttle = new LoginThrottle(
    config.loginMaxFailures,
    config.loginWindowMs,
    now,
    config.loginIpMaxFailures,
    config.loginEmailMaxFailures
  );
  fastify.decorate('mailloom', { config, sessions, throttle });
  // Agent keys and audit live in the same database as the sessions.
  const agentConfig = loadAgentConfig(env);
  const agentStore = new AgentStore(sessions.database, config.sessionSecret, now);
  agentStore.prune();
  fastify.decorate('mailloomAgent', { store: agentStore, config: agentConfig });
  const connectStore = new ConnectStore(sessions.database, config.sessionSecret, now);
  connectStore.prune();
  fastify.decorate('mailloomConnect', connectStore);

  // New-mail notifications (Web Push). The table always exists so sign-out can clean it up.
  const pushConfig = loadPushConfig(env);
  const pushStore = new PushStore(sessions.database, config.sessionSecret, now);
  const pushWatcher = pushConfig.enabled
    ? new PushWatcher(pushStore, opts.push?.send ?? createPushSender(pushConfig), config, fastify.log, {
        ...DEFAULT_TIMING,
        ...opts.push?.timing
      })
    : null;
  fastify.decorate('mailloomPush', {
    config: pushConfig,
    store: pushStore,
    watcher: pushWatcher,
    endpointAllowed: opts.push?.endpointAllowed ?? isAllowedPushEndpoint
  });
  if (pushWatcher) fastify.addHook('onReady', async () => pushWatcher.startAll());

  // Labels, snooze and the conversation index (same database). Snoozed mail is woken by a timer for
  // mailboxes with a stored (push) login, and on the next signed-in request for everyone else.
  const organiseStore = new OrganiseStore(sessions.database, now);
  const snoozer = new Snoozer(organiseStore, pushStore, config, fastify.log, now, opts.organise?.snoozeIntervalMs);
  const indexer = new ConversationIndexer(organiseStore, { ...opts.organise, log: fastify.log, now });
  fastify.decorate('mailloomOrganise', { store: organiseStore, snoozer, indexer, now });
  fastify.decorate('mailloomSettings', new SettingsStore(sessions.database, now));
  const contactStore = new ContactStore(sessions.database);
  const contactIndexer = new ContactIndexer(contactStore, { ...opts.contacts, log: fastify.log, now });
  fastify.decorate('mailloomContacts', { store: contactStore, indexer: contactIndexer, now });
  fastify.addHook('onReady', async () => {
    snoozer.start();
    void snoozer.tick();
  });
  fastify.addHook('preHandler', async (req) => {
    if (req.accountConfig) await snoozer.wakeFor(req.accountConfig);
  });

  if (!config.mail.tls.rejectUnauthorized) {
    fastify.log.warn('MAIL_TLS_REJECT_UNAUTHORIZED=false: mail server certificates are NOT checked (local testing only).');
    if (config.mail.tls.ca) fastify.log.warn('MAIL_TLS_CA_FILE is ignored because certificate checks are switched off.');
  }

  if (config.mail.smtpAllowPlain) {
    fastify.log.warn('MAIL_SMTP_ALLOW_PLAIN is set: SMTP may run without TLS (loopback hosts only, local testing only).');
  }

  // Remove expired sessions and their IMAP connections every 10 minutes.
  const sweeper = setInterval(() => {
    for (const key of sessions.sweep()) void closeSessionConnection(key);
    throttle.prune();
    agentStore.prune();
    connectStore.prune();
  }, 10 * 60_000);
  sweeper.unref();

  fastify.addHook('onClose', async () => {
    clearInterval(sweeper);
    snoozer.stop();
    await indexer.close();
    await contactIndexer.close();
    await pushWatcher?.stopAll();
    await closeAllPooledClients();
    sessions.close();
  });

  // Anything not handled by a route: never show internal error text to the browser.
  fastify.setErrorHandler((err: FastifyError, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: err.message, code: (err as { code?: string }).code });
    }
    req.log.error({ errName: err.name, errCode: (err as { code?: string }).code }, 'Unhandled error');
    return reply.status(500).send({ error: 'Something went wrong. Please try again.' });
  });

  // Cross-origin requests to the API are refused unless the origin is listed in CORS_ORIGINS.
  // Same-origin requests (the normal case) need no CORS at all.
  const allowedOrigins = new Set(config.corsOrigins);
  fastify.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !isApiUrl(req.url)) return;
    if (allowedOrigins.has(origin)) return;
    if (isSameOrigin(origin, req)) return;
    return reply.status(403).send({ code: 'ORIGIN_NOT_ALLOWED', error: 'This site is not allowed to use the Mailloom API.' });
  });

  await fastify.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
    allowedHeaders: ['Content-Type', ACCOUNT_HEADER, 'Idempotency-Key']
  });

  // Session cookies hold 256-bit random ids looked up server-side, so they are not signed.
  await fastify.register(cookie);

  // An empty body sent as application/json (e.g. DELETE or sign-out from older clients)
  // means "no body", not a 400. Non-empty bodies use Fastify's own safe JSON parser.
  const defaultJsonParser = fastify.getDefaultJsonParser('error', 'error');
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    defaultJsonParser(req, text, done);
  });

  await fastify.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024 // 25 MB max attachment upload limit
    }
  });

  // Register routes at / and behind the /mail subpath used by nginx.
  const buildVersion = resolveVersion(env);
  for (const prefix of ['', '/mail']) {
    // Which build is running: a commit short hash, nothing else. Open to everyone so a signed-out tab can check too.
    fastify.get(`${prefix}/api/version`, async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { version: buildVersion };
    });
    await fastify.register(authRoutes, { prefix });
    await fastify.register(mailRoutes, {
      prefix,
      maxMessageBytes: config.maxMessageBytes,
      sessionSecret: config.sessionSecret,
      imageFetch: opts.imageProxy
    });
    await fastify.register(connectionRoutes, { prefix });
    await fastify.register(agentRoutes, { prefix });
    await fastify.register(oauthRoutes, { prefix });
    await fastify.register(agentOAuthRoutes, { prefix });
    await fastify.register(pushRoutes, { prefix });
    await fastify.register(organiseRoutes, { prefix });
    await fastify.register(settingsRoutes, { prefix });
    await fastify.register(contactRoutes, { prefix });
  }

  const clientDist = opts.clientDist === undefined ? resolveClientDist(env) : opts.clientDist;

  // Serve built React static assets if client/dist exists
  if (clientDist && fs.existsSync(clientDist)) {
    fastify.setNotFoundHandler(async (req, reply) => {
      // If it's an API route that wasn't matched, return 404 JSON
      if (isApiUrl(req.url)) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }

      // Clean URL query and strip /mail/ prefix if behind Nginx subpath
      const cleanPath = req.url.split('?')[0].replace(/^\/mail\/?/, '/');
      const safePath = path.normalize(cleanPath).replace(/^(\.\.[/\\])+/, '');
      const candidateFile = path.resolve(clientDist, '.' + path.sep + safePath);
      const insideDist = candidateFile.startsWith(path.resolve(clientDist) + path.sep);

      if (insideDist && fs.existsSync(candidateFile) && fs.statSync(candidateFile).isFile()) {
        const ext = path.extname(candidateFile).toLowerCase();
        setShellHeaders(reply);
        reply.header('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
        return reply.send(fs.createReadStream(candidateFile));
      }

      // Single Page App fallback to index.html
      const indexPath = path.join(clientDist, 'index.html');
      if (fs.existsSync(indexPath)) {
        setShellHeaders(reply);
        reply.header('Content-Type', 'text/html; charset=utf-8');
        return reply.send(fs.createReadStream(indexPath));
      }

      return reply.status(404).send('Not Found');
    });
  }

  if (!(clientDist && fs.existsSync(clientDist))) {
    // No client build: answer 404 ourselves (Fastify's default handler logs the raw URL with its query).
    fastify.setNotFoundHandler(async (_req, reply) =>
      reply.status(404).send(isApiUrl(_req.url) ? { error: 'Endpoint not found' } : 'Not Found')
    );
  }

  return fastify;
}
