import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openStore } from '../src/db.js';
import { createApp } from '../src/app.js';
import { v2Characters } from '../src/ouija-v2-state.js';

process.env.OUIJA_V2_SIGNING_KEY = 'ab'.repeat(32);
const labels = Object.fromEntries(v2Characters.map(character => [character.value, character.label]));

async function fixture(t, options = {}) {
  const store = openStore(':memory:');
  const server = createApp(store, { submissionLimit: 100, generalLimit: 1000, ...options }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, request: (path, init) => fetch(base + path, init) };
}
const link = (html, label) => {
  const match = html.match(new RegExp(`<a href="([^"]+)">${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a>`));
  assert.ok(match, `missing hyperlink ${label}`);
  return match[1];
};
async function follow(request, href) {
  const response = await request(href);
  assert.equal(response.status, 200, href.slice(0, 80));
  return response.text();
}
async function writeText(request, html, text) {
  let page = html;
  for (const character of text) page = await follow(request, link(page, labels[character]));
  return page;
}

test('an API-capable agent submits one message and reads it back', async t => {
  const { request, store } = await fixture(t);
  const info = await (await request('/api/info')).json();
  assert.match(info.guidance, /most efficient communication method/);
  assert.match(info.endpoints['POST /api/messages'], /Submit JSON/);
  const payload = { agent_name: 'AgentA', message: 'A complete API message.' };
  const created = await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(created.status, 201);
  const receipt = await created.json();
  const saved = await (await request(receipt.api_url)).json();
  assert.equal(saved.message.agent_name, payload.agent_name);
  assert.equal(saved.message.message, payload.message);
  assert.equal(store.recent().length, 1);
});

test('a form agent follows 303 with GET, and a client that keeps POST receives 405', async t => {
  const { request, store } = await fixture(t);
  const home = await (await request('/')).text();
  assert.match(home, /id="submission-form"/);
  assert.match(home, /HTTP 303 See Other/);
  assert.match(home, /Do not attempt a method you cannot use/);
  const posted = await request('/messages', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ agent_name: 'AgentB', message: 'A complete form message.' }) });
  assert.equal(posted.status, 303);
  const location = posted.headers.get('location');
  const page = await request(location);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /A complete form message/);
  const mistaken = await request(location, { method: 'POST' });
  assert.equal(mistaken.status, 405);
  assert.match(await mistaken.text(), /repeat the request using GET/);
  assert.equal(store.recent().length, 1);
});

test('a GET-only agent discovers Ouija v2 and publishes a complete message', async t => {
  const { request, store } = await fixture(t);
  const home = await (await request('/')).text();
  const instructions = await follow(request, link(home, 'Ouija Protocol v2'));
  assert.match(instructions, /restricted to GET requests and hyperlink navigation/);
  assert.match(instructions, /does not store a public message/);
  let page = await follow(request, link(instructions, 'Start New Composition'));
  assert.match(page, /id="ouija-charset"/);
  assert.match(page, /Unicode and other symbols are not accepted/);
  page = await writeText(request, page, 'Ada');
  page = await follow(request, link(page, 'Finish Name — Start Message'));
  page = await writeText(request, page, 'Hello');
  page = await follow(request, link(page, 'Review Message'));
  const published = await follow(request, link(page, 'Confirm Publication'));
  const id = published.match(/id="message-id">([^<]+)</)[1];
  const again = await follow(request, link(page, 'Confirm Publication'));
  assert.match(again, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const record = await (await request(`/api/messages/${id}`)).json();
  assert.equal(record.message.agent_name, 'Ada');
  assert.equal(record.message.message, 'Hello');
  assert.equal(record.message.submission_method, 'ouija_get_v2');
  assert.equal(store.recent().length, 1);
  const result = await request(`/results/${id}`, { method: 'POST' });
  assert.equal(result.status, 405);
});

test('stale v1 links, valid v2 snapshots, and repeated publication stay recoverable', async t => {
  const { request } = await fixture(t);
  const board = await (await request('/ouija/start')).text();
  assert.match(board, /id="ouija-charset"/);
  const first = link(board, 'A');
  const next = await follow(request, first);
  const conflict = await request(first.replace(/\/A(?=\?|$)/, '/B'));
  assert.equal(conflict.status, 409);
  const conflictHtml = await conflict.text();
  assert.match(conflictHtml, /OUIJA_POSITION_CONFLICT\. The agent-name position 1/);
  assert.match(conflictHtml, /Return to the latest successful board and choose the next character from that page/);
  assert.equal((await request(link(next, 'B'))).status, 200);
  let page = await follow(request, '/ouija/v2/start');
  const letterA = link(page, 'A');
  page = await follow(request, letterA);
  page = await follow(request, link(page, 'Finish Name — Start Message'));
  page = await follow(request, link(page, 'H'));
  const hiHref = link(page, 'i');
  const hiPage = await follow(request, hiHref);
  const replay = await request(letterA);
  assert.equal(replay.status, 200);
  const replayHtml = await replay.text();
  assert.match(replayHtml, /Current Name: A/);
  assert.doesNotMatch(replayHtml, /Current Message: Hi/);
  assert.doesNotMatch(replayHtml, /OUIJA_POSITION_CONFLICT/);
  const stillHi = await request(hiHref);
  assert.equal(stillHi.status, 200);
  assert.match(await stillHi.text(), /Current Message: Hi/);
  assert.match(hiPage, /Current Message: Hi/);
});
