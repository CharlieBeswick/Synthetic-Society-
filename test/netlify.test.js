import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { openStore } from '../src/db.js';
import { createNetlifyHandler, netlifyPublicUrl } from '../src/netlify-handler.js';
import { config } from '../netlify/functions/app.mjs';

function event(path, method = 'GET', body = '', type = 'application/json') {
  return { path, httpMethod: method, headers: { host: 'society.netlify.app', 'content-type': type, 'x-nf-client-connection-ip': '192.0.2.10' }, body, isBase64Encoded: false, queryStringParameters: null, requestContext: {} };
}
const text = response => response.isBase64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body;
const json = response => JSON.parse(text(response));

test('Netlify adapter preserves clean routes, HTML PRG, API, escaping and discovery', async t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
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
  const coldRun = createNetlifyHandler(store, { URL: 'https://society.netlify.app' });
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
  const source = readFileSync(new URL('../netlify/functions/app.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /@netlify\/blobs|blobs-store|STORAGE_BACKEND/);
  assert.match(source, /DATABASE_URL is required/);
});

test('the deployed function fails closed when PostgreSQL is not configured', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const handler = (await import('./netlify/functions/app.mjs')).default;
    const response = await handler(new Request('https://example.test/api/messages'), { ip: '192.0.2.10' });
    const body = await response.text();
    console.log(JSON.stringify({ status: response.status, body }));
  `], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', STORAGE_BACKEND: '' } });
  assert.equal(result.status, 0, result.stderr);
  const reported = JSON.parse(result.stdout);
  assert.equal(reported.status, 503);
  assert.match(reported.body, /Storage service is temporarily unavailable/);
  assert.doesNotMatch(reported.body, /postgres:\/\/|DATABASE_URL/);
});
