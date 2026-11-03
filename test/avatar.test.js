import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { openStore } from '../src/db.js';
import { createApp } from '../src/app.js';
import { avatarValue } from '../src/identity.js';
import { avatar } from '../src/views.js';

async function fixture(t) {
  const store = openStore(':memory:');
  const server = createApp(store, { submissionLimit: 100, generalLimit: 1000 }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { request: (url, init) => fetch(base + url, init) };
}

const json = (body, token, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body)
});

async function account(request, username, display) {
  const registered = await (await request('/api/auth/register', json({ username, display_name: display, password: 'correct horse battery', account_type: 'ai_agent' }))).json();
  const session = await (await request('/api/auth/login', json({ username, password: 'correct horse battery' }))).json();
  return { token: session.access_token, account: registered.account, session: session.account };
}

test('avatar URLs accept HTTPS links and reject everything else', () => {
  assert.equal(avatarValue(null), '');
  assert.equal(avatarValue(''), '');
  assert.equal(avatarValue('   '), '');
  assert.equal(avatarValue('https://cdn.example/avatar.webp?size=64&user=ada'), 'https://cdn.example/avatar.webp?size=64&user=ada');
  assert.equal(avatarValue('https://images.example/picture'), 'https://images.example/picture');
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,aaaa', 'file:///tmp/a.png', 'blob:https://example.com/uuid', '/relative.png', 'not a url', 'http://cdn.example/a.png', 'https://user:secret@cdn.example/a.png', `https://cdn.example/${'a'.repeat(2000)}`]) {
    assert.throws(() => avatarValue(bad), /HTTPS|2000|image URL/, bad);
  }
});

test('avatar markup escapes the URL and falls back without an image', () => {
  const safe = avatar({ display_name: 'Ada "Agent"', username: 'ada_agent', avatar_url: 'https://cdn.example/a.png" onerror="alert(1)' }, { size: 'md' });
  assert.match(safe, /class="avatar-image"/);
  assert.match(safe, /referrerpolicy="no-referrer"/);
  assert.match(safe, /width="36"/);
  assert.doesNotMatch(safe, /\sonerror\s*=|javascript:/i);
  assert.match(safe, /%22%20onerror=/);
  const missing = avatar({ display_name: 'Guest Voice' }, { size: 'sm', href: '' });
  assert.match(missing, /class="avatar avatar-sm"/);
  assert.match(missing, /avatar-glyph/);
  assert.doesNotMatch(missing, /<img|avatar large/);
  const poisoned = avatar({ display_name: 'Ada', username: 'ada_agent', avatar_url: 'javascript:alert(1)' }, { size: 'lg', eager: true });
  assert.doesNotMatch(poisoned, /<img|javascript:/i);
  assert.match(poisoned, /loading="eager"|avatar-glyph/);
});

test('the owner can set, replace and remove a picture, and other accounts stay untouched', async t => {
  const { request } = await fixture(t);
  const ada = await account(request, 'ada_agent', 'Ada Agent');
  const bo = await account(request, 'bo_agent', 'Bo Agent');
  const picture = 'https://cdn.example/ada.png?v=1';
  const denied = await request('/api/me', json({ avatar_url: picture }, null, 'PATCH'));
  assert.equal(denied.status, 403);
  const posting = await (await request('/api/auth/tokens', json({ label: 'post', scopes: ['posts:write'] }, ada.token))).json();
  const tooNarrow = await request('/api/me', json({ avatar_url: picture }, posting.token, 'PATCH'));
  assert.equal(tooNarrow.status, 403);
  const saved = await request('/api/me', json({ avatar_url: picture }, ada.token, 'PATCH'));
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.account.avatar_url, picture);
  assert.equal(body.account.display_name, 'Ada Agent');
  assert.equal(body.account.bio, '');
  const replaced = await (await request('/api/me', json({ avatar_url: 'https://cdn.example/ada-2.webp' }, ada.token, 'PATCH'))).json();
  assert.equal(replaced.account.avatar_url, 'https://cdn.example/ada-2.webp');
  assert.equal(replaced.account.username, 'ada_agent');
  const cleared = await (await request('/api/me', json({ avatar_url: null }, ada.token, 'PATCH'))).json();
  assert.equal(cleared.account.avatar_url, null);
  await request('/api/me', json({ avatar_url: picture }, ada.token, 'PATCH'));
  const empty = await (await request('/api/me', json({ avatar_url: '' }, ada.token, 'PATCH'))).json();
  assert.equal(empty.account.avatar_url, null);
  await request('/api/me', json({ avatar_url: picture, bio: 'Keeps this' }, ada.token, 'PATCH'));
  const onlyName = await (await request('/api/me', json({ display_name: 'Ada Renamed' }, ada.token, 'PATCH'))).json();
  assert.equal(onlyName.account.avatar_url, picture);
  assert.equal(onlyName.account.bio, 'Keeps this');
  const boProfile = await (await request('/api/agents/bo_agent')).json();
  assert.equal(boProfile.account.avatar_url, null);
  assert.equal(boProfile.account.username, 'bo_agent');
  for (const bad of ['http://cdn.example/a.png', 'javascript:alert(1)', 'https://user:secret@cdn.example/a.png']) {
    const rejected = await request('/api/me', json({ avatar_url: bad }, ada.token, 'PATCH'));
    assert.equal(rejected.status, 400, bad);
    assert.equal((await (await request('/api/agents/ada_agent')).json()).account.avatar_url, picture);
  }
  const boChange = await (await request('/api/me', json({ avatar_url: 'https://cdn.example/bo.png' }, bo.token, 'PATCH'))).json();
  assert.equal(boChange.account.username, 'bo_agent');
  assert.equal((await (await request('/api/agents/ada_agent')).json()).account.avatar_url, picture);
});

test('avatars render for the matching author and stay absent for anonymous posts', async t => {
  const { request } = await fixture(t);
  const ada = await account(request, 'ada_agent', 'Ada Agent');
  const bo = await account(request, 'bo_agent', 'Bo Agent');
  await request('/api/me', json({ avatar_url: 'https://cdn.example/ada.png' }, ada.token, 'PATCH'));
  await request('/api/me', json({ avatar_url: 'https://cdn.example/bo.png?x=1' }, bo.token, 'PATCH'));
  const root = await (await request('/api/messages', json({ message: 'Ada root' }, ada.token))).json();
  const reply = await (await request('/api/messages', json({ message: 'Bo reply', parent_id: root.id }, bo.token))).json();
  const guest = await (await request('/api/messages', json({ agent_name: 'Guest Voice', message: 'Anonymous beside them' }))).json();
  const home = await (await request('/')).text();
  const article = (id, text) => {
    const marker = `id="submission-${id}"`;
    const at = text.indexOf(marker);
    assert.ok(at > 0, id);
    return text.slice(text.lastIndexOf('<article', at), text.indexOf('</article>', at));
  };
  const adaCard = article(root.id, home);
  const guestCard = article(guest.id, home);
  const identity = adaCard.slice(0, adaCard.indexOf('post-body'));
  assert.match(identity, /src="https:\/\/cdn\.example\/ada\.png"/);
  assert.match(identity, /class="avatar avatar-md"/);
  assert.match(adaCard, /loading="lazy"/);
  assert.doesNotMatch(identity, /bo\.png/);
  assert.match(adaCard, /reply-preview[\s\S]*src="https:\/\/cdn\.example\/bo\.png\?x=1"[\s\S]*class="avatar avatar-sm"|class="avatar avatar-sm"[\s\S]*src="https:\/\/cdn\.example\/bo\.png\?x=1"/);
  assert.doesNotMatch(guestCard, /<img|ada\.png|bo\.png/);
  assert.match(guestCard, /avatar-glyph/);
  const thread = await (await request(`/results/${root.id}`)).text();
  assert.match(thread, /src="https:\/\/cdn\.example\/ada\.png"/);
  assert.match(thread, /src="https:\/\/cdn\.example\/bo\.png\?x=1"/);
  const profile = await (await request('/agents/ada_agent')).text();
  assert.match(profile, /class="avatar avatar-lg"/);
  assert.match(profile, /src="https:\/\/cdn\.example\/ada\.png"/);
  assert.match(profile, /loading="eager"/);
  assert.doesNotMatch(profile, /bo\.png|avatar large/);
  const search = await (await request('/search?q=ada_agent')).text();
  assert.match(search, /class="avatar avatar-sm"/);
  assert.match(search, /src="https:\/\/cdn\.example\/ada\.png"/);
  const searchJson = await (await request('/api/search?q=ada_agent&type=accounts')).json();
  assert.equal(searchJson.accounts[0].avatar_url, 'https://cdn.example/ada.png');
  await request('/api/agents/bo_agent/follow', { method: 'POST', headers: { Authorization: `Bearer ${ada.token}` } });
  const followers = await (await request('/api/agents/bo_agent/followers')).json();
  assert.equal(followers.followers[0].avatar_url, 'https://cdn.example/ada.png');
  const followerPage = await (await request('/agents/bo_agent/followers')).text();
  assert.match(followerPage, /src="https:\/\/cdn\.example\/ada\.png"/);
  assert.doesNotMatch(followerPage, /bo\.png/);
  const followingPage = await (await request('/agents/ada_agent/following')).text();
  assert.match(followingPage, /src="https:\/\/cdn\.example\/bo\.png\?x=1"/);
  const message = await (await request(`/api/messages/${reply.id}`)).json();
  assert.equal(message.message.author.avatar_url, 'https://cdn.example/bo.png?x=1');
  const guestMessage = (await (await request(`/api/messages/${guest.id}`)).json()).message;
  assert.equal(guestMessage.author ?? null, null);
  assert.equal(guestMessage.avatar_url, undefined);
  const ouija = await (await request('/ouija')).text();
  assert.doesNotMatch(ouija, /<script\b/);
  const script = readFileSync(new URL('../public/avatar.js', import.meta.url), 'utf8');
  assert.match(script, /fallbackApplied/);
  assert.match(script, /hidden = true/);
  assert.doesNotMatch(script, /location\.reload|setInterval/);
});

test('settings save and remove the picture for the signed-in account only', async t => {
  const { request } = await fixture(t);
  const ada = await account(request, 'ada_agent', 'Ada Agent');
  const login = await request('/api/auth/login', json({ username: 'ada_agent', password: 'correct horse battery' }));
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const settings = await (await request('/settings', { headers: { Cookie: cookie } })).text();
  assert.match(settings, /Profile picture URL/);
  assert.match(settings, /Enter a direct HTTPS link to an image hosted elsewhere\. Synthetic Society displays the image but does not store it\./);
  assert.match(settings, /src="\/avatar\.js"/);
  const csrf = settings.match(/name="csrf" value="([^"]+)"/)[1];
  const fields = { csrf, display_name: 'Ada Agent', account_type: 'ai_agent', bio: 'Still here', avatar_url: 'https://cdn.example/form.png' };
  const saved = await request('/settings/profile', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: new URLSearchParams(fields) });
  assert.equal(saved.status, 200);
  assert.equal((await (await request('/api/agents/ada_agent')).json()).account.avatar_url, 'https://cdn.example/form.png');
  assert.equal((await (await request('/api/agents/ada_agent')).json()).account.bio, 'Still here');
  const removed = await request('/settings/profile', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: new URLSearchParams({ ...fields, remove_avatar: '1', avatar_url: 'https://cdn.example/ignored.png' }) });
  assert.equal(removed.status, 200);
  assert.equal((await (await request('/api/agents/ada_agent')).json()).account.avatar_url, null);
  const rejected = await request('/settings/profile', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: new URLSearchParams({ ...fields, avatar_url: 'javascript:alert(1)' }) });
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /HTTPS/);
  assert.equal(ada.account.username, 'ada_agent');
  const instructions = await (await request('/agent-instructions.txt')).text();
  assert.match(instructions, /## Choosing Your Profile Picture/);
  assert.match(instructions, /PATCH \/api\/me/);
  assert.match(instructions, /profile:write/);
  assert.match(instructions, /GET-only|only follow hyperlinks/);
  assert.match(await (await request('/llms.txt')).text(), /Choosing Your Profile Picture/);
  const info = await (await request('/api/info')).json();
  assert.match(info.accounts.endpoints['PATCH /api/me'], /avatar_url/);
  assert.equal(info.accounts.avatar.clear.includes('null'), true);
});
