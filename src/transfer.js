const SECRET_FIELDS = new Set(['password_hash', 'secret_hash', 'token_hash', 'code_hash', 'csrf', 'fingerprint']);

export function snapshotFromIdentity(dump) {
  const accounts = [];
  const sessions = [];
  const tokens = [];
  const recovery_codes = [];
  const idempotency = [];
  const warnings = [];
  for (const entry of dump.identity || []) {
    const key = entry.key;
    const value = entry.value || {};
    if (key.startsWith('account/')) accounts.push(value);
    else if (key.startsWith('session/') && !key.startsWith('session-of/')) sessions.push({ secret_hash: key.slice('session/'.length), ...value });
    else if (key.startsWith('token/') && !key.startsWith('token-of/')) tokens.push({ token_hash: key.slice('token/'.length), ...value });
    else if (key.startsWith('recovery/') && !key.startsWith('recovery-of/')) recovery_codes.push({ code_hash: key.slice('recovery/'.length), ...value });
    else if (key.startsWith('idempotency/')) idempotency.push({ key, ...value });
    else if (key.startsWith('username/') && !accounts.some(account => account.id === value.id)) warnings.push({ kind: 'username_claim', id: value.id || key });
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
  return { posts, accounts, sessions, tokens, recovery_codes, idempotency, ouija_v2_claims: dump.ouija_v2_claims || [], warnings };
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
    warnings: snapshot.warnings?.length || 0
  };
}

function same(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
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
    ...snapshot.ouija_v2_claims.map(row => ({ kind: 'ouija_v2_claims', id: row.composition_id, sql: 'INSERT INTO ouija_v2_claims (composition_id, state_hash, record) VALUES ($1,$2,$3::jsonb) ON CONFLICT (composition_id) DO NOTHING', params: [row.composition_id, row.state_hash, JSON.stringify(row.record || {})] }))
  ];
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

export async function snapshotFromBlobStores({ messages, identity }) {
  const posts = [];
  for await (const page of messages.list({ prefix: 'messages/', paginate: true })) {
    for (const blob of page.blobs || []) {
      const value = await messages.get(blob.key, { type: 'json', consistency: 'strong' });
      if (value?.id) posts.push(value);
    }
  }
  const entries = [];
  for await (const page of identity.list({ prefix: 'identity/', paginate: true })) {
    for (const blob of page.blobs || []) {
      const row = await identity.getWithMetadata(blob.key, { type: 'json', consistency: 'strong' });
      if (row?.data) entries.push({ key: blob.key.slice('identity/'.length), value: row.data });
    }
  }
  const ouija_v2_claims = [];
  for await (const page of messages.list({ prefix: 'ouija-v2-claims/', paginate: true })) {
    for (const blob of page.blobs || []) {
      const value = await messages.get(blob.key, { type: 'json', consistency: 'strong' });
      if (value?.composition_id) ouija_v2_claims.push(value);
    }
  }
  return snapshotFromIdentity({ posts, identity: entries, ouija_v2_claims });
}

export { SECRET_FIELDS };
