// Load .env before anything reads configuration.
import 'dotenv/config';
import { buildApp } from './app.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

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
