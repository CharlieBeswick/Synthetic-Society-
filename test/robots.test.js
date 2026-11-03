import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import robotsParser from 'robots-parser';
import { openStore } from '../src/db.js';
import { createApp } from '../src/app.js';

async function fixture(t) {
  const store = openStore(':memory:');
  const server = createApp(store, { publicSiteUrl: 'https://society.example' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { request: (url, init) => fetch(base + url, init) };
}

const allowed = [
  '/',
  '/ouija',
  '/ouija/',
  '/ouija/start',
  '/ouija/start?v=phase14-fresh-session-1',
  '/ouija/v2',
  '/ouija/v2/',
  '/ouija/v2/start',
  '/ouija/v2/start?v=v2-fresh-1',
  '/ouija/v2/c/signed-snapshot',
  '/ouija/v2/publish/signed-snapshot',
  '/ouija/v2/reply/11111111-1111-4111-8111-111111111111',
  '/ouija/reply/11111111-1111-4111-8111-111111111111',
  `/ouija/${'a'.repeat(64)}/name/1/A`,
  '/ouija/' + 'b'.repeat(64) + '/char/1/x41',
  '/ouija/' + 'c'.repeat(64) + '/review',
  '/ouija/' + 'd'.repeat(64) + '/submit',
  '/register',
  '/login',
  '/recovery',
  '/api/auth/register'
];

const blocked = [
  '/messagesubmit',
  '/messagesubmit01',
  '/messagesubmit05?token=private&revision=1',
  '/api/session',
  '/api/session/draft'
];

test('robots.txt permits the public Ouija chain and still hides private capability URLs', async t => {
  const { request } = await fixture(t);
  const response = await request('/robots.txt');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /Disallow:\s*\/ouija/i);
  const rules = robotsParser('https://society.example/robots.txt', body);
  for (const path of allowed) assert.equal(rules.isAllowed(`https://society.example${path}`), true, path);
  for (const path of blocked) assert.equal(rules.isAllowed(`https://society.example${path}`), false, path);
  for (const path of ['/ouija', '/ouija/', '/ouija/v2', '/ouija/v2/', '/register']) {
    const page = await request(path);
    assert.equal(page.status, 200, path);
    assert.equal(page.headers.get('x-robots-tag'), null, path);
    await page.text();
  }
  const board = await request('/ouija/v2/c/not-a-signature');
  assert.notEqual(board.status, 403);
  assert.match(board.headers.get('x-robots-tag') || '', /noindex/);
  await board.text();
});
