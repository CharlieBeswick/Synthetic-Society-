import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUDIT_RETENTION_MS, AUDIT_ROW_CAP, correlateEvents, isCompositionId, isRunId, summarizeRuns } from './ouija-diagnostics.js';

export function openStore(path = process.env.DATABASE_PATH || './data/messages.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      agent_name TEXT NOT NULL CHECK(length(agent_name) BETWEEN 1 AND 80),
      message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 2000),
      timestamp TEXT NOT NULL,
      submission_method TEXT NOT NULL DEFAULT 'unknown' CHECK(submission_method IN ('form', 'api', 'unknown', 'session_get', 'ouija_get', 'ouija_get_v2'))
    );`);
  // Old records predate route tracking; do not infer how they were submitted.
  if (!db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'submission_method')) {
    db.exec("ALTER TABLE messages ADD COLUMN submission_method TEXT NOT NULL DEFAULT 'unknown' CHECK(submission_method IN ('form', 'api', 'unknown'))");
  }
  if (!db.prepare("SELECT sql FROM sqlite_master WHERE name='messages'").get().sql.includes("'ouija_get'")) {
    // SQLite cannot alter a CHECK constraint. Preserve IDs and sequence in a transaction.
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE messages_v12 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        agent_name TEXT NOT NULL CHECK(length(agent_name) BETWEEN 1 AND 80),
        message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 2000), timestamp TEXT NOT NULL,
        submission_method TEXT NOT NULL DEFAULT 'unknown' CHECK(submission_method IN ('form','api','unknown','session_get','ouija_get','ouija_get_v2'))
      );
      INSERT INTO messages_v12 SELECT sequence,id,agent_name,message,timestamp,submission_method FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_v12 RENAME TO messages;
      COMMIT;`);
  }
  if (!db.prepare("SELECT sql FROM sqlite_master WHERE name='messages'").get().sql.includes("'ouija_get_v2'")) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE messages_v2 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        agent_name TEXT NOT NULL CHECK(length(agent_name) BETWEEN 1 AND 80),
        message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 2000), timestamp TEXT NOT NULL,
        submission_method TEXT NOT NULL DEFAULT 'unknown' CHECK(submission_method IN ('form','api','unknown','session_get','ouija_get','ouija_get_v2'))
      );
      INSERT INTO messages_v2 SELECT sequence,id,agent_name,message,timestamp,submission_method FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_v2 RENAME TO messages;
      COMMIT;`);
  }
  if (!db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'account_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN account_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS messages_by_account ON messages(account_id, sequence)');
  db.exec(`CREATE TABLE IF NOT EXISTS ouija_v2_claims (composition_id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS experimental_sessions (key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS ouija_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      at TEXT NOT NULL,
      response_id TEXT NOT NULL,
      nav_id TEXT,
      event TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ouija_audit_run ON ouija_audit(run_id, id);
    CREATE INDEX IF NOT EXISTS ouija_audit_at ON ouija_audit(at);
    CREATE TABLE IF NOT EXISTS identity_records (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );`);
  const insertAudit = db.prepare('INSERT INTO ouija_audit(run_id, at, response_id, nav_id, event) VALUES(?,?,?,?,?)');
  const deleteExpired = db.prepare('DELETE FROM ouija_audit WHERE id IN (SELECT id FROM ouija_audit WHERE at < ? ORDER BY id LIMIT 100)');
  const countAudit = db.prepare('SELECT COUNT(*) AS n FROM ouija_audit');
  const deleteOldest = db.prepare('DELETE FROM ouija_audit WHERE id IN (SELECT id FROM ouija_audit ORDER BY id LIMIT 100)');
  const auditByRun = db.prepare('SELECT event FROM ouija_audit WHERE run_id = ? ORDER BY id');
  const recentAudit = db.prepare('SELECT event FROM ouija_audit WHERE run_id IS NOT NULL ORDER BY id DESC LIMIT 2000');
  const insert = db.prepare('INSERT INTO messages(id,agent_name,message,timestamp,submission_method,account_id) VALUES(?,?,?,?,?,?)');
  const one = db.prepare('SELECT id,agent_name,message,timestamp,submission_method,account_id FROM messages WHERE id=?');
  const recent = db.prepare('SELECT id,agent_name,message,timestamp,submission_method,account_id FROM messages ORDER BY sequence DESC LIMIT 100');
  const insertOnce = db.prepare('INSERT INTO messages(id,agent_name,message,timestamp,submission_method,account_id) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
  const postsPage = db.prepare('SELECT id,agent_name,message,timestamp,submission_method,account_id,sequence FROM messages WHERE account_id=? AND (? IS NULL OR sequence < ?) ORDER BY sequence DESC LIMIT ?');
  const postCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id=?');
  function shape(row) {
    if (!row) return row;
    const record = { id: row.id, agent_name: row.agent_name, message: row.message, timestamp: row.timestamp, submission_method: row.submission_method };
    if (row.account_id) record.account_id = row.account_id;
    return record;
  }
  const sessionRead = db.prepare('SELECT value,version FROM experimental_sessions WHERE key=?');
  const sessionCreate = db.prepare('INSERT INTO experimental_sessions(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING');
  const sessionSwap = db.prepare('UPDATE experimental_sessions SET value=?,version=version+1 WHERE key=? AND version=?');
  const readClaim = db.prepare('SELECT value FROM ouija_v2_claims WHERE composition_id=?');
  const insertClaim = db.prepare('INSERT INTO ouija_v2_claims(composition_id, value) VALUES(?,?)');
  function claimOuijaV2(claim) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = readClaim.get(claim.composition_id);
      if (row) {
        const existing = JSON.parse(row.value);
        db.exec('COMMIT');
        if (existing.state_hash !== claim.state_hash) return { outcome: 'different', record: existing.record };
        insertOnce.run(existing.record.id, existing.record.agent_name, existing.record.message, existing.record.timestamp, existing.record.submission_method, existing.record.account_id || null);
        return { outcome: 'same', record: one.get(existing.record.id) };
      }
      insertOnce.run(claim.record.id, claim.record.agent_name, claim.record.message, claim.record.timestamp, claim.record.submission_method, claim.record.account_id || null);
      const saved = shape(one.get(claim.record.id));
      if (!saved || saved.agent_name !== claim.record.agent_name || saved.message !== claim.record.message || saved.submission_method !== claim.record.submission_method) throw new Error('Stored record does not match submission journal.');
      insertClaim.run(claim.composition_id, JSON.stringify({ composition_id: claim.composition_id, state_hash: claim.state_hash, record: saved }));
      db.exec('COMMIT');
      return { outcome: 'created', record: saved };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
      throw error;
    }
  }
  return {
    sessions: {
      read(key) { const row = sessionRead.get(key); return row ? { value: JSON.parse(row.value), etag: row.version } : null; },
      create: (key, value) => sessionCreate.run(key, JSON.stringify(value)).changes === 1,
      swap: (key, value, etag) => sessionSwap.run(JSON.stringify(value), key, etag).changes === 1,
      remove: key => db.prepare('DELETE FROM experimental_sessions WHERE key=?').run(key),
      async *keys() { for (const row of db.prepare('SELECT key FROM experimental_sessions LIMIT 100').all()) yield row.key; }
    },
    identity: {
      get(key) {
        const row = db.prepare('SELECT value, version FROM identity_records WHERE key=?').get(key);
        return row ? { value: JSON.parse(row.value), version: row.version } : null;
      },
      create: (key, value) => db.prepare('INSERT INTO identity_records(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING').run(key, JSON.stringify(value)).changes === 1,
      swap: (key, value, version) => db.prepare('UPDATE identity_records SET value=?, version=version+1 WHERE key=? AND version=?').run(JSON.stringify(value), key, version).changes === 1,
      async remove(key) { db.prepare('DELETE FROM identity_records WHERE key=?').run(key); },
      async keys(prefix = '') {
        const like = `${prefix.replace(/[\\%_]/g, char => `\\${char}`)}%`;
        return db.prepare("SELECT key FROM identity_records WHERE key LIKE ? ESCAPE '\\' ORDER BY key LIMIT 500").all(like).map(row => row.key);
      }
    },
    audit: {
      async append(event) {
        const index = isRunId(event.run_id) ? event.run_id : isCompositionId(event.composition_id) ? event.composition_id : event.run_id;
        insertAudit.run(index, event.at, event.response_id, event.nav_id, JSON.stringify(event));
        try {
          deleteExpired.run(new Date(Date.now() - AUDIT_RETENTION_MS).toISOString());
          if (countAudit.get().n > AUDIT_ROW_CAP) deleteOldest.run();
        } catch (error) { console.error('Ouija audit retention failed', error.name); }
      },
      async events(runId) {
        if (!isRunId(runId) && !isCompositionId(runId)) return [];
        return correlateEvents(auditByRun.all(runId).map(row => JSON.parse(row.event)));
      },
      async summaries(limit = 50) {
        return summarizeRuns(recentAudit.all().map(row => JSON.parse(row.event)).reverse(), limit);
      }
    },
    putIfAbsent(record) {
      insertOnce.run(record.id, record.agent_name, record.message, record.timestamp, record.submission_method, record.account_id || null);
      const saved = shape(one.get(record.id));
      if (JSON.stringify(saved) !== JSON.stringify(record.account_id ? record : { id: record.id, agent_name: record.agent_name, message: record.message, timestamp: record.timestamp, submission_method: record.submission_method })) throw new Error('Stored record does not match submission journal.');
      return saved;
    },
    add(agent_name, message, submission_method, account_id = null) {
      if (!['form', 'api'].includes(submission_method)) throw new Error('Submission method must be form or api.');
      const record = { id: randomUUID(), agent_name, message, timestamp: new Date().toISOString(), submission_method };
      if (account_id) record.account_id = account_id;
      insert.run(record.id, agent_name, message, record.timestamp, submission_method, account_id);
      return record;
    },
    get: id => shape(one.get(id)),
    recent: () => recent.all().map(shape),
    countPosts: accountId => postCount.get(accountId).n,
    postsByAccount(accountId, { limit = 20, cursor = null } = {}) {
      const size = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const before = cursor == null || cursor === '' ? null : Number(cursor);
      if (before != null && !Number.isInteger(before)) return { posts: [], next_cursor: null };
      const rows = postsPage.all(accountId, before, before, size + 1);
      const page = rows.slice(0, size).map(shape);
      return { posts: page, next_cursor: rows.length > size ? String(rows[size - 1].sequence) : null };
    },
    claimOuijaV2,
    exportRecords() {
      return {
        posts: db.prepare('SELECT sequence, id, agent_name, message, timestamp, submission_method, account_id FROM messages ORDER BY sequence').all().map(row => ({ sequence: row.sequence, id: row.id, account_id: row.account_id, agent_name: row.agent_name, message: row.message, submission_method: row.submission_method, timestamp: row.timestamp })),
        identity: db.prepare('SELECT key, value FROM identity_records ORDER BY key').all().map(row => ({ key: row.key, value: JSON.parse(row.value) })),
        ouija_v2_claims: db.prepare('SELECT composition_id, value FROM ouija_v2_claims ORDER BY composition_id').all().map(row => ({ composition_id: row.composition_id, ...JSON.parse(row.value) }))
      };
    },
    close: () => db.close()
  };
}
