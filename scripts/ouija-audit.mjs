import { openStore } from '../src/db.js';
import { formatRun, isRunId } from '../src/ouija-diagnostics.js';

const store = openStore();
try {
  const runId = process.argv[2];
  if (!runId) {
    const runs = await store.audit.summaries();
    if (!runs.length) console.log('No Ouija experiment runs recorded.');
    for (const run of runs) console.log(`${run.run_id} created ${run.created} last ${run.last_at} requests ${run.requests} writes ${run.writes} conflicts ${run.conflicts} last ${run.last_route} ${run.last_status} ${run.last_result}`);
  } else if (!isRunId(runId)) {
    console.error('Run id must look like run_ followed by 12 hexadecimal characters.');
    process.exitCode = 1;
  } else {
    const events = await store.audit.events(runId);
    if (!events.length) console.log(`No events for ${runId}.`);
    else console.log(formatRun(events));
  }
} finally { store.close(); }
