import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPgExecutor, applySchema } from './postgres.js';
import { databaseHost } from './storage.js';
import { importSnapshot, summarize, validateSnapshot, verifySnapshots } from './transfer.js';

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

async function sourceSnapshot() {
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
