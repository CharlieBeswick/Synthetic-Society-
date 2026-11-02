import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openStore } from './db.js';
import { createPgExecutor, applySchema } from './postgres.js';
import { databaseHost } from './storage.js';
import { importSnapshot, snapshotFromBlobStores, summarize, verifySnapshots } from './transfer.js';

const [command, ...args] = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] || '';
};
const has = name => args.includes(name);

function writeSnapshot(path, snapshot) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot));
  console.warn('The export file contains password hashes, session hashes, token hashes and recovery-code hashes. Do not commit it or paste it into chat.');
  console.log(JSON.stringify({ wrote: path, ...summarize(snapshot) }));
}

async function sourceSnapshot() {
  const backend = flag('--backend') || 'sqlite';
  if (backend === 'sqlite') {
    const store = openStore(process.env.DATABASE_PATH || './data/messages.sqlite');
    try { return snapshotFromIdentity(store.exportRecords()); } finally { store.close(); }
  }
  if (backend === 'blobs') {
    const { getStore } = await import('@netlify/blobs');
    const name = process.env.BLOBS_STORE_NAME || 'synthetic-society-messages';
    const messages = getStore({ name, consistency: 'strong' });
    const identity = getStore({ name, consistency: 'strong' });
    return snapshotFromBlobStores({ messages, identity });
  }
  if (backend === 'postgres') {
    const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
    if (!connectionString) throw new Error('Set DATABASE_URL before exporting PostgreSQL.');
    const executor = createPgExecutor(connectionString);
    try {
      const { createStoreFromExecutor } = await import('./postgres.js');
      return createStoreFromExecutor(executor).exportRecords();
    } finally {
      await executor.close();
    }
  }
  throw new Error('Export backend must be sqlite, blobs, or postgres.');
}

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

try {
  if (command === 'export') {
    const out = flag('--out');
    if (!out) throw new Error('Pass --out exports/snapshot.json');
    writeSnapshot(out, await sourceSnapshot());
  } else if (command === 'import' || command === 'verify') {
    if (!connectionString) throw new Error('Set DATABASE_URL before importing or verifying.');
    const file = flag('--file');
    if (!file) throw new Error('Pass --file exports/snapshot.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    const executor = createPgExecutor(connectionString);
    try {
      await applySchema(executor);
      if (command === 'import') {
        const report = await importSnapshot(executor, snapshot, { apply: has('--apply') });
        console.log(JSON.stringify({ target: databaseHost(connectionString), ...report, warnings: report.warnings?.length || 0 }));
        if (!has('--apply')) console.log('Dry run only. Re-run with --apply to write. Existing rows are left unchanged.');
      } else {
        const { createStoreFromExecutor } = await import('./postgres.js');
        const store = createStoreFromExecutor(executor);
        const result = verifySnapshots(snapshot, await store.exportRecords());
        console.log(JSON.stringify({ target: databaseHost(connectionString), ...result }));
        if (result.status !== 'PASS') process.exitCode = 1;
      }
    } finally {
      await executor.close();
    }
  } else {
    throw new Error('Use export, import, or verify.');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  console.error(/^(Pass |Set |Use |Export )/.test(message) ? message : 'Transfer command failed.');
  process.exitCode = 1;
}
