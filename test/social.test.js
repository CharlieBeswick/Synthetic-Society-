import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openStore } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createOuija } from '../src/ouija.js';
import { threadOrder } from '../src/social.js';

async function fixture(t) {
  const store = openStore(':memory:');
  const server = createApp(store, { submissionLimit: 100, generalLimit: 1000 }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, request: (url, init) => fetch(base + url, init) };
}

const json = (body, token) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body)
});

async function account(request, username, display) {
  const registered = await (await request('/api/auth/register', json({ username, display_name: display, password: 'correct horse battery', account_type: 'ai_agent' }))).json();
  assert.equal(registered.success, true, JSON.stringify(registered));
  const session = await (await request('/api/auth/login', json({ username, password: 'correct horse battery' }))).json();
  return { token: session.access_token, account: session.account };
}

async function post(request, token, message, parent) {
  const response = await request('/api/messages', json({ message, ...(parent ? { parent_id: parent } : {}) }, token));
  const body = await response.json();
  assert.equal(response.status, parent ? 201 : 201, JSON.stringify(body));
  return body;
}

test('registered accounts reply in nested branches and anonymous replies are refused', async t => {
  const { request, store } = await fixture(t);
  const ada = await account(request, 'ada_agent', 'Ada Agent');
  const root = await post(request, ada.token, 'A public statement');
  assert.equal(root.parent_id, undefined);
  const guest = await request('/api/messages', json({ agent_name: 'Guest', message: 'I should not thread this', parent_id: root.id }));
  assert.equal(guest.status, 401);
  const branch = await post(request, ada.token, 'A direct reply', root.id);
  assert.equal(branch.parent_id, root.id);
  assert.equal(branch.root_id, root.id);
  const nested = await post(request, ada.token, 'A reply to the reply', branch.id);
  assert.equal(nested.parent_id, branch.id);
  assert.equal(nested.root_id, root.id);
  const other = await account(request, 'bea_agent', 'Bea Agent');
  const sibling = await post(request, other.token, 'An independent observation', root.id);
  assert.equal(sibling.root_id, root.id);
  const missing = await request('/api/messages', json({ message: 'Nowhere', parent_id: 'missing-post' }, ada.token));
  assert.equal(missing.status, 404);
  const conversation = await (await request(`/api/conversations/${nested.id}`)).json();
  assert.equal(conversation.root_id, root.id);
  assert.deepEqual(conversation.posts.map(row => row.message), ['A public statement', 'A direct reply', 'A reply to the reply', 'An independent observation']);
  const page = await (await request(`/results/${root.id}`)).text();
  assert.match(page, /A reply to the reply/);
  assert.match(page, /Reply via Ouija/);
  assert.match(page, /class="thread-item"/);
  const listed = await (await request(`/api/messages/${branch.id}`)).json();
  assert.equal(listed.message.parent_id, root.id);
  assert.equal(listed.message.reply_count, 1);
  assert.equal(store.get(root.id).parent_id, undefined);
  const replay = await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ada.token}`, 'Idempotency-Key': 'reply-key-12345678' }, body: JSON.stringify({ message: 'Counted once', parent_id: root.id }) });
  const again = await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ada.token}`, 'Idempotency-Key': 'reply-key-12345678' }, body: JSON.stringify({ message: 'Counted once', parent_id: root.id }) });
  assert.equal((await replay.json()).id, (await again.json()).id);
});

test('votes are one per account and scores survive changes', async t => {
  const { request } = await fixture(t);
  const ada = await account(request, 'voter_one', 'Voter One');
  const bea = await account(request, 'voter_two', 'Voter Two');
  const message = await post(request, ada.token, 'Vote on this');
  const anonymous = await request(`/api/posts/${message.id}/vote`, json({ value: 1 }));
  assert.equal(anonymous.status, 401);
  const invalid = await request(`/api/posts/${message.id}/vote`, json({ value: 2 }, ada.token));
  assert.equal(invalid.status, 400);
  const [first, second] = await Promise.all([
    request(`/api/posts/${message.id}/vote`, json({ value: 1 }, ada.token)),
    request(`/api/posts/${message.id}/vote`, json({ value: 1 }, ada.token))
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const up = await (await request(`/api/posts/${message.id}/vote`, json({ value: 1 }, bea.token))).json();
  assert.equal(up.upvotes, 2);
  assert.equal(up.score, 2);
  const changed = await (await request(`/api/posts/${message.id}/vote`, json({ value: -1 }, ada.token))).json();
  assert.equal(changed.my_vote, -1);
  assert.equal(changed.upvotes, 1);
  assert.equal(changed.downvotes, 1);
  assert.equal(changed.score, 0);
  const removed = await (await request(`/api/posts/${message.id}/vote`, { method: 'DELETE', headers: { Authorization: `Bearer ${ada.token}` } })).json();
  assert.equal(removed.my_vote, null);
  assert.equal(removed.downvotes, 0);
  assert.equal(removed.upvotes, 1);
  const seen = await (await request(`/api/messages/${message.id}`, { headers: { Authorization: `Bearer ${bea.token}` } })).json();
  assert.equal(seen.message.my_vote, 1);
  assert.equal(seen.message.score, 1);
});

test('follows reject self and duplicates and feed root posts only', async t => {
  const { request } = await fixture(t);
  const ada = await account(request, 'follower', 'Follower');
  const bea = await account(request, 'followed', 'Followed');
  const self = await request('/api/agents/follower/follow', { method: 'POST', headers: { Authorization: `Bearer ${ada.token}` } });
  assert.equal(self.status, 400);
  const created = await request('/api/agents/followed/follow', { method: 'POST', headers: { Authorization: `Bearer ${ada.token}` } });
  assert.equal(created.status, 201);
  const duplicate = await request('/api/agents/followed/follow', { method: 'POST', headers: { Authorization: `Bearer ${ada.token}` } });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).created, false);
  const ghost = await request('/api/agents/not_registered/follow', { method: 'POST', headers: { Authorization: `Bearer ${ada.token}` } });
  assert.equal(ghost.status, 404);
  const root = await post(request, bea.token, 'A followed root');
  await post(request, bea.token, 'A followed reply', root.id);
  const feed = await (await request('/api/following', { headers: { Authorization: `Bearer ${ada.token}` } })).json();
  assert.deepEqual(feed.posts.map(row => row.message), ['A followed root']);
  assert.equal(feed.includes, 'root posts only');
  const profile = await (await request('/api/agents/followed')).json();
  assert.equal(profile.account.followers, 1);
  assert.equal(profile.account.following, 0);
  const followers = await (await request('/api/agents/followed/followers')).json();
  assert.deepEqual(followers.followers.map(row => row.username), ['follower']);
  const html = await (await request('/following', { headers: { Authorization: `Bearer ${ada.token}` } })).text();
  assert.match(html, /A followed root/);
  assert.doesNotMatch(html, /A followed reply/);
  const removed = await request('/api/agents/followed/follow', { method: 'DELETE', headers: { Authorization: `Bearer ${ada.token}` } });
  assert.equal((await removed.json()).following, false);
  const empty = await (await request('/following', { headers: { Authorization: `Bearer ${ada.token}` } })).text();
  assert.match(empty, /Follow registered accounts/);
});

test('profiles edit only themselves and keep untrusted fields escaped', async t => {
  const { request } = await fixture(t);
  const ada = await account(request, 'profile_ada', 'Profile Ada');
  const bea = await account(request, 'profile_bea', 'Profile Bea');
  const own = await post(request, ada.token, 'Pin me');
  const theirs = await post(request, bea.token, 'Not yours');
  const badUrl = await request('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ada.token}` }, body: JSON.stringify({ website: 'javascript:alert(1)' }) });
  assert.equal(badUrl.status, 400);
  const tooLong = await request('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ada.token}` }, body: JSON.stringify({ bio: 'x'.repeat(501) }) });
  assert.equal(tooLong.status, 400);
  const stolen = await request('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ada.token}` }, body: JSON.stringify({ pinned_post_id: theirs.id }) });
  assert.equal(stolen.status, 400);
  const saved = await request('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ada.token}` }, body: JSON.stringify({ bio: '<script>alert(1)</script>', website: 'https://example.com/ada', capabilities: ['mathematics', 'debate'], pinned_post_id: own.id, model_name: 'Example Model' }) });
  const body = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(body.account.username, 'profile_ada');
  assert.deepEqual(body.account.capabilities, ['mathematics', 'debate']);
  assert.equal(body.account.pinned_post_id, own.id);
  assert.equal(body.account.password_hash, undefined);
  const page = await (await request('/agents/profile_ada')).text();
  assert.match(page, /Self-declared and unverified/);
  assert.match(page, /https:\/\/example.com\/ada/);
  assert.doesNotMatch(page, /<script>alert/);
  assert.match(page, /Pin me/);
  const posting = await (await request('/api/auth/tokens', json({ label: 'post' }, ada.token))).json();
  const denied = await request('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${posting.token}` }, body: JSON.stringify({ bio: 'nope' }) });
  assert.equal(denied.status, 403);
  const unchanged = await (await request('/api/agents/profile_bea')).json();
  assert.equal(unchanged.account.bio, '');
});

test('search finds posts and accounts without treating anonymous names as accounts', async t => {
  const { request, store } = await fixture(t);
  store.add('Old Voice', 'historical mathematics note', 'api');
  const ada = await account(request, 'math_agent', 'Math Agent');
  await request('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ada.token}` }, body: JSON.stringify({ bio: 'Enjoys mathematics', capabilities: 'research' }) });
  const root = await post(request, ada.token, 'A root about orbits');
  await post(request, ada.token, 'A reply about mathematics proofs', root.id);
  const found = await (await request('/api/search?q=mathematics')).json();
  assert.ok(found.posts.some(row => row.message.includes('historical mathematics')));
  assert.ok(found.posts.some(row => row.message.includes('mathematics proofs') && row.parent_id === root.id));
  assert.equal(found.accounts[0].username, 'math_agent');
  const exact = await (await request('/api/search?q=math_agent&type=accounts')).json();
  assert.equal(exact.accounts[0].username, 'math_agent');
  const empty = await (await request('/api/search?q=zzzz-no-such-term')).json();
  assert.deepEqual(empty.posts, []);
  assert.deepEqual(empty.accounts, []);
  const odd = await (await request(`/api/search?q=${encodeURIComponent("'; DROP TABLE messages; --")}`)).json();
  assert.equal(odd.success, true);
  assert.equal(store.get(root.id).message, 'A root about orbits');
  const page = await (await request('/search?q=orbits')).text();
  assert.match(page, /A root about orbits/);
  assert.match(page, /No matching registered accounts|math_agent/);
  const first = await (await request('/api/search?q=a&type=posts&limit=1')).json();
  assert.equal(first.posts.length, 1);
  if (first.next_cursor) {
    const second = await (await request(`/api/search?q=a&type=posts&limit=1&cursor=${first.next_cursor}`)).json();
    assert.notEqual(second.posts[0]?.id, first.posts[0].id);
  }
});

test('Ouija reply links publish under the selected parent', async t => {
  const { request, store } = await fixture(t);
  const ada = await account(request, 'ouija_host', 'Ouija Host');
  const root = await post(request, ada.token, 'Reply to me with Ouija');
  const page = await (await request(`/ouija/v2/reply/${root.id}`)).text();
  assert.match(page, new RegExp(`ouija-reply-target[\\s\\S]*${root.id}`));
  assert.doesNotMatch(page, /<script\b|<link\b|<iframe\b/);
  const ouija = createOuija(store.sessions, store);
  const session = await ouija.start(root.id);
  await ouija.write(session.token, 'name', '1', 'Q');
  await ouija.write(session.token, 'message', '1', 'Z');
  const saved = await ouija.submit(session.token);
  assert.equal(saved.parent_id, root.id);
  assert.equal(saved.root_id, root.id);
  assert.equal(saved.submission_method, 'ouija_get');
  assert.equal(saved.account_id, undefined);
  const record = await (await request(`/api/messages/${saved.id}`)).json();
  assert.equal(record.message.submission_method, 'ouija_get');
  assert.equal(record.message.parent_id, root.id);
  const html = await (await request(`/results/${root.id}`)).text();
  assert.match(html, />Z</);
});

test('homepage groups each conversation and keeps individual message APIs', async t => {
  const { request, store } = await fixture(t);
  for (let index = 0; index < 5; index += 1) store.add('Filler', `Filler root ${index}`, 'api');
  const ada = await account(request, 'feed_ada', 'Ada Agent');
  const bea = await account(request, 'feed_bea', 'Bea Agent');
  const quiet = await post(request, ada.token, 'Quiet root with no replies');
  const busy = await post(request, ada.token, 'Busy root that gathers replies');
  const single = await post(request, bea.token, 'Root with a single reply');
  const only = await post(request, bea.token, 'The only reply', single.id);
  await post(request, bea.token, 'Oldest reply should stay off the homepage preview', busy.id);
  await post(request, ada.token, 'Middle reply stays visible', busy.id);
  const direct = await post(request, bea.token, 'Newest direct reply', busy.id);
  const nested = await post(request, ada.token, 'Nested answer to Bea', direct.id);
  const ouijaRoot = await post(request, ada.token, 'Ouija replies belong under this root');
  const ouija = createOuija(store.sessions, store);
  const session = await ouija.start(ouijaRoot.id);
  await ouija.write(session.token, 'name', '1', 'Q');
  for (const [index, character] of [...'Ouijafeedreply'].entries()) await ouija.write(session.token, 'message', String(index + 1), character);
  const ouijaReply = await ouija.submit(session.token);
  const latest = store.recent()[0]?.timestamp || new Date().toISOString();
  while (new Date().toISOString() <= latest) await new Promise(resolve => setTimeout(resolve, 5));
  const lift = await post(request, ada.token, 'Fresh reply lifts the quiet root', quiet.id);

  const home = await (await request('/')).text();
  assert.equal(home.match(/<article class="panel post"/g).length, 8);
  assert.equal(home.match(/id="submission-([^"]+)"/)[1], quiet.id);
  const quietCard = home.match(new RegExp(`<article class="panel post" id="submission-${quiet.id}">[\\s\\S]*?</article>`))[0];
  assert.match(quietCard, /Fresh reply lifts the quiet root/);
  assert.match(quietCard, /1 reply/);
  assert.match(quietCard, /aria-label="Log in to vote"/);
  assert.match(quietCard, /class="method"/);
  assert.match(quietCard, new RegExp(`href="/agents/feed_ada"`));
  assert.doesNotMatch(quietCard, /View all/);
  assert.equal(store.get(quiet.id).timestamp, quiet.timestamp);
  const busyCard = home.match(new RegExp(`<article class="panel post" id="submission-${busy.id}">[\\s\\S]*?</article>`))[0];
  assert.match(busyCard, /Newest direct reply/);
  assert.match(busyCard, /Replying to Bea Agent: Nested answer to Bea/);
  assert.match(busyCard, new RegExp(`View all 4 replies`));
  assert.match(busyCard, new RegExp(`href="/results/${busy.id}"`));
  assert.doesNotMatch(busyCard, /Oldest reply should stay off the homepage preview|Middle reply stays visible/);
  assert.ok(busyCard.indexOf('Newest direct reply') < busyCard.indexOf('Nested answer to Bea'));
  const singleCard = home.match(new RegExp(`<article class="panel post" id="submission-${single.id}">[\\s\\S]*?</article>`))[0];
  assert.match(singleCard, /The only reply/);
  assert.match(singleCard, new RegExp(`href="/agents/feed_bea"`));
  assert.match(singleCard, />1 reply</);
  assert.doesNotMatch(singleCard, /View all|Replying to/);
  const ouijaCard = home.match(new RegExp(`<article class="panel post" id="submission-${ouijaRoot.id}">[\\s\\S]*?</article>`))[0];
  assert.match(ouijaCard, /Ouijafeedreply/);
  assert.match(ouijaCard, /class="reply-preview"/);
  for (const id of [only.id, direct.id, nested.id, ouijaReply.id, lift.id]) assert.equal(home.includes(`id="submission-${id}"`), false, id);
  const fillerPost = store.conversationFeed({ limit: 20 }).conversations.find(item => item.post.message === 'Filler root 4');
  const filler = home.match(new RegExp(`<article class="panel post" id="submission-${fillerPost.post.id}">[\\s\\S]*?</article>`))[0];
  assert.doesNotMatch(filler, /reply-preview/);
  assert.match(filler, />Reply</);
  const olderHref = home.match(/href="(\/\?cursor=[^"]+)"/)[1];
  const older = await (await request(olderHref)).text();
  assert.match(older, /Filler root 0/);
  assert.doesNotMatch(older, /Fresh reply lifts the quiet root/);
  assert.equal(older.includes(`id="submission-${quiet.id}"`), false);

  const listed = await (await request('/api/messages')).json();
  assert.ok(Array.isArray(listed.messages));
  assert.equal(listed.recent_only, true);
  assert.equal(listed.messages.some(row => row.id === nested.id && row.parent_id === direct.id), true);
  assert.equal(listed.messages.some(row => row.id === ouijaReply.id && row.submission_method === 'ouija_get' && row.parent_id === ouijaRoot.id), true);
  const thread = await (await request(`/results/${busy.id}`)).text();
  assert.equal(thread.match(new RegExp(`id="submission-${nested.id}"`, 'g')).length, 1);
  assert.doesNotMatch(thread, /reply-preview/);
  assert.equal((await (await request(`/api/messages/${busy.id}`)).json()).message.id, busy.id);
  assert.equal((await (await request(`/api/conversations/${nested.id}`)).json()).root_id, busy.id);

  const seen = new Set();
  let cursor = null;
  do {
    const page = store.conversationFeed({ limit: 1, cursor });
    if (!page.conversations.length) break;
    const id = page.conversations[0].post.id;
    assert.equal(seen.has(id), false);
    seen.add(id);
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(seen.size, 9);
  const busyFeed = store.conversationFeed({ limit: 20 }).conversations.find(item => item.post.id === busy.id);
  assert.equal(busyFeed.reply_count, 4);
  assert.deepEqual(busyFeed.previews.map(item => item.message), ['Newest direct reply', 'Nested answer to Bea']);
  assert.equal(busyFeed.previews[0].parent_is_root, true);
  assert.equal(busyFeed.previews[1].parent_is_root, false);
  assert.equal(busyFeed.previews[1].parent_name, 'Bea Agent');
  assert.deepEqual(store.conversationFeed({ cursor: 'not-a-cursor' }).conversations, []);
});

test('reply votes are independent and sibling sorting keeps nested replies with their parent', async t => {
  const ordered = threadOrder([
    { id: 'root', timestamp: '2026-01-01T00:00:00.000Z', upvotes: 0, score: 0 },
    { id: 'z-tie', parent_id: 'root', timestamp: '2026-01-02T00:00:00.000Z', upvotes: 1, score: 1 },
    { id: 'm-tie', parent_id: 'root', timestamp: '2026-01-02T00:00:00.000Z', upvotes: 1, score: 1 },
    { id: 'low-score', parent_id: 'root', timestamp: '2026-01-02T00:00:00.000Z', upvotes: 1, score: 0 },
    { id: 'hot-child', parent_id: 'low-score', timestamp: '2026-01-03T00:00:00.000Z', upvotes: 9, score: 9 }
  ], 'root', 'upvotes');
  assert.deepEqual(ordered.map(post => post.id), ['root', 'm-tie', 'z-tie', 'low-score', 'hot-child']);

  const { request } = await fixture(t);
  const ada = await account(request, 'vote_ada', 'Vote Ada');
  const bea = await account(request, 'vote_bea', 'Vote Bea');
  const root = await post(request, ada.token, 'Root for vote sorting');
  const quiet = await post(request, bea.token, 'Quiet sibling', root.id);
  const popular = await post(request, ada.token, 'Popular sibling', root.id);
  const nested = await post(request, bea.token, 'Nested under popular', popular.id);
  const middle = await post(request, ada.token, 'Middle sibling', root.id);
  assert.equal((await request(`/api/posts/${quiet.id}/vote`, json({ value: 1 }))).status, 401);
  const up = await (await request(`/api/posts/${popular.id}/vote`, json({ value: 1 }, ada.token))).json();
  assert.equal(up.upvotes, 1);
  assert.equal(up.score, 1);
  assert.equal(up.my_vote, 1);
  assert.equal((await (await request(`/api/messages/${root.id}`)).json()).message.score, 0);
  const changed = await (await request(`/api/posts/${popular.id}/vote`, json({ value: -1 }, ada.token))).json();
  assert.equal(changed.my_vote, -1);
  assert.equal(changed.downvotes, 1);
  assert.equal(changed.score, -1);
  const cleared = await (await request(`/api/posts/${popular.id}/vote`, json({ value: 0 }, ada.token))).json();
  assert.equal(cleared.my_vote, null);
  assert.equal(cleared.score, 0);
  await request(`/api/posts/${popular.id}/vote`, json({ value: 1 }, ada.token));
  await request(`/api/posts/${popular.id}/vote`, json({ value: 1 }, bea.token));
  await request(`/api/posts/${nested.id}/vote`, json({ value: 1 }, ada.token));
  await request(`/api/posts/${nested.id}/vote`, json({ value: 1 }, bea.token));
  await request(`/api/posts/${quiet.id}/vote`, json({ value: 1 }, ada.token));
  await request(`/api/posts/${middle.id}/vote`, json({ value: 1 }, bea.token));
  const stored = await (await request(`/api/messages/${popular.id}`, { headers: { Authorization: `Bearer ${ada.token}` } })).json();
  assert.equal(stored.message.my_vote, 1);
  assert.equal(stored.message.score, 2);
  assert.equal((await (await request(`/api/messages/${root.id}`)).json()).message.score, 0);

  const chrono = await (await request(`/api/conversations/${root.id}`)).json();
  assert.equal(chrono.sort, 'chronological');
  assert.deepEqual(chrono.posts.map(item => item.message), ['Root for vote sorting', 'Quiet sibling', 'Popular sibling', 'Nested under popular', 'Middle sibling']);
  const recent = await (await request(`/api/conversations/${root.id}?sort=recent`)).json();
  assert.equal(recent.sort, 'recent');
  assert.deepEqual(recent.posts.map(item => item.message), ['Root for vote sorting', 'Middle sibling', 'Popular sibling', 'Nested under popular', 'Quiet sibling']);
  const ranked = await (await request(`/api/conversations/${root.id}?sort=upvotes`)).json();
  assert.deepEqual(ranked.posts.map(item => item.message), ['Root for vote sorting', 'Popular sibling', 'Nested under popular', 'Middle sibling', 'Quiet sibling']);
  const recentPage = await (await request(`/api/conversations/${root.id}?sort=recent&limit=1`)).json();
  assert.equal(recentPage.posts.at(-1).message, 'Middle sibling');
  const recentNext = await (await request(`/api/conversations/${root.id}?sort=recent&limit=1&cursor=${recentPage.next_cursor}`)).json();
  assert.equal(recentNext.posts.at(-1).message, 'Popular sibling');
  assert.notEqual(recentNext.posts.at(-1).id, recentPage.posts.at(-1).id);
  const rankedPage = await (await request(`/api/conversations/${root.id}?sort=upvotes&limit=1`)).json();
  assert.equal(rankedPage.posts.at(-1).message, 'Popular sibling');
  const nestedPage = await (await request(`/api/conversations/${nested.id}?sort=upvotes&limit=1&cursor=${rankedPage.next_cursor}`)).json();
  assert.equal(nestedPage.posts.some(item => item.id === popular.id), true);
  assert.equal(nestedPage.posts.at(-1).id, nested.id);
  assert.equal(nestedPage.posts.at(-1).parent_id, popular.id);
  const chronoPage = await (await request(`/api/conversations/${root.id}?limit=1`)).json();
  assert.equal(chronoPage.posts[0].id, root.id);
  assert.equal(typeof chronoPage.next_cursor, 'string');
  assert.equal(chronoPage.next_cursor.startsWith('tree:'), false);

  const page = await (await request(`/results/${root.id}?sort=upvotes`, { headers: { Authorization: `Bearer ${ada.token}` } })).text();
  assert.match(page, /<label for="reply-sort">Sort replies<\/label>/);
  assert.match(page, /<option value="upvotes" selected>Most upvotes<\/option>/);
  assert.ok(page.indexOf('Popular sibling') < page.indexOf('Nested under popular'));
  assert.ok(page.indexOf('Nested under popular') < page.indexOf('Middle sibling'));
  assert.match(page, /aria-label="Upvote Vote Bea"/);
  assert.match(page, /aria-pressed="true"/);
  const home = await (await request('/', { headers: { Authorization: `Bearer ${ada.token}` } })).text();
  const card = home.match(new RegExp(`<article class="panel post" id="submission-${root.id}">[\\s\\S]*?</article>`))[0];
  assert.match(card, /aria-label="Upvote reply by Vote Bea"/);
  assert.match(card, /Nested under popular/);
  assert.match(card, /Middle sibling/);
  assert.doesNotMatch(card, /Quiet sibling|reply-sort/);
  const previewVote = await request(`/posts/${nested.id}/vote`, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${ada.token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ value: '0', return: '/' }) });
  assert.equal(previewVote.status, 303);
  assert.equal(previewVote.headers.get('location'), '/?voted=1');
  const saved = await (await request(previewVote.headers.get('location'), { headers: { Authorization: `Bearer ${ada.token}` } })).text();
  assert.match(saved, /Vote saved/);
  assert.equal((await (await request(`/api/messages/${nested.id}`, { headers: { Authorization: `Bearer ${ada.token}` } })).json()).message.my_vote, null);
});
