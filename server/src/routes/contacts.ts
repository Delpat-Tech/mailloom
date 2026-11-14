import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import type { ContactIndexer, ContactStore } from '../services/contacts.js';

export interface ContactsContext {
  store: ContactStore;
  indexer: ContactIndexer;
  now: () => number;
}

declare module 'fastify' {
  interface FastifyInstance {
    mailloomContacts: ContactsContext;
  }
}

export async function contactRoutes(fastify: FastifyInstance) {
  // GET /api/contacts/suggest?q=<prefix>&limit=8 -> [{ name, email, count, lastUsed }]
  fastify.get('/api/contacts/suggest', { onRequest: [requireAuth] }, async (req, reply) => {
    const config = req.accountConfig!;
    const { q = '', limit = '8' } = req.query as { q?: string; limit?: string };
    if (typeof q !== 'string' || q.length > 200) return reply.status(400).send({ code: 'INVALID_INPUT', error: 'Invalid search text' });
    const max = Math.min(20, Math.max(1, parseInt(String(limit), 10) || 8));
    if (config.isDemo || !q.trim()) return [];
    const { store, indexer, now } = fastify.mailloomContacts;
    // Build or top up in the background. The very first time there is nothing to show yet, so wait briefly.
    indexer.kick(config);
    if (!store.hasAnySync(config.email)) await indexer.waitFor(config.email, 2500);
    return store.suggest(config.email, q, max, now());
  });
}
