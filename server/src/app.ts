import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mailRoutes } from './routes/mail.js';

export interface BuildAppOptions {
  /** Environment to read configuration from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Fastify logger option. Defaults to false (tests); index.ts passes true. */
  logger?: FastifyServerOptions['logger'];
  /** Folder with the built client. null disables static serving. */
  clientDist?: string | null;
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
  const fastify = Fastify({ logger: opts.logger ?? false });

  await fastify.register(cors, {
    origin: true,
    credentials: true
  });

  await fastify.register(cookie, {
    secret: env.COOKIE_SECRET || 'mailloom-secret-cookie-sign-key-998811'
  });

  await fastify.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024 // 25 MB max attachment upload limit
    }
  });

  // Register Mail Routes (they have /api/... inside mailRoutes)
  await fastify.register(mailRoutes);
  await fastify.register(mailRoutes, { prefix: '/mail' });

  const clientDist = opts.clientDist === undefined ? resolveClientDist(env) : opts.clientDist;

  // Serve built React static assets if client/dist exists
  if (clientDist && fs.existsSync(clientDist)) {
    fastify.setNotFoundHandler(async (req, reply) => {
      // If it's an API route that wasn't matched, return 404 JSON
      if (req.url.startsWith('/api/') || req.url.startsWith('/mail/api/')) {
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
