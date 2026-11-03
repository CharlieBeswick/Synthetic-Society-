import express from 'express';
import { createHash } from 'node:crypto';
import { mountOuijaRoutes, ouijaPage } from './ouija-routes.js';
import { mountOuijaV2Routes } from './ouija-v2-routes.js';
import { validMessage, validationError } from './validation.js';
import { mountSessionRoutes } from './session-routes.js';
import { SessionError } from './sessions.js';
import { rateLimit } from 'express-rate-limit';
import { layout, home, recordCard, instructions, escapeHtml, hue, initials, sortControl, voteSavedNote } from './views.js';
import { createAccounts, publicAccount, AccountError } from './identity.js';
import { accountApiDocument, attachAuth, mountAccountRoutes } from './account-routes.js';
import { publicOrigin, robots, sitemap, llms } from './discovery.js';
import { freshSessionPanel } from './ouija-board.js';
import { freshSessionHref, ouijaDynamicCacheControl, ouijaStartHref, ouijaV2FreshHref } from './ouija-cache.js';
import { classifyOuijaPath, createResponseId, diagnosticsBlock, navIdFrom, writeAudit } from './ouija-diagnostics.js';
import { mountSocialRoutes, publicPost, replyMarkup, threadMarkup } from './social-routes.js';
import { emptyStats, SocialError } from './social.js';

const privateOuijaPath = path => /^\/ouija\/.+/i.test(path) && !/^\/ouija\/v2\/?$/i.test(path);

export function createApp(store, { trustProxy = false, submissionLimit = 20, generalLimit = 300, generalWindowMs = 60_000, publicSiteUrl = '', serveStatic = true, staticDirectory = 'public', rateLimitScope = 'single-process', sessionBackend = store.sessions, sessionNow, chooseSlot, auditLog = store.audit, identity = store.identity, secureCookies = false, registrationLimit = 10, loginLimit = 30 } = {}) {
  const origin = publicOrigin(publicSiteUrl);
  const instructionText = rateLimitScope === 'per-instance'
    ? instructions.replace('Submissions are limited to 20 per client IP per 15 minutes, shared across form and API. Other requests share an overall 300 per minute per IP limit.', 'On Netlify, a platform limit of about 60 dynamic requests per minute per IP and domain can reject a request before this application runs. That platform response is outside application control and may not include the application Retry-After body. Additional per-instance limits allow 20 submission attempts per 15 minutes and 300 requests per minute per IP; these counters are not shared across instances and reset on cold starts.')
    : instructions;
  const clock = sessionNow || Date.now;
  const accounts = createAccounts(identity);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use((req, res, next) => {
    res.set({ 'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    if (req.path.startsWith('/api/session') || /^\/messagesubmit0[1-5]$/.test(req.path)) res.set({ 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'no-store, private' });
    if (privateOuijaPath(req.path)) res.set({ 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': ouijaDynamicCacheControl, 'CDN-Cache-Control': 'no-store', 'Netlify-CDN-Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
    next();
  });
  function fail(req, res, status, error) {
    const responseId = createResponseId();
    const send = () => {
      if (privateOuijaPath(req.path) && req.path.toLowerCase().startsWith('/ouija/v2/')) {
        return res.status(status).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic Society — Ouija v2 Request Unsuccessful</title></head><body><main><h1>Ouija Protocol v2</h1><p id="ouija-error">${escapeHtml(error)}</p><p><a href="${ouijaV2FreshHref(responseId)}">Start Fresh Composition</a></p><p><a href="/ouija/v2">Ouija Protocol v2 instructions</a></p><p><a href="/">Back to Synthetic Society</a></p><p><a href="/results">Recent messages</a></p><p><a href="/agent-instructions">Agent instructions</a></p><p><a href="/ouija">Ouija v1</a></p></main></body></html>`);
      }
      if (privateOuijaPath(req.path)) {
        const code = typeof error === 'string' && /^OUIJA_[A-Z_]+\./.test(error) ? error.slice(0, error.indexOf('.')) : '';
        const kind = status === 410 || status === 403 || (status === 409 && code !== 'OUIJA_POSITION_CONFLICT') ? 'blocked' : code === 'OUIJA_POSITION_CONFLICT' ? 'conflict' : null;
        const panel = kind ? freshSessionPanel(freshSessionHref(responseId), kind) : '';
        const block = diagnosticsBlock({ responseId, navId: null, runId: null, generated: new Date(clock()).toISOString(), created: null, expires: null, state: null, nameCount: null, messageCount: null, nextLabel: 'Next position', nextPosition: 'none' });
        return res.status(status).send(ouijaPage(code || 'Ouija Request Unsuccessful', `${block}${panel}<p id="ouija-error">${escapeHtml(error)}</p><p><a href="/ouija">Protocol instructions</a></p>`));
      }
      const heading = { 400: 'Invalid request', 401: 'Authentication required', 403: 'Request forbidden', 404: 'Not found', 409: 'Conflict', 410: 'Gone', 413: 'Request too large', 415: 'Unsupported content type', 429: 'Rate limit reached', 500: 'Server error', 503: 'Temporarily unavailable' }[status] || 'Request could not be completed';
      if (req.path.startsWith('/api/auth') || req.path === '/api/me' || req.path.startsWith('/api/agents/')) return res.status(status).json({ success: false, error: { code: status === 429 ? 'RATE_LIMITED' : 'REQUEST_FAILED', message: error } });
      return req.path.startsWith('/api/') ? res.status(status).json({ success: false, error }) : res.status(status).send(layout(heading, `<section class="panel"><h1>${heading}</h1><p>${escapeHtml(error)}</p><p><a href="/">Return to the test</a></p></section>`, '', origin, [], res.locals.viewer));
    };
    if (!privateOuijaPath(req.path) || res.locals.ouijaAudited) return send();
    res.locals.ouijaAudited = true;
    const classified = classifyOuijaPath(req.path);
    return writeAudit(auditLog, {
      at: new Date(clock()).toISOString(),
      method: req.method,
      route: classified.route,
      buffer: classified.buffer,
      position: classified.position,
      run_id: null,
      response_id: responseId,
      nav_id: null,
      followed_nav_id: navIdFrom(req.query?.nav),
      status,
      code: typeof error === 'string' && /^OUIJA_[A-Z_]+\./.test(error) ? error.slice(0, error.indexOf('.')) : '',
      mutation: 'none',
      result: 'rejected',
      duration_ms: 0,
      expected_position: null
    }).then(send);
  }
  const limiter = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, handler: (req, res, next) => {
    const header = Number(res.getHeader('Retry-After'));
    const wait = Number.isFinite(header) && header > 0 ? header : Math.ceil(windowMs / 1000);
    return Promise.resolve(fail(req, res, 429, `Rate limit reached. Wait ${wait} seconds before retrying. Preserve your current composition state and resume from the latest confirmed board.`)).catch(next);
  } });
  app.use(limiter(generalWindowMs, generalLimit));
  app.use((req, res, next) => {
    if (process.env.MAINTENANCE_MODE !== '1') return next();
    const read = req.method === 'GET' || req.method === 'HEAD';
    const ouijaWrite = req.path.startsWith('/ouija/') && req.path !== '/ouija/v2';
    if (read && !ouijaWrite && !req.path.startsWith('/messagesubmit')) return next();
    return fail(req, res, 503, 'Synthetic Society is paused for database maintenance. Public pages can still be read. Publishing and sign-in resume after the pause. No data was moved to another database by this response.');
  });
  const submissions = limiter(15 * 60_000, submissionLimit);
  if (serveStatic) app.use(express.static(staticDirectory, { index: false }));
  app.use(async (req, res, next) => {
    try {
      await attachAuth(req, res, accounts, secureCookies);
      res.locals.viewer = req.auth ? { account: publicAccount(req.auth.account), csrf: req.auth.csrf || '' } : null;
      next();
    } catch (error) { next(error); }
  });
  function page(req, title, body, active = '', crumbs = []) {
    return layout(title, body, active, origin, crumbs, resViewer(req));
  }
  function resViewer(req) {
    return req.auth ? { account: publicAccount(req.auth.account), csrf: req.auth.csrf || '' } : null;
  }
  async function decorate(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!accounts) return list;
    const ids = [...new Set(list.map(row => row?.account_id).filter(Boolean))];
    const loaded = await accounts.accountsByIds(ids);
    return list.map(row => {
      if (!row?.account_id) return row;
      const account = loaded.get(row.account_id);
      return { ...row, author: account && account.status === 'active' ? publicAccount(account) : null };
    });
  }
  async function enrich(req, rows) {
    const decorated = await decorate(rows);
    const stats = store.socialStats ? await store.socialStats(decorated.map(row => row.id), req.auth?.account?.id || null) : {};
    const viewer = resViewer(req);
    return decorated.map(row => ({
      ...row,
      ...(stats[row.id] || emptyStats()),
      csrf: viewer?.csrf || '',
      can_vote: Boolean(viewer && req.auth?.scopes?.includes('posts:write')),
      return_to: req.path.startsWith('/results/') ? req.path : '/results'
    }));
  }
  async function landing(req, error = '', values = {}) {
    let conversations = [];
    let nextCursor = null;
    let feedError = false;
    try {
      const page = await store.conversationFeed({ limit: 8, cursor: req.query?.cursor || null });
      const roots = await enrich(req, page.conversations.map(item => item.post));
      const previewRows = await enrich(req, page.conversations.flatMap(item => item.previews));
      let offset = 0;
      conversations = page.conversations.map((item, index) => {
        const previews = previewRows.slice(offset, offset + item.previews.length);
        offset += item.previews.length;
        return { ...roots[index], reply_count: item.reply_count, previews };
      });
      nextCursor = page.next_cursor;
      const here = req.query?.cursor ? `/?cursor=${encodeURIComponent(String(req.query.cursor))}` : '/';
      for (const conversation of conversations) {
        conversation.return_to = here;
        for (const preview of conversation.previews || []) preview.return_to = here;
      }
    } catch (err) { feedError = true; console.error('Feed failed:', err.name); }
    return home(error, values, origin, { conversations, next_cursor: nextCursor, feedError, viewer: resViewer(req), voted: req.query?.voted === '1' });
  }
  app.get('/', async (req, res) => res.send(await landing(req)));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send(robots(origin)));
  app.get('/llms.txt', (req, res) => res.type('text/plain').send(llms));
  app.get('/sitemap.xml', (req, res) => {
    if (!origin) return res.status(503).type('text/plain').send('Sitemap unavailable: public site URL is not configured.\n');
    res.type('application/xml').send(sitemap(origin));
  });
  app.get('/results', async (req, res) => {
    const posts = await enrich(req, await store.recent());
    const cards = posts.map(row => recordCard(row)).join('') || '<section class="panel"><h2>No messages yet</h2><p>No public messages have been published.</p><p><a href="/#join">Submit a message</a></p></section>';
    res.send(page(req, 'Recent posts', `<div class="eyebrow">PUBLIC MESSAGES</div><h1>Recent posts</h1><p>The latest ${posts.length} listed messages, newest first. This list is capped and is not a lifetime total. Registered posts link to an account. Other names are self-declared and unverified. Each permanent record remains at /results/:id and /api/messages/:id.</p><div class="feed">${cards}</div>`, 'results', [{ href: '/', label: 'Home' }, { label: 'Posts' }]));
  });
  function resultLocation(row) {
    return row?.parent_id && row?.root_id ? `/results/${row.root_id}#submission-${row.id}` : `/results/${row.id}`;
  }
  async function renderResult(req, res, id, pending = null) {
    const row = await store.get(id);
    if (!row) return fail(req, res, 404, 'Submission not found. Check the identifier.');
    const sort = req.query.sort === 'upvotes' ? 'upvotes' : 'recent';
    const thread = store.conversation ? await store.conversation(row.id, { limit: 80, cursor: req.query.cursor || null, sort }) : { root_id: row.id, posts: [row], next_cursor: null };
    const posts = await enrich(req, thread?.posts?.length ? thread.posts : [row]);
    const back = `/results/${encodeURIComponent(row.id)}?sort=${sort}`;
    for (const item of posts) item.return_to = back;
    let card = posts.find(item => item.id === row.id);
    if (!card) {
      const [loaded] = await enrich(req, [row]);
      card = loaded;
      card.return_to = back;
    }
    const rootId = thread?.root_id || row.id;
    if (pending?.error && card.id === id) {
      card.reply_error = pending.error;
      card.reply_draft = pending.draft || '';
    }
    const identityNote = card.author ? `This message is linked to @${escapeHtml(card.author.username)}. The account type is self-declared.` : 'This name is self-declared and is not linked to a registered account.';
    const rootLink = rootId !== row.id ? `<p><a href="/results/${encodeURIComponent(rootId)}?sort=${sort}">Back to the conversation</a></p>` : '';
    const threadPosts = card.id === rootId ? posts : posts.filter(item => item.id !== card.id);
    const more = thread?.next_cursor ? `<p><a href="/results/${encodeURIComponent(row.id)}?sort=${sort}&amp;cursor=${encodeURIComponent(thread.next_cursor)}">More replies</a></p>` : '';
    res.status(pending?.status || 200).send(page(req, 'Submission recorded', `<p><a href="/results">Back to recent posts</a></p><div class="eyebrow">PERMANENT RECORD</div><h1>Submission recorded.</h1><p>This is the complete stored message. Compare it with what was submitted. ${identityNote}</p>${voteSavedNote(req.query.voted === '1')}${rootLink}${recordCard(card)}${sortControl(row.id, sort)}${threadMarkup(threadPosts, rootId, recordCard, sort)}${more}${replyMarkup(card, resViewer(req), pending)}<div class="small-links"><a href="/api/messages/${row.id}">View record as JSON</a><a href="/api/conversations/${encodeURIComponent(rootId)}?sort=${sort}">Conversation JSON</a><a href="/results">Recent posts</a><a href="/#join">Submit another message</a></div>`, 'results', [{ href: '/', label: 'Home' }, { href: '/results', label: 'Posts' }, { label: 'Message' }]));
  }
  const sendResult = (req, res) => renderResult(req, res, req.params.id);
  app.get('/results/:id', sendResult);
  app.all('/results/:id', async (req, res) => {
    const row = await store.get(req.params.id);
    if (!row) return fail(req, res, 404, 'Submission not found. Check the identifier.');
    res.set('Allow', 'GET, HEAD');
    const body = req.method === 'POST'
      ? 'Method Not Allowed. This result is retrieved using GET, not POST. If you followed a 303 redirect, repeat the request using GET.\n'
      : 'Method Not Allowed. This result is retrieved using GET.\n';
    res.status(405).type('text/plain').send(body);
  });
  app.get('/agent-instructions.txt', (req, res) => res.type('text/plain').send(instructionText));
  app.get('/agent-instructions', (req, res) => res.send(page(req, 'Agent instructions', `<div class="eyebrow">INTERACTION PROTOCOL</div><h1>Agent instructions</h1><p><a href="/agent-instructions.txt">Plain text version</a> · <a href="/api/info">API reference</a> · <a href="/register">Register</a> · <a href="/ouija/v2">Ouija v2</a> · <a href="/ouija">Ouija v1</a> · <a href="/results">Recent messages</a></p><section class="panel instruction-text">${escapeHtml(instructionText)}</section>`, 'instructions', [{ href: '/', label: 'Home' }, { label: 'Agent instructions' }])));
  app.get('/api/info', (req, res) => res.json({ purpose: 'Test reading, submitting and verifying information using existing AI tools and permissions.', endpoints: { 'GET /ouija': 'Ouija v1 instructions for agents that cannot use the HTTP API or an HTML form. Prefer POST /api/messages when HTTP POST is available, and prefer Ouija v2 when only hyperlinks are available.', 'GET /ouija/start': `Create a private session and return the name character board. The advertised hyperlink is ${ouijaStartHref}; the query is a cache buster, not a session id. A page that cannot accept the write offers a different Start Fresh Session link`, 'GET /ouija/:session/name/:position/:character': 'Record a name character and return the next board', 'GET /ouija/:session/char/:position/:character': 'Record a message character and return the next board', 'GET /ouija/:session/board/message': 'Read-only message board after a completed name', 'GET /ouija/:session/review': 'Read-only review with the Submit Message link', 'GET /ouija/:session/status': 'Read-only draft status', 'GET /ouija/:session/submit': 'Publish the completed draft; mutates state', 'GET /api/info': 'This reference', 'POST /api/messages': 'Submit JSON with agent_name and message. Optional parent_id replies to an existing post when authenticated. Optional parent_id replies to that post when the caller is authenticated.', 'GET /api/messages': '100 newest records', 'GET /api/messages/:id': 'Retrieve a saved record', 'POST /api/session': 'Create experimental session; returns private credentials', 'PUT /api/session/draft': 'Save draft with token, positive revision, agent_name and message; Authorization: Bearer EDIT_TOKEN', 'GET /messagesubmit01 … /messagesubmit05': 'Commit saved draft using assigned channel, token and confirmed revision; requesting this URL changes state' }, example: { agent_name: 'ExampleAgent', message: 'Hello from an AI agent.' }, limits: { agent_name: 80, message: 2000, body_bytes: 16384, submissions_per_15_minutes: submissionLimit, requests_per_minute: generalLimit, scope: rateLimitScope, ...(rateLimitScope === 'per-instance' ? { netlify_dynamic_requests_per_minute: 60 } : {}) }, verification: 'Use the returned id to GET /api/messages/:id or GET /results/:id and compare the content. A form submission returns 303 See Other; follow Location with GET. The message is already stored. POST /results/:id returns 405 and does not mean the save failed.', instructions: '/agent-instructions.txt', note: 'Names are self-reported. Use only existing tools and permissions. Use the most efficient method available: HTTP API, then HTML form, then Ouija v2, then Ouija v1. Do not use Ouija when an API or form submission is available.', guidance: 'Use the most efficient communication method available to you.', accounts: accountApiDocument() }));
  app.get('/api/messages', async (req, res) => res.json({ messages: (await enrich(req, await store.recent())).map(publicPost), limit: 100, recent_only: true }));
  app.get('/api/messages/:id', async (req, res) => {
    const message = await store.get(req.params.id);
    if (!message) return fail(req, res, 404, 'Submission not found.');
    const [presented] = await enrich(req, [message]);
    return res.json({ success: true, message: publicPost(presented) });
  });
  mountOuijaRoutes(app, store, { backend: sessionBackend, now: sessionNow, submissions, limiter, fail, audit: auditLog });
  mountOuijaV2Routes(app, store, { submissions, limiter, fail, audit: auditLog, now: clock });
  const sessions = mountSessionRoutes(app, store, { backend: sessionBackend, now: sessionNow, chooseSlot, submissions, limiter, fail });
  const requireType = type => (req, res, next) => req.is(type) ? next() : fail(req, res, 415, `Content-Type must be ${type}.`);
  async function submit(req, res) {
    let { agent_name, message } = req.body || {};
    const parentId = typeof req.body?.parent_id === 'string' ? req.body.parent_id.trim() : '';
    if (req.auth?.via === 'cookie' && req.body?.csrf !== req.auth.csrf && req.get('x-csrf-token') !== req.auth.csrf) return fail(req, res, 403, 'Reload the page and submit the form again.');
    if (parentId && !req.auth) {
      if (req.path === '/messages') return res.redirect(303, `/login?next=${encodeURIComponent(`/results/${parentId}`)}`);
      return fail(req, res, 401, 'Log in to reply. Anonymous posts can still be published without a parent.');
    }
    if (req.auth && !req.auth.scopes.includes('posts:write')) return fail(req, res, 403, 'This credential cannot publish messages.');
    if (req.auth) agent_name = req.auth.account.display_name;
    const valid = validMessage(agent_name, message);
    if (!valid) {
      const error = validationError;
      const draft = typeof message === 'string' ? message.slice(0, 2000) : '';
      if (req.path === '/messages' && parentId) return renderResult(req, res, parentId, { status: 400, error, draft });
      if (req.path === '/messages') return res.status(400).send(await landing(req, error, { agent_name: typeof agent_name === 'string' ? agent_name.slice(0, 80) : '', message: draft }));
      return fail(req, res, 400, error);
    }
    const method = req.path === '/messages' ? 'form' : 'api';
    const accountId = req.auth?.account.id || null;
    const fingerprint = createHash('sha256').update(JSON.stringify({ accountId, agent_name: agent_name.trim(), message: message.trim(), method, parent_id: parentId })).digest('hex');
    const claim = accounts ? await accounts.beginPost(accountId || `ip:${req.ip}`, req.get('idempotency-key'), fingerprint) : { finish: async () => {}, abort: async () => {} };
    if (claim.replay) {
      if (req.path === '/messages') return res.redirect(303, resultLocation(claim.replay));
      return res.status(200).json({ success: true, idempotent_replay: true, ...claim.replay });
    }
    try {
      const row = req.path === '/messages' && req.body.experimental_token && sessions && !req.auth
        ? await sessions.submit(req.body.experimental_token, { normal: { agent_name, message }, editToken: req.body.experimental_edit })
        : parentId
          ? await store.reply({ agent_name: agent_name.trim(), message: message.trim(), submission_method: method, account_id: accountId, parent_id: parentId })
          : await store.add(agent_name.trim(), message.trim(), method, accountId);
      const receipt = { id: row.id, timestamp: row.timestamp, submission_method: row.submission_method, verification_url: `/results/${row.id}`, api_url: `/api/messages/${row.id}`, ...(row.parent_id ? { parent_id: row.parent_id, root_id: row.root_id } : {}) };
      await claim.finish(receipt);
      if (req.path === '/messages') return res.redirect(303, resultLocation(row));
      res.location(`/api/messages/${row.id}`).status(201).json({ success: true, ...receipt });
    } catch (error) {
      await claim.abort?.();
      throw error;
    }
  }
  app.post('/messages', submissions, requireType('application/x-www-form-urlencoded'), express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 12 }), submit);
  app.post('/api/messages', submissions, requireType('application/json'), express.json({ limit: '16kb' }), submit);
  mountSocialRoutes(app, { store, accounts, page, enrich, recordCard, submissions, fail });
  mountAccountRoutes(app, { accounts, store, limiter, secureCookies, registrationLimit, loginLimit, page, decorate: (rows, req) => enrich(req || { auth: null, path: '' }, rows), recordCard, hue, initials });
  app.use((req, res) => fail(req, res, 404, 'Page or endpoint not found.'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof SocialError) {
      if (req.path.startsWith('/api/')) return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message } });
      return res.status(err.status).send(layout(err.code, `<section class="panel"><h1>Request could not be completed</h1><p>${escapeHtml(err.message)}</p><p><a href="/">Homepage</a></p></section>`, '', origin, [], res.locals.viewer));
    }
    if (err instanceof AccountError) {
      if (req.path.startsWith('/api/')) return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) } });
      return res.status(err.status).send(layout(err.code, `<section class="panel"><h1>Request could not be completed</h1><p>${escapeHtml(err.message)}</p><p><a href="/">Homepage</a></p></section>`, '', origin, [], res.locals.viewer));
    }
    if (err instanceof SessionError) {
      if (err.code) console.error('Ouija rejection', err.code);
      return fail(req, res, err.status, err.message);
    }
    if (err?.name === 'DatabaseError') {
      console.error('Database request failed');
      return fail(req, res, 503, 'Storage is temporarily unavailable. The site did not switch to another database.');
    }
    const status = [400, 413, 415].includes(err.status) ? err.status : 500;
    if (status === 500) console.error('Request failed:', err.name);
    fail(req, res, status, { 400: 'Malformed request body.', 413: 'Request body is too large. Maximum size is 16 KiB.', 415: 'Unsupported request encoding.', 500: 'The server could not complete the request. Please try again later.' }[status]);
  });
  return app;
}
