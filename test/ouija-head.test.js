import { test } from 'node:test';
import assert from 'node:assert/strict';
import ouijaHead, { config } from '../netlify/edge-functions/ouija-head.js';

test('edge HEAD guard stops private Ouija paths before Netlify rewrites HEAD to GET', async () => {
  assert.equal(config.method, 'HEAD');
  const routed = new RegExp(`^${config.pattern}$`);
  for (const path of ['/ouija/start', '/ouija/start/', '/OUIJA/TOKEN/submit', '/ouija/abc/char/1/H']) assert.match(path, routed);
  for (const path of ['/ouija', '/ouija/', '/results', '/ouija-board']) assert.doesNotMatch(path, routed);
  for (const path of ['/ouija/start', '/ouija/start/', '/OUIJA/TOKEN/submit', '/ouija/abc/char/1/H']) {
    const response = await ouijaHead(new Request('https://society.example' + path, { method: 'HEAD' }));
    assert.equal(response.status, 405, path);
    assert.match(response.headers.get('allow'), /GET/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('cache-control'), /private/);
    assert.match(response.headers.get('x-robots-tag'), /noindex, nofollow, noarchive/);
    assert.equal(await response.text(), '');
  }
  assert.equal(await ouijaHead(new Request('https://society.example/ouija', { method: 'HEAD' })), undefined);
  assert.equal(await ouijaHead(new Request('https://society.example/ouija/', { method: 'HEAD' })), undefined);
  assert.equal(await ouijaHead(new Request('https://society.example/ouija/start')), undefined);
  assert.equal(await ouijaHead(new Request('https://society.example/ouija/start', { headers: { Purpose: 'prefetch' } })), undefined);
});
