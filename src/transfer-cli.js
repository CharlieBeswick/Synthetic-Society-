import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openStore } from './db.js';
import { createPgExecutor, applySchema } from './postgres.js';
import { databaseHost } from './storage.js';
import { assertSiteIdentity, importSnapshot, missingPublicPosts, PRODUCTION_HOST, snapshotFromBlobStores, snapshotFromIdentity, summarize, validateSnapshot, verifySnapshots } from './transfer.js';

const [command, ...args] = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] || '';
};
const has = name => args.includes(name);

function writeSnapshot(path, snapshot) {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = JSON.stringify(snapshot);
  writeFileSync(path, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  console.warn('The export file contains password hashes, session hashes, token hashes and recovery-code hashes. Do not commit it or paste it into chat.');
  console.log(JSON.stringify({ wrote: path, sha256, exported_at: new Date().toISOString(), ...summarize(snapshot), problems: validateSnapshot(snapshot).length }));
  return sha256;
}

async function productionSite(siteID, token) {
  const response = await fetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteID)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('Export stopped. Netlify did not accept the site credentials.');
  return assertSiteIdentity(await response.json());
}

async function sourceSnapshot() {
  const backend = flag('--backend') || 'sqlite';
  if (backend === 'sqlite') {
    const store = openStore(process.env.DATABASE_PATH || './data/messages.sqlite');
    try { return snapshotFromIdentity(store.exportRecords()); } finally { store.close(); }
  }
  if (backend === 'blobs') {
    const siteID = process.env.NETLIFY_SITE_ID || '';
    const token = process.env.NETLIFY_AUTH_TOKEN || '';
    if (!siteID || !token) throw new Error('Set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN in this shell only. Do not commit them or paste them into chat.');
    const site = await productionSite(siteID, token);
    const { getStore } = await import('@netlify/blobs');
    const name = process.env.BLOBS_STORE_NAME || 'synthetic-society-messages';
    const options = { siteID, token, consistency: 'strong' };
    const messages = getStore({ name, ...options });
    const sessionStore = getStore({ name: `${name}-sessions`, ...options });
    console.log(JSON.stringify({ source: site.url, stores: [name, `${name}-sessions`] }));
    const snapshot = await snapshotFromBlobStores({ messages, identity: messages, sessions: sessionStore });
    const listed = await fetch(`https://${PRODUCTION_HOST}/api/messages`);
    if (!listed.ok) throw new Error('Export stopped. The public production feed could not be read.');
    const missing = missingPublicPosts(snapshot, (await listed.json()).messages || []);
    if (!snapshot.posts.length) throw new Error('Export stopped. The Blob snapshot contains no posts.');
    if (missing.length) throw new Error(`Export stopped. ${missing.length} public post ids are missing from the Blob snapshot.`);
    snapshot.source = { site: site.url, stores: [name, `${name}-sessions`], exported_at: new Date().toISOString() };
    return snapshot;
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
    const snapshot = await sourceSnapshot();
    writeSnapshot(out, snapshot);
    const problems = validateSnapshot(snapshot);
    if (problems.length) {
      console.log(JSON.stringify({ problems: problems.slice(0, 20) }));
      process.exitCode = 1;
    }
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
        console.log(JSON.stringify({ target: databaseHost(connectionString), apply: report.apply, inserted: report.inserted, skipped: report.skipped, errors: report.errors, problems: report.problems || [], warnings: report.warnings?.length || 0 }));
        if (report.errors.length || report.problems?.length) process.exitCode = 1;
        else if (!has('--apply')) console.log('Dry run only. Re-run with --apply to write. Existing rows are left unchanged.');
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
