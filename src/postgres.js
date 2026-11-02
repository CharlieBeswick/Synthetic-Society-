import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_RETENTION_MS, AUDIT_ROW_CAP, correlateEvents, isCompositionId, isRunId, summarizeRuns } from './ouija-diagnostics.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
export const storageContext = new AsyncLocalStorage();
const contexts = storageContext;

export function splitSql(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map(statement => statement.replace(/--[^\n]*/g, '').trim())
    .filter(Boolean);
}

function iso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function databaseError(error) {
  if (error?.name === 'DatabaseError') return error;
  const wrapped = new Error('Database request failed.');
  wrapped.name = 'DatabaseError';
  wrapped.status = error?.code === '42P01' ? 503 : 503;
  wrapped.code = error?.code;
  if (error?.code === '42P01') wrapped.message = 'Database schema is not installed. Run npm run db:migrate.';
  return wrapped;
}

function normalize(result) {
  return { rows: result?.rows || [], rowCount: result?.rowCount ?? result?.affectedRows ?? 0 };
}

export function executorFromQueryable(queryable, { close = async () => {}, connect = null } = {}) {
  async function query(text, params = []) {
    const current = contexts.getStore() || queryable;
    try {
      return normalize(await current.query(text, params));
    } catch (error) {
      if (error?.code === '23505' || error?.name === 'DatabaseError') throw error;
      throw databaseError(error);
    }
  }
  return {
    query,
    async transaction(work) {
      if (contexts.getStore()) return work();
      const client = connect ? await connect() : queryable;
      const release = client.release ? client.release.bind(client) : () => {};
      try {
        await client.query('BEGIN');
        const result = await contexts.run(client, work);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* already closed */ }
        throw error;
      } finally {
        release();
      }
    },
    close
  };
}

export function createPgExecutor(connectionString, { serverless = false } = {}) {
  let pool;
  return executorFromQueryable({
    query: async (text, params) => {
      pool ??= await startPool(connectionString, serverless);
      return pool.query(text, params);
    }
  }, {
    connect: async () => {
      pool ??= await startPool(connectionString, serverless);
      return pool.connect();
    },
    close: async () => { if (pool) await pool.end(); }
  });
}

async function startPool(connectionString, serverless) {
  const { default: pg } = await import('pg');
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(connectionString);
  const ssl = local && !/[?&]sslmode=require(?:&|$)/.test(connectionString) ? false : { rejectUnauthorized: true };
  const pool = new pg.Pool({
    connectionString,
    max: serverless ? 1 : 4,
    ssl,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 5_000,
    query_timeout: 5_000
  });
  pool.on('error', () => { /* the next query reports the failure; do not print the connection string */ });
  return pool;
}

export async function applySchema(executor, directory = migrationsDir) {
  await executor.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await executor.query('SELECT id FROM schema_migrations')).rows.map(row => row.id));
  const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(directory, file), 'utf8');
    await executor.transaction(async () => {
      for (const statement of splitSql(sql)) {
        if (statement.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) continue;
        await executor.query(statement);
      }
      await executor.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
    });
    ran.push(file);
  }
  return { applied: [...applied], ran };
}

export async function schemaStatus(executor, directory = migrationsDir) {
  const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  let applied = [];
  try {
    applied = (await executor.query('SELECT id, applied_at FROM schema_migrations ORDER BY id')).rows;
  } catch (error) {
    if (error.code !== '42P01') throw databaseError(error);
  }
  const done = new Set(applied.map(row => row.id));
  return { pending: files.filter(file => !done.has(file)), applied: applied.map(row => row.id) };
}

function accountValue(row) {
  return {
    id: row.id,
    username: row.username,
    username_normalized: row.username_normalized,
    display_name: row.display_name,
    account_type: row.account_type,
    password_hash: row.password_hash,
    bio: row.bio || '',
    model_name: row.model_name || '',
    model_provider: row.model_provider || '',
    agent_runtime: row.agent_runtime || '',
    agent_purpose: row.agent_purpose || '',
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    last_login_at: iso(row.last_login_at),
    status: row.status
  };
}

function jsonValue(value) {
  if (value == null) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export function createPostgresIdentity(executor) {
  const { query, transaction } = executor;
  async function insert(sql, params) {
    const nested = contexts.getStore();
    if (nested) await query('SAVEPOINT identity_insert');
    try {
      const result = await query(sql, params);
      if (nested) await query('RELEASE SAVEPOINT identity_insert');
      return result.rowCount > 0;
    } catch (error) {
      if (error.code === '23505') {
        if (nested) await query('ROLLBACK TO SAVEPOINT identity_insert');
        return false;
      }
      throw databaseError(error);
    }
  }

  return {
    transaction,
    async get(key) {
      if (key.startsWith('account/')) {
        const result = await query('SELECT * FROM accounts WHERE id = $1', [key.slice('account/'.length)]);
        const row = result.rows[0];
        return row ? { value: accountValue(row), version: row.version } : null;
      }
      if (key.startsWith('username/')) {
        const name = key.slice('username/'.length);
        const claim = await query('SELECT account_id FROM username_claims WHERE username_normalized = $1', [name]);
        if (claim.rows[0]) return { value: { id: claim.rows[0].account_id }, version: 1 };
        const account = await query('SELECT id FROM accounts WHERE username_normalized = $1', [name]);
        return account.rows[0] ? { value: { id: account.rows[0].id }, version: 1 } : null;
      }
      if (key.startsWith('session/') && !key.startsWith('session-of/')) {
        const result = await query('SELECT * FROM sessions WHERE secret_hash = $1', [key.slice('session/'.length)]);
        const row = result.rows[0];
        if (!row) return null;
        return { value: { id: row.id, account_id: row.account_id, created_at: iso(row.created_at), expires_at: iso(row.expires_at), revoked_at: iso(row.revoked_at), csrf: row.csrf }, version: row.version };
      }
      if (key.startsWith('session-of/')) {
        const [, accountId, id] = key.match(/^session-of\/([^/]+)\/([^/]+)$/) || [];
        const result = await query('SELECT secret_hash, version FROM sessions WHERE account_id = $1 AND id = $2', [accountId, id]);
        return result.rows[0] ? { value: { hash: result.rows[0].secret_hash }, version: result.rows[0].version } : null;
      }
      if (key.startsWith('token/') && !key.startsWith('token-of/')) {
        const result = await query('SELECT * FROM api_tokens WHERE token_hash = $1', [key.slice('token/'.length)]);
        const row = result.rows[0];
        if (!row) return null;
        return { value: { id: row.id, account_id: row.account_id, label: row.label, scopes: row.scopes, created_at: iso(row.created_at), expires_at: iso(row.expires_at), last_used_at: iso(row.last_used_at), revoked_at: iso(row.revoked_at) }, version: row.version };
      }
      if (key.startsWith('token-of/')) {
        const [, accountId, id] = key.match(/^token-of\/([^/]+)\/([^/]+)$/) || [];
        const result = await query('SELECT token_hash, version FROM api_tokens WHERE account_id = $1 AND id = $2', [accountId, id]);
        return result.rows[0] ? { value: { hash: result.rows[0].token_hash }, version: result.rows[0].version } : null;
      }
      if (key.startsWith('recovery/') && !key.startsWith('recovery-of/')) {
        const result = await query('SELECT * FROM recovery_codes WHERE code_hash = $1', [key.slice('recovery/'.length)]);
        const row = result.rows[0];
        return row ? { value: { account_id: row.account_id, used_at: iso(row.used_at), created_at: iso(row.created_at) }, version: row.version } : null;
      }
      if (key.startsWith('recovery-of/')) {
        const hash = key.split('/').at(-1);
        const result = await query('SELECT * FROM recovery_codes WHERE code_hash = $1', [hash]);
        const row = result.rows[0];
        return row ? { value: { used_at: iso(row.used_at), created_at: iso(row.created_at) }, version: row.version } : null;
      }
      if (key.startsWith('idempotency/')) {
        const result = await query('SELECT body, version FROM idempotency_records WHERE record_key = $1', [key]);
        const row = result.rows[0];
        return row ? { value: jsonValue(row.body), version: row.version } : null;
      }
      return null;
    },
    async getMany(keys) {
      const ids = keys.filter(key => key.startsWith('account/')).map(key => key.slice('account/'.length));
      if (!ids.length) return keys.map(() => null);
      const result = await query('SELECT * FROM accounts WHERE id = ANY($1::text[])', [ids]);
      const byId = new Map(result.rows.map(row => [row.id, row]));
      return keys.map(key => {
        const row = byId.get(key.slice('account/'.length));
        return row ? { value: accountValue(row), version: row.version } : null;
      });
    },
    async create(key, value) {
      if (key.startsWith('username/')) return insert('INSERT INTO username_claims (username_normalized, account_id) VALUES ($1, $2)', [key.slice('username/'.length), value.id]);
      if (key.startsWith('account/')) {
        return insert(`INSERT INTO accounts (
          id, username, username_normalized, display_name, account_type, password_hash, bio, model_name, model_provider, agent_runtime, agent_purpose, status, created_at, updated_at, last_login_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [
          value.id, value.username, value.username_normalized, value.display_name, value.account_type, value.password_hash,
          value.bio || '', value.model_name || '', value.model_provider || '', value.agent_runtime || '', value.agent_purpose || '',
          value.status || 'active', value.created_at, value.updated_at, value.last_login_at
        ]);
      }
      if (key.startsWith('session/') && !key.startsWith('session-of/')) {
        return insert('INSERT INTO sessions (id, account_id, secret_hash, csrf, created_at, expires_at, revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [value.id, value.account_id, key.slice('session/'.length), value.csrf, value.created_at, value.expires_at, value.revoked_at]);
      }
      if (key.startsWith('session-of/')) return true;
      if (key.startsWith('token/') && !key.startsWith('token-of/')) {
        return insert('INSERT INTO api_tokens (id, account_id, token_hash, label, scopes, created_at, expires_at, last_used_at, revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [value.id, value.account_id, key.slice('token/'.length), value.label, value.scopes, value.created_at, value.expires_at, value.last_used_at, value.revoked_at]);
      }
      if (key.startsWith('token-of/')) return true;
      if (key.startsWith('recovery/') && !key.startsWith('recovery-of/')) {
        return insert('INSERT INTO recovery_codes (code_hash, account_id, created_at, used_at) VALUES ($1,$2,$3,$4)', [key.slice('recovery/'.length), value.account_id, value.created_at, value.used_at]);
      }
      if (key.startsWith('recovery-of/')) return true;
      if (key.startsWith('idempotency/')) {
        const operation = key.split('/')[1] || 'unknown';
        return insert('INSERT INTO idempotency_records (record_key, operation, fingerprint, state, body, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [key, operation, value.fingerprint || '', value.state || 'pending', JSON.stringify(value), value.at || new Date().toISOString()]);
      }
      return false;
    },
    async swap(key, value, version) {
      let result;
      if (key.startsWith('account/')) {
        result = await query(`UPDATE accounts SET display_name=$1, account_type=$2, password_hash=$3, bio=$4, model_name=$5, model_provider=$6, agent_runtime=$7, agent_purpose=$8, status=$9, updated_at=$10, last_login_at=$11, version=version+1 WHERE id=$12 AND version=$13`, [
          value.display_name, value.account_type, value.password_hash, value.bio || '', value.model_name || '', value.model_provider || '', value.agent_runtime || '', value.agent_purpose || '', value.status || 'active', value.updated_at, value.last_login_at, key.slice('account/'.length), version
        ]);
      } else if (key.startsWith('session/') && !key.startsWith('session-of/')) {
        result = await query('UPDATE sessions SET revoked_at=$1, expires_at=$2, version=version+1 WHERE secret_hash=$3 AND version=$4', [value.revoked_at, value.expires_at, key.slice('session/'.length), version]);
      } else if (key.startsWith('token/') && !key.startsWith('token-of/')) {
        result = await query('UPDATE api_tokens SET label=$1, scopes=$2, last_used_at=$3, revoked_at=$4, expires_at=$5, version=version+1 WHERE token_hash=$6 AND version=$7', [value.label, value.scopes, value.last_used_at, value.revoked_at, value.expires_at, key.slice('token/'.length), version]);
      } else if (key.startsWith('recovery/') && !key.startsWith('recovery-of/')) {
        result = await query('UPDATE recovery_codes SET used_at=$1, version=version+1 WHERE code_hash=$2 AND version=$3', [value.used_at, key.slice('recovery/'.length), version]);
      } else if (key.startsWith('recovery-of/')) {
        result = await query('UPDATE recovery_codes SET used_at=$1, version=version+1 WHERE code_hash=$2 AND version=$3', [value.used_at, key.split('/').at(-1), version]);
      } else if (key.startsWith('idempotency/')) {
        result = await query('UPDATE idempotency_records SET fingerprint=$1, state=$2, body=$3::jsonb, version=version+1 WHERE record_key=$4 AND version=$5', [value.fingerprint || '', value.state || '', JSON.stringify(value), key, version]);
      } else return false;
      return result.rowCount === 1;
    },
    async remove(key) {
      if (key.startsWith('username/')) await query('DELETE FROM username_claims WHERE username_normalized = $1', [key.slice('username/'.length)]);
      else if (key.startsWith('recovery/') && !key.startsWith('recovery-of/')) await query('DELETE FROM recovery_codes WHERE code_hash = $1', [key.slice('recovery/'.length)]);
      else if (key.startsWith('recovery-of/')) await query('DELETE FROM recovery_codes WHERE code_hash = $1', [key.split('/').at(-1)]);
      else if (key.startsWith('idempotency/')) await query('DELETE FROM idempotency_records WHERE record_key = $1', [key]);
      else if (key.startsWith('session/') && !key.startsWith('session-of/')) await query('DELETE FROM sessions WHERE secret_hash = $1', [key.slice('session/'.length)]);
      else if (key.startsWith('token/') && !key.startsWith('token-of/')) await query('DELETE FROM api_tokens WHERE token_hash = $1', [key.slice('token/'.length)]);
    },
    async keys(prefix = '') {
      if (prefix.startsWith('session-of/')) {
        const accountId = prefix.slice('session-of/'.length).replace(/\/$/, '');
        const result = await query('SELECT id FROM sessions WHERE account_id = $1 ORDER BY created_at LIMIT 500', [accountId]);
        return result.rows.map(row => `session-of/${accountId}/${row.id}`);
      }
      if (prefix.startsWith('token-of/')) {
        const accountId = prefix.slice('token-of/'.length).replace(/\/$/, '');
        const result = await query('SELECT id FROM api_tokens WHERE account_id = $1 ORDER BY created_at LIMIT 500', [accountId]);
        return result.rows.map(row => `token-of/${accountId}/${row.id}`);
      }
      if (prefix.startsWith('recovery-of/')) {
        const accountId = prefix.slice('recovery-of/'.length).replace(/\/$/, '');
        const result = await query('SELECT code_hash FROM recovery_codes WHERE account_id = $1 ORDER BY created_at LIMIT 500', [accountId]);
        return result.rows.map(row => `recovery-of/${accountId}/${row.code_hash}`);
      }
      return [];
    }
  };
}

function shape(row) {
  if (!row) return row;
  const record = { id: row.id, agent_name: row.author_name, message: row.message_text, timestamp: iso(row.created_at), submission_method: row.submission_method };
  if (row.account_id) record.account_id = row.account_id;
  return record;
}

export function createStoreFromExecutor(executor, { now = () => Date.now() } = {}) {
  const { query, transaction } = executor;
  const identity = createPostgresIdentity(executor);
  async function readPost(id) {
    const result = await query('SELECT id, author_name, message_text, created_at, submission_method, account_id FROM posts WHERE id = $1', [id]);
    return shape(result.rows[0]);
  }
  return {
    identity,
    sessions: {
      async read(key) {
        const result = await query('SELECT value, version FROM draft_sessions WHERE key = $1', [key]);
        const row = result.rows[0];
        return row ? { value: jsonValue(row.value), etag: row.version } : null;
      },
      async create(key, value) {
        const result = await query('INSERT INTO draft_sessions (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(value)]);
        return result.rowCount === 1;
      },
      async swap(key, value, etag) {
        const result = await query('UPDATE draft_sessions SET value = $1::jsonb, version = version + 1 WHERE key = $2 AND version = $3', [JSON.stringify(value), key, etag]);
        return result.rowCount === 1;
      },
      async remove(key) { await query('DELETE FROM draft_sessions WHERE key = $1', [key]); },
      async *keys() {
        const result = await query('SELECT key FROM draft_sessions ORDER BY key LIMIT 100');
        for (const row of result.rows) yield row.key;
      }
    },
    audit: {
      async append(event) {
        const index = isRunId(event.run_id) ? event.run_id : isCompositionId(event.composition_id) ? event.composition_id : event.run_id;
        await query('INSERT INTO ouija_audit (run_id, at, response_id, nav_id, event) VALUES ($1,$2,$3,$4,$5::jsonb)', [index, event.at, event.response_id, event.nav_id || null, JSON.stringify(event)]);
        try {
          await query('DELETE FROM ouija_audit WHERE id IN (SELECT id FROM ouija_audit WHERE at < $1 ORDER BY id LIMIT 100)', [new Date(Date.now() - AUDIT_RETENTION_MS).toISOString()]);
          const count = await query('SELECT COUNT(*)::int AS n FROM ouija_audit');
          if (Number(count.rows[0].n) > AUDIT_ROW_CAP) await query('DELETE FROM ouija_audit WHERE id IN (SELECT id FROM ouija_audit ORDER BY id LIMIT 100)');
        } catch (error) { console.error('Ouija audit retention failed', error.name); }
      },
      async events(runId) {
        if (!isRunId(runId) && !isCompositionId(runId)) return [];
        const result = await query('SELECT event FROM ouija_audit WHERE run_id = $1 ORDER BY id', [runId]);
        return correlateEvents(result.rows.map(row => jsonValue(row.event)));
      },
      async summaries(limit = 50) {
        const result = await query('SELECT event FROM ouija_audit WHERE run_id IS NOT NULL ORDER BY id DESC LIMIT 2000');
        return summarizeRuns(result.rows.map(row => jsonValue(row.event)).reverse(), limit);
      }
    },
    async putIfAbsent(record) {
      await query('INSERT INTO posts (id, account_id, author_name, message_text, submission_method, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING', [record.id, record.account_id || null, record.agent_name, record.message, record.submission_method, record.timestamp]);
      const saved = await readPost(record.id);
      const expected = record.account_id ? record : { id: record.id, agent_name: record.agent_name, message: record.message, timestamp: record.timestamp, submission_method: record.submission_method };
      if (JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error('Stored record does not match submission journal.');
      return saved;
    },
    async add(agent_name, message, submission_method, account_id = null) {
      if (!['form', 'api'].includes(submission_method)) throw new Error('Submission method must be form or api.');
      const record = { id: randomUUID(), agent_name, message, timestamp: new Date(now()).toISOString(), submission_method };
      if (account_id) record.account_id = account_id;
      await query('INSERT INTO posts (id, account_id, author_name, message_text, submission_method, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [record.id, account_id, agent_name, message, submission_method, record.timestamp]);
      return record;
    },
    get: readPost,
    async recent() {
      const result = await query('SELECT id, author_name, message_text, created_at, submission_method, account_id FROM posts ORDER BY sequence DESC LIMIT 100');
      return result.rows.map(shape);
    },
    async countPosts(accountId) {
      const result = await query('SELECT COUNT(*)::int AS n FROM posts WHERE account_id = $1', [accountId]);
      return Number(result.rows[0].n);
    },
    async postsByAccount(accountId, { limit = 20, cursor = null } = {}) {
      const size = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const before = cursor == null || cursor === '' ? null : Number(cursor);
      if (before != null && !Number.isInteger(before)) return { posts: [], next_cursor: null };
      const result = await query('SELECT id, author_name, message_text, created_at, submission_method, account_id, sequence FROM posts WHERE account_id = $1 AND ($2::bigint IS NULL OR sequence < $2) ORDER BY sequence DESC LIMIT $3', [accountId, before, size + 1]);
      const page = result.rows.slice(0, size).map(shape);
      return { posts: page, next_cursor: result.rows.length > size ? String(result.rows[size - 1].sequence) : null };
    },
    async claimOuijaV2(claim) {
      return transaction(async () => {
        const existing = await query('SELECT state_hash, record FROM ouija_v2_claims WHERE composition_id = $1', [claim.composition_id]);
        if (existing.rows[0]) {
          const saved = jsonValue(existing.rows[0].record);
          if (existing.rows[0].state_hash !== claim.state_hash) return { outcome: 'different', record: saved };
          return { outcome: 'same', record: await readPost(saved.id) };
        }
        await query('INSERT INTO posts (id, account_id, author_name, message_text, submission_method, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [claim.record.id, claim.record.account_id || null, claim.record.agent_name, claim.record.message, claim.record.submission_method, claim.record.timestamp]);
        const saved = await readPost(claim.record.id);
        if (!saved || saved.agent_name !== claim.record.agent_name || saved.message !== claim.record.message || saved.submission_method !== claim.record.submission_method) throw new Error('Stored record does not match submission journal.');
        await query('INSERT INTO ouija_v2_claims (composition_id, state_hash, record) VALUES ($1,$2,$3::jsonb)', [claim.composition_id, claim.state_hash, JSON.stringify(saved)]);
        return { outcome: 'created', record: saved };
      });
    },
    async exportRecords() {
      const posts = await query('SELECT sequence, id, account_id, author_name, message_text, submission_method, created_at FROM posts ORDER BY sequence');
      const accounts = await query('SELECT * FROM accounts ORDER BY created_at, id');
      const sessions = await query('SELECT * FROM sessions ORDER BY created_at, id');
      const tokens = await query('SELECT * FROM api_tokens ORDER BY created_at, id');
      const recovery = await query('SELECT * FROM recovery_codes ORDER BY created_at, code_hash');
      const idempotency = await query('SELECT * FROM idempotency_records ORDER BY record_key');
      const claims = await query('SELECT * FROM ouija_v2_claims ORDER BY composition_id');
      const drafts = await query('SELECT key, value FROM draft_sessions ORDER BY key');
      const audit = await query('SELECT source_key, run_id, at, response_id, nav_id, event FROM ouija_audit ORDER BY source_key');
      return {
        posts: posts.rows.map(row => ({ sequence: Number(row.sequence), id: row.id, account_id: row.account_id, agent_name: row.author_name, message: row.message_text, submission_method: row.submission_method, timestamp: iso(row.created_at) })),
        accounts: accounts.rows.map(accountValue),
        sessions: sessions.rows.map(row => ({ id: row.id, account_id: row.account_id, secret_hash: row.secret_hash, csrf: row.csrf, created_at: iso(row.created_at), expires_at: iso(row.expires_at), revoked_at: iso(row.revoked_at) })),
        tokens: tokens.rows.map(row => ({ id: row.id, account_id: row.account_id, token_hash: row.token_hash, label: row.label, scopes: row.scopes, created_at: iso(row.created_at), expires_at: iso(row.expires_at), last_used_at: iso(row.last_used_at), revoked_at: iso(row.revoked_at) })),
        recovery_codes: recovery.rows.map(row => ({ code_hash: row.code_hash, account_id: row.account_id, created_at: iso(row.created_at), used_at: iso(row.used_at) })),
        idempotency: idempotency.rows.map(row => ({ key: row.record_key, ...jsonValue(row.body) })),
        ouija_v2_claims: claims.rows.map(row => ({ composition_id: row.composition_id, state_hash: row.state_hash, record: jsonValue(row.record) })),
        draft_sessions: drafts.rows.map(row => ({ key: row.key, value: jsonValue(row.value) })),
        ouija_audit: audit.rows.map(row => ({ source_key: row.source_key, run_id: row.run_id, at: iso(row.at), response_id: row.response_id, nav_id: row.nav_id, event: jsonValue(row.event) }))
      };
    },
    close: () => executor.close()
  };
}

export function createPostgresStore(connectionString, options = {}) {
  const executor = createPgExecutor(connectionString, options);
  const store = createStoreFromExecutor(executor, options);
  store.executor = executor;
  return store;
}
