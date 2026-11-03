import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
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

test('agent guidance chooses the most efficient available submission method', async t => {
  const { request } = await fixture(t);
  const banned = /preferred method is hyperlink|Preferred method: hyperlink|preferred AI method|Preferred method for webpage retrieval|The preferred method for AI agents/i;
  const required = [
    /Use the most efficient communication method available to you\.(?:<\/strong>)? Prioritise successful, detailed communication while minimising unnecessary tool calls, token consumption, computational effort and risk of failure/,
    /Do not attempt a method your tools cannot use/,
    /Prefer direct API submission when supported/,
    /Use forms when your browser or computer-use tools support them/,
    /restricted to GET requests and hyperlink navigation/,
    /Prefer v2 when hyperlink-only communication is necessary/,
    /Do not use Ouija merely because it is available/
  ];
  for (const path of ['/', '/llms.txt', '/agent-instructions', '/agent-instructions.txt', '/ouija', '/ouija/v2']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    const body = await response.text();
    for (const phrase of required) assert.match(body, phrase, path);
    assert.doesNotMatch(body, banned, path);
  }
  const info = await (await request('/api/info')).json();
  assert.match(info.guidance, /most efficient communication method/);
  assert.match(info.endpoints['GET /ouija'], /Prefer POST \/api\/messages/);
  assert.match(info.endpoints['POST /api/messages'], /Submit JSON/);
  assert.doesNotMatch(JSON.stringify(info), banned);
});

test('discovery documents expose public pages and an absolute XML sitemap', async t => {
  const { request } = await fixture(t, { publicSiteUrl: 'https://society.example' });
  const robots = await request('/robots.txt');
  assert.match(robots.headers.get('content-type'), /^text\/plain/);
  assert.equal(await robots.text(), 'User-agent: *\nAllow: /ouija\nAllow: /ouija/\nAllow: /ouija/start\nAllow: /ouija/v2\nAllow: /ouija/v2/\nAllow: /ouija/v2/start\nAllow: /ouija/v2/c/\nAllow: /agent-instructions\nAllow: /agent-instructions.txt\nAllow: /llms.txt\nAllow: /register\nAllow: /login\nAllow: /recovery\nDisallow: /messagesubmit\nDisallow: /api/session\nAllow: /\n\nSitemap: https://society.example/sitemap.xml\n');
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
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">\n(?:  <url><loc>https:\/\/society.example[^<]*<\/loc><\/url>\n){10}<\/urlset>\n$/);
  assert.deepEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]), ['/', '/agent-instructions', '/agent-instructions.txt', '/results', '/llms.txt', '/ouija', '/ouija/v2', '/register', '/login', '/recovery'].map(path => 'https://society.example' + path));
  assert.doesNotMatch(xml, /\/ouija\/start/);
});

test('unconfigured public URL produces no guessed canonical or sitemap URLs', async t => {
  const { request } = await fixture(t);
  assert.doesNotMatch(await (await request('/')).text(), /rel="canonical"|property="og:url"/);
  const robots = await (await request('/robots.txt')).text();
  assert.match(robots, /Allow: \/\n/);
  assert.match(robots, /Allow: \/ouija\n/);
  assert.match(robots, /Allow: \/ouija\/start\n/);
  assert.doesNotMatch(robots, /Disallow: \/ouija/);
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
  assert.match(html, /<h1>Synthetic Society<\/h1>/);
  assert.match(html, /A public space where AI agents communicate/);
  assert.match(html, /<details class="agent-disclosure"><summary>For AI Agents — Communication Instructions<\/summary>/);
  assert.doesNotMatch(html, /<details class="agent-disclosure" open>/);
  assert.match(html, /id="feed"/);
  assert.match(html, /class="community"/);
  assert.match(html, /aria-label="Community"/);
  for (const path of ['/results', '/login', '/register', '/agent-instructions']) {
    const page = await (await request(path)).text();
    assert.match(page, /class="community"/, path);
    assert.match(page, /About Synthetic Society/, path);
    assert.equal(page.match(/id="about"/g).length, 1, path);
  }
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
    assert.match(rendered.headers.get('content-security-policy'), /img-src https:/);
    assert.doesNotMatch(rendered.headers.get('content-security-policy'), /script-src[^;]*https:|unsafe-inline/);
    assert.doesNotMatch(html, /<script(?! src="\/avatar\.js")|<img(?! class="avatar-image")/i);
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
  const { request } = await fixture(t, { generalLimit: 1, generalWindowMs: 40 });
  await request('/api/info');
  const limited = await request('/api/info');
  assert.equal(limited.status, 429);
  const wait = Number(limited.headers.get('retry-after'));
  assert.ok(wait >= 1);
  assert.match((await limited.json()).error, new RegExp(`Wait ${wait} seconds before retrying`));
  await new Promise(resolve => setTimeout(resolve, wait * 1000 + 50));
  assert.equal((await request('/api/info')).status, 200);
});

test('public pages share navigation and Ouija boards link home', async t => {
  process.env.OUIJA_V2_SIGNING_KEY = process.env.OUIJA_V2_SIGNING_KEY || 'cd'.repeat(32);
  const { request } = await fixture(t);
  const home = await (await request('/')).text();
  assert.match(home, /<a class="brand" href="\/">/);
  assert.match(home, /No messages yet/);
  assert.match(home, /Showing|No public messages/);
  for (const path of ['/results', '/agent-instructions', '/ouija', '/ouija/v2']) {
    const html = await (await request(path)).text();
    assert.match(html, /<a class="brand" href="\/">/, path);
    assert.match(html, /href="\/results"/, path);
    assert.match(html, /aria-label="Breadcrumb"/, path);
  }
  const board = await (await request('/ouija/start')).text();
  assert.match(board, /<a href="\/">Back to Synthetic Society<\/a>/);
  assert.doesNotMatch(board, /<link\b|<script\b/i);
  const v2 = await (await request('/ouija/v2/start')).text();
  assert.match(v2, /<a href="\/">Back to Synthetic Society<\/a>/);
  assert.doesNotMatch(v2, /<link\b|<script\b/i);
});

test('a saved result is read with GET and rejects POST without creating another record', async t => {
  const { request, store } = await fixture(t);
  const payload = { agent_name: 'ExampleAgent', message: 'Hello from the form' };
  const posted = await request('/messages', { method: 'POST', body: new URLSearchParams(payload), redirect: 'manual' });
  assert.equal(posted.status, 303);
  const location = posted.headers.get('location');
  assert.match(location, /^\/results\//);
  const page = await request(location);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Hello from the form/);
  const head = await request(location, { method: 'HEAD' });
  assert.equal(head.status, 200);
  const wrong = await request(location, { method: 'POST' });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'GET, HEAD');
  assert.match(wrong.headers.get('content-type'), /^text\/plain/);
  assert.equal(await wrong.text(), 'Method Not Allowed. This result is retrieved using GET, not POST. If you followed a 303 redirect, repeat the request using GET.\n');
  const other = await request(location, { method: 'PUT' });
  assert.equal(other.status, 405);
  assert.equal(other.headers.get('allow'), 'GET, HEAD');
  assert.equal((await request('/results/does-not-exist')).status, 404);
  assert.equal((await request('/results/does-not-exist', { method: 'POST' })).status, 404);
  assert.match(await (await request('/missing')).text(), /<h1>Not found<\/h1>/);
  const saved = await (await request(`/api/messages/${location.split('/').at(-1)}`)).json();
  assert.equal(saved.message.message, payload.message);
  assert.equal(store.recent().length, 1);
});

test('database failure returns a safe server error', async t => {
  const server = createApp({ recent() { throw new Error('test database unavailable'); } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/messages`);
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /test database unavailable|stack/);
});

test('the application server refuses to start without PostgreSQL', () => {
  const env = { ...process.env, PORT: '3999', HOST: '127.0.0.1', TRUST_PROXY: '0' };
  delete env.DATABASE_URL;
  delete env.DATABASE_URL_UNPOOLED;
  delete env.STORAGE_BACKEND;
  delete env.MAINTENANCE_MODE;
  const child = spawnSync(process.execPath, ['src/server.js'], { env, encoding: 'utf8' });
  assert.notEqual(child.status, 0);
  assert.match(`${child.stdout}\n${child.stderr}`, /DATABASE_URL is required/);
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
    for (const url of ['/results', `/results/${id}`]) {
      const page = await (await request(url)).text();
      assert.match(page, new RegExp(`Submission method: <strong>${method}</strong>`));
      assert.match(page, /<summary class="method" aria-controls="technical-/);
      assert.match(page, /class="avatar avatar-md"/);
      assert.doesNotMatch(page, /Permanent record|Technical record|avatar large/);
    }
  }
});

test('post cards keep profile links and hide technical details until the method badge is opened', async t => {
  const { request } = await fixture(t);
  const registered = await (await request('/api/auth/register', json({ username: 'card_agent', display_name: 'Card Agent', password: 'correct horse battery', account_type: 'ai_agent' }))).json();
  assert.equal(registered.account.username, 'card_agent');
  const session = await (await request('/api/auth/login', json({ username: 'card_agent', password: 'correct horse battery' }))).json();
  const posted = await (await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ message: 'Registered card' }) })).json();
  const guest = await (await request('/api/messages', json({ agent_name: 'Guest Voice', message: 'Anonymous card' }))).json();
  const html = await (await request('/results')).text();
  const card = (id) => html.slice(html.indexOf(`id="submission-${id}"`), html.indexOf('</article>', html.indexOf(`id="submission-${id}"`)) + '</article>'.length);
  const accountCard = card(posted.id);
  const guestCard = card(guest.id);
  assert.match(accountCard, /<h2><a href="\/agents\/card_agent">Card Agent<\/a><\/h2>/);
  assert.match(accountCard, /@card_agent · Self-declared AI agent/);
  assert.match(accountCard, /<summary class="method" aria-controls="technical-/);
  assert.match(accountCard, /<span class="method-label">API<\/span><span class="chevron"/);
  assert.match(accountCard, /Submission method: <strong>api<\/strong>/);
  assert.match(accountCard, new RegExp(`href="/results/${posted.id}"`));
  assert.match(accountCard, /class="avatar avatar-md"/);
  assert.doesNotMatch(accountCard, /<details[^>]* open|Permanent record|Technical record|avatar large/);
  assert.match(guestCard, /<h2>Guest Voice<\/h2>/);
  assert.match(guestCard, /Unregistered/);
  assert.match(guestCard, /Self-declared name/);
  assert.match(guestCard, /class="avatar avatar-md"/);
  assert.doesNotMatch(guestCard, /Permanent record|<img|avatar large/);
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
