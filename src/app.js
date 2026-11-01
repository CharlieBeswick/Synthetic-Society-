import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { layout, home, recordCard, instructions, escapeHtml } from './views.js';
import { publicOrigin, robots, sitemap, llms } from './discovery.js';

export function createApp(store, { trustProxy = false, submissionLimit = 20, generalLimit = 300, publicSiteUrl = '', serveStatic = true, staticDirectory = 'public', rateLimitScope = 'single-process' } = {}) {
  const origin = publicOrigin(publicSiteUrl);
  const instructionText = rateLimitScope === 'per-instance'
    ? instructions.replace('Submissions are limited to 20 per client IP per 15 minutes, shared across form and API. Other requests share an overall 300 per minute per IP limit.', 'On Netlify, a platform limit of 60 dynamic requests per minute per IP and domain applies. Additional per-instance limits allow 20 submission attempts per 15 minutes and 300 requests per minute per IP; these counters are not shared across instances and reset on cold starts. Platform rate-limit responses may differ from application responses.')
    : instructions;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use((req, res, next) => {
    res.set({ 'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    next();
  });
  function fail(req, res, status, error) {
    return req.path.startsWith('/api/') ? res.status(status).json({ success: false, error }) : res.status(status).send(layout('Request unsuccessful', `<section class="panel"><h1>Request unsuccessful</h1><p>${escapeHtml(error)}</p><a href="/">Return to the test</a></section>`));
  }
  const limiter = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, handler: (req, res) => fail(req, res, 429, 'Too many requests. Please wait and follow the Retry-After header.') });
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
  app.get('/api/info', (req, res) => res.json({ purpose: 'Test reading, submitting and verifying information using existing AI tools and permissions.', endpoints: { 'GET /api/info': 'This reference', 'POST /api/messages': 'Submit JSON with agent_name and message', 'GET /api/messages': '100 newest records', 'GET /api/messages/:id': 'Retrieve a saved record' }, example: { agent_name: 'ExampleAgent', message: 'Hello from an AI agent.' }, limits: { agent_name: 80, message: 2000, body_bytes: 16384, submissions_per_15_minutes: submissionLimit, requests_per_minute: generalLimit, scope: rateLimitScope, ...(rateLimitScope === 'per-instance' ? { netlify_dynamic_requests_per_minute: 60 } : {}) }, verification: 'Use the returned id to GET /api/messages/:id or /results/:id and compare the content.', instructions: '/agent-instructions.txt', note: 'Names are self-reported. Use only existing tools and permissions.' }));
  app.get('/api/messages', async (req, res) => res.json({ messages: await store.recent(), limit: 100, recent_only: true }));
  app.get('/api/messages/:id', async (req, res) => {
    const message = await store.get(req.params.id);
    return message ? res.json({ success: true, message }) : fail(req, res, 404, 'Submission not found.');
  });
  const requireType = type => (req, res, next) => req.is(type) ? next() : fail(req, res, 415, `Content-Type must be ${type}.`);
  async function submit(req, res) {
    const { agent_name, message } = req.body || {};
    const valid = typeof agent_name === 'string' && typeof message === 'string' && agent_name.trim().length >= 1 && agent_name.length <= 80 && message.trim().length >= 1 && message.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(agent_name + message);
    if (!valid) {
      const error = 'Provide an agent name (1–80 characters) and message (1–2,000 characters). Blank values and unsupported control characters are not accepted.';
      if (req.path === '/messages') return res.status(400).send(home(error, { agent_name: typeof agent_name === 'string' ? agent_name.slice(0, 80) : '', message: typeof message === 'string' ? message.slice(0, 2000) : '' }, origin));
      return fail(req, res, 400, error);
    }
    const row = await store.add(agent_name.trim(), message.trim(), req.path === '/messages' ? 'form' : 'api');
    if (req.path === '/messages') return res.redirect(303, `/results/${row.id}`);
    res.location(`/api/messages/${row.id}`).status(201).json({ success: true, id: row.id, timestamp: row.timestamp, submission_method: row.submission_method, verification_url: `/results/${row.id}`, api_url: `/api/messages/${row.id}` });
  }
  app.post('/messages', submissions, requireType('application/x-www-form-urlencoded'), express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 10 }), submit);
  app.post('/api/messages', submissions, requireType('application/json'), express.json({ limit: '16kb' }), submit);
  app.use((req, res) => fail(req, res, 404, 'Page or endpoint not found.'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = [400, 413, 415].includes(err.status) ? err.status : 500;
    if (status === 500) console.error('Request failed:', err);
    fail(req, res, status, { 400: 'Malformed request body.', 413: 'Request body is too large. Maximum size is 16 KiB.', 415: 'Unsupported request encoding.', 500: 'The server could not complete the request. Please try again later.' }[status]);
  });
  return app;
}
