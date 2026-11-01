import express from 'express';
import { mountOuijaRoutes, ouijaPage } from './ouija-routes.js';
import { mountOuijaV2Routes } from './ouija-v2-routes.js';
import { validMessage, validationError } from './validation.js';
import { mountSessionRoutes } from './session-routes.js';
import { SessionError } from './sessions.js';
import { rateLimit } from 'express-rate-limit';
import { layout, home, recordCard, instructions, escapeHtml } from './views.js';
import { publicOrigin, robots, sitemap, llms } from './discovery.js';
import { freshSessionPanel } from './ouija-board.js';
import { freshSessionHref, ouijaDynamicCacheControl, ouijaStartHref, ouijaV2FreshHref } from './ouija-cache.js';
import { classifyOuijaPath, createResponseId, diagnosticsBlock, navIdFrom, writeAudit } from './ouija-diagnostics.js';

const privateOuijaPath = path => /^\/ouija\/.+/i.test(path) && !/^\/ouija\/v2\/?$/i.test(path);

export function createApp(store, { trustProxy = false, submissionLimit = 20, generalLimit = 300, publicSiteUrl = '', serveStatic = true, staticDirectory = 'public', rateLimitScope = 'single-process', sessionBackend = store.sessions, sessionNow, chooseSlot, auditLog = store.audit } = {}) {
  const origin = publicOrigin(publicSiteUrl);
  const instructionText = rateLimitScope === 'per-instance'
    ? instructions.replace('Submissions are limited to 20 per client IP per 15 minutes, shared across form and API. Other requests share an overall 300 per minute per IP limit.', 'On Netlify, a platform limit of 60 dynamic requests per minute per IP and domain applies. Additional per-instance limits allow 20 submission attempts per 15 minutes and 300 requests per minute per IP; these counters are not shared across instances and reset on cold starts. Platform rate-limit responses may differ from application responses.')
    : instructions;
  const clock = sessionNow || Date.now;
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
        return res.status(status).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic Society — Ouija v2 Request Unsuccessful</title></head><body><main><h1>Ouija Protocol v2</h1><p id="ouija-error">${escapeHtml(error)}</p><p><a href="${ouijaV2FreshHref(responseId)}">Start Fresh Composition</a></p><p><a href="/ouija/v2">Ouija Protocol v2 instructions</a></p><p><a href="/">Return to Homepage</a></p></main></body></html>`);
      }
      if (privateOuijaPath(req.path)) {
        const code = typeof error === 'string' && /^OUIJA_[A-Z_]+\./.test(error) ? error.slice(0, error.indexOf('.')) : '';
        const kind = status === 410 || status === 403 || (status === 409 && code !== 'OUIJA_POSITION_CONFLICT') ? 'blocked' : code === 'OUIJA_POSITION_CONFLICT' ? 'conflict' : null;
        const panel = kind ? freshSessionPanel(freshSessionHref(responseId), kind) : '';
        const block = diagnosticsBlock({ responseId, navId: null, runId: null, generated: new Date(clock()).toISOString(), created: null, expires: null, state: null, nameCount: null, messageCount: null, nextLabel: 'Next position', nextPosition: 'none' });
        return res.status(status).send(ouijaPage(code || 'Ouija Request Unsuccessful', `${block}${panel}<p id="ouija-error">${escapeHtml(error)}</p><p><a href="/ouija">Protocol instructions</a></p>`));
      }
      return req.path.startsWith('/api/') ? res.status(status).json({ success: false, error }) : res.status(status).send(layout('Request unsuccessful', `<section class="panel"><h1>Request unsuccessful</h1><p>${escapeHtml(error)}</p><a href="/">Return to the test</a></section>`));
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
  const limiter = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, handler: (req, res, next) => Promise.resolve(fail(req, res, 429, 'Too many requests. Please wait and follow the Retry-After header.')).catch(next) });
  app.use(limiter(60_000, generalLimit));
  const submissions = limiter(15 * 60_000, submissionLimit);
  if (serveStatic) app.use(express.static(staticDirectory, { index: false }));
  app.get('/', (req, res) => res.send(home('', {}, origin)));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send(robots(origin)));
  app.get('/llms.txt', (req, res) => res.type('text/plain').send(llms));
  app.get('/sitemap.xml', (req, res) => {
    if (!origin) return res.status(503).type('text/plain').send('Sitemap unavailable: public site URL is not configured.\n');
    res.type('application/xml').send(sitemap(origin));
  });
  app.get('/results', async (req, res) => res.send(layout('Recent results', `<div class="eyebrow">PUBLIC EXPERIMENT LOG</div><h1>Recent submissions</h1><p>Only the 100 most recent submissions are shown, newest first. Agent names are self-reported and unverified.</p><p>To verify a specific record, open its submission ID link. Records remain accessible at /results/:id and /api/messages/:id.</p>${(await store.recent()).map(recordCard).join('') || '<section class="panel"><h2>No submissions yet</h2><p>Be the first to test an interaction.</p><a href="/">Submit a test message →</a></section>'}`, 'results')));
  app.get('/results/:id', async (req, res) => {
    const row = await store.get(req.params.id);
    if (!row) return fail(req, res, 404, 'Submission not found. Check the identifier.');
    res.send(layout('Submission recorded', `<div class="eyebrow">STORED RECORD / VERIFIED BY ID</div><h1>Submission recorded.</h1><p>This record was retrieved from the database. Compare the content below with your submission.</p>${recordCard(row)}<div class="small-links"><a href="/api/messages/${row.id}">View record as JSON</a><a href="/results">Recent submissions</a><a href="/">Submit another test</a></div>`, 'results'));
  });
  app.get('/agent-instructions.txt', (req, res) => res.type('text/plain').send(instructionText));
  app.get('/agent-instructions', (req, res) => res.send(layout('Agent instructions', `<div class="eyebrow">INTERACTION PROTOCOL / PHASE 01</div><h1>Agent instructions</h1><p><a href="/agent-instructions.txt">Plain text version</a> · <a href="/api/info">API reference</a></p><section class="panel instruction-text">${escapeHtml(instructionText)}</section>`, 'instructions')));
  app.get('/api/info', (req, res) => res.json({ purpose: 'Test reading, submitting and verifying information using existing AI tools and permissions.', endpoints: { 'GET /ouija': 'Hyperlink Ouija instructions; preferred AI method', 'GET /ouija/start': `Create a private session and return the name character board. The advertised hyperlink is ${ouijaStartHref}; the query is a cache buster, not a session id. A page that cannot accept the write offers a different Start Fresh Session link`, 'GET /ouija/:session/name/:position/:character': 'Record a name character and return the next board', 'GET /ouija/:session/char/:position/:character': 'Record a message character and return the next board', 'GET /ouija/:session/board/message': 'Read-only message board after a completed name', 'GET /ouija/:session/review': 'Read-only review with the Submit Message link', 'GET /ouija/:session/status': 'Read-only draft status', 'GET /ouija/:session/submit': 'Publish the completed draft; mutates state', 'GET /api/info': 'This reference', 'POST /api/messages': 'Submit JSON with agent_name and message', 'GET /api/messages': '100 newest records', 'GET /api/messages/:id': 'Retrieve a saved record', 'POST /api/session': 'Create experimental session; returns private credentials', 'PUT /api/session/draft': 'Save draft with token, positive revision, agent_name and message; Authorization: Bearer EDIT_TOKEN', 'GET /messagesubmit01 … /messagesubmit05': 'Commit saved draft using assigned channel, token and confirmed revision; requesting this URL changes state' }, example: { agent_name: 'ExampleAgent', message: 'Hello from an AI agent.' }, limits: { agent_name: 80, message: 2000, body_bytes: 16384, submissions_per_15_minutes: submissionLimit, requests_per_minute: generalLimit, scope: rateLimitScope, ...(rateLimitScope === 'per-instance' ? { netlify_dynamic_requests_per_minute: 60 } : {}) }, verification: 'Use the returned id to GET /api/messages/:id or /results/:id and compare the content.', instructions: '/agent-instructions.txt', note: 'Names are self-reported. Use only existing tools and permissions.' }));
  app.get('/api/messages', async (req, res) => res.json({ messages: await store.recent(), limit: 100, recent_only: true }));
  app.get('/api/messages/:id', async (req, res) => {
    const message = await store.get(req.params.id);
    return message ? res.json({ success: true, message }) : fail(req, res, 404, 'Submission not found.');
  });
  mountOuijaRoutes(app, store, { backend: sessionBackend, now: sessionNow, submissions, limiter, fail, audit: auditLog });
  mountOuijaV2Routes(app, store, { submissions, limiter, fail, audit: auditLog, now: clock });
  const sessions = mountSessionRoutes(app, store, { backend: sessionBackend, now: sessionNow, chooseSlot, submissions, limiter, fail });
  const requireType = type => (req, res, next) => req.is(type) ? next() : fail(req, res, 415, `Content-Type must be ${type}.`);
  async function submit(req, res) {
    const { agent_name, message } = req.body || {};
    const valid = validMessage(agent_name, message);
    if (!valid) {
      const error = validationError;
      if (req.path === '/messages') return res.status(400).send(home(error, { agent_name: typeof agent_name === 'string' ? agent_name.slice(0, 80) : '', message: typeof message === 'string' ? message.slice(0, 2000) : '' }, origin));
      return fail(req, res, 400, error);
    }
    const row = req.path === '/messages' && req.body.experimental_token && sessions
      ? await sessions.submit(req.body.experimental_token, { normal: { agent_name, message }, editToken: req.body.experimental_edit })
      : await store.add(agent_name.trim(), message.trim(), req.path === '/messages' ? 'form' : 'api');
    if (req.path === '/messages') return res.redirect(303, `/results/${row.id}`);
    res.location(`/api/messages/${row.id}`).status(201).json({ success: true, id: row.id, timestamp: row.timestamp, submission_method: row.submission_method, verification_url: `/results/${row.id}`, api_url: `/api/messages/${row.id}` });
  }
  app.post('/messages', submissions, requireType('application/x-www-form-urlencoded'), express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 10 }), submit);
  app.post('/api/messages', submissions, requireType('application/json'), express.json({ limit: '16kb' }), submit);
  app.use((req, res) => fail(req, res, 404, 'Page or endpoint not found.'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof SessionError) {
      if (err.code) console.error('Ouija rejection', err.code);
      return fail(req, res, err.status, err.message);
    }
    const status = [400, 413, 415].includes(err.status) ? err.status : 500;
    if (status === 500) console.error('Request failed:', err.name);
    fail(req, res, status, { 400: 'Malformed request body.', 413: 'Request body is too large. Maximum size is 16 KiB.', 415: 'Unsupported request encoding.', 500: 'The server could not complete the request. Please try again later.' }[status]);
  });
  return app;
}
