import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { applySchema, schemaStatus, splitSql } from '../src/postgres.js';
import { createPgliteStore } from '../src/pglite-store.js';
import { databaseHost, requireDatabaseUrl } from '../src/storage.js';
import { assertReportIsSafe, assertSiteIdentity, importSnapshot, missingPublicPosts, snapshotFromIdentity, summarize, validateSnapshot, verifySnapshots } from '../src/transfer.js';

async function database() {
  const store = await createPgliteStore();
  return store;
}

const account = (id, username) => ({
  id,
  username,
  username_normalized: username,
  display_name: username,
  account_type: 'ai_agent',
  password_hash: 'scrypt$test-hash',
  bio: '',
  model_name: '',
  model_provider: '',
  agent_runtime: '',
  agent_purpose: '',
  status: 'active',
  created_at: '2026-01-02T03:04:05.006Z',
  updated_at: '2026-01-02T03:04:05.006Z',
  last_login_at: null
});

test('the application requires PostgreSQL and does not fall back to another database', () => {
  assert.throws(() => requireDatabaseUrl({}), /DATABASE_URL is required/);
  assert.throws(() => requireDatabaseUrl({ DATABASE_URL: '  ' }), /DATABASE_URL is required/);
  assert.equal(requireDatabaseUrl({ DATABASE_URL: 'postgres://db.example/app' }), 'postgres://db.example/app');
  assert.equal(databaseHost('postgres://user:secret@db.example:5432/app'), 'db.example:5432/app');
});

test('schema applies once and enforces the account and post constraints', async () => {
  const store = await database();
  const again = await applySchema(store.executor);
  assert.deepEqual(again.ran, []);
  const status = await schemaStatus(store.executor);
  assert.deepEqual(status.pending, []);
  assert.ok(status.applied.includes('001_initial.sql'));
  const tables = await store.executor.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  for (const name of ['accounts', 'posts', 'sessions', 'api_tokens', 'recovery_codes', 'idempotency_records', 'username_claims']) {
    assert.ok(tables.rows.some(row => row.table_name === name), name);
  }
  const indexes = await store.executor.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
  assert.ok(indexes.rows.some(row => row.indexname === 'posts_by_account'));
  await assert.rejects(() => store.executor.query(`INSERT INTO accounts (id, username, username_normalized, display_name, account_type, password_hash, created_at, updated_at) VALUES ('a','A','a','A','verified','x', now(), now())`));
  await store.executor.query(`INSERT INTO accounts (id, username, username_normalized, display_name, account_type, password_hash, created_at, updated_at) VALUES ('a','A','a','A','ai_agent','hash', now(), now())`);
  await assert.rejects(() => store.executor.query(`INSERT INTO accounts (id, username, username_normalized, display_name, account_type, password_hash, created_at, updated_at) VALUES ('b','B','a','B','human','hash', now(), now())`));
  await store.close();
});

test('postgres accounts, posts, tokens, recovery and ouija claims round-trip', async t => {
  const store = await database();
  const server = createApp(store, { submissionLimit: 100, generalLimit: 1000, registrationLimit: 100, loginLimit: 100 }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const request = (url, init) => fetch(`http://127.0.0.1:${server.address().port}${url}`, init);
  const body = { username: 'pg_agent', display_name: 'PG Agent', password: 'correct horse battery', account_type: 'ai_agent', bio: 'Line\n<script>' };
  const created = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(created.status, 201);
  const registration = await created.json();
  assert.equal(registration.password, undefined);
  assert.doesNotMatch(JSON.stringify(registration), /scrypt\$/);
  const taken = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, username: 'PG_AGENT' }) });
  assert.equal(taken.status, 409);
  const session = await (await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pg_agent', password: 'correct horse battery' }) })).json();
  const token = await (await request('/api/auth/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ label: 'post' }) })).json();
  const posted = await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.token}` }, body: JSON.stringify({ agent_name: 'Forged', message: "'; DROP TABLE posts; --", account_id: 'forged' }) });
  assert.equal(posted.status, 201);
  const receipt = await posted.json();
  const saved = await (await request(receipt.api_url)).json();
  assert.equal(saved.message.agent_name, 'PG Agent');
  assert.equal(saved.message.account_id, registration.account.id);
  assert.equal(saved.message.message, "'; DROP TABLE posts; --");
  const guest = await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_name: 'Guest', message: 'still anonymous', account_id: registration.account.id }) });
  assert.equal((await (await request(`/api/messages/${(await guest.json()).id}`)).json()).message.account_id, undefined);
  const profile = await (await request('/agents/pg_agent')).text();
  assert.match(profile, /&lt;script&gt;/);
  assert.match(profile, /DROP TABLE posts/);
  await request(`/api/auth/tokens/${token.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}` } });
  assert.equal((await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.token}` }, body: JSON.stringify({ message: 'after revoke' }) })).status, 401);
  const recovered = await request('/api/auth/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pg_agent', recovery_code: registration.recovery_codes[0], new_password: 'replacement passphrase' }) });
  assert.equal(recovered.status, 200);
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pg_agent', password: 'correct horse battery' }) })).status, 401);
  const claim = await store.claimOuijaV2({ composition_id: 'composition-1', state_hash: 'hash-1', record: { id: 'ouija-post-1', agent_name: 'Ouija', message: 'Hello', timestamp: '2026-01-02T03:04:05.006Z', submission_method: 'ouija_get_v2' } });
  assert.equal(claim.outcome, 'created');
  const repeat = await store.claimOuijaV2({ composition_id: 'composition-1', state_hash: 'hash-1', record: claim.record });
  assert.equal(repeat.outcome, 'same');
  assert.equal(repeat.record.id, 'ouija-post-1');
  const tables = await store.executor.query('SELECT COUNT(*)::int AS n FROM posts');
  assert.ok(Number(tables.rows[0].n) >= 3);
});

test('concurrent postgres registration keeps one username', async t => {
  const store = await database();
  const server = createApp(store, { submissionLimit: 100, generalLimit: 1000, registrationLimit: 100, loginLimit: 100 }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const register = () => fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'race_pg', display_name: 'Race', password: 'correct horse battery', account_type: 'human' })
  });
  const responses = await Promise.all([register(), register()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const count = await store.executor.query(`SELECT COUNT(*)::int AS n FROM accounts WHERE username_normalized = 'race_pg'`);
  assert.equal(Number(count.rows[0].n), 1);
});

test('registration rolls back when the account write fails', async () => {
  const store = await database();
  const username = await store.executor.transaction(async () => {
    await store.identity.create('username/rollback_name', { id: 'missing-account' });
    throw new Error('stop');
  }).catch(error => error);
  assert.equal(username.message, 'stop');
  assert.equal(await store.identity.get('username/rollback_name'), null);
  await store.close();
});

test('import is repeatable, keeps anonymous history, and stops without corrupting earlier rows', async () => {
  const store = await database();
  const posts = Array.from({ length: 120 }, (_, index) => ({
    id: `post-${String(index).padStart(4, '0')}`,
    account_id: index % 2 === 0 ? 'account-1' : null,
    agent_name: 'Writer',
    message: `Message ${index}`,
    submission_method: 'api',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
  }));
  const snapshot = snapshotFromIdentity({
    posts,
    identity: [
      { key: 'account/account-1', value: account('account-1', 'writer') },
      { key: 'username/writer', value: { id: 'account-1' } },
      { key: 'session/abc123', value: { id: 'session-1', account_id: 'account-1', created_at: '2026-01-02T03:04:05.006Z', expires_at: '2020-01-01T00:00:00.000Z', revoked_at: null, csrf: 'csrf-secret' } },
      { key: 'token/def456', value: { id: 'token-1', account_id: 'account-1', label: 'old', scopes: ['posts:write'], created_at: '2026-01-02T03:04:05.006Z', expires_at: '2027-01-02T03:04:05.006Z', last_used_at: null, revoked_at: '2026-02-02T03:04:05.006Z' } },
      { key: 'recovery/feedface', value: { account_id: 'account-1', created_at: '2026-01-02T03:04:05.006Z', used_at: null } },
      { key: 'idempotency/post/key-1', value: { state: 'complete', fingerprint: 'fingerprint-secret', at: '2026-01-02T03:04:05.006Z', receipt: { id: 'post-0000' } } }
    ],
    ouija_v2_claims: [{ composition_id: 'comp-1', state_hash: 'state-1', record: { id: 'post-0001' } }]
  });
  const dry = await importSnapshot(store.executor, snapshot, { apply: false });
  assert.equal(dry.apply, false);
  assert.equal(await store.countPosts('account-1'), 0);
  const first = await importSnapshot(store.executor, snapshot, { apply: true });
  assert.equal(first.errors.length, 0);
  assert.equal(first.inserted.posts, 120);
  assert.equal(first.inserted.accounts, 1);
  const second = await importSnapshot(store.executor, snapshot, { apply: true });
  assert.equal(second.inserted.posts, 0);
  assert.equal(second.skipped.posts, 120);
  const exported = await store.exportRecords();
  const verified = verifySnapshots(snapshot, exported);
  assert.equal(verified.status, 'PASS', JSON.stringify(verified.mismatches));
  assert.equal(assertReportIsSafe(verified, ['scrypt$test-hash', 'csrf-secret', 'fingerprint-secret', 'abc123', 'def456', 'feedface']), true);
  assert.equal(summarize(exported).anonymous_posts, 60);
  const renamed = { ...snapshot, accounts: [{ ...snapshot.accounts[0], display_name: 'Changed elsewhere' }] };
  await store.executor.query(`UPDATE accounts SET display_name = 'Kept' WHERE id = 'account-1'`);
  await importSnapshot(store.executor, renamed, { apply: true });
  const kept = await store.executor.query(`SELECT display_name FROM accounts WHERE id = 'account-1'`);
  assert.equal(kept.rows[0].display_name, 'Kept');
  const recent = await store.recent();
  assert.equal(recent.length, 100);
  assert.equal(recent[0].id, 'post-0119');
  const broken = snapshotFromIdentity({
    posts: [{ sequence: 1000, id: 'good-extra', agent_name: 'Writer', message: 'ok', submission_method: 'api', timestamp: '2026-04-01T00:00:00.000Z' }, { sequence: 1001, id: 'bad-extra', agent_name: 'Writer', message: 'nope', submission_method: 'carrier-pigeon', timestamp: '2026-04-01T00:00:01.000Z' }],
    identity: []
  });
  const stopped = await importSnapshot(store.executor, broken, { apply: true });
  assert.equal(stopped.errors[0].code, 'INVALID');
  assert.ok(stopped.problems.some(problem => problem.id === 'bad-extra' && problem.field === 'submission_method'));
  assert.equal(await store.get('good-extra'), undefined);
  assert.equal(await store.get('bad-extra'), undefined);
  const added = await store.add('Writer', 'after import', 'api', 'account-1');
  assert.ok(added.id);
  assert.equal((await store.recent())[0].id, added.id);
  await store.close();
});

test('snapshot validation keeps every relationship and refuses a duplicate username', () => {
  const snapshot = snapshotFromIdentity({
    posts: [{ id: 'post-1', account_id: 'missing', agent_name: 'Guest', message: 'Hi', submission_method: 'api', timestamp: '2026-01-02T03:04:05.006Z' }],
    identity: [
      { key: 'username/writer', value: { id: 'account-1' } },
      { key: 'account/account-1', value: account('account-1', 'writer') },
      { key: 'account/account-2', value: account('account-2', 'writer') },
      { key: 'custom/other', value: { id: 'x' } }
    ]
  });
  assert.equal(snapshot.warnings.some(warning => warning.kind === 'username_claim'), false);
  assert.equal(snapshot.warnings.some(warning => warning.field === 'unrecognized'), true);
  const problems = validateSnapshot(snapshot);
  assert.ok(problems.some(problem => problem.kind === 'usernames' && problem.field === 'duplicate'));
  assert.ok(problems.some(problem => problem.kind === 'posts' && problem.field === 'account_id'));
  assert.throws(() => assertSiteIdentity({ ssl_url: 'https://example.netlify.app' }), /production site/);
  assert.equal(assertSiteIdentity({ ssl_url: 'https://syntheticsociety.netlify.app' }).url.includes('syntheticsociety.netlify.app'), true);
  assert.deepEqual(missingPublicPosts(snapshot, [{ id: 'post-1' }, { id: 'post-2' }]), ['post-2']);
});

test('import keeps drafts and audit events without printing secrets', async () => {
  const snapshot = snapshotFromIdentity({
    posts: [{ id: 'post-1', agent_name: 'Guest', message: 'Hello', timestamp: '2026-01-02T03:04:05.006Z', submission_method: 'api' }],
    identity: [{ key: 'account/account-1', value: account('account-1', 'writer') }],
    ouija_v2_claims: [{ composition_id: 'comp-1', state_hash: 'state-1', record: { id: 'post-1' } }],
    draft_sessions: [{ key: 'ouija-abc', value: { kind: 'ouija', state: 'writing', name: { 1: 'A' } } }],
    ouija_audit: [{ source_key: 'ouija-audit/run_7f2a91c8d04e/1-resp', run_id: 'run_7f2a91c8d04e', at: '2026-01-02T03:04:05.006Z', response_id: 'resp_123', nav_id: 'nav', event: { at: '2026-01-02T03:04:05.006Z', response_id: 'resp_123', run_id: 'run_7f2a91c8d04e' } }]
  });
  assert.equal(summarize(snapshot).posts, 1);
  assert.equal(summarize(snapshot).accounts, 1);
  assert.equal(summarize(snapshot).draft_sessions, 1);
  assert.equal(summarize(snapshot).ouija_audit, 1);
  assert.equal(snapshot.warnings.length, 0);
  assert.equal(assertReportIsSafe(summarize(snapshot), ['scrypt$test-hash']), true);
  const store = await database();
  const imported = await importSnapshot(store.executor, snapshot, { apply: true });
  assert.equal(imported.errors.length, 0, JSON.stringify(imported.errors));
  const verified = verifySnapshots(snapshot, await store.exportRecords());
  assert.equal(verified.status, 'PASS', JSON.stringify(verified.mismatches));
  await store.close();
});

test('maintenance mode blocks writes and a database failure stays on this backend', async t => {
  const store = await database();
  const previous = process.env.MAINTENANCE_MODE;
  process.env.MAINTENANCE_MODE = '1';
  const server = createApp(store, { generalLimit: 1000 }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    process.env.MAINTENANCE_MODE = previous;
    await new Promise(resolve => server.close(resolve));
    await store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/')).status, 200);
  const paused = await fetch(base + '/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_name: 'A', message: 'B' }) });
  assert.equal(paused.status, 503);
  assert.match(await paused.text(), /paused for database maintenance/);
  process.env.MAINTENANCE_MODE = previous;
  store.add = async () => { const error = new Error('relation posts does not exist SELECT password'); error.name = 'DatabaseError'; throw error; };
  const failed = await fetch(base + '/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_name: 'A', message: 'B' }) });
  assert.equal(failed.status, 503);
  const text = await failed.text();
  assert.doesNotMatch(text, /password|relation posts/);
  assert.match(text, /did not switch to another database/);
});

test('sql splitter keeps statements and drops comments', () => {
  const statements = splitSql('-- heading\nCREATE TABLE example (id text);\nCREATE INDEX example_id ON example (id);\n');
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^CREATE TABLE/);
});
