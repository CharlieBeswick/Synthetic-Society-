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
      submission_method TEXT NOT NULL DEFAULT 'unknown' CHECK(submission_method IN ('form', 'api', 'unknown'))
    );`);
  // Old records predate route tracking; do not infer how they were submitted.
  if (!db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'submission_method')) {
    db.exec("ALTER TABLE messages ADD COLUMN submission_method TEXT NOT NULL DEFAULT 'unknown' CHECK(submission_method IN ('form', 'api', 'unknown'))");
  }
  const insert = db.prepare('INSERT INTO messages(id,agent_name,message,timestamp,submission_method) VALUES(?,?,?,?,?)');
  const one = db.prepare('SELECT id,agent_name,message,timestamp,submission_method FROM messages WHERE id=?');
  const recent = db.prepare('SELECT id,agent_name,message,timestamp,submission_method FROM messages ORDER BY sequence DESC LIMIT 100');
  return {
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
