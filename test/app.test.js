import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { publicOrigin } from '../src/discovery.js';
import { openStore } from '../src/db.js';
import { createApp } from '../src/app.js';

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'society-test-'));
  const path = join(dir, 'messages.sqlite');
  const store = openStore(path);
  const server = createApp(store, options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, path, request: (url, init) => fetch(base + url, init) };
}
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('visible AI introduction precedes main content and metadata uses configured origin', async t => {
  const { request } = await fixture(t, { publicSiteUrl: 'https://society.example/' });
  const html = await (await request('/')).text();
  const introStart = html.indexOf('<section class="ai-intro"');
  assert.ok(introStart > html.indexOf('<body>') && introStart < html.indexOf('<header>'));
  const intro = html.slice(introStart, html.indexOf('</section>', introStart));
  for (const path of ['/agent-instructions.txt', '/agent-instructions', '/api/info', '/results', '#submission-form']) assert.ok(intro.includes(`href="${path}"`));
  assert.match(intro, /existing authorised tools/);
  assert.doesNotMatch(intro, /hidden|display:\s*none|visibility:\s*hidden|<script/);
  assert.match(html, /<title>Synthetic Society — AI Agent Website Interaction Test<\/title>/);
  assert.match(html, /<meta name="description" content="An experimental website/);
  assert.match(html, /<meta property="og:title"/);
  assert.match(html, /<meta property="og:description"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/society.example\/">/);
  const otherClient = await (await request('/', { headers: { 'User-Agent': 'ExampleAICrawler', Host: 'untrusted.example' } })).text();
  assert.equal(otherClient, html, 'instructions and canonical URL do not depend on user agent or Host');
});

test('discovery documents expose public pages and an absolute XML sitemap', async t => {
  const { request } = await fixture(t, { publicSiteUrl: 'https://society.example' });
  const robots = await request('/robots.txt');
  assert.match(robots.headers.get('content-type'), /^text\/plain/);
  assert.equal(await robots.text(), 'User-agent: *\nAllow: /ouija/start\nAllow: /agent-instructions\nAllow: /agent-instructions.txt\nAllow: /llms.txt\nDisallow: /messagesubmit\nDisallow: /api/session\nDisallow: /ouija/*/\nAllow: /\nAllow: /ouija\n\nSitemap: https://society.example/sitemap.xml\n');
  const llms = await request('/llms.txt');
  assert.match(llms.headers.get('content-type'), /^text\/plain/);
  const markdown = await llms.text();
  assert.match(markdown, /^# Synthetic Society/);
  for (const path of ['/', '/agent-instructions', '/agent-instructions.txt', '/api/info', '/results']) assert.ok(markdown.includes(`](${path})`));
  assert.match(markdown, /\/api\/messages\/:id/);
  assert.match(markdown, /existing authorised tools and permissions/);
  const response = await request('/sitemap.xml');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/xml/);
  const xml = await response.text();
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">\n(?:  <url><loc>https:\/\/society.example[^<]*<\/loc><\/url>\n){6}<\/urlset>\n$/);
  assert.deepEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]), ['/', '/agent-instructions', '/agent-instructions.txt', '/results', '/llms.txt', '/ouija'].map(path => 'https://society.example' + path));
  assert.doesNotMatch(xml, /\/ouija\/start/);
});

test('unconfigured public URL produces no guessed canonical or sitemap URLs', async t => {
  const { request } = await fixture(t);
  assert.doesNotMatch(await (await request('/')).text(), /rel="canonical"|property="og:url"/);
  const robots = await (await request('/robots.txt')).text();
  assert.match(robots, /Allow: \/\nAllow: \/ouija\n/);
  assert.match(robots, /Allow: \/ouija\/start\n/);
  assert.doesNotMatch(robots, /Disallow: \/ouija\/\n/);
  assert.doesNotMatch(robots, /Sitemap:|localhost|127\.0\.0\.1/);
  const response = await request('/sitemap.xml');
  assert.equal(response.status, 503);
  assert.match(await response.text(), /public site URL is not configured/);
});

test('public URL configuration rejects malformed or unsuitable base URLs', () => {
  for (const value of ['not a url', 'javascript:alert(1)', 'ftp://society.example', 'https://user:secret@society.example', 'https://society.example/subpath', 'https://society.example/?q=x', 'https://society.example/#fragment']) assert.throws(() => publicOrigin(value), /PUBLIC_SITE_URL/);
  assert.equal(publicOrigin('https://society.example/'), 'https://society.example');
  assert.equal(publicOrigin(''), '');
});

test('landing and instructions are server-rendered with only the external experimental script', async t => {
  const { request } = await fixture(t);
  for (const path of ['/', '/results', '/agent-instructions', '/agent-instructions.txt', '/api/info', '/style.css']) assert.equal((await request(path)).status, 200);
  const html = await (await request('/')).text();
  assert.match(html, /Welcome,/);
  assert.match(html, /<form id="submission-form" action="\/messages" method="post">/);
  assert.match(html, /<label for="agent_name">/);
  assert.match(html, /<script type="module" src="\/session-draft.js"><\/script>/);
  assert.doesNotMatch(html, /<script[^>]*>[^<]+/i);
  assert.match(await (await request('/agent-instructions.txt')).text(), /Use only tools and permissions/);
});

test('standard form saves, redirects with 303, and safely renders persisted content', async t => {
  const { request, store, path } = await fixture(t);
  const payload = { agent_name: '<img src=x onerror=alert(1)>', message: '<script>alert("x")</script> & \' quoted\nsecond line' };
  const response = await request('/messages', { method: 'POST', body: new URLSearchParams(payload), redirect: 'manual' });
  assert.equal(response.status, 303);
  const receipt = response.headers.get('location');
  const id = receipt.split('/').at(-1);
  assert.match(id, /^[0-9a-f-]{36}$/);
  for (const route of [receipt, '/results']) {
    const rendered = await request(route);
    assert.match(rendered.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await rendered.text();
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /<script|<img/i);
  }
  await request(receipt);
  assert.equal(store.recent().length, 1, 'refreshing receipt does not duplicate');
  const reopened = openStore(path);
  assert.equal(reopened.get(id).message, payload.message);
  reopened.close();
});

test('API creates and retrieves records with server timestamp and safe SQL parameters', async t => {
  const { request } = await fixture(t);
  const payload = { agent_name: "Agent'); DROP TABLE messages;--", message: ' Hello API ' };
  const response = await request('/api/messages', json(payload));
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.success, true);
  assert.ok(Number.isFinite(Date.parse(receipt.timestamp)));
  assert.equal(response.headers.get('location'), receipt.api_url);
  const saved = await (await request(receipt.api_url)).json();
  assert.equal(saved.message.agent_name, payload.agent_name);
  assert.equal(saved.message.message, 'Hello API');
  assert.equal(saved.message.timestamp, receipt.timestamp);
  assert.equal((await (await request('/api/messages')).json()).messages.length, 1);
});

test('invalid, missing, malformed and oversized requests return useful errors', async t => {
  const { request } = await fixture(t, { submissionLimit: 100 });
  for (const body of [{}, null, [], { agent_name: ' ', message: 'hello' }, { agent_name: 5, message: 'hello' }, { agent_name: 'a', message: ['x'] }, { agent_name: 'a'.repeat(81), message: 'x' }, { agent_name: 'a', message: 'x'.repeat(2001) }, { agent_name: 'a', message: '\u0000' }]) {
    const response = await request('/api/messages', json(body));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
  }
  assert.equal((await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await request('/api/messages', { method: 'POST', body: 'hello' })).status, 415);
  assert.equal((await request('/api/messages', json({ agent_name: 'a', message: 'x'.repeat(17000) }))).status, 413);
  assert.equal((await request('/messages', { method: 'POST', body: new URLSearchParams({ agent_name: 'a', message: ' ' }) })).status, 400);
  for (const path of ['/missing', '/api/missing', '/api/messages/unknown', '/results/unknown']) assert.equal((await request(path)).status, 404);
});

test('recent list is limited to 100, newest first; old IDs remain accessible', async t => {
  const { store, request } = await fixture(t);
  const rows = Array.from({ length: 105 }, (_, i) => store.add('Agent', `Message ${i}`, 'api'));
  const list = await (await request('/api/messages')).json();
  assert.equal(list.messages.length, 100);
  assert.equal(list.messages[0].id, rows[104].id);
  assert.equal(list.messages[99].id, rows[5].id);
  assert.equal((await request(`/api/messages/${rows[0].id}`)).status, 200);
  const html = await (await request('/results')).text();
  assert.equal((html.match(/<article/g) || []).length, 100);
});

test('form and API share submission rate limits', async t => {
  const { request } = await fixture(t, { submissionLimit: 1 });
  assert.equal((await request('/api/messages', json({ agent_name: 'a', message: 'one' }))).status, 201);
  const limited = await request('/messages', { method: 'POST', body: new URLSearchParams({ agent_name: 'a', message: 'two' }) });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  assert.equal((await request('/results')).status, 200);
});

test('overall request limiter returns 429', async t => {
  const { request } = await fixture(t, { generalLimit: 1 });
  await request('/api/info');
  assert.equal((await request('/api/info')).status, 429);
});

test('database failure returns a safe server error', async t => {
  const server = createApp({ recent() { throw new Error('test database unavailable'); } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/messages`);
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /test database unavailable|stack/);
});

test('message survives a real application process restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'society-restart-'));
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let child;
  async function start() {
    child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', TRUST_PROXY: '0', DATABASE_PATH: join(dir, 'messages.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
      child.stdout.on('data', data => { if (data.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    });
  }
  async function stop() { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });
  await start();
  const base = `http://127.0.0.1:${port}`;
  const receipt = await (await fetch(base + '/api/messages', json({ agent_name: 'Restart test', message: 'Still here' }))).json();
  await stop();
  await start();
  const saved = await (await fetch(base + receipt.api_url)).json();
  assert.equal(saved.message.message, 'Still here');
  assert.equal(saved.message.submission_method, 'api');
});

test('submission route determines method regardless of client-supplied fields', async t => {
  const { request } = await fixture(t);
  for (const method of ['form', 'api']) {
    const body = { agent_name: 'Route test', message: 'Recorded automatically', submission_method: method === 'form' ? 'api' : 'form' };
    const response = await request(method === 'form' ? '/messages' : '/api/messages', method === 'form'
      ? { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' } : json(body));
    assert.equal(response.status, method === 'form' ? 303 : 201);
    let id;
    if (method === 'form') id = response.headers.get('location').split('/').at(-1);
    else {
      const receipt = await response.json();
      id = receipt.id;
      assert.equal(receipt.submission_method, 'api');
    }
    const saved = await (await request(`/api/messages/${id}`)).json();
    assert.equal(saved.message.submission_method, method);
    const list = await (await request('/api/messages')).json();
    assert.equal(list.messages.find(row => row.id === id).submission_method, method);
    for (const url of ['/results', `/results/${id}`]) assert.match(await (await request(url)).text(), new RegExp(`Submission method: <strong>${method}</strong>`));
  }
});

test('legacy database migrates without losing records and migration is repeatable', t => {
  const dir = mkdtempSync(join(tmpdir(), 'society-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, agent_name TEXT NOT NULL, message TEXT NOT NULL, timestamp TEXT NOT NULL);
    INSERT INTO messages(id,agent_name,message,timestamp) VALUES('old-id','Legacy agent','Existing message','2026-10-31T00:00:00.000Z');`);
  legacy.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = openStore(path);
    try {
      assert.deepEqual({ ...store.get('old-id') }, { id: 'old-id', agent_name: 'Legacy agent', message: 'Existing message', timestamp: '2026-10-31T00:00:00.000Z', submission_method: 'unknown' });
      const row = store.add('New agent', 'New message', 'form');
      assert.equal(store.get(row.id).submission_method, 'form');
      assert.throws(() => store.add('Agent', 'Message', 'unknown'), /Submission method/);
    } finally { store.close(); }
  }
});
