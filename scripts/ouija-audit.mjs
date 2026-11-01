import { getStore } from '@netlify/blobs';
import { openStore } from '../src/db.js';
import { blobsAudit } from '../src/session-backends.js';
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
  const siteID = process.env.NETLIFY_SITE_ID || '';
  const token = process.env.NETLIFY_AUTH_TOKEN || '';
  if (!siteID || !token) {
    console.error(`Production audit access is not configured.
Set these variables in the current shell only. Do not commit them, put them in the repository, or paste them into chat.

NETLIFY_SITE_ID
  The Site ID for https://syntheticsociety.netlify.app/
  Site configuration, then General, then Site details.

NETLIFY_AUTH_TOKEN
  A Netlify personal access token for the account that owns the site:
  https://app.netlify.com/user/applications#personal-access-tokens
  Create it for this lookup and revoke it afterwards.

Optional BLOBS_STORE_NAME when production does not use synthetic-society-messages.
The command reads only ouija-audit/<run id>/ in the sessions blob store. It does not read session records.

PowerShell:
  $env:NETLIFY_SITE_ID = '<site id>'
  $env:NETLIFY_AUTH_TOKEN = '<personal access token>'
  node scripts/ouija-audit.mjs --production run_734c0a19c3fd run_4ab67d3134ce
  Remove-Item Env:NETLIFY_AUTH_TOKEN
  Remove-Item Env:NETLIFY_SITE_ID`);
    process.exit(1);
  }
  const name = `${process.env.BLOBS_STORE_NAME || 'synthetic-society-messages'}-sessions`;
  console.error(`Reading ouija-audit entries from blob store ${name}.`);
  const audit = blobsAudit(() => getStore({ name, siteID, token, consistency: 'strong' }));
  try { await printRuns(audit, runIds); }
  catch (error) { reportFailure(error); }
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
