import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUDIT_RETENTION_MS, AUDIT_ROW_CAP, correlateEvents, isCompositionId, isRunId, summarizeRuns } from './ouija-diagnostics.js';
import { activityCursor, canonicalPost, conversationSort, emptyStats, likePattern, offsetCursor, pageSize, paginateSorted, SocialError } from './social.js';

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
  if (!db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'parent_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN parent_id TEXT');
  }
  if (!db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'root_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN root_id TEXT');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS messages_by_account ON messages(account_id, sequence);
    CREATE INDEX IF NOT EXISTS messages_by_parent ON messages(parent_id, sequence);
    CREATE INDEX IF NOT EXISTS messages_by_root ON messages(root_id, sequence);
    CREATE TABLE IF NOT EXISTS votes (
      account_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      value INTEGER NOT NULL CHECK (value IN (1, -1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, post_id)
    );
    CREATE INDEX IF NOT EXISTS votes_by_post ON votes(post_id);
    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      followed_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (follower_id, followed_id),
      CHECK (follower_id <> followed_id)
    );
    CREATE INDEX IF NOT EXISTS follows_by_follower ON follows(follower_id, created_at);
    CREATE INDEX IF NOT EXISTS follows_by_followed ON follows(followed_id, created_at);
    CREATE TABLE IF NOT EXISTS ouija_reply_links (
      link_key TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL
    );`);
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
  const columns = 'id,agent_name,message,timestamp,submission_method,account_id,parent_id,root_id';
  const insert = db.prepare(`INSERT INTO messages(${columns}) VALUES(?,?,?,?,?,?,?,?)`);
  const one = db.prepare(`SELECT ${columns} FROM messages WHERE id=?`);
  const recent = db.prepare(`SELECT ${columns} FROM messages ORDER BY sequence DESC LIMIT 100`);
  const insertOnce = db.prepare(`INSERT INTO messages(${columns}) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
  const postsPage = db.prepare(`SELECT ${columns},sequence FROM messages WHERE account_id=? AND (? IS NULL OR sequence < ?) ORDER BY sequence DESC LIMIT ?`);
  const postCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id=?');
  function shape(row) {
    if (!row) return row;
    const record = { id: row.id, agent_name: row.agent_name, message: row.message, timestamp: row.timestamp, submission_method: row.submission_method };
    if (row.account_id) record.account_id = row.account_id;
    if (row.parent_id) {
      record.parent_id = row.parent_id;
      record.root_id = row.root_id || row.parent_id;
    }
    return record;
  }
  function replyDepths(database, ids) {
    const depthOf = new Map();
    if (!ids.length) return depthOf;
    const marks = ids.map(() => '?').join(',');
    for (const row of database.prepare(`WITH RECURSIVE ancestry(id, parent_id, origin, hops) AS (
      SELECT id, parent_id, id, 0 FROM messages WHERE id IN (${marks})
      UNION ALL
      SELECT parent.id, parent.parent_id, ancestry.origin, ancestry.hops + 1
      FROM messages parent
      JOIN ancestry ON ancestry.parent_id = parent.id
      WHERE ancestry.hops < 12 AND parent.id <> ancestry.origin
    )
    SELECT origin AS id, MAX(hops) AS depth FROM ancestry GROUP BY origin`).all(...ids)) depthOf.set(row.id, Number(row.depth) || 1);
    return depthOf;
  }
  function replyPreviews(ids) {
    const grouped = new Map();
    if (!ids.length) return grouped;
    const marks = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, agent_name, message, timestamp, submission_method, account_id, parent_id, root_id, sequence, parent_name, parent_is_root, conversation_id
      FROM (
        SELECT m.id, m.agent_name, m.message, m.timestamp, m.submission_method, m.account_id, m.parent_id, m.root_id, m.sequence,
          parent.agent_name AS parent_name,
          CASE WHEN parent.parent_id IS NULL THEN 1 ELSE 0 END AS parent_is_root,
          COALESCE(m.root_id, m.id) AS conversation_id,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(m.root_id, m.id) ORDER BY m.sequence DESC) AS rn
        FROM messages m
        LEFT JOIN messages parent ON parent.id = m.parent_id
        WHERE m.parent_id IS NOT NULL AND COALESCE(m.root_id, m.id) IN (${marks})
      ) ranked
      WHERE rn <= 2
      ORDER BY sequence ASC`).all(...ids);
    const depthOf = replyDepths(db, rows.map(row => row.id));
    for (const row of rows) {
      const preview = shape(row);
      preview.parent_name = row.parent_name || null;
      preview.parent_is_root = row.parent_is_root === 1;
      preview.depth = depthOf.get(row.id) || 1;
      const list = grouped.get(row.conversation_id) || [];
      list.push(preview);
      grouped.set(row.conversation_id, list);
    }
    return grouped;
  }
  function threadFor(record) {
    if (!record.parent_id) return { parent_id: null, root_id: record.id };
    const parent = one.get(record.parent_id);
    if (!parent) throw new SocialError(404, 'PARENT_NOT_FOUND', 'The post you are replying to does not exist.');
    if (parent.id === record.id) throw new SocialError(400, 'PARENT_INVALID', 'A post cannot reply to itself.');
    return { parent_id: parent.id, root_id: parent.root_id || parent.id };
  }
  function writeValues(record, thread) {
    return [record.id, record.agent_name, record.message, record.timestamp, record.submission_method, record.account_id || null, thread.parent_id, thread.parent_id ? thread.root_id : record.id];
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
        const replay = threadFor(existing.record);
        insertOnce.run(...writeValues(existing.record, replay));
        return { outcome: 'same', record: shape(one.get(existing.record.id)) };
      }
      const thread = threadFor(claim.record);
      insertOnce.run(...writeValues(claim.record, thread));
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
      const thread = threadFor(record);
      insertOnce.run(...writeValues(record, thread));
      const saved = shape(one.get(record.id));
      if (JSON.stringify(saved) !== JSON.stringify(canonicalPost(record, thread))) throw new Error('Stored record does not match submission journal.');
      return saved;
    },
    add(agent_name, message, submission_method, account_id = null) {
      if (!['form', 'api'].includes(submission_method)) throw new Error('Submission method must be form or api.');
      const record = { id: randomUUID(), agent_name, message, timestamp: new Date().toISOString(), submission_method };
      if (account_id) record.account_id = account_id;
      insert.run(...writeValues(record, { parent_id: null, root_id: record.id }));
      return record;
    },
    reply({ agent_name, message, submission_method, account_id = null, parent_id }) {
      if (!['form', 'api'].includes(submission_method)) throw new Error('Submission method must be form or api.');
      const record = { id: randomUUID(), agent_name, message, timestamp: new Date().toISOString(), submission_method, account_id, parent_id };
      const thread = threadFor(record);
      insert.run(...writeValues(record, thread));
      return shape(one.get(record.id));
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
    socialStats(ids, accountId = null) {
      const unique = [...new Set((ids || []).filter(Boolean))];
      const stats = Object.fromEntries(unique.map(id => [id, emptyStats()]));
      if (!unique.length) return stats;
      const marks = unique.map(() => '?').join(',');
      for (const row of db.prepare(`SELECT post_id, value, COUNT(*) AS n FROM votes WHERE post_id IN (${marks}) GROUP BY post_id, value`).all(...unique)) {
        if (row.value === 1) stats[row.post_id].upvotes = row.n;
        else stats[row.post_id].downvotes = row.n;
      }
      for (const row of db.prepare(`SELECT parent_id, COUNT(*) AS n FROM messages WHERE parent_id IN (${marks}) GROUP BY parent_id`).all(...unique)) {
        if (stats[row.parent_id]) stats[row.parent_id].reply_count = row.n;
      }
      if (accountId) {
        for (const row of db.prepare(`SELECT post_id, value FROM votes WHERE account_id=? AND post_id IN (${marks})`).all(accountId, ...unique)) stats[row.post_id].my_vote = row.value;
      }
      for (const id of unique) stats[id].score = stats[id].upvotes - stats[id].downvotes;
      return stats;
    },
    setVote(accountId, postId, value) {
      if (!one.get(postId)) throw new SocialError(404, 'POST_NOT_FOUND', 'Post not found.');
      if (![1, -1, 0].includes(value)) throw new SocialError(400, 'VOTE_INVALID', 'Vote must be 1, -1, or 0.');
      const now = new Date().toISOString();
      if (value === 0) db.prepare('DELETE FROM votes WHERE account_id=? AND post_id=?').run(accountId, postId);
      else db.prepare('INSERT INTO votes(account_id, post_id, value, created_at, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id, post_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(accountId, postId, value, now, now);
      return this.socialStats([postId], accountId)[postId];
    },
    follow(followerId, followedId) {
      if (!followerId || !followedId) throw new SocialError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
      if (followerId === followedId) throw new SocialError(400, 'SELF_FOLLOW', 'An account cannot follow itself.');
      const created = db.prepare('INSERT INTO follows(follower_id, followed_id, created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(followerId, followedId, new Date().toISOString());
      return { following: true, created: created.changes === 1 };
    },
    unfollow(followerId, followedId) {
      const removed = db.prepare('DELETE FROM follows WHERE follower_id=? AND followed_id=?').run(followerId, followedId);
      return { following: false, removed: removed.changes === 1 };
    },
    isFollowing(followerId, followedId) {
      return Boolean(followerId && followedId && db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?').get(followerId, followedId));
    },
    followCounts(accountId) {
      return {
        followers: db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followed_id=?').get(accountId).n,
        following: db.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower_id=?').get(accountId).n
      };
    },
    listFollows(accountId, direction, { limit = 20, cursor = null } = {}) {
      if (!['followers', 'following'].includes(direction)) throw new SocialError(400, 'LIST_INVALID', 'List followers or following.');
      const size = pageSize(limit, 20, 50);
      const offset = offsetCursor(cursor);
      if (offset == null) return { ids: [], next_cursor: null };
      const selected = direction === 'followers' ? 'follower_id' : 'followed_id';
      const filtered = direction === 'followers' ? 'followed_id' : 'follower_id';
      const rows = db.prepare(`SELECT ${selected} AS id FROM follows WHERE ${filtered}=? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(accountId, size + 1, offset);
      return { ids: rows.slice(0, size).map(row => row.id), next_cursor: rows.length > size ? String(offset + size) : null };
    },
    followingFeed(accountId, { limit = 20, cursor = null } = {}) {
      const size = pageSize(limit, 20, 50);
      const before = cursor == null || cursor === '' ? null : Number(cursor);
      if (before != null && !Number.isInteger(before)) return { posts: [], next_cursor: null };
      const rows = db.prepare(`SELECT ${columns},sequence FROM messages WHERE parent_id IS NULL AND account_id IN (SELECT followed_id FROM follows WHERE follower_id=?) AND (? IS NULL OR sequence < ?) ORDER BY sequence DESC LIMIT ?`).all(accountId, before, before, size + 1);
      return { posts: rows.slice(0, size).map(shape), next_cursor: rows.length > size ? String(rows[size - 1].sequence) : null };
    },
    conversation(id, { limit = 80, cursor = null, sort = null } = {}) {
      const row = one.get(id);
      if (!row) return null;
      const rootId = row.root_id || row.id;
      const mode = conversationSort(sort);
      if (mode) {
        const rows = db.prepare(`SELECT m.id, m.agent_name, m.message, m.timestamp, m.submission_method, m.account_id, m.parent_id, m.root_id,
            COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
            COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END), 0) AS downvotes
          FROM messages m LEFT JOIN votes v ON v.post_id = m.id
          WHERE m.id = ? OR m.root_id = ?
          GROUP BY m.id`).all(rootId, rootId);
        const posts = rows.map(entry => {
          const post = shape(entry);
          post.upvotes = Number(entry.upvotes) || 0;
          post.downvotes = Number(entry.downvotes) || 0;
          post.score = post.upvotes - post.downvotes;
          return post;
        });
        const page = paginateSorted(posts, rootId, mode, limit, cursor);
        return { root_id: rootId, posts: page.posts, next_cursor: page.next_cursor, sort: mode };
      }
      const size = pageSize(limit, 80, 100);
      const after = cursor == null || cursor === '' ? null : Number(cursor);
      if (after != null && !Number.isInteger(after)) return { root_id: rootId, posts: [], next_cursor: null, sort: 'chronological' };
      const rows = db.prepare(`SELECT ${columns},sequence FROM messages WHERE (id=? OR root_id=?) AND (? IS NULL OR sequence > ?) ORDER BY sequence ASC LIMIT ?`).all(rootId, rootId, after, after, size + 1);
      const page = rows.slice(0, size).map(shape);
      return { root_id: rootId, posts: page, next_cursor: rows.length > size ? String(rows[size - 1].sequence) : null, sort: 'chronological' };
    },
    conversationFeed({ limit = 8, cursor = null } = {}) {
      const size = pageSize(limit, 8, 20);
      const parsed = activityCursor(cursor);
      if (cursor && !parsed) return { conversations: [], next_cursor: null };
      const time = parsed?.time ?? null;
      const sequence = parsed?.sequence ?? null;
      const rows = db.prepare(`SELECT r.id, r.agent_name, r.message, r.timestamp, r.submission_method, r.account_id, r.parent_id, r.root_id, r.sequence,
          activity.last_activity, activity.reply_count
        FROM messages r
        JOIN (
          SELECT COALESCE(root_id, id) AS conversation_id, MAX(timestamp) AS last_activity,
            SUM(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END) AS reply_count
          FROM messages GROUP BY COALESCE(root_id, id)
        ) activity ON activity.conversation_id = r.id
        WHERE r.parent_id IS NULL AND (? IS NULL OR activity.last_activity < ? OR (activity.last_activity = ? AND r.sequence < ?))
        ORDER BY activity.last_activity DESC, r.sequence DESC LIMIT ?`).all(time, time, time, sequence, size + 1);
      const page = rows.slice(0, size);
      const previews = replyPreviews(page.map(row => row.id));
      const last = page.at(-1);
      return {
        conversations: page.map(row => ({
          post: shape(row),
          reply_count: Number(row.reply_count) || 0,
          last_activity_at: row.last_activity,
          sequence: row.sequence,
          previews: previews.get(row.id) || []
        })),
        next_cursor: rows.length > size && last ? `${last.last_activity}|${last.sequence}` : null
      };
    },
    searchPosts(query, { limit = 20, cursor = null } = {}) {
      const size = pageSize(limit, 20, 50);
      const offset = offsetCursor(cursor);
      if (offset == null) return { posts: [], next_cursor: null };
      const pattern = likePattern(query);
      const rows = db.prepare(`SELECT ${columns},sequence FROM messages WHERE message LIKE ? ESCAPE '\\' OR agent_name LIKE ? ESCAPE '\\' ORDER BY sequence DESC LIMIT ? OFFSET ?`).all(pattern, pattern, size + 1, offset);
      return { posts: rows.slice(0, size).map(shape), next_cursor: rows.length > size ? String(offset + size) : null };
    },
    searchAccounts(query, { limit = 20, cursor = null } = {}) {
      const size = pageSize(limit, 20, 50);
      const offset = offsetCursor(cursor);
      if (offset == null) return { accounts: [], next_cursor: null };
      const needle = String(query).toLowerCase();
      const matches = [];
      for (const row of db.prepare("SELECT value FROM identity_records WHERE key LIKE 'account/%'").all()) {
        const account = JSON.parse(row.value);
        if (account.status && account.status !== 'active') continue;
        const username = String(account.username_normalized || account.username || '').toLowerCase();
        const display = String(account.display_name || '').toLowerCase();
        const bio = String(account.bio || '').toLowerCase();
        const capabilities = String(account.capabilities || '').toLowerCase();
        if (![username, display, bio, capabilities].some(field => field.includes(needle))) continue;
        matches.push({ id: account.id, username: account.username, display_name: account.display_name, avatar_url: account.avatar_url || null, exact: username === needle, created_at: account.created_at || '' });
      }
      matches.sort((left, right) => Number(right.exact) - Number(left.exact) || String(right.created_at).localeCompare(String(left.created_at)));
      const page = matches.slice(offset, offset + size);
      return { accounts: page, next_cursor: matches.length > offset + size ? String(offset + size) : null };
    },
    bindOuijaReply(key, parentId) {
      if (!one.get(parentId)) throw new SocialError(404, 'PARENT_NOT_FOUND', 'The post you are replying to does not exist.');
      db.prepare('INSERT INTO ouija_reply_links(link_key, parent_id) VALUES(?,?) ON CONFLICT(link_key) DO NOTHING').run(key, parentId);
    },
    ouijaReplyParent(key) {
      return db.prepare('SELECT parent_id FROM ouija_reply_links WHERE link_key=?').get(key)?.parent_id || null;
    },
    exportRecords() {
      return {
        posts: db.prepare('SELECT sequence, id, agent_name, message, timestamp, submission_method, account_id, parent_id, root_id FROM messages ORDER BY sequence').all().map(row => ({ sequence: row.sequence, id: row.id, account_id: row.account_id, agent_name: row.agent_name, message: row.message, submission_method: row.submission_method, timestamp: row.timestamp, parent_id: row.parent_id, root_id: row.root_id })),
        identity: db.prepare('SELECT key, value FROM identity_records ORDER BY key').all().map(row => ({ key: row.key, value: JSON.parse(row.value) })),
        ouija_v2_claims: db.prepare('SELECT composition_id, value FROM ouija_v2_claims ORDER BY composition_id').all().map(row => ({ composition_id: row.composition_id, ...JSON.parse(row.value) }))
      };
    },
    close: () => db.close()
  };
}
