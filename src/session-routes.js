import express from 'express';
import { createSessions, SessionError } from './sessions.js';
import { layout, recordCard } from './views.js';

export function mountSessionRoutes(app, messages, { backend, now, chooseSlot, submissions, limiter, fail }) {
  const sessions = backend ? createSessions(backend, messages, { now, chooseSlot }) : null;
  const sensitive = (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store, private', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer' });
    next();
  };
  app.use(['/api/session', /^\/messagesubmit0[1-5]$/], sensitive);
  const available = (req, res, next) => sessions ? next() : fail(req, res, 503, 'Experimental session storage is unavailable. Normal form and API submission remain available.');
  const json = express.json({ limit: '16kb' });
  const jsonType = (req, res, next) => req.is('application/json') ? next() : fail(req, res, 415, 'Content-Type must be application/json.');
  const handle = action => async (req, res, next) => {
    try { await action(req, res); } catch (error) {
      if (error instanceof SessionError) return fail(req, res, error.status, error.message);
      next(error);
    }
  };
  app.post('/api/session', limiter(15 * 60_000, 20), available, handle(async (req, res) => {
    const session = await sessions.create();
    res.status(201).json({ success: true, ...session, submission_path: `/messagesubmit${session.slot}` });
  }));
  app.put('/api/session/draft', limiter(60_000, 40), available, jsonType, json, handle(async (req, res) => {
    const { token, revision, agent_name, message } = req.body || {};
    const edit = req.get('authorization')?.replace(/^Bearer /, '');
    res.json({ success: true, ...await sessions.save(token, edit, revision, { agent_name, message }) });
  }));
  // HEAD must never fall through to Express's automatic GET handling.
  for (let i = 1; i <= 5; i++) {
    const slot = String(i).padStart(2, '0');
    const path = `/messagesubmit${slot}`;
    app.head(path, (req, res) => res.status(405).set('Allow', 'GET').end());
    app.get(path, submissions, available, handle(async (req, res) => {
      if (/prefetch|prerender|preview/i.test(`${req.get('purpose') || ''} ${req.get('sec-purpose') || ''} ${req.get('x-purpose') || ''}`)) return fail(req, res, 400, 'Prefetch and preview requests cannot trigger submission. Request the URL intentionally.');
      const record = await sessions.submit(req.query.token, { slot, revision: Number(req.query.revision) });
      if (req.accepts(['html', 'json']) === 'json') return res.json({ success: true, ...record, verification_url: `/results/${record.id}`, api_url: `/api/messages/${record.id}` });
      res.send(layout('Submission Successful', `<h1>Submission succeeded.</h1><p>Your prepared message has been saved. Repeated requests return this same record.</p>${recordCard(record)}<p><a href="/results/${record.id}">Individual result</a> · <a href="/api/messages/${record.id}">JSON verification</a></p>`));
    }));
  }
  return sessions;
}
