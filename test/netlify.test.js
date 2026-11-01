import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBlobsStore } from '../src/blobs-store.js';
import { createNetlifyHandler, netlifyPublicUrl } from '../src/netlify-handler.js';
import { config } from '../netlify/functions/app.mjs';

function mockBlobs() {
  const records = new Map();
  const calls = { pages: 0, reads: 0 };
  return {
    records, calls,
    async setJSON(key, value, options) {
      assert.equal(options.onlyIfNew, true);
      if (records.has(key)) return { modified: false };
      records.set(key, structuredClone(value));
      return { modified: true };
    },
    async get(key, options) {
      assert.deepEqual(options, { type: 'json', consistency: 'strong' });
      calls.reads++;
      return structuredClone(records.get(key) || null);
    },
    async *list(options) {
      assert.deepEqual(options, { prefix: 'messages/', paginate: true });
      // Deliberately unordered and multiple pages, including an empty page.
      const keys = [...records.keys()].filter(key => key.startsWith(options.prefix)).reverse();
      yield { blobs: [] }; calls.pages++;
      for (let i = 0; i < keys.length; i += 17) {
        calls.pages++;
        yield { blobs: keys.slice(i, i + 17).map(key => ({ key })) };
      }
    }
  };
}

function event(path, method = 'GET', body = '', type = 'application/json') {
  return { path, httpMethod: method, headers: { host: 'society.netlify.app', 'content-type': type, 'x-nf-client-connection-ip': '192.0.2.10' }, body, isBase64Encoded: false, queryStringParameters: null, requestContext: {} };
}
const text = response => response.isBase64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body;
const json = response => JSON.parse(text(response));

test('Blobs saves unique concurrent records, scans all pages and returns latest 100', async () => {
  const blobs = mockBlobs();
  let time = 1800000000000;
  const store = createBlobsStore(blobs, { now: () => time++ });
  const rows = await Promise.all(Array.from({ length: 135 }, (_, i) => store.add('Agent', `Message ${i}`, i % 2 ? 'form' : 'api')));
  assert.equal(blobs.records.size, 135);
  assert.equal(new Set(rows.map(row => row.id)).size, 135);
  const recent = await store.recent();
  assert.deepEqual(recent, rows.slice(-100).reverse());
  assert.ok(blobs.calls.pages > 2);
  assert.equal(blobs.calls.reads, 100);
  assert.deepEqual(await store.get(rows[0].id), rows[0]);
  assert.equal(await store.get('unknown'), null);
  assert.equal(await store.get('1800000000000-00000000-0000-4000-8000-000000000000'), null);
  assert.deepEqual(await createBlobsStore(blobs).get(rows[0].id), rows[0], 'new adapter instance reads persisted record');
});

test('Blobs handles empty stores, same-time ordering, missing blobs and storage errors', async () => {
  const blobs = mockBlobs();
  const store = createBlobsStore(blobs, { now: () => 1800000000000 });
  assert.deepEqual(await store.recent(), []);
  const rows = await Promise.all([store.add('a', 'one', 'api'), store.add('a', 'two', 'form')]);
  assert.deepEqual((await store.recent()).map(row => row.id), rows.map(row => row.id).sort().reverse());
  blobs.get = async () => null;
  assert.deepEqual(await store.recent(), []);
  await assert.rejects(store.add('a', 'bad', 'unknown'), /Submission method/);
  blobs.setJSON = async () => ({ modified: false });
  await assert.rejects(store.add('a', 'collision', 'api'), /collision/);
  blobs.setJSON = async () => { throw new Error('write failed'); };
  await assert.rejects(store.add('a', 'failure', 'api'), /write failed/);
  blobs.list = async function* () { throw new Error('listing failed'); };
  await assert.rejects(store.recent(), /listing failed/);
});

test('Netlify adapter preserves clean routes, HTML PRG, API, escaping and discovery', async () => {
  const blobs = mockBlobs();
  const store = createBlobsStore(blobs);
  const run = createNetlifyHandler(store, { URL: 'https://society.netlify.app' });
  for (const path of ['/', '/results', '/agent-instructions', '/agent-instructions.txt', '/robots.txt', '/llms.txt', '/sitemap.xml', '/api/info', '/api/messages']) {
    assert.equal((await run(event(path), {})).statusCode, 200, path);
  }
  assert.match(text(await run(event('/'), {})), /rel="canonical" href="https:\/\/society.netlify.app\/"/);
  assert.match(text(await run(event('/sitemap.xml'), {})), /<loc>https:\/\/society.netlify.app\/results<\/loc>/);
  assert.match(text(await run(event('/agent-instructions.txt'), {})), /per-instance/);
  const api = await run(event('/api/messages', 'POST', JSON.stringify({ agent_name: 'API test', message: '<script>alert(1)</script>', submission_method: 'form' })), {});
  assert.equal(api.statusCode, 201);
  const receipt = json(api);
  assert.equal(receipt.submission_method, 'api');
  assert.equal(json(await run(event(receipt.api_url), {})).message.message, '<script>alert(1)</script>');
  const form = await run(event('/messages', 'POST', 'agent_name=Form+test&message=Hello&submission_method=api', 'application/x-www-form-urlencoded'), {});
  assert.equal(form.statusCode, 303);
  assert.match(form.headers.location, /^\/results\//);
  const html = text(await run(event(form.headers.location), {}));
  assert.match(html, /Submission recorded/);
  assert.match(html, /<strong>form<\/strong>/);
  const results = text(await run(event('/results'), {}));
  assert.match(results, /&lt;script&gt;/);
  assert.doesNotMatch(results, /<script>/);
  const coldRun = createNetlifyHandler(createBlobsStore(blobs), { URL: 'https://society.netlify.app' });
  assert.equal(json(await coldRun(event(receipt.api_url), {})).message.submission_method, 'api');
  assert.equal((await run(event('/.netlify/functions/app/api/info'), {})).statusCode, 200);
  assert.equal((await run(event('/api/messages', 'POST', '{}'), {})).statusCode, 400);
  assert.equal((await run(event('/api/messages', 'POST', '{'), {})).statusCode, 400);
  assert.equal((await run(event('/api/messages', 'POST', JSON.stringify({ message: 'x'.repeat(17000) })), {})).statusCode, 413);
  assert.equal((await run(event('/api/messages/missing'), {})).statusCode, 404);
});

test('async storage failures produce safe API and form errors', async () => {
  const fail = async () => { throw new Error('private storage detail'); };
  const run = createNetlifyHandler({ add: fail, get: fail, recent: fail }, {});
  for (const input of [event('/api/messages'), event('/api/messages/test'), event('/results'), event('/api/messages', 'POST', '{"agent_name":"a","message":"b"}'), event('/messages', 'POST', 'agent_name=a&message=b', 'application/x-www-form-urlencoded')]) {
    const response = await run(input, {});
    assert.equal(response.statusCode, 500);
    assert.doesNotMatch(text(response), /private storage detail/);
  }
});

test('Netlify URL precedence and deploy configuration preserve routing and edge limits', () => {
  assert.equal(netlifyPublicUrl({ PUBLIC_SITE_URL: 'https://custom.example', URL: 'https://fallback.netlify.app' }), 'https://custom.example');
  assert.equal(netlifyPublicUrl({ PUBLIC_SITE_URL: ' ', URL: 'https://fallback.netlify.app' }), 'https://fallback.netlify.app');
  assert.equal(netlifyPublicUrl({}), '');
  assert.deepEqual(config.rateLimit, { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] });
  const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.match(toml, /publish = "public"/);
  assert.match(toml, /from = "\/\*"/);
  assert.match(toml, /to = "\/\.netlify\/functions\/app\/:splat"/);
  assert.match(toml, /force = false/);
});
