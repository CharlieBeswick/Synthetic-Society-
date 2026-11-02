import { createApp } from './app.js';
import { createPostgresStore } from './postgres.js';
import { fileURLToPath } from 'node:url';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
if (!['0', '1', undefined].includes(process.env.TRUST_PROXY)) throw new Error('TRUST_PROXY must be 0 or 1.');
const connectionString = process.env.DATABASE_URL?.trim() || '';
if (!connectionString) throw new Error('DATABASE_URL is required. Refusing to start without PostgreSQL.');
const store = createPostgresStore(connectionString);
const app = createApp(store, { trustProxy: process.env.TRUST_PROXY === '1' ? 'loopback' : false, publicSiteUrl: process.env.PUBLIC_SITE_URL || '', staticDirectory: fileURLToPath(new URL('../public', import.meta.url)) });
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Synthetic Society listening at http://${process.env.HOST || '127.0.0.1'}:${port} (storage: postgres)`));
server.on('error', error => { console.error(error); store.close(); process.exitCode = 1; });
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return;
  closing = true;
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
});
