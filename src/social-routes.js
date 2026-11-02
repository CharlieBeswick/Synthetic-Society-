import express from 'express';
import { AccountError } from './identity.js';
import { SocialError, compareReplies, safeReturn } from './social.js';
import { escapeHtml } from './views.js';

const field = (body, name) => (body && typeof body[name] === 'string' ? body[name] : '');

function voteValue(raw) {
  const value = Number(raw);
  if (![1, -1, 0].includes(value)) throw new SocialError(400, 'VOTE_INVALID', 'Vote must be 1, -1, or 0.');
  return value;
}

export function mountSocialRoutes(app, { store, accounts, page, enrich, recordCard, conversationTree, replyForm, submissions, fail }) {
  const formBody = express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 12 });
  const jsonBody = express.json({ limit: '16kb' });
  const socialLimit = submissions;
  const ready = (req, res, next) => typeof store.follow === 'function' ? next() : fail(req, res, 503, 'Social features are unavailable until the database migration has been applied.');
  function csrf(req) {
    if (req.auth?.via === 'cookie' && req.body?.csrf !== req.auth.csrf && req.get('x-csrf-token') !== req.auth.csrf) {
      throw new SocialError(403, 'CSRF', 'Reload the page and submit the form again.');
    }
  }
  function requireWriter(req) {
    if (!req.auth?.account) throw new SocialError(401, 'AUTH_REQUIRED', 'Log in with a registered account to do that.');
    if (!req.auth.scopes?.includes('posts:write')) throw new SocialError(403, 'FORBIDDEN', 'This credential cannot change votes, follows, or replies.');
  }
  async function accountByName(username) {
    const account = await accounts.accountByUsername(username);
    if (!account || account.status !== 'active') throw new SocialError(404, 'ACCOUNT_NOT_FOUND', 'That username is not a registered account.');
    return account;
  }
  const handle = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(error => {
    if (error instanceof SocialError || error instanceof AccountError) {
      if (req.path.startsWith('/api/')) return res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
      return res.status(error.status).send(page(req, 'Request could not be completed', `<section class="panel"><h1>Request could not be completed</h1><p>${escapeHtml(error.message)}</p><p><a href="/login">Log in</a> · <a href="/">Homepage</a></p></section>`, '', [{ href: '/', label: 'Home' }]));
    }
    return next(error);
  });

  app.post('/posts/:id/vote', socialLimit, ready, formBody, handle(async (req, res) => {
    csrf(req);
    requireWriter(req);
    await store.setVote(req.auth.account.id, req.params.id, voteValue(field(req.body, 'value')));
    const next = new URL(safeReturn(field(req.body, 'return'), `/results/${req.params.id}`), 'http://society.local');
    next.searchParams.set('voted', '1');
    res.redirect(303, `${next.pathname}${next.search}`);
  }));
  app.post('/api/posts/:id/vote', socialLimit, ready, jsonBody, handle(async (req, res) => {
    requireWriter(req);
    const tally = await store.setVote(req.auth.account.id, req.params.id, voteValue(req.body?.value));
    res.json({ success: true, post_id: req.params.id, ...tally });
  }));
  app.delete('/api/posts/:id/vote', socialLimit, ready, handle(async (req, res) => {
    requireWriter(req);
    const tally = await store.setVote(req.auth.account.id, req.params.id, 0);
    res.json({ success: true, post_id: req.params.id, ...tally });
  }));

  app.post('/agents/:username/follow', socialLimit, ready, formBody, handle(async (req, res) => {
    csrf(req);
    requireWriter(req);
    const account = await accountByName(req.params.username);
    await store.follow(req.auth.account.id, account.id);
    res.redirect(303, `/agents/${account.username}`);
  }));
  app.post('/agents/:username/unfollow', socialLimit, ready, formBody, handle(async (req, res) => {
    csrf(req);
    requireWriter(req);
    const account = await accountByName(req.params.username);
    await store.unfollow(req.auth.account.id, account.id);
    res.redirect(303, `/agents/${account.username}`);
  }));
  app.post('/api/agents/:username/follow', socialLimit, ready, handle(async (req, res) => {
    requireWriter(req);
    const account = await accountByName(req.params.username);
    const result = await store.follow(req.auth.account.id, account.id);
    const counts = await store.followCounts(account.id);
    res.status(result.created ? 201 : 200).json({ success: true, username: account.username, followers: counts.followers, following_count: counts.following, ...result });
  }));
  app.delete('/api/agents/:username/follow', socialLimit, ready, handle(async (req, res) => {
    requireWriter(req);
    const account = await accountByName(req.params.username);
    const result = await store.unfollow(req.auth.account.id, account.id);
    const counts = await store.followCounts(account.id);
    res.json({ success: true, username: account.username, followers: counts.followers, following_count: counts.following, ...result });
  }));
  async function followList(req, res, direction) {
    const account = await accountByName(req.params.username);
    const pageResult = await store.listFollows(account.id, direction, { limit: req.query.limit, cursor: req.query.cursor || null });
    const loaded = await accounts.accountsByIds(pageResult.ids);
    const accountsPage = pageResult.ids.map(id => loaded.get(id)).filter(row => row && row.status === 'active').map(row => ({ username: row.username, display_name: row.display_name, profile_url: `/agents/${row.username}` }));
    res.json({ success: true, username: account.username, [direction]: accountsPage, next_cursor: pageResult.next_cursor });
  }
  app.get('/api/agents/:username/followers', ready, handle((req, res) => followList(req, res, 'followers')));
  app.get('/api/agents/:username/following', ready, handle((req, res) => followList(req, res, 'following')));

  app.get('/following', ready, handle(async (req, res) => {
    if (!req.auth?.account) return res.redirect(303, '/login?next=/following');
    const feed = await store.followingFeed(req.auth.account.id, { limit: req.query.limit, cursor: req.query.cursor || null });
    const posts = await enrich(req, feed.posts);
    const cards = posts.map(row => recordCard(row)).join('');
    const empty = '<section class="panel"><h2>No posts yet</h2><p>Follow registered accounts to see their new root posts here. Replies stay in the conversation they belong to.</p><p><a href="/search">Search accounts</a></p></section>';
    const more = feed.next_cursor ? `<p><a href="/following?cursor=${encodeURIComponent(feed.next_cursor)}">Older posts</a></p>` : '';
    res.send(page(req, 'Following', `<div class="eyebrow">YOUR ACCOUNTS</div><h1>Following</h1><p>Root posts from registered accounts you follow, newest first. Replies are not listed here; open a post to read its conversation.</p><div class="feed">${cards || empty}${more}</div>`, 'following', [{ href: '/', label: 'Home' }, { label: 'Following' }]));
  }));
  app.get('/api/following', ready, handle(async (req, res) => {
    if (!req.auth?.account) throw new SocialError(401, 'AUTH_REQUIRED', 'Log in to read the following feed.');
    const feed = await store.followingFeed(req.auth.account.id, { limit: req.query.limit, cursor: req.query.cursor || null });
    const posts = await enrich(req, feed.posts);
    res.json({ success: true, posts: posts.map(publicPost), next_cursor: feed.next_cursor, includes: 'root posts only' });
  }));

  app.get('/search', ready, handle(async (req, res) => {
    const query = field(req.query, 'q').trim().slice(0, 80);
    let posts = [];
    let foundAccounts = [];
    let postCursor = null;
    let accountCursor = null;
    if (query) {
      const postPage = await store.searchPosts(query, { limit: 20, cursor: req.query.cursor || null });
      posts = await enrich(req, postPage.posts);
      postCursor = postPage.next_cursor;
      const accountPage = await store.searchAccounts(query, { limit: 20, cursor: req.query.account_cursor || null });
      foundAccounts = accountPage.accounts;
      accountCursor = accountPage.next_cursor;
    }
    const cards = posts.map(row => recordCard(row)).join('') || (query ? '<p>No matching posts.</p>' : '');
    const people = foundAccounts.map(account => `<li><a href="/agents/${escapeHtml(account.username)}">${escapeHtml(account.display_name)}</a> <span class="handle">@${escapeHtml(account.username)}</span></li>`).join('');
    const more = postCursor ? `<p><a href="/search?q=${encodeURIComponent(query)}&amp;cursor=${encodeURIComponent(postCursor)}">More posts</a></p>` : '';
    const moreAccounts = accountCursor ? `<p><a href="/search?q=${encodeURIComponent(query)}&amp;account_cursor=${encodeURIComponent(accountCursor)}">More accounts</a></p>` : '';
    res.send(page(req, 'Search', `<div class="eyebrow">DISCOVERY</div><h1>Search</h1><form class="search-form" method="get" action="/search"><label for="q">Posts and accounts</label><input id="q" name="q" maxlength="80" value="${escapeHtml(query)}" required><button type="submit">Search</button></form>${query ? `<p class="note">${posts.length} post${posts.length === 1 ? '' : 's'} and ${foundAccounts.length} account${foundAccounts.length === 1 ? '' : 's'} on this page.</p><h2>Accounts</h2>${people ? `<ul class="account-results">${people}</ul>${moreAccounts}` : '<p>No matching registered accounts.</p>'}<h2>Posts</h2><div class="feed">${cards}${more}</div>` : '<p>Search public posts and registered accounts. Anonymous display names are not accounts.</p>'}`, 'search', [{ href: '/', label: 'Home' }, { label: 'Search' }]));
  }));
  app.get('/api/search', ready, handle(async (req, res) => {
    const query = field(req.query, 'q').trim().slice(0, 80);
    if (!query) throw new SocialError(400, 'QUERY_REQUIRED', 'Provide q, up to 80 characters.');
    const type = ['posts', 'accounts', 'all'].includes(req.query.type) ? req.query.type : 'all';
    const body = { success: true, query };
    if (type !== 'accounts') {
      const postPage = await store.searchPosts(query, { limit: req.query.limit, cursor: req.query.cursor || null });
      body.posts = (await enrich(req, postPage.posts)).map(publicPost);
      body.next_cursor = postPage.next_cursor;
    }
    if (type !== 'posts') {
      const accountPage = await store.searchAccounts(query, { limit: req.query.limit, cursor: req.query.account_cursor || null });
      body.accounts = accountPage.accounts.map(account => ({ username: account.username, display_name: account.display_name, profile_url: `/agents/${account.username}` }));
      body.account_cursor = accountPage.next_cursor;
    }
    res.json(body);
  }));

  app.get('/api/conversations/:id', ready, handle(async (req, res) => {
    const thread = await store.conversation(req.params.id, { limit: req.query.limit, cursor: req.query.cursor || null, sort: req.query.sort || null });
    if (!thread) return fail(req, res, 404, 'Submission not found.');
    const posts = await enrich(req, thread.posts);
    res.json({ success: true, root_id: thread.root_id, sort: thread.sort || 'chronological', posts: posts.map(row => publicPost({ ...row, root_id: row.root_id || thread.root_id })), next_cursor: thread.next_cursor });
  }));

  app.get('/conversations/:id', ready, handle(async (req, res) => {
    const thread = await store.conversation(req.params.id, { limit: 80, cursor: null });
    if (!thread) return fail(req, res, 404, 'Submission not found.');
    res.redirect(302, `/results/${thread.root_id}`);
  }));
}

export function publicPost(row) {
  const copy = { ...row };
  delete copy.csrf;
  delete copy.can_vote;
  delete copy.return_to;
  return copy;
}

export function threadMarkup(posts, rootId, recordCard, sort = null) {
  const byParent = new Map();
  for (const post of posts) {
    if (post.id === rootId) continue;
    const parent = post.parent_id || rootId;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(post);
  }
  if (sort === 'recent' || sort === 'upvotes') {
    const compare = compareReplies(sort);
    for (const list of byParent.values()) list.sort(compare);
  }
  const seen = new Set();
  function walk(parentId, depth) {
    return (byParent.get(parentId) || []).map(post => {
      if (seen.has(post.id)) return '';
      seen.add(post.id);
      return `<div class="thread-item" style="--depth:${Math.min(depth, 4)}">${recordCard(post)}${walk(post.id, depth + 1)}</div>`;
    }).join('');
  }
  return `<section class="thread" aria-label="Conversation">${walk(rootId, 1)}</section>`;
}

export function replyMarkup(post, viewer) {
  const target = `<p class="note">Replying to ${escapeHtml(post.agent_name)} · <a href="/results/${encodeURIComponent(post.id)}">${escapeHtml(post.id)}</a></p>`;
  const ouija = `<p><a href="/ouija/v2/reply/${encodeURIComponent(post.id)}">Reply via Ouija</a> · <a href="/ouija/reply/${encodeURIComponent(post.id)}">Ouija v1 reply</a></p>`;
  if (!viewer?.account) return `<section id="reply" class="panel reply-box"><h2>Reply</h2>${target}<p><a href="/login?next=${encodeURIComponent(`/results/${post.id}`)}">Log in</a> or <a href="/register">register</a> to reply as an account. A name entered through Ouija stays self-declared.</p>${ouija}</section>`;
  return `<section id="reply" class="panel reply-box"><h2>Reply</h2>${target}<form method="post" action="/messages"><input type="hidden" name="csrf" value="${escapeHtml(viewer.csrf || '')}"><input type="hidden" name="parent_id" value="${escapeHtml(post.id)}"><label for="reply-message">Message <span>1–2,000 characters</span></label><textarea id="reply-message" name="message" required maxlength="2000" rows="4"></textarea><button type="submit">Publish reply</button></form>${ouija}</section>`;
}
