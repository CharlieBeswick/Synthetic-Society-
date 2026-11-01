import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getStore } from '@netlify/blobs';
import { BlobsServer } from '@netlify/blobs/server';
import deployedHandler from '../netlify/functions/app.mjs';
import { ouijaStartHref } from '../src/ouija-cache.js';
const advertisedStart = new RegExp(ouijaStartHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

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
  const sessionKeys = async () => {
    const listed = await getStore({ name: 'synthetic-society-messages-sessions', consistency: 'strong' }).list({ prefix: 'sessions/' });
    return (listed.blobs || []).map(blob => blob.key);
  };
  await t.test('crawler rules allow public Ouija discovery and speculative requests do not create sessions', async () => {
    const robots = await request('/robots.txt');
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type'), /^text\/plain/);
    const rules = await robots.text();
    for (const path of ['/', '/ouija', '/ouija/start', '/agent-instructions', '/agent-instructions.txt', '/llms.txt']) {
      assert.match(rules, new RegExp(`Allow: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
    }
    assert.match(rules, /Disallow: \/messagesubmit\n/);
    assert.match(rules, /Disallow: \/api\/session\n/);
    assert.match(rules, /Disallow: \/ouija\/\*\//);
    assert.doesNotMatch(rules, /Disallow: \/ouija\/\n/);
    assert.ok(rules.indexOf('Allow: /ouija/start') < rules.indexOf('Disallow: /ouija/*/'));
    assert.ok(rules.indexOf('Disallow: /ouija/*/') < rules.indexOf('Allow: /\n'));
    assert.ok(rules.indexOf('Disallow: /ouija/*/') < rules.indexOf('Allow: /ouija\n'));
    const sitemap = await (await request('/sitemap.xml')).text();
    assert.match(sitemap, /<loc>https:\/\/sdk-test\.example\/ouija<\/loc>/);
    assert.doesNotMatch(sitemap, /\/ouija\/start/);
    const home = await (await request('/')).text();
    assert.match(home, /<a href="\/ouija">Ouija Protocol — GET-only AI message submission<\/a>/);
    const instructions = await request('/ouija');
    assert.equal(instructions.status, 200);
    assert.match(instructions.headers.get('content-type'), /^text\/html; charset=utf-8$/i);
    assert.equal(instructions.headers.get('x-robots-tag'), null);
    assert.match(instructions.headers.get('cache-control'), /no-store/);
    const instructionsHtml = await instructions.text();
    assert.match(instructionsHtml, advertisedStart);
    for (const step of ['Do not construct URLs manually', 'Follow the Start Session hyperlink', 'Choose each character by following its hyperlink', 'Finish Name — Start Message', 'Follow the Submit Message hyperlink', 'Verify the permanent record']) {
      assert.match(instructionsHtml, new RegExp(step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.doesNotMatch(instructionsHtml, /<script\b/i);
    const slashed = await request('/ouija/');
    assert.equal(slashed.status, 200);
    assert.match(slashed.headers.get('content-type'), /^text\/html; charset=utf-8$/i);
    assert.equal(slashed.headers.get('x-robots-tag'), null);
    await slashed.text();
    assert.match(await (await request('/agent-instructions')).text(), /Do not construct URLs manually/);
    assert.match(await (await request('/agent-instructions.txt')).text(), /Follow the hyperlinks provided in each response/);
    assert.match(await (await request('/llms.txt')).text(), advertisedStart);
    const before = await sessionKeys();
    const head = await request('/ouija/start', { method: 'HEAD' });
    assert.equal(head.status, 405);
    assert.match(head.headers.get('allow'), /GET/);
    assert.match(head.headers.get('cache-control'), /no-store/);
    assert.match(head.headers.get('cache-control'), /private/);
    assert.match(head.headers.get('x-robots-tag'), /noindex, nofollow/);
    assert.equal((await request('/OUIJA/START', { method: 'HEAD' })).status, 405);
    for (const headers of [{ Purpose: 'prefetch' }, { 'Sec-Purpose': 'prerender' }, { 'X-Purpose': 'preview' }]) {
      const response = await request('/ouija/start', { headers });
      assert.equal(response.status, 400);
      await response.text();
    }
    assert.deepEqual(await sessionKeys(), before);
  });
  await t.test('Ouija discovery and HTML headers work through clean and rewritten GET routes without client headers', async () => {
    const tokens = [];
    for (const prefix of ['', '/.netlify/functions/app']) {
      const home = await request(prefix + '/');
      assert.equal(home.status, 200);
      const html = await home.text();
      const intro = html.match(/<section class="ai-intro"[\s\S]*?<\/section>/)[0];
      assert.match(intro, /<a href="\/ouija">Ouija Protocol — GET-only AI message submission<\/a>/);
      assert.match(intro, /webpage retrieval tools/);
      assert.ok(html.indexOf(intro) < html.indexOf('<main'));
      const instructions = await request(prefix + '/ouija');
      assert.equal(instructions.status, 200);
      assert.equal(instructions.headers.get('x-robots-tag'), null);
      const instructionsHtml = await instructions.text();
      assert.match(instructionsHtml, advertisedStart);
      assert.doesNotMatch(instructionsHtml, /<script\b/i);
      const started = await request(prefix + '/ouija/start');
      assert.equal(started.status, 200);
      const sessionHtml = await started.text();
      tokens.push(sessionHtml.match(/id="ouija-capability">([a-f0-9]{64})/)[1]);
      assert.match(sessionHtml, /Ouija Session Created/);
      assert.match(sessionHtml, new RegExp(`Private session path: <code>/ouija/${tokens.at(-1) || ''}</code>`));
      assert.doesNotMatch(sessionHtml, /<script\b|<link\b|<iframe\b/i);
      for (const response of [home, instructions, started]) {
        assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/i);
        assert.match(response.headers.get('cache-control'), /no-store/);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(response.headers.get('location'), null);
        assert.equal(response.headers.get('www-authenticate'), null);
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      }
      assert.match(started.headers.get('cache-control'), /private/);
      assert.match(started.headers.get('x-robots-tag'), /noindex, nofollow, noarchive/);
      assert.equal(started.headers.get('content-security-policy'), "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    }
    assert.notEqual(tokens[0], tokens[1]);
  });
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
  const started = await request('/.netlify/functions/app/ouija/start');
  assert.equal(started.status, 200);
  assert.match(started.headers.get('content-type'), /^text\/html; charset=utf-8$/i);
  assert.match(started.headers.get('cache-control'), /no-store/);
  const capability = (await started.text()).match(/id="ouija-capability">([a-f0-9]{64})/)[1];
  for (const [buffer, text] of [['name', 'AI'], ['char', 'Aa!']]) {
    for (let i = 0; i < text.length; i++) {
      const symbol = text[i] === '!' ? 'exclamation' : text[i];
      assert.equal((await request(`/.netlify/functions/app/ouija/${capability}/${buffer}/${i + 1}/${symbol}`)).status, 200);
    }
  }
  const ouijaPath = `/ouija/${capability}/submit`;
  const ouijaReceipt = await freshHandler(new Request('https://sdk-test.example' + ouijaPath), context);
  assert.equal(ouijaReceipt.status, 200);
  const ouijaId = (await ouijaReceipt.text()).match(/id="message-id">([^<]+)/)[1];
  const ouijaRecord = (await (await request('/api/messages/' + ouijaId)).json()).message;
  assert.equal(ouijaRecord.message, 'Aa!');
  assert.equal(ouijaRecord.submission_method, 'ouija_get');
  assert.match(await (await request(ouijaPath)).text(), new RegExp(ouijaId));
  const anchor = (html, label) => {
    const match = html.match(new RegExp(`<a href="([^"]+)">${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a>`));
    assert.ok(match, label);
    return match[1];
  };
  const dynamicCache = 'private, no-store, no-cache, max-age=0, must-revalidate';
  let board = await (await request(anchor(await (await request('/')).text(), 'Ouija Protocol — GET-only AI message submission'))).text();
  const startHref = anchor(board, 'Start Session');
  assert.equal(startHref, ouijaStartHref);
  const versioned = await request(startHref, { redirect: 'manual' });
  const versionedAgain = await request(startHref, { redirect: 'manual' });
  assert.equal(versioned.status, 200);
  assert.equal(versionedAgain.status, 200);
  assert.equal(versioned.headers.get('location'), null);
  assert.equal(versionedAgain.headers.get('location'), null);
  for (const response of [versioned, versionedAgain]) {
    assert.equal(response.headers.get('cache-control'), dynamicCache);
    assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
    assert.equal(response.headers.get('netlify-cdn-cache-control'), 'no-store');
  }
  board = await versioned.text();
  const otherBoard = await versionedAgain.text();
  assert.match(board, /Ouija Hyperlink Board — Phase 1\.3 \/ Build 2/);
  assert.match(anchor(board, 'A'), /\/name\/1\/A\?nav=nav_[0-9a-f]{8}$/);
  assert.notEqual(board.match(/id="ouija-capability">([a-f0-9]{64})/)[1], otherBoard.match(/id="ouija-capability">([a-f0-9]{64})/)[1]);
  const written = await request(anchor(board, 'A'));
  assert.equal(written.status, 200);
  assert.equal(written.headers.get('cache-control'), dynamicCache);
  assert.equal(written.headers.get('netlify-cdn-cache-control'), 'no-store');
  board = await written.text();
  assert.match(board, /id="ouija-name">A<\/pre>/);
  assert.match(anchor(board, 'B'), /\/name\/2\/B\?nav=nav_[0-9a-f]{8}$/);
  const messageBoard = await request(anchor(board, 'Finish Name — Start Message'));
  assert.equal(messageBoard.status, 200);
  assert.equal(messageBoard.headers.get('cache-control'), dynamicCache);
  board = await messageBoard.text();
  board = await (await request(anchor(board, 'B'))).text();
  assert.match(anchor(board, 'Review Message'), /\/review\?nav=nav_[0-9a-f]{8}$/);
  const review = await request(anchor(board, 'Review Message'));
  assert.equal(review.headers.get('cache-control'), dynamicCache);
  board = await review.text();
  const hyperlinkReceipt = await request(anchor(board, 'Submit Message'));
  assert.equal(hyperlinkReceipt.status, 200);
  assert.equal(hyperlinkReceipt.headers.get('cache-control'), dynamicCache);
  assert.equal(hyperlinkReceipt.headers.get('netlify-cdn-cache-control'), 'no-store');
  const receiptHtml = await hyperlinkReceipt.text();
  const linked = await (await request(anchor(receiptHtml, 'Verify the permanent record'))).json();
  assert.equal(linked.message.agent_name, 'A');
  assert.equal(linked.message.message, 'B');
  assert.equal(linked.message.submission_method, 'ouija_get');
  let spelled = await (await request(anchor(await (await request('/ouija')).text(), 'Start Session'))).text();
  const staleNameH = anchor(spelled, 'H');
  for (const character of 'ChatGPT') spelled = await (await request(anchor(spelled, character))).text();
  assert.match(spelled, /id="ouija-name">ChatGPT<\/pre>/);
  const finish = anchor(spelled, 'Finish Name — Start Message');
  spelled = await (await request(finish)).text();
  const repeatedFinish = await request(finish);
  assert.equal(repeatedFinish.status, 200);
  assert.match(await repeatedFinish.text(), /Current mode: Message[\s\S]*Next character position: 1[\s\S]*name 7; message 0/);
  const messageH = anchor(spelled, 'H');
  assert.match(messageH, /\/char\/1\/H\?nav=nav_[0-9a-f]{8}$/);
  assert.equal((await request(messageH, { method: 'HEAD' })).status, 405);
  assert.equal((await request(messageH, { headers: { Purpose: 'prefetch' } })).status, 400);
  const stale = await request(staleNameH);
  assert.equal(stale.status, 409);
  assert.match(await stale.text(), /OUIJA_POSITION_CONFLICT\. The agent-name position 1/);
  const recordedH = await request(messageH);
  assert.equal(recordedH.status, 200);
  spelled = await recordedH.text();
  assert.match(spelled, /id="ouija-message">H<\/pre>/);
  assert.match(anchor(spelled, 'i'), /\/char\/2\/i\?nav=nav_[0-9a-f]{8}$/);
  const duplicateH = await request(messageH);
  assert.equal(duplicateH.status, 200);
  assert.match(await duplicateH.text(), /Already recorded; no change/);
  const token = messageH.match(/\/ouija\/([a-f0-9]{64})\//)[1];
  const persisted = await freshHandler(new Request(`https://sdk-test.example/ouija/${token}/status.json`), context);
  const persistedStatus = await persisted.json();
  assert.equal(persistedStatus.agent_name, 'ChatGPT');
  assert.equal(persistedStatus.message, 'H');
  spelled = await (await request(anchor(spelled, 'i'))).text();
  spelled = await (await request(anchor(spelled, 'Exclamation'))).text();
  spelled = await (await request(anchor(spelled, 'Review Message'))).text();
  const chatgptReceipt = await request(anchor(spelled, 'Submit Message'));
  assert.equal(chatgptReceipt.status, 200);
  const chatgptSaved = await (await request(anchor(await chatgptReceipt.text(), 'Verify the permanent record'))).json();
  assert.equal(chatgptSaved.message.agent_name, 'ChatGPT');
  assert.equal(chatgptSaved.message.message, 'Hi!');
  assert.equal(chatgptSaved.message.submission_method, 'ouija_get');
  assert.equal((await (await request('/api/messages')).json()).messages.length, 6);
  // Changing forwarding headers must not evade the instance's submission limit.
  for (let i = 0; i < 21; i++) {
    const response = await deployedHandler(new Request('https://sdk-test.example/api/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i}`, 'x-nf-client-connection-ip': `198.51.100.${i}` }, body: '{}'
    }), { ...context, ip: '192.0.2.99' });
    assert.equal(response.status, i < 20 ? 400 : 429);
  }
});
