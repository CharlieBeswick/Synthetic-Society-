const SECRET_FIELDS = new Set(['password_hash', 'secret_hash', 'token_hash', 'code_hash', 'csrf', 'fingerprint']);
const METHODS = new Set(['form', 'api', 'unknown', 'session_get', 'ouija_get', 'ouija_get_v2']);
export const PRODUCTION_HOST = 'syntheticsociety.netlify.app';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value ?? null;
}

export function snapshotFromIdentity(dump) {
  const accounts = [];
  const sessions = [];
  const tokens = [];
  const recovery_codes = [];
  const idempotency = [];
  const warnings = [];
  for (const entry of dump.identity || []) {
    const key = entry.key || '';
    const value = entry.value || {};
    if (key.startsWith('account/')) accounts.push(value);
    else if (key.startsWith('session-of/') || key.startsWith('token-of/') || key.startsWith('recovery-of/') || key.startsWith('username/')) continue;
    else if (key.startsWith('session/')) sessions.push({ secret_hash: key.slice('session/'.length), ...value });
    else if (key.startsWith('token/')) tokens.push({ token_hash: key.slice('token/'.length), ...value });
    else if (key.startsWith('recovery/')) recovery_codes.push({ code_hash: key.slice('recovery/'.length), ...value });
    else if (key.startsWith('idempotency/')) idempotency.push({ key, ...value });
    else warnings.push({ kind: 'identity', id: key, field: 'unrecognized' });
  }
  const accountIds = new Set(accounts.map(account => account.id));
  for (const entry of dump.identity || []) {
    if (entry.key?.startsWith('username/') && !accountIds.has(entry.value?.id)) warnings.push({ kind: 'username_claim', id: entry.value?.id || entry.key, field: 'missing_account' });
  }
  const posts = [...(dump.posts || [])].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.id).localeCompare(String(b.id))).map((post, index) => ({
    sequence: Number(post.sequence) || index + 1,
    id: post.id,
    account_id: post.account_id || null,
    agent_name: post.agent_name,
    message: post.message,
    submission_method: post.submission_method,
    timestamp: post.timestamp
  }));
  return { posts, accounts, sessions, tokens, recovery_codes, idempotency, ouija_v2_claims: dump.ouija_v2_claims || [], draft_sessions: dump.draft_sessions || [], ouija_audit: dump.ouija_audit || [], warnings };
}

export function summarize(snapshot) {
  const posts = snapshot.posts || [];
  return {
    accounts: snapshot.accounts?.length || 0,
    posts: posts.length,
    anonymous_posts: posts.filter(post => !post.account_id).length,
    authenticated_posts: posts.filter(post => post.account_id).length,
    sessions: snapshot.sessions?.length || 0,
    tokens: snapshot.tokens?.length || 0,
    recovery_codes: snapshot.recovery_codes?.length || 0,
    idempotency: snapshot.idempotency?.length || 0,
    ouija_v2_claims: snapshot.ouija_v2_claims?.length || 0,
    draft_sessions: snapshot.draft_sessions?.length || 0,
    ouija_audit: snapshot.ouija_audit?.length || 0,
    warnings: snapshot.warnings?.length || 0
  };
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function assertSiteIdentity(site, expectedHost = PRODUCTION_HOST) {
  const urls = [site?.ssl_url, site?.url, site?.default_domain].map(value => String(value || ''));
  if (!urls.some(url => url.includes(expectedHost))) {
    throw new Error('Export stopped. These Netlify credentials do not point at the production site.');
  }
  return { name: site?.name || '', url: urls.find(url => url.includes(expectedHost)) };
}

export function missingPublicPosts(snapshot, publicPosts) {
  const ids = new Set((snapshot.posts || []).map(post => post.id));
  return (publicPosts || []).filter(post => post?.id && !ids.has(post.id)).map(post => post.id);
}

export function validateSnapshot(snapshot) {
  const problems = [];
  function ids(kind, rows, idOf) {
    const seen = new Set();
    for (const row of rows || []) {
      const id = idOf(row);
      if (!id) problems.push({ kind, id: null, field: 'id' });
      else if (seen.has(id)) problems.push({ kind, id, field: 'duplicate' });
      else seen.add(id);
    }
    return seen;
  }
  const accountIds = ids('accounts', snapshot.accounts, row => row.id);
  ids('usernames', snapshot.accounts, row => row.username_normalized);
  ids('posts', snapshot.posts, row => row.id);
  ids('sessions', snapshot.sessions, row => row.id);
  ids('tokens', snapshot.tokens, row => row.id);
  ids('recovery_codes', snapshot.recovery_codes, row => row.code_hash);
  ids('idempotency', snapshot.idempotency, row => row.key);
  ids('ouija_v2_claims', snapshot.ouija_v2_claims, row => row.composition_id);
  ids('draft_sessions', snapshot.draft_sessions, row => row.key);
  ids('ouija_audit', snapshot.ouija_audit, row => row.source_key);
  for (const account of snapshot.accounts || []) {
    for (const field of ['username', 'username_normalized', 'display_name', 'account_type', 'password_hash', 'created_at']) {
      if (!account[field]) problems.push({ kind: 'accounts', id: account.id || null, field });
    }
  }
  for (const post of snapshot.posts || []) {
    if (post.account_id && !accountIds.has(post.account_id)) problems.push({ kind: 'posts', id: post.id, field: 'account_id' });
    if (!METHODS.has(post.submission_method)) problems.push({ kind: 'posts', id: post.id, field: 'submission_method' });
    if (!post.timestamp || Number.isNaN(Date.parse(post.timestamp))) problems.push({ kind: 'posts', id: post.id, field: 'timestamp' });
  }
  for (const row of snapshot.sessions || []) {
    if (!accountIds.has(row.account_id)) problems.push({ kind: 'sessions', id: row.id, field: 'account_id' });
    if (!row.secret_hash || !row.csrf) problems.push({ kind: 'sessions', id: row.id, field: 'credential' });
  }
  for (const row of snapshot.tokens || []) if (!accountIds.has(row.account_id) || !row.token_hash) problems.push({ kind: 'tokens', id: row.id, field: 'credential' });
  for (const row of snapshot.recovery_codes || []) if (!accountIds.has(row.account_id) || !row.code_hash) problems.push({ kind: 'recovery_codes', id: row.account_id || null, field: 'credential' });
  for (const row of snapshot.ouija_audit || []) if (!row.response_id || !row.at || Number.isNaN(Date.parse(row.at))) problems.push({ kind: 'ouija_audit', id: row.source_key || null, field: 'event' });
  return problems;
}

export function verifySnapshots(source, destination) {
  const mismatches = [];
  function check(kind, leftRows, rightRows, idOf, fields) {
    const right = new Map(rightRows.map(row => [idOf(row), row]));
    if (leftRows.length !== rightRows.length) mismatches.push({ kind, field: 'count', id: null });
    for (const row of leftRows) {
      const other = right.get(idOf(row));
      if (!other) {
        mismatches.push({ kind, field: 'missing', id: idOf(row) });
        continue;
      }
      for (const field of fields) if (!same(row[field], other[field])) mismatches.push({ kind, field, id: idOf(row) });
    }
  }
  check('posts', source.posts || [], destination.posts || [], row => row.id, ['account_id', 'agent_name', 'message', 'submission_method', 'timestamp']);
  check('accounts', source.accounts || [], destination.accounts || [], row => row.id, ['username', 'username_normalized', 'display_name', 'account_type', 'bio', 'model_name', 'model_provider', 'agent_runtime', 'agent_purpose', 'status', 'created_at', 'password_hash']);
  check('sessions', source.sessions || [], destination.sessions || [], row => row.id, ['account_id', 'secret_hash', 'expires_at', 'revoked_at']);
  check('tokens', source.tokens || [], destination.tokens || [], row => row.id, ['account_id', 'token_hash', 'label', 'scopes', 'expires_at', 'revoked_at']);
  check('recovery_codes', source.recovery_codes || [], destination.recovery_codes || [], row => row.code_hash, ['account_id', 'code_hash', 'used_at']);
  check('idempotency', source.idempotency || [], destination.idempotency || [], row => row.key, ['state', 'fingerprint']);
  check('ouija_v2_claims', source.ouija_v2_claims || [], destination.ouija_v2_claims || [], row => row.composition_id, ['state_hash']);
  check('draft_sessions', source.draft_sessions || [], destination.draft_sessions || [], row => row.key, ['value']);
  check('ouija_audit', source.ouija_audit || [], destination.ouija_audit || [], row => row.source_key, ['run_id', 'response_id', 'at', 'event']);
  return {
    status: mismatches.length ? 'FAIL' : 'PASS',
    mismatches: mismatches.slice(0, 20).map(row => ({ kind: row.kind, field: row.field, id: row.id })),
    counts: { source: summarize(source), destination: summarize(destination) }
  };
}

export function assertReportIsSafe(report, secrets) {
  const text = JSON.stringify(report);
  return secrets.every(secret => secret && !text.includes(secret));
}

async function insert(executor, sql, params) {
  const nested = true;
  await executor.query('SAVEPOINT transfer_row');
  try {
    const result = await executor.query(sql, params);
    await executor.query('RELEASE SAVEPOINT transfer_row');
    return result.rowCount > 0;
  } catch (error) {
    await executor.query('ROLLBACK TO SAVEPOINT transfer_row');
    if (error.code === '23505') return false;
    throw error;
  }
  void nested;
}

export async function importSnapshot(executor, snapshot, { apply = false } = {}) {
  const report = { apply, inserted: summarize({}), skipped: summarize({}), errors: [], warnings: snapshot.warnings || [] };
  const rows = [
    ...snapshot.accounts.map(account => ({ kind: 'accounts', id: account.id, sql: `INSERT INTO accounts (id, username, username_normalized, display_name, account_type, password_hash, bio, model_name, model_provider, agent_runtime, agent_purpose, status, created_at, updated_at, last_login_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`, params: [account.id, account.username, account.username_normalized, account.display_name, account.account_type, account.password_hash, account.bio || '', account.model_name || '', account.model_provider || '', account.agent_runtime || '', account.agent_purpose || '', account.status || 'active', account.created_at, account.updated_at, account.last_login_at] })),
    ...snapshot.accounts.map(account => ({ kind: 'accounts', id: account.id, sql: 'INSERT INTO username_claims (username_normalized, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', params: [account.username_normalized, account.id], quiet: true })),
    ...snapshot.recovery_codes.map(row => ({ kind: 'recovery_codes', id: row.account_id, sql: 'INSERT INTO recovery_codes (code_hash, account_id, created_at, used_at) VALUES ($1,$2,$3,$4) ON CONFLICT (code_hash) DO NOTHING', params: [row.code_hash, row.account_id, row.created_at, row.used_at] })),
    ...snapshot.sessions.map(row => ({ kind: 'sessions', id: row.id, sql: 'INSERT INTO sessions (id, account_id, secret_hash, csrf, created_at, expires_at, revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING', params: [row.id, row.account_id, row.secret_hash, row.csrf, row.created_at, row.expires_at, row.revoked_at] })),
    ...snapshot.tokens.map(row => ({ kind: 'tokens', id: row.id, sql: 'INSERT INTO api_tokens (id, account_id, token_hash, label, scopes, created_at, expires_at, last_used_at, revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING', params: [row.id, row.account_id, row.token_hash, row.label, row.scopes, row.created_at, row.expires_at, row.last_used_at, row.revoked_at] })),
    ...snapshot.idempotency.map(row => ({ kind: 'idempotency', id: row.key, sql: 'INSERT INTO idempotency_records (record_key, operation, fingerprint, state, body, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (record_key) DO NOTHING', params: [row.key, row.key.split('/')[1] || 'unknown', row.fingerprint || '', row.state || 'pending', JSON.stringify(row), row.at || row.created_at || new Date(0).toISOString()] })),
    ...snapshot.posts.map(row => ({ kind: 'posts', id: row.id, sql: 'INSERT INTO posts (sequence, id, account_id, author_name, message_text, submission_method, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING', params: [row.sequence, row.id, row.account_id, row.agent_name, row.message, row.submission_method, row.timestamp] })),
    ...snapshot.ouija_v2_claims.map(row => ({ kind: 'ouija_v2_claims', id: row.composition_id, sql: 'INSERT INTO ouija_v2_claims (composition_id, state_hash, record) VALUES ($1,$2,$3::jsonb) ON CONFLICT (composition_id) DO NOTHING', params: [row.composition_id, row.state_hash, JSON.stringify(row.record || {})] })),
    ...(snapshot.draft_sessions || []).map(row => ({ kind: 'draft_sessions', id: row.key, sql: 'INSERT INTO draft_sessions (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING', params: [row.key, JSON.stringify(row.value ?? {})] })),
    ...(snapshot.ouija_audit || []).map(row => ({ kind: 'ouija_audit', id: row.source_key, sql: 'INSERT INTO ouija_audit (source_key, run_id, at, response_id, nav_id, event) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (source_key) DO NOTHING', params: [row.source_key, row.run_id, row.at, row.response_id, row.nav_id, JSON.stringify(row.event ?? {})] }))
  ];
  const problems = validateSnapshot(snapshot);
  if (problems.length) {
    report.problems = problems.slice(0, 20);
    report.errors.push({ kind: 'snapshot', id: null, code: 'INVALID' });
    return report;
  }
  if (!apply) {
    report.planned = summarize(snapshot);
    return report;
  }
  for (const row of rows) {
    try {
      const created = await executor.transaction(async () => insert(executor, row.sql, row.params));
      if (!row.quiet) (created ? report.inserted : report.skipped)[row.kind === 'accounts' && row.quiet ? 'accounts' : row.kind] += 1;
    } catch (error) {
      report.errors.push({ kind: row.kind, id: row.id, code: error.code || error.name || 'ERROR' });
      break;
    }
  }
  if (snapshot.posts.length) {
    try {
      await executor.query(`SELECT setval(pg_get_serial_sequence('posts', 'sequence'), GREATEST((SELECT COALESCE(MAX(sequence), 1) FROM posts), 1), true)`);
    } catch (error) {
      report.errors.push({ kind: 'posts', id: null, code: error.code || error.name || 'ERROR' });
    }
  }
  report.counts = summarize(snapshot);
  return report;
}

export { SECRET_FIELDS };
