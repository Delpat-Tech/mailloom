// Load .env before anything reads configuration.
import 'dotenv/config';
import { buildApp } from './app.js';

const PORT = Number(process.env.PORT) || 3000;
// Production listens on loopback unless HOST says otherwise (Nginx is the way in); dev keeps all addresses.
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0');

let app;
try {
  app = await buildApp({ logger: true });
} catch (err) {
  console.error(`Mailloom cannot start: ${(err as Error).message}`);
  process.exit(1);
}

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`\nMailloom Webmail Server running on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
