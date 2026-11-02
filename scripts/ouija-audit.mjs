import { openStore } from '../src/db.js';
import { createPostgresStore } from '../src/postgres.js';
import { formatRun, isCompositionId, isRunId } from '../src/ouija-diagnostics.js';

const args = process.argv.slice(2);
const production = args.includes('--production');
const runIds = args.filter(arg => arg !== '--production');
const header = 'time run method route buffer position expected status result response_id advertises followed origin recovery';

if (runIds.some(arg => arg.startsWith('-'))) {
  console.error('Unknown option. Usage: node scripts/ouija-audit.mjs [--production] [run_id ...]');
  process.exit(1);
}

function reportFailure(error) {
  const status = Number.isInteger(error?.status) ? ` HTTP ${error.status}` : '';
  console.error(`Audit request failed${status}. ${error?.name || 'Error'}`);
  process.exitCode = 1;
}

async function printRuns(audit, ids) {
  if (!ids.length) {
    console.error('Pass one or more run ids, for example run_734c0a19c3fd.');
    process.exitCode = 1;
    return;
  }
  for (const runId of ids) {
    if (!isRunId(runId) && !isCompositionId(runId)) {
      console.error('Pass a run id (run_ and 12 hex characters) or a v2 composition id (cmp_ and 22 URL-safe characters).');
      process.exitCode = 1;
      continue;
    }
    const events = await audit.events(runId);
    console.log(`# ${runId}`);
    if (!events.length) console.log('No events.');
    else {
      console.log(header);
      console.log(formatRun(events));
    }
    console.log('');
  }
}

if (production) {
  const connectionString = process.env.DATABASE_URL?.trim() || '';
  if (!connectionString) {
    console.error('Set DATABASE_URL to read Ouija audit events from PostgreSQL. Do not paste the connection string into chat.');
    process.exit(1);
  }
  const store = createPostgresStore(connectionString, { serverless: true });
  try { await printRuns(store.audit, runIds); }
  catch (error) { reportFailure(error); }
  finally { await store.close(); }
} else {
  const store = openStore();
  try {
    if (!runIds.length) {
      const runs = await store.audit.summaries();
      if (!runs.length) console.log('No Ouija experiment runs recorded.');
      for (const run of runs) console.log(`${run.run_id} created ${run.created} last ${run.last_at} requests ${run.requests} writes ${run.writes} conflicts ${run.conflicts} last ${run.last_route} ${run.last_status} ${run.last_result}`);
    } else {
      await printRuns(store.audit, runIds);
    }
  } catch (error) { reportFailure(error); }
  finally { store.close(); }
}
