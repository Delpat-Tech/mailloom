import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
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

export interface BuildAppOptions {
  /** Environment to read configuration from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Fastify logger option. Defaults to false (tests); index.ts passes true. */
  logger?: FastifyServerOptions['logger'];
  /** Folder with the built client. null disables static serving. */
  clientDist?: string | null;
  /** Clock override for tests (session expiry, login throttle). */
  now?: () => number;
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

  const fastify = Fastify({ logger: opts.logger ?? false, trustProxy: config.trustProxy as string | boolean });

  const sessions = new SessionStore(
    config.sessionDbPath,
    config.sessionSecret,
    { idleMs: config.sessionIdleMs, shortMaxMs: config.sessionShortMaxMs, rememberMs: config.sessionRememberMs },
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

  if (!config.mail.tls.rejectUnauthorized) {
    fastify.log.warn('MAIL_TLS_REJECT_UNAUTHORIZED=false: mail server certificates are NOT checked (local testing only).');
  }

  // Remove expired sessions and their IMAP connections every 10 minutes.
  const sweeper = setInterval(() => {
    for (const key of sessions.sweep()) void closeSessionConnection(key);
    throttle.prune();
  }, 10 * 60_000);
  sweeper.unref();

  fastify.addHook('onClose', async () => {
    clearInterval(sweeper);
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
  for (const prefix of ['', '/mail']) {
    await fastify.register(authRoutes, { prefix });
    await fastify.register(mailRoutes, { prefix });
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
        reply.header('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
        return reply.send(fs.createReadStream(candidateFile));
      }

      // Single Page App fallback to index.html
      const indexPath = path.join(clientDist, 'index.html');
      if (fs.existsSync(indexPath)) {
        reply.header('Content-Type', 'text/html; charset=utf-8');
        return reply.send(fs.createReadStream(indexPath));
      }

      return reply.status(404).send('Not Found');
    });
  }

  return fastify;
}
