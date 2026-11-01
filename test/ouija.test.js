import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ouijaStartHref } from '../src/ouija-cache.js';
import { createOuija, decodeCharacter, aliases } from '../src/ouija.js';
import { createSessions } from '../src/sessions.js';

async function fixture(t, options = {}) {
  const store = openStore(':memory:');
  const server = createApp(store, { submissionLimit: 100, generalLimit: 1000, ...options }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, get: (path, options) => fetch(base + path, options) };
}
const tokenFrom = html => html.match(/id="ouija-capability">([0-9a-f]{64})</)?.[1];
const link = (html, label) => {
  const match = html.match(new RegExp(`<a href="([^"]+)">${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a>`));
  assert.ok(match, `missing hyperlink ${label}`);
  return match[1];
};
async function follow(get, href) {
  const response = await get(href);
  assert.equal(response.status, 200, href);
  return response.text();
}
const idFrom = html => html.match(/id="message-id">([^<]+)</)?.[1];
async function start(get) {
  const response = await get('/ouija/start');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/i);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, no-cache, max-age=0, must-revalidate');
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('netlify-cdn-cache-control'), 'no-store');
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert.equal(response.headers.get('set-cookie'), null);
  const html = await response.text();
  assert.match(html, /Private session path: <code>\/ouija\/[0-9a-f]{64}<\/code>/);
  assert.doesNotMatch(html, /<script|<link|<img|<iframe/);
  const token = tokenFrom(html);
  assert.ok(token);
  return token;
}
async function spell(get, token, buffer, text) {
  for (let i = 0; i < text.length; i++) {
    const response = await get(`/ouija/${token}/${buffer}/${i + 1}/x${text.charCodeAt(i).toString(16).padStart(2, '0')}`);
    assert.equal(response.status, 200);
    await response.text();
  }
}

test('fresh client composes, publishes and verifies using GET only without headers or cookies', async t => {
  const { get, store } = await fixture(t);
  const landing = await get('/ouija');
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get('content-type'), /^text\/html; charset=utf-8$/i);
  assert.equal(landing.headers.get('x-robots-tag'), null);
  const landingHtml = await landing.text();
  assert.match(landingHtml, /GET-Only AI Communication/);
  assert.match(landingHtml, new RegExp(`<a href="${ouijaStartHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">Start Session</a>`));
  assert.match(landingHtml, /Do not construct URLs manually/);
  assert.match(landingHtml, /Follow the Start Session hyperlink/);
  assert.match(landingHtml, /Finish Name — Start Message/);
  assert.match(landingHtml, /Follow the Submit Message hyperlink/);
  assert.doesNotMatch(landingHtml, /<script\b/i);
  const slashed = await get('/ouija/');
  assert.equal(slashed.status, 200);
  assert.equal(slashed.headers.get('x-robots-tag'), null);
  assert.match(await slashed.text(), new RegExp(`<a href="${ouijaStartHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">Start Session</a>`));
  const token = await start(get);
  await spell(get, token, 'name', 'ChatGPT');
  await spell(get, token, 'char', 'Hello from Ouija!');
  const status = await (await get(`/ouija/${token}/status.json`)).json();
  assert.equal(status.agent_name, 'ChatGPT');
  assert.equal(status.message, 'Hello from Ouija!');
  assert.equal(status.can_submit, true);
  const reply = await get(`/ouija/${token}/submit`);
  assert.equal(reply.status, 200);
  const html = await reply.text();
  assert.match(html, /Ouija Submission Successful/);
  assert.ok(!html.includes(token));
  const id = idFrom(html);
  const saved = await (await get(`/api/messages/${id}`)).json();
  assert.equal(saved.message.agent_name, 'ChatGPT');
  assert.equal(saved.message.message, 'Hello from Ouija!');
  assert.equal(saved.message.submission_method, 'ouija_get');
  assert.match(await (await get('/results')).text(), /ouija_get/);
  assert.equal(idFrom(await (await get(`/ouija/${token}/submit`)).text()), id);
  assert.equal(store.recent().length, 1);
  assert.ok(!(await (await get('/api/messages')).text()).includes(token));
});

test('case-safe ASCII encoding, all aliases, and unsupported symbols', () => {
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
    assert.equal(decodeCharacter(c), c);
    assert.equal(decodeCharacter('x' + c.charCodeAt(0).toString(16)), c);
  }
  assert.equal(decodeCharacter('x41'), 'A'); assert.equal(decodeCharacter('x61'), 'a');
  for (const [alias, value] of Object.entries(aliases)) {
    assert.equal(decodeCharacter(alias), value);
    assert.equal(decodeCharacter('x' + value.charCodeAt(0).toString(16).padStart(2, '0')), value);
  }
  for (const value of ['Hello', '.', 'x00', 'x09', 'x2f', 'x3c', 'x7f', 'xFF', 'é', 'u1f600', '', 'constructor', '__proto__']) assert.throws(() => decodeCharacter(value), /Unsupported/);
});

test('out-of-order writes reconstruct by position; duplicates are acknowledged and conflicts rejected', async t => {
  const { get } = await fixture(t);
  const token = await start(get);
  await spell(get, token, 'name', 'AI');
  for (const [position, character] of [[3, 'exclamation'], [1, 'H']]) assert.equal((await get(`/ouija/${token}/char/${position}/${character}`)).status, 200);
  const incomplete = await (await get(`/ouija/${token}/status.json`)).json();
  assert.deepEqual(incomplete.message_buffer.missing, [2]);
  assert.equal(incomplete.message, 'H□!');
  assert.equal((await get(`/ouija/${token}/submit`)).status, 409);
  await get(`/ouija/${token}/char/2/i`);
  const duplicate = await (await get(`/ouija/${token}/char/2/i`)).text();
  assert.match(duplicate, /Already recorded; no change/);
  assert.equal((await get(`/ouija/${token}/char/2/x`)).status, 409);
  assert.equal((await get(`/ouija/${token}/name/1/B`)).status, 409);
  assert.equal((await (await get(`/ouija/${token}/status.json`)).json()).message, 'Hi!');
  await get(`/ouija/${token}/submit`);
  assert.equal((await get(`/ouija/${token}/char/4/x`)).status, 409);
  assert.equal((await get(`/ouija/${token}/char/2/i`)).status, 200);
});

test('position bounds, empty buffers and missing name characters reject submission', async t => {
  const { get } = await fixture(t);
  const token = await start(get);
  assert.equal((await get(`/ouija/${token}/submit`)).status, 400);
  for (const position of ['0', '-1', '01', '1.5', '1e2', '2001', '99999999999', '__proto__']) assert.equal((await get(`/ouija/${token}/char/${position}/a`)).status, 400);
  assert.equal((await get(`/ouija/${token}/name/81/a`)).status, 400);
  await get(`/ouija/${token}/char/1/H`);
  assert.equal((await get(`/ouija/${token}/submit`)).status, 400);
  await get(`/ouija/${token}/name/2/I`);
  assert.equal((await get(`/ouija/${token}/submit`)).status, 409);
  await get(`/ouija/${token}/name/1/A`);
  assert.equal((await get(`/ouija/${token}/submit`)).status, 200);
  const other = await start(get);
  await get(`/ouija/${other}/name/1/A`);
  assert.equal((await get(`/ouija/${other}/submit`)).status, 400);
  await get(`/ouija/${other}/char/1/space`);
  assert.equal((await get(`/ouija/${other}/submit`)).status, 400);
});

test('status is read-only, duplicates do not extend expiry, and expired credentials are rejected', async t => {
  let now = 1800000000000;
  const { get, store } = await fixture(t, { sessionNow: () => now });
  const token = await start(get);
  const key = 'ouija-' + createHash('sha256').update(token).digest('hex');
  await get(`/ouija/${token}/char/1/A`);
  const before = store.sessions.read(key);
  now += 1000;
  await get(`/ouija/${token}/status`); await get(`/ouija/${token}/status.json`); await get(`/ouija/${token}/char/1/A`);
  assert.deepEqual(store.sessions.read(key), before);
  now += 15 * 60_000;
  for (const suffix of ['status', 'char/2/a', 'submit']) assert.equal((await get(`/ouija/${token}/${suffix}`)).status, 410);
  assert.equal((await get('/ouija/not-a-token/status')).status, 403);
  await start(get);
  assert.equal(store.sessions.read(key), null);
});

test('multiple simultaneous sessions and Phase 1.1 capabilities remain isolated', async t => {
  const { get, store } = await fixture(t);
  const tokens = await Promise.all(Array.from({ length: 3 }, () => start(get)));
  assert.equal(new Set(tokens).size, 3);
  await Promise.all(tokens.map(async (token, i) => { await spell(get, token, 'name', `Agent${i}`); await spell(get, token, 'char', `Text${i}`); }));
  for (let i = 0; i < 3; i++) assert.equal((await (await get(`/ouija/${tokens[i]}/status.json`)).json()).message, `Text${i}`);
  const paired = createSessions(store.sessions, store);
  const pairedSession = await paired.create();
  assert.equal((await get(`/ouija/${pairedSession.token}/status`)).status, 403);
  await assert.rejects(paired.submit(tokens[0], { revision: 1 }), /Invalid/);
});

test('concurrent characters and final requests preserve characters and one permanent record', async () => {
  const store = openStore(':memory:');
  try {
    const workers = Array.from({ length: 6 }, () => createOuija(store.sessions, store));
    const { token } = await workers[0].start();
    await workers[0].write(token, 'name', 1, 'A');
    await Promise.all(workers.map((worker, i) => worker.write(token, 'message', i + 1, String(i))));
    assert.equal((await workers[0].status(token)).message, '012345');
    const receipts = await Promise.all(workers.map(worker => worker.submit(token)));
    assert.equal(new Set(receipts.map(row => row.id)).size, 1);
    assert.equal(store.recent().length, 1);
  } finally { store.close(); }
});

test('HEAD and recognised previews never allocate, write or submit', async t => {
  const { get, store } = await fixture(t);
  assert.equal((await get('/ouija/start', { method: 'HEAD' })).status, 405);
  const mixedCaseHead = await get('/OUIJA/START', { method: 'HEAD' });
  assert.equal(mixedCaseHead.status, 405);
  assert.match(mixedCaseHead.headers.get('cache-control'), /private/);
  assert.match(mixedCaseHead.headers.get('x-robots-tag'), /noindex/);
  for (const headers of [{ Purpose: 'prefetch' }, { 'Sec-Purpose': 'prerender' }, { 'X-Purpose': 'preview' }]) assert.equal((await get('/ouija/start', { headers })).status, 400);
  const keys = []; for await (const key of store.sessions.keys()) keys.push(key);
  assert.equal(keys.length, 0);
  const token = await start(get);
  for (const suffix of ['char/1/H', 'name/1/A', 'submit', 'status']) assert.equal((await get(`/ouija/${token}/${suffix}`, { method: 'HEAD' })).status, 405);
  for (const suffix of ['char/1/H', 'name/1/A', 'submit']) assert.equal((await get(`/ouija/${token}/${suffix}`, { headers: { Purpose: 'prefetch' } })).status, 400);
  assert.equal((await (await get(`/ouija/${token}/status.json`)).json()).recorded_character_count, 0);
  assert.equal(store.recent().length, 0);
});

test('max length is accepted; whitespace is preserved; oversized positions are rejected', async () => {
  const store = openStore(':memory:');
  try {
    const service = createOuija(store.sessions, store);
    const { token } = await service.start();
    for (let i = 1; i <= 80; i++) await service.write(token, 'name', i, 'N');
    for (let i = 1; i <= 2000; i++) await service.write(token, 'message', i, i === 1 ? 'space' : i === 2000 ? 'newline' : 'a');
    await assert.rejects(service.write(token, 'name', 81, 'a'), /1 to 80/);
    await assert.rejects(service.write(token, 'message', 2001, 'a'), /1 to 2000/);
    const row = await service.submit(token);
    assert.equal(row.agent_name.length, 80); assert.equal(row.message.length, 2000);
    assert.equal(row.message, ' ' + 'a'.repeat(1998) + '\n');
  } finally { store.close(); }
});

test('failure after permanent write is recoverable and retries retain one record', async () => {
  const store = openStore(':memory:');
  try {
    let failing = true;
    const service = createOuija(store.sessions, { putIfAbsent(record) { const row = store.putIfAbsent(record); if (failing) throw new Error('lost response'); return row; } });
    const { token } = await service.start();
    await service.write(token, 'name', 1, 'A'); await service.write(token, 'message', 1, 'B');
    await assert.rejects(service.submit(token), /lost response/);
    const status = await service.status(token);
    assert.equal(status.state, 'submitting'); assert.ok(status.recovery_id);
    failing = false;
    assert.equal((await service.submit(token)).id, status.recovery_id);
    assert.equal(store.recent().length, 1);
  } finally { store.close(); }
});

test('storage failure and bounded session creation return clear errors', async t => {
  const broken = await fixture(t, { sessionBackend: { async *keys() { throw new Error('private details'); } } });
  const response = await broken.get('/ouija/start');
  assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /private details/);
  const normal = await fixture(t);
  for (let i = 0; i < 20; i++) await start(normal.get);
  const limited = await normal.get('/ouija/start');
  assert.equal(limited.status, 429); assert.ok(limited.headers.get('retry-after'));
  assert.match(limited.headers.get('x-robots-tag'), /noindex/);
});

test('SQLite migration preserves Phase 1.1 records and Ouija sessions survive reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouija-migration-'));
  const path = join(dir, 'db.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,agent_name TEXT NOT NULL,message TEXT NOT NULL,timestamp TEXT NOT NULL,submission_method TEXT NOT NULL CHECK(submission_method IN ('form','api','session_get','unknown'))); INSERT INTO messages(id,agent_name,message,timestamp,submission_method) VALUES('legacy','Old','Preserved','2026-10-31T00:00:00.000Z','session_get');");
  legacy.close();
  let store = openStore(path);
  try {
    assert.equal(store.get('legacy').message, 'Preserved');
    let service = createOuija(store.sessions, store);
    const { token } = await service.start();
    await service.write(token, 'name', 1, 'A'); await service.write(token, 'message', 1, 'Z');
    store.close(); store = openStore(path); service = createOuija(store.sessions, store);
    const row = await service.submit(token);
    store.close(); store = openStore(path);
    assert.equal(store.get(row.id).submission_method, 'ouija_get');
    assert.equal(store.get('legacy').submission_method, 'session_get');
    assert.equal((await createOuija(store.sessions, store).submit(token)).id, row.id);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('versioned session start is fresh, uncached and returns the hyperlink board', async t => {
  const { get } = await fixture(t);
  const cache = 'private, no-store, no-cache, max-age=0, must-revalidate';
  const page = await (await get('/ouija')).text();
  const startHref = link(page, 'Start Session');
  assert.equal(startHref, ouijaStartHref);
  assert.match(page, /Follow the actual hyperlinks provided by each page/);
  assert.match(page, /Do not manually construct character URLs/);
  const first = await get(startHref, { redirect: 'manual' });
  const second = await get(startHref, { redirect: 'manual' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.headers.get('location'), null);
  assert.equal(second.headers.get('location'), null);
  for (const response of [first, second]) {
    assert.equal(response.headers.get('cache-control'), cache);
    assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
    assert.equal(response.headers.get('netlify-cdn-cache-control'), 'no-store');
  }
  const html = await first.text();
  const other = await second.text();
  const token = tokenFrom(html);
  assert.notEqual(token, tokenFrom(other));
  assert.match(html, /id="ouija-protocol-version">Ouija Hyperlink Board — Phase 1\.3 \/ Build 2</);
  assert.match(html, new RegExp(`<a href="/ouija/${token}/name/1/C\\?nav=nav_[0-9a-f]{8}">C</a>`));
  assert.doesNotMatch(html, /Name: GET /);
  const written = await get(link(html, 'C'), { redirect: 'manual' });
  assert.equal(written.status, 200);
  assert.equal(written.headers.get('location'), null);
  assert.equal(written.headers.get('cache-control'), cache);
  assert.equal(written.headers.get('netlify-cdn-cache-control'), 'no-store');
  const next = await written.text();
  assert.match(next, /Ouija Hyperlink Board — Phase 1\.3 \/ Build 2/);
  assert.match(link(next, 'D'), new RegExp(`/ouija/${token}/name/2/D\\?nav=nav_[0-9a-f]{8}$`));
  const messageBoard = await get(link(next, 'Finish Name — Start Message'));
  assert.equal(messageBoard.status, 200);
  assert.equal(messageBoard.headers.get('cache-control'), cache);
  const review = await get(`/ouija/${token}/review`);
  assert.equal(review.status, 400);
  assert.equal(review.headers.get('cache-control'), cache);
  assert.equal(review.headers.get('netlify-cdn-cache-control'), 'no-store');
  const status = await get(`/ouija/${token}/status`);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), cache);
  const statusJson = await get(`/ouija/${token}/status.json`);
  assert.equal(statusJson.headers.get('cache-control'), cache);
  assert.equal(statusJson.headers.get('cdn-cache-control'), 'no-store');
  await messageBoard.text();
  await review.text();
  await status.text();
  await statusJson.json();
  const legacy = await get('/ouija/start', { redirect: 'manual' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get('location'), null);
  assert.notEqual(tokenFrom(await legacy.text()), token);
  assert.equal((await get(startHref, { method: 'HEAD' })).status, 405);
  assert.equal((await get(startHref, { headers: { Purpose: 'prefetch' } })).status, 400);
  const css = await get('/style.css');
  assert.equal(css.headers.get('netlify-cdn-cache-control'), null);
  assert.equal(css.headers.get('cdn-cache-control'), null);
  await css.text();
});

test('hyperlink navigation from the homepage publishes without constructing character URLs', async t => {
  const { get, store } = await fixture(t);
  let html = await follow(get, link(await (await get('/')).text(), 'Ouija Protocol — GET-only AI message submission'));
  html = await follow(get, link(html, 'Start Session'));
  assert.match(html, /id="ouija-board"/);
  assert.match(html, /Current mode: Agent name/);
  assert.match(html, /Next character position: 1/);
  assert.match(html, /Remaining character allowance: 80/);
  assert.doesNotMatch(html, /<script\b|<link\b|<iframe\b/i);
  for (const [label, suffix] of [['A', '/name/1/A'], ['a', '/name/1/a'], ['7', '/name/1/7'], ['Space', '/name/1/space'], ['Newline', '/name/1/newline'], ['Exclamation', '/name/1/exclamation']]) assert.match(link(html, label), new RegExp(`${suffix}\\?nav=nav_[0-9a-f]{8}$`));
  html = await follow(get, link(html, 'A'));
  assert.match(html, /id="ouija-name">A<\/pre>/);
  assert.match(html, /Saved successfully/);
  assert.match(link(html, 'I'), /\/name\/2\/I\?nav=nav_[0-9a-f]{8}$/);
  html = await follow(get, link(html, 'I'));
  html = await follow(get, link(html, 'Finish Name — Start Message'));
  assert.match(html, /Current mode: Message/);
  assert.match(link(html, 'H'), /\/char\/1\/H\?nav=nav_[0-9a-f]{8}$/);
  html = await follow(get, link(html, 'H'));
  html = await follow(get, link(html, 'i'));
  assert.match(link(html, 'Exclamation'), /\/char\/3\/exclamation\?nav=nav_[0-9a-f]{8}$/);
  html = await follow(get, link(html, 'Exclamation'));
  html = await follow(get, link(html, 'Review Message'));
  assert.match(html, /id="ouija-name">AI<\/pre>/);
  assert.match(html, /id="ouija-message">Hi!<\/pre>/);
  html = await follow(get, link(html, 'Submit Message'));
  assert.match(html, /ouija_get/);
  const saved = await (await get(link(html, 'Verify the permanent record'))).json();
  assert.equal(saved.message.agent_name, 'AI');
  assert.equal(saved.message.message, 'Hi!');
  assert.equal(saved.message.submission_method, 'ouija_get');
  assert.equal(store.recent().length, 1);
});

test('repeated, stale and speculative hyperlinks do not corrupt or duplicate a draft', async t => {
  const { get } = await fixture(t);
  const instructions = await (await get('/ouija')).text();
  const startHref = link(instructions, 'Start Session');
  const first = await follow(get, startHref);
  const second = await follow(get, startHref);
  const firstA = link(first, 'A');
  const secondA = link(second, 'A');
  assert.notEqual(firstA, secondA);
  const staleB = link(first, 'B');
  assert.equal((await get(firstA, { method: 'HEAD' })).status, 405);
  assert.equal((await get(firstA, { headers: { Purpose: 'prefetch' } })).status, 400);
  const blocked = await get(link(first, 'Finish Name — Start Message'));
  assert.equal(blocked.status, 400);
  assert.match(await blocked.text(), /id="ouija-name"><\/pre>/);
  const written = await follow(get, firstA);
  assert.match(written, /id="ouija-name">A<\/pre>/);
  assert.match(link(written, 'C'), /\/name\/2\/C\?nav=nav_[0-9a-f]{8}$/);
  const again = await follow(get, firstA);
  assert.match(again, /Already recorded; no change/);
  assert.match(again, /id="ouija-name">A<\/pre>/);
  const conflict = await get(staleB);
  assert.equal(conflict.status, 409);
  const conflictHtml = await conflict.text();
  assert.match(conflictHtml, /id="ouija-name">A<\/pre>/);
  assert.doesNotMatch(conflictHtml, /id="ouija-name">B<\/pre>/);
  const isolated = await get(link(second, 'Finish Name — Start Message'));
  assert.equal(isolated.status, 400);
  assert.match(await isolated.text(), /id="ouija-name"><\/pre>/);
});

test('hyperlink spelling of ChatGPT records message H and names a stale-link 409', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouija-chatgpt-'));
  const path = join(dir, 'db.sqlite');
  const open = async () => {
    const store = openStore(path);
    const server = createApp(store, { submissionLimit: 100, generalLimit: 1000 }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { store, server, get: (href, options) => fetch(`http://127.0.0.1:${server.address().port}` + href, options) };
  };
  const close = async session => {
    if (!session?.server) return;
    const server = session.server;
    const store = session.store;
    session.server = null;
    await new Promise(resolve => server.close(resolve));
    store.close();
  };
  let session = await open();
  try {
    let html = await follow(session.get, link(await (await session.get('/ouija')).text(), 'Start Session'));
    const staleNameH = link(html, 'H');
    for (const character of 'ChatGPT') html = await follow(session.get, link(html, character));
    assert.match(html, /id="ouija-name">ChatGPT<\/pre>/);
    const finish = link(html, 'Finish Name — Start Message');
    html = await follow(session.get, finish);
    const repeated = await follow(session.get, finish);
    assert.match(repeated, /Current mode: Message/);
    assert.match(repeated, /Next character position: 1/);
    assert.match(repeated, /name 7; message 0/);
    const messageH = link(html, 'H');
    const staleMessageA = link(html, 'A');
    assert.match(messageH, /\/char\/1\/H\?nav=nav_[0-9a-f]{8}$/);
    assert.match(staleNameH, /\/name\/1\/H\?nav=nav_[0-9a-f]{8}$/);
    assert.equal((await session.get(messageH, { method: 'HEAD' })).status, 405);
    assert.equal((await session.get(messageH, { headers: { Purpose: 'prefetch' } })).status, 400);
    const conflict = await session.get(staleNameH);
    assert.equal(conflict.status, 409);
    const conflictHtml = await conflict.text();
    assert.match(conflictHtml, /id="ouija-error">OUIJA_POSITION_CONFLICT\. The agent-name position 1/);
    assert.match(conflictHtml, /id="ouija-name">ChatGPT<\/pre>/);
    assert.match(conflictHtml, /id="ouija-message"><\/pre>/);
    await close(session);
    session = await open();
    html = await follow(session.get, messageH);
    assert.match(html, /id="ouija-message">H<\/pre>/);
    assert.match(html, /Next character position: 2/);
    assert.match(link(html, 'i'), /\/char\/2\/i\?nav=nav_[0-9a-f]{8}$/);
    const duplicate = await follow(session.get, messageH);
    assert.match(duplicate, /Already recorded; no change/);
    assert.match(duplicate, /id="ouija-message">H<\/pre>/);
    const wrong = await session.get(staleMessageA);
    assert.equal(wrong.status, 409);
    assert.match(await wrong.text(), /OUIJA_POSITION_CONFLICT\. The message position 1/);
    html = await follow(session.get, link(html, 'i'));
    html = await follow(session.get, link(html, 'Exclamation'));
    html = await follow(session.get, link(html, 'Review Message'));
    assert.match(html, /id="ouija-name">ChatGPT<\/pre>/);
    assert.match(html, /id="ouija-message">Hi!<\/pre>/);
    html = await follow(session.get, link(html, 'Submit Message'));
    const saved = await (await session.get(link(html, 'Verify the permanent record'))).json();
    assert.equal(saved.message.agent_name, 'ChatGPT');
    assert.equal(saved.message.message, 'Hi!');
    assert.equal(saved.message.submission_method, 'ouija_get');
  } finally {
    await close(session);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an extracted character link expires with its session', async t => {
  let now = 1800000000000;
  const { get } = await fixture(t, { sessionNow: () => now });
  const html = await follow(get, link(await (await get('/ouija')).text(), 'Start Session'));
  const href = link(html, 'Z');
  const run = html.match(/Experiment run: (run_[0-9a-f]{12})/)[1];
  const token = tokenFrom(html);
  now += 15 * 60_000;
  const expired = await get(href);
  assert.equal(expired.status, 410);
  const page = await expired.text();
  assert.match(page, /This Ouija session cannot accept new characters/);
  assert.match(page, /This Ouija session has expired/);
  assert.equal(link(page, 'Return to Homepage'), '/');
  assert.equal(page.includes(token), false);
  const fresh = link(page, 'Start Fresh Session');
  assert.match(fresh, /^\/ouija\/start\?v=phase14-recover-resp_[0-9a-f]{8}$/);
  const restarted = await follow(get, fresh);
  assert.match(restarted, /Name characters: 0/);
  assert.match(restarted, /Message characters: 0/);
  assert.doesNotMatch(restarted, /id="ouija-fresh-session"/);
  assert.notEqual(restarted.match(/Experiment run: (run_[0-9a-f]{12})/)[1], run);
});

test('homepage and older start URLs create independent empty sessions', async t => {
  const { get, store } = await fixture(t);
  const home = await (await get('/')).text();
  const instructions = await follow(get, link(home, 'Ouija Protocol — GET-only AI message submission'));
  assert.equal(link(home, 'Start Session'), ouijaStartHref);
  assert.equal(link(instructions, 'Start Session'), ouijaStartHref);
  for (const page of [home, instructions]) {
    assert.match(page, /<h2 id="ai-agent-instructions-title">Instructions for AI Agents<\/h2>/);
    assert.match(page, /Do not reuse session-start URLs, character-board links or private session URLs from previous visits or conversations/);
    assert.match(page, /Confirm that the new session has an empty name, an empty message and a valid expiry time/);
    assert.match(page, /Use only character hyperlinks from the latest returned board/);
    assert.doesNotMatch(page.match(/<section id="ai-agent-instructions"[\s\S]*?<\/section>/)[0], /<script\b/i);
  }
  const runs = [];
  const tokens = [];
  for (const href of [ouijaStartHref, '/ouija/start', '/ouija/start?v=phase13-hyperlink-board-2', `${ouijaStartHref}&recover=resp_abcdef12`]) {
    const html = await follow(get, href);
    runs.push(html.match(/Experiment run: (run_[0-9a-f]{12})/)[1]);
    tokens.push(tokenFrom(html));
    assert.match(html, /Ouija Protocol — Phase 1.4 Diagnostics/);
    assert.match(html, /Name characters: 0/);
    assert.match(html, /Message characters: 0/);
    assert.match(html, /State: writing/);
    assert.doesNotMatch(html, /id="ouija-fresh-session"/);
  }
  assert.equal(new Set(runs).size, 4);
  assert.equal(new Set(tokens).size, 4);
  const recovered = await store.audit.events(runs[3]);
  assert.equal(recovered.find(event => event.route === 'start' && event.result === 'recorded').recovery_of, 'resp_abcdef12');
  assert.equal(JSON.stringify(recovered).includes(tokens[3]), false);
  assert.equal((await store.audit.events(runs[1])).find(event => event.route === 'start').recovery_of, null);
  const ignored = await follow(get, '/ouija/start?recover=not-a-response-id');
  const ignoredEvents = await store.audit.events(ignored.match(/Experiment run: (run_[0-9a-f]{12})/)[1]);
  assert.equal(ignoredEvents.find(event => event.route === 'start').recovery_of, null);
  assert.equal(JSON.stringify(ignoredEvents).includes('not-a-response-id'), false);
});

test('hyperlink spelling of ChatGPT and Hello publishes without reusing another session', async t => {
  const { get, store } = await fixture(t);
  let html = await follow(get, link(await (await get('/')).text(), 'Ouija Protocol — GET-only AI message submission'));
  html = await follow(get, link(html, 'Start Session'));
  const firstRun = html.match(/Experiment run: (run_[0-9a-f]{12})/)[1];
  const token = tokenFrom(html);
  const firstC = link(html, 'C');
  assert.doesNotMatch(html, /id="ouija-fresh-session"/);
  assert.match(html, /Ouija Protocol — Phase 1.4 Diagnostics/);
  for (const character of 'ChatGPT') html = await follow(get, link(html, character));
  assert.match(html, /id="ouija-name">ChatGPT<\/pre>/);
  const unusedName = link(html, 'A');
  const repeated = await follow(get, firstC);
  assert.match(repeated, /Already recorded; no change/);
  assert.match(repeated, /id="ouija-name">ChatGPT<\/pre>/);
  html = await follow(get, link(html, 'Finish Name — Start Message'));
  for (const character of ['H', 'e', 'l', 'l', 'o', 'Exclamation']) html = await follow(get, link(html, character));
  assert.match(html, /id="ouija-message">Hello!<\/pre>/);
  html = await follow(get, link(html, 'Review Message'));
  assert.match(html, /id="ouija-name">ChatGPT<\/pre>/);
  assert.match(html, /id="ouija-message">Hello!<\/pre>/);
  html = await follow(get, link(html, 'Submit Message'));
  const saved = await (await get(link(html, 'Verify the permanent record'))).json();
  assert.equal(saved.message.agent_name, 'ChatGPT');
  assert.equal(saved.message.message, 'Hello!');
  assert.equal(saved.message.submission_method, 'ouija_get');
  const locked = await get(unusedName);
  assert.equal(locked.status, 409);
  const lockedHtml = await locked.text();
  assert.match(lockedHtml, /OUIJA_STATE_CONFLICT/);
  assert.match(lockedHtml, /This Ouija session cannot accept new characters/);
  const fresh = link(lockedHtml, 'Start Fresh Session');
  const responseId = lockedHtml.match(/Response: (resp_[0-9a-f]{8})/)[1];
  assert.equal(fresh, `/ouija/start?v=phase14-recover-${responseId}`);
  assert.equal(fresh.includes(token), false);
  const restarted = await follow(get, fresh);
  const secondRun = restarted.match(/Experiment run: (run_[0-9a-f]{12})/)[1];
  assert.notEqual(secondRun, firstRun);
  assert.notEqual(tokenFrom(restarted), token);
  assert.match(restarted, /Name characters: 0/);
  assert.match(restarted, /Message characters: 0/);
  const third = await follow(get, link(await (await get('/ouija')).text(), 'Start Session'));
  const thirdRun = third.match(/Experiment run: (run_[0-9a-f]{12})/)[1];
  assert.notEqual(thirdRun, firstRun);
  assert.notEqual(thirdRun, secondRun);
  assert.match(third, /Name characters: 0/);
  assert.equal((await store.audit.events(secondRun)).find(event => event.route === 'start').recovery_of, responseId);
  assert.equal(JSON.stringify(await store.audit.events(firstRun)).includes(token), false);
  const still = await (await get(`/api/messages/${saved.message.id}`)).json();
  assert.equal(still.message.agent_name, 'ChatGPT');
  assert.equal(still.message.message, 'Hello!');
  let conflictPage = await follow(get, ouijaStartHref);
  const conflictRun = conflictPage.match(/Experiment run: (run_[0-9a-f]{12})/)[1];
  for (const character of 'ChatG') conflictPage = await follow(get, link(conflictPage, character));
  const uppercaseP = link(conflictPage, 'P');
  const lowercaseP = link(conflictPage, 'p');
  conflictPage = await follow(get, lowercaseP);
  assert.match(await follow(get, lowercaseP), /Already recorded/);
  const conflict = await get(uppercaseP);
  assert.equal(conflict.status, 409);
  const conflictHtml = await conflict.text();
  assert.match(conflictHtml, /OUIJA_POSITION_CONFLICT\. The agent-name position 6/);
  assert.match(conflictHtml, /already occupied/);
  assert.match(conflictHtml, /earlier board/);
  assert.match(conflictHtml, /id="ouija-name">ChatGp<\/pre>/);
  const recovered = await follow(get, link(conflictHtml, 'Start Fresh Session'));
  assert.match(recovered, /Name characters: 0/);
  assert.doesNotMatch(recovered, /ChatGp/);
  assert.notEqual(recovered.match(/Experiment run: (run_[0-9a-f]{12})/)[1], conflictRun);
});

test('an earlier character hyperlink that conflicts explains the occupied position and offers recovery', async t => {
  const { get, store } = await fixture(t);
  let html = await follow(get, link(await (await get('/ouija')).text(), 'Start Session'));
  const token = tokenFrom(html);
  assert.match(html, /Important — AI Navigation Instructions/);
  assert.match(html, /Only follow character hyperlinks from the most recently returned Ouija board/);
  const staleB = link(html, 'B');
  const firstC = link(html, 'C');
  html = await follow(get, firstC);
  html = await follow(get, link(html, 'h'));
  html = await follow(get, link(html, 'a'));
  assert.match(html, /id="ouija-name">Cha<\/pre>/);
  const same = await follow(get, firstC);
  assert.match(same, /Already recorded; no change/);
  assert.doesNotMatch(same, /OUIJA_POSITION_CONFLICT/);
  assert.doesNotMatch(same, /Character Conflict/);
  const conflict = await get(staleB);
  assert.equal(conflict.status, 409);
  const page = await conflict.text();
  assert.match(page, /OUIJA_POSITION_CONFLICT/);
  assert.match(page, /Ouija Protocol — Character Conflict/);
  assert.match(page, /name character position 1/);
  assert.match(page, /progressed beyond position 1/);
  assert.match(page, /The next expected position is 4/);
  assert.match(page, /already occupied/);
  assert.match(page, /advertised by an earlier board/);
  assert.match(page, /Do not retry the same conflicting hyperlink/);
  assert.match(page, /id="ouija-name">Cha<\/pre>/);
  assert.doesNotMatch(page, />B<\/pre>/);
  assert.equal(link(page, 'Return to Homepage'), '/');
  const fresh = link(page, 'Start Fresh Session');
  assert.match(fresh, /^\/ouija\/start\?v=phase14-recover-resp_[0-9a-f]{8}$/);
  const recovered = await follow(get, fresh);
  assert.match(recovered, /Name characters: 0/);
  assert.match(recovered, /Message characters: 0/);
  const run = page.match(/Experiment run: (run_[0-9a-f]{12})/)[1];
  const rejected = (await store.audit.events(run)).find(event => event.code === 'OUIJA_POSITION_CONFLICT');
  assert.equal(rejected.stale_nav, true);
  assert.equal(rejected.position, 1);
  assert.equal(rejected.expected_position, 4);
  assert.equal(rejected.status, 409);
  assert.equal(JSON.stringify(await store.audit.events(run)).includes(token), false);
});
