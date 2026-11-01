import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BlobsServer } from '@netlify/blobs/server';
import deployedHandler from '../netlify/functions/app.mjs';

test('actual modern function wrapper and official SDK persist against local Blobs server', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'society-blobs-sdk-'));
  const server = new BlobsServer({ directory, token: 'local-test-token' });
  const address = await server.start();
  const previous = process.env.NETLIFY_BLOBS_CONTEXT;
  const previousUrl = process.env.PUBLIC_SITE_URL;
  process.env.PUBLIC_SITE_URL = 'https://sdk-test.example';
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ siteID: 'local-test-site', token: 'local-test-token', edgeURL: `http://127.0.0.1:${address.port}`, uncachedEdgeURL: `http://127.0.0.1:${address.port}` })).toString('base64');
  t.after(async () => {
    if (previous === undefined) delete process.env.NETLIFY_BLOBS_CONTEXT; else process.env.NETLIFY_BLOBS_CONTEXT = previous;
    if (previousUrl === undefined) delete process.env.PUBLIC_SITE_URL; else process.env.PUBLIC_SITE_URL = previousUrl;
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const context = { ip: '192.0.2.23', requestId: 'test-request', site: { id: 'local-test-site', url: 'https://sdk-test.example' } };
  const request = (path, options) => deployedHandler(new Request('https://sdk-test.example' + path, options), context);
  const submitted = await request('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.10', 'forwarded': 'for=198.51.100.10' }, body: JSON.stringify({ agent_name: 'SDK test', message: 'Saved using official SDK' }) });
  assert.equal(submitted.status, 201);
  const receipt = await submitted.json();
  const retrieved = await request(receipt.api_url);
  assert.equal((await retrieved.json()).message.submission_method, 'api');
  assert.equal((await (await request('/api/messages')).json()).messages.length, 1);
  const form = await request('/messages', { method: 'POST', body: new URLSearchParams({ agent_name: 'SDK form', message: 'Normal form' }) });
  assert.equal(form.status, 303);
  assert.match(await (await request(form.headers.get('location'))).text(), /<strong>form<\/strong>/);
  // Simulate a newly loaded deployment entrypoint; store remains site-scoped.
  const freshHandler = (await import('../netlify/functions/app.mjs?fresh-deployment')).default;
  const afterReload = await freshHandler(new Request('https://sdk-test.example' + receipt.api_url), context);
  assert.equal((await afterReload.json()).message.message, 'Saved using official SDK');
  assert.match(await (await request('/sitemap.xml')).text(), /https:\/\/sdk-test.example\/results/);
  const sessionResponse = await request('/api/session', { method: 'POST' });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json();
  const draftRequest = revision => request('/api/session/draft', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.edit_token}` }, body: JSON.stringify({ token: session.token, revision, agent_name: 'SDK session', message: `Draft ${revision}` }) });
  assert.equal((await draftRequest(1)).status, 200);
  assert.equal((await draftRequest(2)).status, 200);
  assert.equal((await draftRequest(1)).status, 409);
  const trigger = `${session.submission_path}?token=${session.token}&revision=2`;
  // Official file-based emulator is not an atomic CAS implementation under
  // concurrency. Test SDK integration here; atomic concurrency is tested separately.
  const triggers = [];
  for (let i = 0; i < 4; i++) triggers.push(await request(trigger, { headers: { Accept: 'application/json' } }));
  for (const response of triggers) assert.equal(response.status, 200);
  const receipts = await Promise.all(triggers.map(response => response.json()));
  assert.equal(new Set(receipts.map(row => row.id)).size, 1);
  assert.equal(receipts[0].submission_method, 'session_get');
  assert.equal(receipts[0].message, 'Draft 2');
  const freshSessionResponse = await freshHandler(new Request('https://sdk-test.example' + trigger, { headers: { Accept: 'application/json' } }), context);
  assert.equal((await freshSessionResponse.json()).id, receipts[0].id);
  assert.equal((await (await request('/api/messages')).json()).messages.length, 3);
  // Changing forwarding headers must not evade the instance's submission limit.
  for (let i = 0; i < 21; i++) {
    const response = await deployedHandler(new Request('https://sdk-test.example/api/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i}`, 'x-nf-client-connection-ip': `198.51.100.${i}` }, body: '{}'
    }), { ...context, ip: '192.0.2.99' });
    assert.equal(response.status, i < 20 ? 400 : 429);
  }
});
