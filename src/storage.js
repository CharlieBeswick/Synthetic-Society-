import { openStore } from './db.js';

export function selectBackend(env = process.env, { defaultBackend = 'sqlite' } = {}) {
  const raw = env.STORAGE_BACKEND;
  const choice = typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : defaultBackend;
  if (!['sqlite', 'blobs', 'postgres'].includes(choice)) {
    throw new Error('STORAGE_BACKEND must be sqlite, blobs, or postgres.');
  }
  if (choice === 'postgres' && !(env.DATABASE_URL || '').trim()) {
    throw new Error('STORAGE_BACKEND=postgres requires DATABASE_URL. Refusing to fall back to another database.');
  }
  return choice;
}

export function databaseHost(connectionString) {
  const url = new URL(connectionString);
  const port = url.port || '5432';
  const name = url.pathname.replace(/^\//, '') || '(default)';
  return `${url.hostname}:${port}/${name}`;
}

export function openConfiguredStore(env = process.env) {
  const backend = selectBackend(env, { defaultBackend: 'sqlite' });
  if (backend === 'sqlite') return { backend, store: openStore(env.DATABASE_PATH || './data/messages.sqlite') };
  if (backend === 'blobs') throw new Error('STORAGE_BACKEND=blobs is provided by the Netlify function, not the local Node server.');
  return { backend, store: null, postgres: true };
}
