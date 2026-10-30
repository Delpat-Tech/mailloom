import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mailRoutes } from './routes/mail.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');

const fastify = Fastify({
  logger: true
});

// Plugins
await fastify.register(cors, {
  origin: true,
  credentials: true
});

await fastify.register(cookie, {
  secret: process.env.COOKIE_SECRET || 'mailloom-secret-cookie-sign-key-998811'
});

await fastify.register(multipart, {
  limits: {
    fileSize: 25 * 1024 * 1024 // 25 MB max attachment upload limit
  }
});

// Rewrite /mail/api/... to /api/... if Nginx passes the subpath through
fastify.addHook('onRequest', async (req) => {
  if (req.raw.url?.startsWith('/mail/api/')) {
    req.raw.url = req.raw.url.replace('/mail/api/', '/api/');
  } else if (req.raw.url === '/mail/api') {
    req.raw.url = '/api';
  }
});

// Health check
fastify.get('/api/health', async () => {
  return { status: 'ok', server: 'Mailloom Webmail API', timestamp: new Date().toISOString() };
});

// Register Mail Routes
await fastify.register(mailRoutes);

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

// Serve built React static assets if client/dist exists
if (fs.existsSync(CLIENT_DIST)) {
  fastify.setNotFoundHandler(async (req, reply) => {
    // If it's an API route that wasn't matched, return 404 JSON
    if (req.url.startsWith('/api/') || req.url.startsWith('/mail/api/')) {
      return reply.status(404).send({ error: 'Endpoint not found' });
    }

    // Clean URL query and strip /mail/ prefix if behind Nginx subpath
    const cleanPath = req.url.split('?')[0].replace(/^\/mail\/?/, '/');
    const safePath = path.normalize(cleanPath).replace(/^(\.\.[\/\\])+/, '');
    const candidateFile = path.join(CLIENT_DIST, safePath);

    if (fs.existsSync(candidateFile) && fs.statSync(candidateFile).isFile()) {
      const ext = path.extname(candidateFile).toLowerCase();
      reply.header('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      return reply.send(fs.createReadStream(candidateFile));
    }

    // Single Page App fallback to index.html
    const indexPath = path.join(CLIENT_DIST, 'index.html');
    if (fs.existsSync(indexPath)) {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(fs.createReadStream(indexPath));
    }

    return reply.status(404).send('Not Found');
  });
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

try {
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`\n🚀 Mailloom Webmail Server running on http://${HOST}:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
