import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { openStore } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createNetlifyHandler } from '../src/netlify-handler.js';
import { ouijaV2SigningKey } from '../src/ouija-v2-key.js';
import { publicationId } from '../src/ouija-v2-state.js';
import { v2Characters } from '../src/ouija-v2-state.js';
process.env.OUIJA_V2_SIGNING_KEY = 'ab'.repeat(32);
const messageId = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const labels = Object.fromEntries(v2Characters.map(character => [character.value, character.label]));

async function fixture(t) {
  const store = openStore(':memory:');
  const server = createApp(store, { submissionLimit: 100, generalLimit: 1000 }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, get: (path, options) => fetch(base + path, options) };
}
const link = (html, label) => {
  const match = html.match(new RegExp(`<a href="([^"]+)">${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a>`));
  assert.ok(match, `missing hyperlink ${label}`);
  return match[1];
};
async function follow(get, href) {
  const response = await get(href);
  assert.equal(response.status, 200, href.slice(0, 80));
  return response.text();
}
async function writeText(get, html, text) {
  let page = html;
  for (const character of text) page = await follow(get, link(page, labels[character]));
  return page;
}
const field = (html, name) => {
  const match = html.match(new RegExp(`${name}: ([^\\n<]+)`));
  assert.ok(match, name);
  return match[1];
};
const compositionOf = html => field(html, 'Composition ID');

async function publish(get, review) {
  const response = await get(link(review, 'Confirm Publication'));
  assert.equal(response.status, 200);
  const html = await response.text();
  const id = html.match(/id="message-id">([^<]+)</)[1];
  assert.match(id, messageId);
  return { html, id };
}

test('homepage links reach a signed v2 composition and publish one public record', async t => {
  const { get, store } = await fixture(t);
  const home = await follow(get, '/');
  assert.equal(link(home, 'Ouija Protocol v1 — Original'), '/ouija');
  assert.equal(link(home, 'Ouija Protocol v2 — Experimental Stateless Version'), '/ouija/v2');
  const instructions = await follow(get, link(home, 'Ouija Protocol v2 — Experimental Stateless Version'));
  assert.match(instructions, /not the default|does not replace|remains available/i);
  assert.match(instructions, /cannot force a retrieval tool/);
  const started = await get(link(instructions, 'Start New Composition'));
  assert.equal(started.status, 200);
  assert.match(started.headers.get('cache-control'), /no-store/);
  assert.equal(started.headers.get('set-cookie'), null);
  let page = await started.text();
  assert.match(page, /AI Navigation Instructions/);
  assert.match(page, /Current Name: \n/);
  assert.equal(field(page, 'Message Length'), '0');
  assert.equal(field(page, 'Parent State Hash'), 'none');
  const compositionId = compositionOf(page);
  page = await writeText(get, page, 'ChatGPT');
  assert.match(page, /id="ouija-name">ChatGPT</);
  page = await follow(get, link(page, 'Finish Name — Start Message'));
  assert.match(page, /id="ouija-message"><\/pre>/);
  page = await writeText(get, page, 'Hello!');
  assert.match(page, /id="ouija-message">Hello!<\/pre>/);
  const review = await follow(get, link(page, 'Review Message'));
  assert.match(review, /Ouija Protocol v2 — Review/);
  assert.match(review, /Author: ChatGPT/);
  assert.match(review, /Hello!/);
  assert.doesNotMatch(review, /<script\b/i);
  const first = await publish(get, review);
  const second = await publish(get, review);
  assert.equal(second.id, first.id);
  assert.equal(store.recent().filter(row => row.submission_method === 'ouija_get_v2').length, 1);
  const saved = await (await get(`/api/messages/${first.id}`)).json();
  assert.equal(saved.message.agent_name, 'ChatGPT');
  assert.equal(saved.message.message, 'Hello!');
  assert.equal(saved.message.submission_method, 'ouija_get_v2');
  assert.match(await follow(get, `/results/${first.id}`), /Hello!/);
  const events = await store.audit.events(compositionId);
  const published = events.find(event => event.route === 'v2-publish' && event.result === 'recorded');
  assert.equal(published.publication_id, first.id);
  assert.equal(published.protocol_version, 2);
  assert.equal(published.name_length, 7);
  assert.equal(published.message_length, 6);
  assert.equal(JSON.stringify(events).includes('Hello!'), false);
  assert.equal(JSON.stringify(events).includes('ChatGPT'), false);
});

test('an earlier v2 hyperlink stays valid and does not change the later snapshot', async t => {
  const { get } = await fixture(t);
  let page = await follow(get, '/ouija/v2/start');
  page = await follow(get, link(page, 'A'));
  page = await follow(get, link(page, 'Finish Name — Start Message'));
  let staleHref = '';
  for (const character of 'Hel') {
    staleHref = link(page, labels[character]);
    page = await follow(get, staleHref);
  }
  const helHash = field(page, 'State Hash');
  const next = await follow(get, link(page, 'l'));
  assert.equal(field(next, 'Parent State Hash'), helHash);
  const later = await follow(get, link(await follow(get, link(next, 'o')), 'Review Message'));
  assert.match(later, /Hello/);
  const revisited = await get(staleHref);
  assert.equal(revisited.status, 200);
  const stale = await revisited.text();
  assert.match(stale, /Current Message: Hel\n/);
  assert.doesNotMatch(stale, /OUIJA_POSITION_CONFLICT|HTTP 409/);
  assert.match(stale, /shorter than expected/);
  assert.match(later, /Hello/);
});

test('two branches from one snapshot both remain readable', async t => {
  const { get, store } = await fixture(t);
  let page = await follow(get, '/ouija/v2/start');
  page = await follow(get, link(page, 'A'));
  page = await follow(get, link(page, 'Finish Name — Start Message'));
  let shared = '';
  for (const character of 'Hel') {
    shared = link(page, labels[character]);
    page = await follow(get, shared);
  }
  const hello = await follow(get, link(await writeText(get, page, 'lo'), 'Review Message'));
  const help = await follow(get, link(await writeText(get, await follow(get, shared), 'p'), 'Review Message'));
  assert.match(hello, /Hello/);
  assert.match(help, /Help/);
  const helloReceipt = await publish(get, hello);
  const helpResponse = await get(link(help, 'Confirm Publication'));
  assert.equal(helpResponse.status, 409);
  assert.match(await helpResponse.text(), /OUIJA_V2_BRANCH/);
  assert.equal(store.recent().length, 1);
  assert.match(await follow(get, shared), /Current Message: Hel\n/);
  assert.equal(helloReceipt.id.length > 0, true);
});

test('a saved page shows its own accumulated text', async t => {
  const { get } = await fixture(t);
  let page = await follow(get, '/ouija/v2/start');
  page = await follow(get, link(page, 'A'));
  page = await follow(get, link(page, 'Finish Name — Start Message'));
  page = await writeText(get, page, 'Hel');
  const saved = page;
  const later = await writeText(get, page, 'lo');
  assert.match(saved, /Current Message: Hel\n/);
  assert.match(saved, /If the returned text is shorter than expected/);
  assert.match(saved, /Composition ID: cmp_/);
  assert.doesNotMatch(saved, /Hello/);
  assert.match(later, /Hello/);
});

test('independent compositions can publish the same words as two records', async t => {
  const { get, store } = await fixture(t);
  const ids = [];
  for (let copy = 0; copy < 2; copy += 1) {
    let page = await follow(get, '/ouija/v2/start?v=v2-fresh-1');
    page = await writeText(get, page, 'AI');
    page = await follow(get, link(page, 'Finish Name — Start Message'));
    page = await writeText(get, page, 'Hi!');
    page = await follow(get, link(page, 'Review Message'));
    ids.push((await publish(get, page)).id);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal(store.recent().length, 2);
  assert.deepEqual(store.recent().map(row => row.message).sort(), ['Hi!', 'Hi!']);
});

test('concurrent confirmation of one snapshot stores one record', async t => {
  const { get, store } = await fixture(t);
  let page = await follow(get, '/ouija/v2/start');
  page = await writeText(get, page, 'A');
  page = await follow(get, link(page, 'Finish Name — Start Message'));
  page = await writeText(get, page, 'B');
  const review = await follow(get, link(page, 'Review Message'));
  const href = link(review, 'Confirm Publication');
  const responses = await Promise.all([get(href), get(href), get(href)]);
  const bodies = await Promise.all(responses.map(response => response.text()));
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
  const ids = bodies.map(body => body.match(/id="message-id">([^<]+)</)[1]);
  assert.equal(new Set(ids).size, 1);
  assert.equal(store.recent().length, 1);
});

test('a composition link with a altered payload is rejected', async t => {
  const { get } = await fixture(t);
  const page = await follow(get, '/ouija/v2/start');
  const href = link(page, 'A');
  const queryAt = href.indexOf('?');
  const path = queryAt === -1 ? href : href.slice(0, queryAt);
  const slash = path.lastIndexOf('/');
  const token = path.slice(slash + 1);
  const dot = token.indexOf('.');
  const flipped = `${token[0] === 'a' ? 'b' : 'a'}${token.slice(1, dot)}.${token.slice(dot + 1)}`;
  const response = await get(`${path.slice(0, slash + 1)}${flipped}`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /OUIJA_V2_STATE/);
  const uppercase = `${path.slice(0, slash + 1)}${token.toUpperCase()}`;
  assert.match(await follow(get, uppercase), /id="ouija-name">A<\/pre>/);
});

test('v2 publication ids are stable and production refuses to sign without a key', () => {
  const hash = 'a'.repeat(64);
  const id = publicationId('cmp_AAAAAAAAAAAAAAAAAAAAAA', hash);
  assert.equal(publicationId('cmp_AAAAAAAAAAAAAAAAAAAAAA', hash), id);
  assert.notEqual(publicationId('cmp_BBBBBBBBBBBBBBBBBBBBBB', hash), id);
  assert.match(id, messageId);
  assert.throws(() => ouijaV2SigningKey({ AWS_LAMBDA_FUNCTION_NAME: 'synthetic-society', OUIJA_V2_SIGNING_KEY: '' }), /OUIJA_V2_SIGNING_KEY/);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { once } = await import('node:events');
    const { createApp } = await import('./src/app.js');
    const { openStore } = await import('./src/db.js');
    const store = openStore(':memory:');
    const server = createApp(store, { submissionLimit: 100, generalLimit: 1000 }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/ouija/v2/start');
    const body = await response.text();
    console.log(JSON.stringify({ status: response.status, body }));
    server.close();
    store.close();
  `], { encoding: 'utf8', env: { ...process.env, AWS_LAMBDA_FUNCTION_NAME: 'synthetic-society', OUIJA_V2_SIGNING_KEY: '' } });
  assert.equal(result.status, 0, result.stderr);
  const reported = JSON.parse(result.stdout);
  assert.equal(reported.status, 503);
  assert.match(reported.body, /OUIJA_V2_SIGNING_KEY/);
});

test('the Netlify function wrapper publishes a signed v2 snapshot once', async t => {
  const store = openStore(':memory:');
  const run = createNetlifyHandler(store, { PUBLIC_SITE_URL: 'https://v2-test.example' });
  t.after(() => store.close());
  const request = async (path, options = {}) => {
    const url = new URL(path, 'https://v2-test.example');
    const headers = { host: 'v2-test.example', 'x-nf-client-connection-ip': '192.0.2.40' };
    for (const [key, value] of Object.entries(options.headers || {})) headers[key.toLowerCase()] = value;
    const response = await run({ path: url.pathname, httpMethod: options.method || 'GET', headers, body: options.body ? String(options.body) : '', isBase64Encoded: false, queryStringParameters: url.search ? Object.fromEntries(url.searchParams) : null, requestContext: {} }, {});
    const body = response.isBase64Encoded ? Buffer.from(response.body, 'base64').toString() : (response.body || '');
    return { status: response.statusCode, text: async () => body, json: async () => JSON.parse(body) };
  };
  const home = await (await request('/')).text();
  let page = await (await request(link(home, 'Ouija Protocol v2 — Experimental Stateless Version'))).text();
  page = await (await request(link(page, 'Start New Composition'))).text();
  page = await (await request(link(page, 'A'))).text();
  page = await (await request(link(page, 'Finish Name — Start Message'))).text();
  page = await (await request(link(page, 'I'))).text();
  const review = await (await request(link(page, 'Review Message'))).text();
  const href = link(review, 'Confirm Publication');
  const first = await request(href);
  const second = await request(href);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstHtml = await first.text();
  const secondHtml = await second.text();
  const id = firstHtml.match(/id="message-id">([^<]+)</)[1];
  assert.equal(secondHtml.match(/id="message-id">([^<]+)</)[1], id);
  const saved = await (await request(`/api/messages/${id}`)).json();
  assert.equal(saved.message.agent_name, 'A');
  assert.equal(saved.message.message, 'I');
  assert.equal(saved.message.submission_method, 'ouija_get_v2');
  const prefetch = await request(href, { headers: { purpose: 'prefetch' } });
  assert.equal(prefetch.status, 400);
  assert.equal((await (await request('/api/messages')).json()).messages.filter(row => row.id === id).length, 1);
});
