import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { openStore } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createSessions } from '../src/sessions.js';
import { createDraftSync } from '../public/draft-sync.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function setup(t, options = {}) {
  const store = openStore(':memory:');
  const server = createApp(store, { submissionLimit: 200, generalLimit: 1000, ...options }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, request: (path, options) => fetch(base + path, options) };
}
const prepared = { agent_name: 'Session agent', message: '<script>not executable</script>' };
const create = async request => {
  const response = await request('/api/session', { method: 'POST' });
  assert.equal(response.status, 201);
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  return response.json();
};
const save = (request, session, revision = 1, draft = prepared, edit = session.edit_token) => request('/api/session/draft', {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${edit}` }, body: JSON.stringify({ token: session.token, revision, ...draft })
});
const trigger = (session, revision = 1) => `/messagesubmit${session.slot}?token=${session.token}&revision=${revision}`;

test('all five actual routes commit isolated drafts; repeated and concurrent GETs reuse one ID', async t => {
  let chosen = 0;
  const { request, store } = await setup(t, { chooseSlot: () => ++chosen });
  for (let i = 1; i <= 5; i++) {
    const session = await create(request);
    assert.equal(session.slot, String(i).padStart(2, '0'));
    assert.match(session.token, /^[0-9a-f]{64}$/);
    assert.notEqual(session.edit_token, session.token);
    assert.equal((await save(request, session)).status, 200);
    const replies = await Promise.all(Array.from({ length: 4 }, () => request(trigger(session), { headers: { Accept: 'application/json' } })));
    for (const reply of replies) assert.equal(reply.status, 200);
    const receipts = await Promise.all(replies.map(reply => reply.json()));
    assert.equal(new Set(receipts.map(row => row.id)).size, 1);
    const row = receipts[0];
    assert.equal(row.submission_method, 'session_get');
    assert.equal((await (await request(row.api_url)).json()).message.message, prepared.message);
    const html = await (await request(trigger(session))).text();
    assert.match(html, /Submission succeeded/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, new RegExp(session.token + '|' + session.edit_token));
    assert.equal((await save(request, session, 2)).status, 409);
  }
  assert.equal(store.recent().length, 5);
});

test('draft validation, stale updates, credentials, pending revisions and safe GET behaviour', async t => {
  const { request, store } = await setup(t, { chooseSlot: () => 1 });
  const session = await create(request);
  assert.equal((await request('/messagesubmit01')).status, 401);
  assert.equal((await request('/messagesubmit01?token=bad')).status, 403);
  assert.equal((await request(trigger(session))).status, 409);
  for (const draft of [{ agent_name: '', message: '' }, { agent_name: 'a'.repeat(81), message: 'b' }, { agent_name: 'a', message: 'b'.repeat(2001) }, { agent_name: [], message: 'b' }]) assert.equal((await save(request, session, 1, draft)).status, 400);
  assert.equal((await save(request, session, 1, prepared, session.token)).status, 403);
  assert.equal((await save(request, session, 1)).status, 200);
  const latest = { agent_name: 'New name', message: 'Newest text' };
  assert.equal((await save(request, session, 2, latest)).status, 200);
  assert.equal((await save(request, session, 1)).status, 409);
  assert.equal((await save(request, session, 2, latest)).status, 200, 'lost-ack retry');
  assert.equal((await save(request, session, 2)).status, 409, 'same revision different content');
  assert.equal((await request(trigger(session, 1))).status, 409);
  assert.equal((await request(trigger(session, 3))).status, 409);
  assert.equal((await request(trigger(session, 2).replace('01?', '02?'))).status, 403);
  const head = await request(trigger(session, 2), { method: 'HEAD' });
  assert.equal(head.status, 405);
  for (const headers of [{ Purpose: 'prefetch' }, { 'Sec-Purpose': 'prefetch;prerender' }, { 'X-Purpose': 'preview' }]) assert.equal((await request(trigger(session, 2), { headers })).status, 400);
  assert.equal(store.recent().length, 0);
  const receipt = await request(trigger(session, 2), { headers: { Accept: 'application/json' } });
  assert.match(receipt.headers.get('cache-control'), /no-store/);
  assert.match(receipt.headers.get('x-robots-tag'), /noindex/);
  assert.equal((await receipt.json()).message, latest.message);
});

test('simultaneous visitors on the same channel cannot edit each other and stay isolated', async t => {
  const { request, store } = await setup(t, { chooseSlot: () => 5 });
  const sessions = await Promise.all(Array.from({ length: 8 }, () => create(request)));
  assert.equal(new Set(sessions.map(session => session.token)).size, 8);
  for (let i = 0; i < sessions.length; i++) assert.equal((await save(request, sessions[i], 1, { agent_name: `Agent ${i}`, message: `Draft ${i}` })).status, 200);
  assert.equal((await save(request, sessions[0], 2, prepared, sessions[1].edit_token)).status, 403);
  const responses = await Promise.all(sessions.map(session => request(trigger(session), { headers: { Accept: 'application/json' } })));
  const records = await Promise.all(responses.map(response => response.json()));
  records.forEach((row, i) => assert.equal(row.message, `Draft ${i}`));
  assert.equal(store.recent().length, 8);
  const publicText = await (await request('/api/messages')).text();
  for (const session of sessions) assert.ok(!publicText.includes(session.token) && !publicText.includes(session.edit_token));
});

test('expiry is enforced and cleanup cannot revive an expired session', async t => {
  let time = 1800000000000;
  const { request, store } = await setup(t, { sessionNow: () => time });
  const session = await create(request);
  await save(request, session);
  time += 15 * 60_000 + 1;
  assert.equal((await request(trigger(session))).status, 410);
  assert.equal((await save(request, session, 2)).status, 410);
  await create(request); // Opportunistic cleanup.
  assert.equal(store.sessions.read(createHash('sha256').update(session.token).digest('hex')), null);
  assert.equal((await request(trigger(session))).status, 403);
});

test('normal HTML form and GET fallback share a receipt even with a newer unsaved form value', async t => {
  const { request, store } = await setup(t);
  const session = await create(request);
  await save(request, session);
  const form = await request('/messages', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ agent_name: 'Normal form', message: 'Newest form text', experimental_token: session.token, experimental_edit: session.edit_token }) });
  assert.equal(form.status, 303);
  const fallback = await (await request(trigger(session), { headers: { Accept: 'application/json' } })).json();
  assert.equal(fallback.verification_url, form.headers.get('location'));
  assert.equal(fallback.submission_method, 'form');
  assert.equal(fallback.message, 'Newest form text');
  assert.equal(store.recent().length, 1);
});

test('retries recover failures before/after permanent write without duplication', async () => {
  const store = openStore(':memory:');
  try {
    let mode = 'before';
    const service = createSessions(store.sessions, { putIfAbsent(record) {
      if (mode === 'before') throw new Error('unavailable');
      const row = store.putIfAbsent(record);
      if (mode === 'after') throw new Error('lost response');
      return row;
    } });
    const session = await service.create();
    await service.save(session.token, session.edit_token, 1, prepared);
    await assert.rejects(service.submit(session.token, { revision: 1 }), /unavailable/);
    assert.equal(store.recent().length, 0);
    mode = 'after';
    await assert.rejects(service.submit(session.token, { revision: 1 }), /lost response/);
    assert.equal(store.recent().length, 1);
    mode = 'working';
    const results = await Promise.all(Array.from({ length: 10 }, () => service.submit(session.token, { revision: 1 })));
    assert.equal(new Set(results.map(row => row.id)).size, 1);
    assert.equal(store.recent().length, 1);
  } finally { store.close(); }
});

test('session storage errors and rate limits return clear failures', async t => {
  const { request } = await setup(t, { sessionBackend: { async *keys() { throw new Error('storage offline'); } } });
  const response = await request('/api/session', { method: 'POST' });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).success, false);
  const normal = await request('/messages', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ agent_name: 'Normal', message: 'Works independently' }) });
  assert.equal(normal.status, 303);
  const other = await setup(t);
  for (let i = 0; i < 20; i++) await create(other.request);
  const limited = await other.request('/api/session', { method: 'POST' });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
});

test('draft controller never labels an old acknowledgement saved and retries lost responses', async () => {
  const states = [], pending = [];
  const sync = createDraftSync({ delay: 100000, report: state => states.push(state), send: (revision, draft) => new Promise((resolve, reject) => pending.push({ revision, draft, resolve, reject })) });
  try {
    sync.change(prepared);
    const first = sync.retry();
    sync.change({ ...prepared, message: 'Newer' });
    pending[0].resolve({ revision: 1 });
    await first;
    assert.equal(states.filter(state => state.state === 'saved').length, 0);
    const second = sync.retry();
    assert.equal(pending[1].revision, 2);
    pending[1].reject(new Error('offline'));
    await second;
    assert.equal(states.at(-1).state, 'error');
    const retry = sync.retry();
    assert.equal(pending[2].revision, 2);
    pending[2].resolve({ revision: 2 });
    await retry;
    assert.equal(states.at(-1).state, 'saved');
    sync.change(null);
    assert.equal(states.at(-1).state, 'incomplete');
  } finally { sync.stop(); }
});

test('concurrent draft revisions cannot overwrite a newer saved draft', async () => {
  const store = openStore(':memory:');
  try {
    const sessions = createSessions(store.sessions, store);
    const session = await sessions.create();
    await sessions.save(session.token, session.edit_token, 1, prepared);
    await Promise.allSettled([2, 3, 4].map(revision => sessions.save(session.token, session.edit_token, revision, { ...prepared, message: `Revision ${revision}` })));
    const record = await sessions.submit(session.token, { revision: 4 });
    assert.equal(record.message, 'Revision 4');
  } finally { store.close(); }
});

test('SQLite draft and submission journal survive reopening the database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'society-session-restart-'));
  const path = join(directory, 'test.sqlite');
  let store = openStore(path);
  try {
    let service = createSessions(store.sessions, store);
    const session = await service.create();
    await service.save(session.token, session.edit_token, 1, prepared);
    store.close(); store = openStore(path);
    service = createSessions(store.sessions, store);
    const row = await service.submit(session.token, { revision: 1 });
    store.close(); store = openStore(path);
    const again = await createSessions(store.sessions, store).submit(session.token, { revision: 1 });
    assert.equal(again.id, row.id);
    assert.equal(store.recent().length, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
