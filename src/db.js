import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

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
      submission_method TEXT NOT NULL DEFAULT 'unknown' CHECK(submission_method IN ('form', 'api', 'unknown', 'session_get', 'ouija_get'))
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
        submission_method TEXT NOT NULL DEFAULT 'unknown' CHECK(submission_method IN ('form','api','unknown','session_get','ouija_get'))
      );
      INSERT INTO messages_v12 SELECT sequence,id,agent_name,message,timestamp,submission_method FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_v12 RENAME TO messages;
      COMMIT;`);
  }
  db.exec('CREATE TABLE IF NOT EXISTS experimental_sessions (key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1)');
  const insert = db.prepare('INSERT INTO messages(id,agent_name,message,timestamp,submission_method) VALUES(?,?,?,?,?)');
  const one = db.prepare('SELECT id,agent_name,message,timestamp,submission_method FROM messages WHERE id=?');
  const recent = db.prepare('SELECT id,agent_name,message,timestamp,submission_method FROM messages ORDER BY sequence DESC LIMIT 100');
  const insertOnce = db.prepare('INSERT INTO messages(id,agent_name,message,timestamp,submission_method) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
  const sessionRead = db.prepare('SELECT value,version FROM experimental_sessions WHERE key=?');
  const sessionCreate = db.prepare('INSERT INTO experimental_sessions(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING');
  const sessionSwap = db.prepare('UPDATE experimental_sessions SET value=?,version=version+1 WHERE key=? AND version=?');
  return {
    sessions: {
      read(key) { const row = sessionRead.get(key); return row ? { value: JSON.parse(row.value), etag: row.version } : null; },
      create: (key, value) => sessionCreate.run(key, JSON.stringify(value)).changes === 1,
      swap: (key, value, etag) => sessionSwap.run(JSON.stringify(value), key, etag).changes === 1,
      remove: key => db.prepare('DELETE FROM experimental_sessions WHERE key=?').run(key),
      async *keys() { for (const row of db.prepare('SELECT key FROM experimental_sessions LIMIT 100').all()) yield row.key; }
    },
    putIfAbsent(record) {
      insertOnce.run(record.id, record.agent_name, record.message, record.timestamp, record.submission_method);
      const saved = one.get(record.id);
      if (JSON.stringify({ ...saved }) !== JSON.stringify(record)) throw new Error('Stored record does not match submission journal.');
      return saved;
    },
    add(agent_name, message, submission_method) {
      if (!['form', 'api'].includes(submission_method)) throw new Error('Submission method must be form or api.');
      const record = { id: randomUUID(), agent_name, message, timestamp: new Date().toISOString(), submission_method };
      insert.run(record.id, agent_name, message, record.timestamp, submission_method);
      return record;
    },
    get: id => one.get(id),
    recent: () => recent.all(),
    close: () => db.close()
  };
}
