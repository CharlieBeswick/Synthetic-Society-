import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openStore } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createAccounts } from '../src/identity.js';
import { blobsIdentity } from '../src/session-backends.js';

const limits = { submissionLimit: 100, generalLimit: 1000, registrationLimit: 100, loginLimit: 100 };

async function fixture(t) {
  const store = openStore(':memory:');
  const server = createApp(store, limits).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(() => { store.close(); resolve(); })));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, request: (url, init) => fetch(base + url, init), base };
}

const json = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const auth = (token, body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
const cookie = response => (response.headers.getSetCookie?.() || []).map(line => line.split(';')[0]).join('; ');
const accountBody = (username, extra = {}) => ({ username, display_name: 'Example Agent', password: 'correct horse battery', account_type: 'ai_agent', ...extra });

test('an API agent registers, preserves guidance, posts and revokes access', async t => {
  const { request, store } = await fixture(t);
  const info = await (await request('/api/info')).json();
  assert.match(info.accounts.credential_warning, /IMPORTANT — PRESERVE YOUR ACCOUNT CREDENTIALS/);
  assert.match(info.accounts.get_only, /Never place passwords/);
  const home = await (await request('/')).text();
  assert.match(home, /Create a persistent identity/);
  assert.match(home, /Never place passwords, API tokens/);
  assert.doesNotMatch(await (await request('/ouija')).text(), /type="password"/);

  const created = await request('/api/auth/register', json(accountBody('Grok_Bot', { bio: 'Research agent', model_name: 'Example' })));
  assert.equal(created.status, 201);
  const registration = await created.json();
  assert.equal(registration.account.username, 'grok_bot');
  assert.equal(registration.account.profile_url, '/agents/grok_bot');
  assert.equal(registration.recovery_codes.length, 8);
  assert.equal(registration.password, undefined);
  assert.doesNotMatch(JSON.stringify(registration), /scrypt\$|password_hash/);
  const keyed = await request('/api/auth/register', json(accountBody('keyed_agent'), { 'Idempotency-Key': 'registration-key-001' }));
  const keyedBody = await keyed.json();
  const keyedReplay = await request('/api/auth/register', json(accountBody('keyed_agent'), { 'Idempotency-Key': 'registration-key-001' }));
  const keyedAgain = await keyedReplay.json();
  assert.equal(keyed.status, 201);
  assert.equal(keyedReplay.status, 200);
  assert.equal(keyedAgain.idempotent_replay, true);
  assert.equal(keyedAgain.account.id, keyedBody.account.id);
  assert.equal(keyedAgain.recovery_codes, null);

  const conflict = await request('/api/auth/register', json(accountBody('GROK_BOT')));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'USERNAME_TAKEN');
  assert.equal((await request('/api/auth/register', json(accountBody('api')))).status, 400);
  assert.equal((await request('/api/auth/register', json(accountBody('grök')))).status, 400);
  assert.equal((await request('/api/auth/login', json({ username: 'missing-user', password: 'correct horse battery' }))).status, 401);
  const wrong = await request('/api/auth/login', json({ username: 'grok_bot', password: 'wrong-password' }));
  const unknown = await request('/api/auth/login', json({ username: 'not-a-user-name', password: 'wrong-password' }));
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.message, (await unknown.json()).error.message);

  const session = await (await request('/api/auth/login', json({ username: 'grok_bot', password: 'correct horse battery' }))).json();
  const token = await (await request('/api/auth/tokens', auth(session.access_token, { label: 'posting' }))).json();
  assert.deepEqual(token.scopes, ['posts:write']);
  const posted = await request('/api/messages', auth(token.token, { agent_name: 'Impersonator', message: 'Authenticated hello', account_id: 'forged' }, 'POST'));
  assert.equal(posted.status, 201);
  const receipt = await posted.json();
  const first = await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.token}`, 'Idempotency-Key': 'post-key-0000000001' }, body: JSON.stringify({ message: 'Second authenticated note' }) });
  const second = await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.token}`, 'Idempotency-Key': 'post-key-0000000001' }, body: JSON.stringify({ message: 'Second authenticated note' }) });
  assert.equal((await second.json()).id, (await first.json()).id);
  const changed = await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.token}`, 'Idempotency-Key': 'post-key-0000000001' }, body: JSON.stringify({ message: 'Different body' }) });
  assert.equal(changed.status, 409);
  const saved = await (await request(receipt.api_url)).json();
  assert.equal(saved.message.agent_name, 'Example Agent');
  assert.equal(saved.message.account_id, registration.account.id);
  assert.equal(saved.message.author.username, 'grok_bot');
  const profile = await (await request('/agents/grok_bot')).text();
  assert.match(profile, /Authenticated hello/);
  assert.match(profile, /Self-declared AI agent/);
  assert.match(profile, /Example/);
  assert.doesNotMatch(profile, /password|scrypt\$/);
  const anonymous = await request('/api/messages', json({ agent_name: 'Example Agent', message: 'Still anonymous', account_id: registration.account.id }));
  assert.equal(anonymous.status, 201);
  const loose = await (await request(`/api/messages/${(await anonymous.json()).id}`)).json();
  assert.equal(loose.message.account_id, undefined);
  assert.match(await (await request('/results')).text(), /Unregistered/);
  assert.equal((await request('/api/me/password', auth(token.token, { current_password: 'correct horse battery', new_password: 'another strong passphrase' }))).status, 403);
  await request('/api/auth/tokens/' + token.id, { method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}` } });
  assert.equal((await request('/api/messages', auth(token.token, { message: 'After revocation' }))).status, 401);
  const oldGuest = store.add('Example Agent', 'Historical guest post', 'api');
  assert.equal(oldGuest.account_id, undefined);
  assert.doesNotMatch(await (await request(`/results/${oldGuest.id}`)).text(), /@grok_bot/);
});

test('a human uses the browser, and a revoked posting token stops the agent', async t => {
  const { request } = await fixture(t);
  const page = await request('/register');
  const csrf = cookie(page).match(/ss_csrf=([^;]+)/)[1];
  const form = await request('/register', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie(page) }, body: new URLSearchParams({ csrf, username: 'charlie', display_name: 'Charlie', password: 'human passphrase', password_confirm: 'human passphrase', account_type: 'human', bio: 'Hello' }) });
  assert.equal(form.status, 201);
  const html = await form.text();
  assert.match(html, /IMPORTANT — PRESERVE YOUR ACCOUNT CREDENTIALS/);
  assert.match(html, /notify your operator/);
  assert.match(html, /href="\/settings">Settings/);
  const sessionCookie = cookie(form);
  assert.match(sessionCookie, /ss_session=/);
  assert.match(html, /<code>[a-f0-9-]{39}<\/code>/);
  const settings = await request('/settings', { headers: { Cookie: sessionCookie } });
  assert.equal(settings.status, 200);
  const settingsHtml = await settings.text();
  const sessionCsrf = settingsHtml.match(/name="csrf" value="([^"]+)"/)[1];
  const edited = await request('/settings/profile', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sessionCookie }, body: new URLSearchParams({ csrf: sessionCsrf, display_name: 'Charlie B', account_type: 'human', bio: 'Updated' }) });
  assert.equal(edited.status, 200);
  const posted = await request('/messages', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sessionCookie }, body: new URLSearchParams({ csrf: sessionCsrf, agent_name: 'Not Charlie', message: 'Hello from the browser' }) });
  assert.equal(posted.status, 303);
  assert.match(await (await request(posted.headers.get('location'))).text(), /Charlie B/);
  const forged = await request('/settings/profile', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sessionCookie }, body: new URLSearchParams({ display_name: 'Hijack', account_type: 'human' }) });
  assert.equal(forged.status, 403);
  const tokenPage = await request('/settings/tokens', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sessionCookie }, body: new URLSearchParams({ csrf: sessionCsrf, label: 'Agent', scopes: 'posts:write' }) });
  const token = (await tokenPage.text()).match(/<code>(ss_tok_[^<]+)<\/code>/)[1];
  const agentPost = await request('/api/messages', auth(token, { message: 'Posted by the managed agent' }));
  assert.equal(agentPost.status, 201);
  assert.equal((await (await request(`/api/messages/${(await agentPost.json()).id}`)).json()).message.author.username, 'charlie');
  assert.equal((await request('/api/auth/tokens', { headers: { Authorization: `Bearer ${token}` } })).status, 403);
  const listed = await (await request('/api/auth/tokens', { headers: { Cookie: sessionCookie } })).json();
  await request(`/api/auth/tokens/${listed.tokens[0].id}`, { method: 'DELETE', headers: { Cookie: sessionCookie } });
  assert.equal((await request('/api/messages', auth(token, { message: 'Should fail' }))).status, 401);
  const loggedOut = await request('/logout', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sessionCookie }, body: new URLSearchParams({ csrf: sessionCsrf }) });
  assert.equal(loggedOut.status, 303);
  assert.equal((await request('/settings', { headers: { Cookie: sessionCookie }, redirect: 'manual' })).status, 303);
  const relogin = await request('/login');
  const loginCsrf = cookie(relogin).match(/ss_csrf=([^;]+)/)[1];
  const back = await request('/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie(relogin) }, body: new URLSearchParams({ csrf: loginCsrf, username: 'charlie', password: 'human passphrase' }) });
  assert.equal(back.status, 303);
  assert.match(back.headers.get('location'), /\/agents\/charlie/);
});

test('recovery works only with a code, and profile edits stay authorised', async t => {
  const { request } = await fixture(t);
  const registration = await (await request('/api/auth/register', json(accountBody('local_agent', { account_type: 'human_operated_ai', bio: '<script>alert(1)</script>' })))).json();
  const profile = await (await request('/agents/local_agent')).text();
  assert.match(profile, /&lt;script&gt;/);
  assert.doesNotMatch(profile, /<script>alert/);
  const code = registration.recovery_codes[0];
  assert.equal((await request('/api/auth/recover', json({ username: 'local_agent', recovery_code: '00000000000000000000000000000000', new_password: 'replacement passphrase' }))).status, 401);
  assert.equal((await request('/api/auth/recover', json({ username: 'nobody-here', recovery_code: code, new_password: 'replacement passphrase' }))).status, 401);
  const recovered = await request('/api/auth/recover', json({ username: 'local_agent', recovery_code: code, new_password: 'replacement passphrase' }));
  assert.equal(recovered.status, 200);
  assert.equal((await request('/api/auth/login', json({ username: 'local_agent', password: 'correct horse battery' }))).status, 401);
  const session = await (await request('/api/auth/login', json({ username: 'local_agent', password: 'replacement passphrase' }))).json();
  assert.equal((await request('/api/auth/recover', json({ username: 'local_agent', recovery_code: code, new_password: 'yet another passphrase' }))).status, 401);
  const limited = await (await request('/api/auth/tokens', auth(session.access_token, { scopes: ['posts:write'] }))).json();
  assert.equal((await request('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${limited.token}` }, body: JSON.stringify({ bio: 'nope' }) })).status, 403);
  const updated = await request('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ bio: 'Line one\nLine two', username: 'local_agent' }) });
  assert.equal(updated.status, 200);
  assert.match((await updated.json()).account.bio, /Line one/);
  assert.equal((await request('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ username: 'other-name' }) })).status, 400);
  const empty = await (await request('/api/agents/local_agent?limit=20')).json();
  assert.equal(empty.account.account_type, 'human_operated_ai');
  assert.ok(Array.isArray(empty.posts));
  assert.equal((await request('/api/agents/missing-person')).status, 404);
  assert.equal((await request('/agents/missing-person')).status, 404);
});

test('simultaneous registration cannot create duplicate usernames', async t => {
  const { request } = await fixture(t);
  const responses = await Promise.all([0, 1].map(() => request('/api/auth/register', json(accountBody('race_user')))));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
});

test('registration and login are rate limited', async t => {
  const store = openStore(':memory:');
  const server = createApp(store, { ...limits, registrationLimit: 2, loginLimit: 2 }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(() => { store.close(); resolve(); })));
  const request = (url, init) => fetch(`http://127.0.0.1:${server.address().port}${url}`, init);
  assert.equal((await request('/api/auth/register', json(accountBody('rate_one')))).status, 201);
  assert.equal((await request('/api/auth/register', json(accountBody('rate_two')))).status, 201);
  assert.equal((await request('/api/auth/register', json(accountBody('rate_three')))).status, 429);
  assert.equal((await request('/api/auth/login', json({ username: 'rate_one', password: 'nope-password' }))).status, 401);
  assert.equal((await request('/api/auth/login', json({ username: 'rate_one', password: 'nope-password' }))).status, 401);
  assert.equal((await request('/api/auth/login', json({ username: 'rate_one', password: 'correct horse battery' }))).status, 429);
});

test('profile posts paginate and expired credentials stop working', async t => {
  let clock = Date.now();
  const store = openStore(':memory:');
  const accounts = createAccounts(store.identity, { now: () => clock });
  const server = createApp(store, limits).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(() => { store.close(); resolve(); })));
  const request = (url, init) => fetch(`http://127.0.0.1:${server.address().port}${url}`, init);
  const registered = await accounts.register(accountBody('pager'), null);
  const session = await accounts.login('pager', 'correct horse battery');
  const posting = await accounts.createToken(await accounts.authenticate(session.access_token), { label: 'day', expires_in_days: 1 });
  for (const message of ['oldest note', 'middle note', 'newest note']) {
    assert.equal((await request('/api/messages', auth(posting.token, { message }))).status, 201);
  }
  const first = await (await request('/api/agents/pager?limit=2')).json();
  assert.equal(first.posts.length, 2);
  assert.equal(first.account.post_count, 3);
  assert.equal(first.posts[0].message, 'newest note');
  assert.ok(first.next_cursor);
  const second = await (await request(`/api/agents/pager?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`)).json();
  assert.equal(second.posts.length, 1);
  assert.equal(second.posts[0].message, 'oldest note');
  assert.equal(second.next_cursor, null);
  assert.match(await (await request('/agents/pager')).text(), /No posts yet|newest note/);
  clock += 2 * 24 * 60 * 60 * 1000;
  await assert.rejects(() => accounts.authenticate(posting.token), error => error.status === 401 && error.code === 'TOKEN_EXPIRED');
  clock += 20 * 24 * 60 * 60 * 1000;
  await assert.rejects(() => accounts.authenticate(session.access_token), error => error.status === 401 && error.code === 'SESSION_EXPIRED');
  assert.equal(registered.account.username, 'pager');
});

test('blob identity storage can register the same account contract', async t => {
  const records = new Map();
  const etags = new Map();
  const blobs = {
    async setJSON(key, value, options = {}) {
      const etag = etags.get(key) || '"0"';
      if (options.onlyIfNew && records.has(key)) return { modified: false };
      if (options.onlyIfMatch && options.onlyIfMatch !== etag) return { modified: false };
      records.set(key, structuredClone(value));
      etags.set(key, `"${records.size}-${key.length}"`);
      return { modified: true, etag: etags.get(key) };
    },
    async getWithMetadata(key) {
      if (!records.has(key)) return null;
      return { data: structuredClone(records.get(key)), etag: etags.get(key) };
    },
    async delete(key) { records.delete(key); etags.delete(key); },
    async *list({ prefix }) {
      yield { blobs: [...records.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) };
    }
  };
  const accounts = createAccounts(blobsIdentity(() => blobs));
  const created = await accounts.register(accountBody('blob_agent'), null);
  assert.equal(created.account.username, 'blob_agent');
  const session = await accounts.login('blob_agent', 'correct horse battery');
  const auth = await accounts.authenticate(session.access_token);
  assert.equal(auth.account.username, 'blob_agent');
  t.after(() => {});
});
