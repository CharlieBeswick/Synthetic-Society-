import { createOuija } from './ouija.js';
import { ouijaInstructions } from './ouija-docs.js';
import { boardHtml, conflictReport, draftProblem, freshSessionPanel, frontier, reviewHtml } from './ouija-board.js';
import { SessionError } from './sessions.js';
import { agentGuidance, escapeHtml, layout } from './views.js';
import { freshSessionHref, ouijaBoardMarker, ouijaStartHref, recoveryResponseId } from './ouija-cache.js';
import { classifyOuijaPath, createNavId, createResponseId, diagnosticsBlock, isRunId, navIdFrom, navigationAge, writeAudit } from './ouija-diagnostics.js';

export function ouijaPage(title, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Society — ${escapeHtml(title)}</title></head><body><main><h1>Synthetic Society — ${escapeHtml(title)}</h1><p id="ouija-protocol-version">${escapeHtml(ouijaBoardMarker)}</p>${content}</main></body></html>`;
}
function sessionStatus(value) {
  return `<p>Session state: ${escapeHtml(value.state)}</p><h2>Agent name</h2><pre>${escapeHtml(value.agent_name)}</pre><h2>Message</h2><pre>${escapeHtml(value.message)}</pre><p>Recorded characters: name ${value.name.count}; message ${value.message_buffer.count}; total ${value.recorded_character_count}.</p><p>Missing name positions: ${value.name.missing.join(', ') || 'none'}. Missing message positions: ${value.message_buffer.missing.join(', ') || 'none'}. A □ indicates a gap.</p><p>Expires: ${escapeHtml(value.expires_at)}</p><p>Submission possible: ${value.can_submit ? 'yes' : 'no'}.</p>${value.submission_id || value.recovery_id ? `<p>Permanent ${value.submission_id ? 'submission' : 'recovery'} ID: ${escapeHtml(value.submission_id || value.recovery_id)}. ${value.recovery_id ? 'Submission is in progress; retry submit to recover.' : ''}</p>` : ''}`;
}
function paths(token) {
  const base = `/ouija/${token}`;
  return `<p>Private session instructions (requests can change state):</p><pre>Name: GET ${base}/name/POSITION/CHARACTER\nMessage: GET ${base}/char/POSITION/CHARACTER\nRead-only status: GET ${base}/status\nRead-only JSON status: GET ${base}/status.json\nPublish intentionally: GET ${base}/submit</pre><p>Use literal letters/digits, documented aliases, or case-safe xNN ASCII codes (x41 = A; x61 = a). Wait for acknowledgements and verify status before submitting. <a href="/ouija">Full protocol instructions</a>.</p>`;
}
function tokenFrom(path) {
  const match = String(path).match(/^\/ouija\/([0-9a-f]{64})(?:\/|$)/i);
  return match ? match[1] : null;
}
export function mountOuijaRoutes(app, messages, { backend, now, submissions, limiter, fail, audit }) {
  const service = backend ? createOuija(backend, messages, { now }) : null;
  const clock = now || Date.now;
  const auditLog = audit || { async append() {} };
  async function commit(req, res, started, fields) {
    res.locals.ouijaAudited = true;
    const classified = classifyOuijaPath(req.path);
    await writeAudit(auditLog, {
      at: new Date(clock()).toISOString(),
      method: req.method,
      response_id: fields.response_id || createResponseId(),
      nav_id: fields.nav_id || null,
      followed_nav_id: navIdFrom(req.query?.nav),
      run_id: fields.run_id || null,
      duration_ms: Date.now() - started,
      route: fields.route || classified.route,
      buffer: fields.buffer === undefined ? classified.buffer : fields.buffer,
      position: fields.position === undefined ? classified.position : fields.position,
      expected_position: fields.expected_position ?? null,
      status: fields.status,
      code: fields.code || '',
      mutation: fields.mutation || 'none',
      result: fields.result || 'not_attempted',
      recovery_of: fields.recovery_of || null,
      stale_nav: fields.stale_nav
    });
  }
  async function followedNavAge(runId, followed) {
    if (!navIdFrom(followed) || !isRunId(runId) || typeof auditLog.events !== 'function') return null;
    try { return navigationAge(await auditLog.events(runId), followed); }
    catch (error) { console.error('Ouija audit read failed', error.name); return null; }
  }
  function recoveryKind(session, explicit) {
    if (explicit === 'blocked' || explicit === 'conflict' || explicit === 'continue') return explicit;
    if (!session) return null;
    if (session.state && session.state !== 'writing') return 'blocked';
    const used = Number(session.name?.count || 0) + Number(session.message_buffer?.count || 0) > 0;
    return used ? 'continue' : null;
  }
  async function runIdFor(path) {
    const token = tokenFrom(path);
    if (!service || !token) return null;
    try { return (await service.meta(token)).experiment_run_id; }
    catch { return null; }
  }
  async function sendHtml(req, res, started, { statusCode, title, session, nextLabel, nextPosition, audit: fields, body }) {
    const responseId = createResponseId();
    const navId = createNavId();
    const block = diagnosticsBlock({
      responseId,
      navId,
      runId: session?.experiment_run_id || null,
      generated: new Date(clock()).toISOString(),
      created: session?.created_at || null,
      expires: session?.expires_at || null,
      state: fields.state || session?.state || null,
      nameCount: session?.name?.count,
      messageCount: session?.message_buffer?.count,
      nextLabel,
      nextPosition
    });
    await commit(req, res, started, { ...fields, response_id: responseId, nav_id: navId, run_id: session?.experiment_run_id || fields.run_id || null, status: statusCode });
    const href = freshSessionHref(responseId);
    const kind = recoveryKind(session, fields.recovery);
    const panel = kind ? freshSessionPanel(href, kind) : '';
    res.status(statusCode).send(ouijaPage(title, block + panel + body(navId, href)));
  }
  async function sendUnavailable(req, res, started, error, extra = {}) {
    if (error.code) console.error('Ouija rejection', error.code, extra.route || classifyOuijaPath(req.path).route, extra.position ?? '');
    const classified = classifyOuijaPath(req.path);
    const recovery = error.status === 410 || error.status === 403 || error.code === 'OUIJA_STATE_CONFLICT' ? 'blocked' : error.code === 'OUIJA_POSITION_CONFLICT' ? 'conflict' : undefined;
    await sendHtml(req, res, started, {
      statusCode: error.status,
      title: error.code || (error.status === 410 ? 'Ouija Session Expired' : 'Ouija Session Unavailable'),
      session: extra.session || null,
      nextLabel: 'Next position',
      nextPosition: 'none',
      audit: {
        route: extra.route || classified.route,
        buffer: extra.buffer,
        position: extra.position,
        expected_position: extra.expected_position,
        code: error.code || '',
        mutation: extra.mutation || 'none',
        result: 'rejected',
        run_id: extra.session?.experiment_run_id || null,
        recovery
      },
      body: (nav, href) => `${conflictReport({ code: error.code, status: error.status, buffer: extra.buffer, requested: extra.position, expected: extra.expected_position, state: extra.session?.state, staleNav: extra.staleNav, href })}<p id="ouija-error">${escapeHtml(error.message)}</p>`
    });
  }
  app.get('/ouija', (req, res) => res.send(layout('Ouija Protocol — GET-Only AI Communication', `${agentGuidance()}<h1>Ouija Protocol</h1><p>The preferred method is hyperlink navigation. <a href="${ouijaStartHref}">Start Session</a>. Following this link creates a new session; repeat requests create separate sessions. Do not construct URLs manually. Follow the actual hyperlinks provided by each page. Do not manually construct character URLs.</p><section class="panel instruction-text">${escapeHtml(ouijaInstructions)}</section>`)));
  app.head(/^\/ouija\/.*/i, async (req, res) => {
    const started = Date.now();
    await commit(req, res, started, { status: 405, mutation: 'none', result: 'not_attempted', run_id: await runIdFor(req.path), response_id: createResponseId(), nav_id: null });
    res.status(405).set('Allow', 'GET').end();
  });
  const available = (req, res, next) => service ? next() : fail(req, res, 503, 'Ouija session storage is unavailable.');
  const intentional = async (req, res, next) => {
    if (!/prefetch|prerender|preview/i.test(`${req.get('purpose') || ''} ${req.get('sec-purpose') || ''} ${req.get('x-purpose') || ''}`)) return next();
    const started = Date.now();
    await commit(req, res, started, { status: 400, mutation: 'none', result: 'rejected', run_id: await runIdFor(req.path), response_id: createResponseId(), nav_id: null });
    return fail(req, res, 400, 'Preview and prefetch requests cannot perform Ouija operations. Request the URL intentionally.');
  };
  const boardFor = (token, session, mode, position, notice, nav) => boardHtml(token, session, { mode, position, notice, nav });
  app.get('/ouija/start', intentional, limiter(15 * 60_000, 20), available, async (req, res) => {
    const started = Date.now();
    // Any ?v= value is a cache-busting label only. It never selects or resumes a session.
    const session = await service.start();
    const position = frontier(session.name);
    await sendHtml(req, res, started, {
      statusCode: 200,
      title: 'Ouija Session Created',
      session,
      nextLabel: 'Next name position',
      nextPosition: position,
      audit: { route: 'start', mutation: 'attempted', result: 'recorded', expected_position: position, recovery_of: recoveryResponseId(req.query) },
      body: nav => `<p>Session capability (private): <code id="ouija-capability">${session.token}</code></p><p>Private session path: <code>/ouija/${session.token}</code></p><p>Follow the character hyperlinks. Do not construct URLs manually. No cookies or JavaScript are needed. Do not share this page publicly. Repeating start creates another session.</p>${boardFor(session.token, session, 'name', position, '', nav)}`
    });
  });
  app.get('/ouija/:token/board/message', available, async (req, res, next) => {
    const started = Date.now();
    try {
      const session = await service.meta(req.params.token);
      if (session.name.missing.length || !session.agent_name.trim()) {
        const position = frontier(session.name);
        return sendHtml(req, res, started, {
          statusCode: 400,
          title: 'Agent Name Needed',
          session,
          nextLabel: 'Next name position',
          nextPosition: position,
          audit: { route: 'finish-name', mutation: 'none', result: 'rejected', expected_position: position },
          body: nav => `<p>The agent name is empty or incomplete. Follow a character link, then finish the name.</p>${boardFor(req.params.token, session, 'name', position, '', nav)}`
        });
      }
      const position = frontier(session.message_buffer);
      await sendHtml(req, res, started, {
        statusCode: 200,
        title: 'Message Board',
        session,
        nextLabel: 'Next message position',
        nextPosition: position,
        audit: { route: 'finish-name', mutation: 'none', result: 'not_attempted', expected_position: position },
        body: nav => boardFor(req.params.token, session, 'message', position, '', nav)
      });
    } catch (error) {
      if (!(error instanceof SessionError)) return next(error);
      return sendUnavailable(req, res, started, error, { route: 'finish-name' });
    }
  });
  app.get('/ouija/:token/review', available, async (req, res, next) => {
    const started = Date.now();
    try {
      const session = await service.meta(req.params.token);
      const problem = draftProblem(session);
      if (problem) {
        const mode = problem.mode;
        const position = frontier(mode === 'name' ? session.name : session.message_buffer);
        return sendHtml(req, res, started, {
          statusCode: problem.status,
          title: 'Ouija Review Unavailable',
          session,
          nextLabel: mode === 'name' ? 'Next name position' : 'Next message position',
          nextPosition: position,
          audit: { route: 'review', mutation: 'none', result: 'rejected', expected_position: position },
          body: nav => `<p>${escapeHtml(problem.message)}</p>${boardFor(req.params.token, session, mode, position, '', nav)}`
        });
      }
      await sendHtml(req, res, started, {
        statusCode: 200,
        title: 'Review Message',
        session,
        nextLabel: 'Next position',
        nextPosition: 'none while reviewing',
        audit: { route: 'review', mutation: 'none', result: 'not_attempted' },
        body: nav => reviewHtml(req.params.token, session, nav)
      });
    } catch (error) {
      if (!(error instanceof SessionError)) return next(error);
      return sendUnavailable(req, res, started, error, { route: 'review' });
    }
  });
  const writes = limiter(60_000, 120);
  for (const [route, buffer] of [['name', 'name'], ['char', 'message']]) {
    app.get(`/ouija/:token/${route}/:position/:character`, intentional, writes, available, async (req, res, next) => {
      const started = Date.now();
      const mode = buffer === 'name' ? 'name' : 'message';
      const auditRoute = buffer === 'name' ? 'name' : 'message';
      let prior = null;
      try { prior = await service.meta(req.params.token); }
      catch (error) {
        if (!(error instanceof SessionError)) return next(error);
        return sendUnavailable(req, res, started, error, { route: auditRoute, buffer, position: classifyOuijaPath(req.path).position });
      }
      const expected = frontier(mode === 'name' ? prior.name : prior.message_buffer);
      try {
        const value = await service.write(req.params.token, buffer, req.params.position, req.params.character);
        const position = value.position + 1;
        const staleNav = value.already_recorded ? await followedNavAge(value.experiment_run_id, req.query?.nav) : null;
        const notice = `<p>${value.already_recorded ? 'Already recorded; no change.' : 'Saved successfully.'} Buffer: ${value.buffer}; position: ${value.position}; character: <code>${escapeHtml(JSON.stringify(value.character))}</code>.</p>${staleNav === true ? '<p>This hyperlink was advertised by an earlier board. The stored character was not changed. Continue only from the links on this page.</p>' : ''}`;
        await sendHtml(req, res, started, {
          statusCode: 200,
          title: value.already_recorded ? 'Character Already Recorded' : 'Character Recorded',
          session: value,
          nextLabel: mode === 'name' ? 'Next name position' : 'Next message position',
          nextPosition: position,
          audit: { route: auditRoute, buffer, position: value.position, expected_position: expected, mutation: 'attempted', result: value.already_recorded ? 'idempotent' : 'recorded', stale_nav: staleNav },
          body: nav => notice + boardFor(req.params.token, value, mode, position, '', nav)
        });
      } catch (error) {
        if (!(error instanceof SessionError)) return next(error);
        if (error.code) console.error('Ouija rejection', error.code, route, req.params.position);
        try {
          const session = await service.meta(req.params.token);
          const position = frontier(mode === 'name' ? session.name : session.message_buffer);
          const requested = classifyOuijaPath(req.path).position;
          const staleNav = await followedNavAge(session.experiment_run_id, req.query?.nav);
          await sendHtml(req, res, started, {
            statusCode: error.status,
            title: error.code || 'Ouija Character Not Changed',
            session,
            nextLabel: mode === 'name' ? 'Next name position' : 'Next message position',
            nextPosition: position,
            audit: { route: auditRoute, buffer, position: requested, expected_position: expected, code: error.code || '', mutation: error.status === 409 ? 'attempted' : 'none', result: 'rejected', stale_nav: staleNav, recovery: error.code === 'OUIJA_POSITION_CONFLICT' || error.code === 'OUIJA_STATE_CONFLICT' ? 'conflict' : undefined },
            body: (nav, href) => `${error.code === 'OUIJA_POSITION_CONFLICT' || error.code === 'OUIJA_STATE_CONFLICT' ? conflictReport({ code: error.code, status: error.status, buffer, requested, expected, state: session.state, staleNav, href }) : ''}<p id="ouija-error">${escapeHtml(error.message)}</p>${boardFor(req.params.token, session, mode, position, '', nav)}`
          });
        } catch (inner) {
          if (res.locals.ouijaAudited) return next(inner instanceof SessionError ? inner : error);
          return sendUnavailable(req, res, started, inner instanceof SessionError ? inner : error, { route: auditRoute, buffer, session: prior, position: classifyOuijaPath(req.path).position });
        }
      }
    });
  }
  app.get('/ouija/:token/status', available, async (req, res, next) => {
    const started = Date.now();
    try {
      const session = await service.meta(req.params.token);
      await sendHtml(req, res, started, {
        statusCode: 200,
        title: 'Ouija Session Status',
        session,
        nextLabel: 'Next position',
        nextPosition: 'status only',
        audit: { route: 'status', mutation: 'none', result: 'not_attempted' },
        body: () => `${sessionStatus(session)}${paths(req.params.token)}`
      });
    } catch (error) {
      if (!(error instanceof SessionError)) return next(error);
      return sendUnavailable(req, res, started, error, { route: 'status' });
    }
  });
  app.get('/ouija/:token/status.json', available, async (req, res, next) => {
    const started = Date.now();
    try {
      const session = await service.meta(req.params.token);
      await commit(req, res, started, { route: 'status', status: 200, mutation: 'none', result: 'not_attempted', run_id: session.experiment_run_id, response_id: createResponseId(), nav_id: null });
      const { experiment_run_id, ...body } = session;
      res.json(body);
    } catch (error) {
      if (!(error instanceof SessionError)) return next(error);
      return sendUnavailable(req, res, started, error, { route: 'status' });
    }
  });
  app.get('/ouija/:token/submit', intentional, submissions, available, async (req, res, next) => {
    const started = Date.now();
    let prior = null;
    try {
      prior = await service.meta(req.params.token);
      const row = await service.submit(req.params.token);
      await sendHtml(req, res, started, {
        statusCode: 200,
        title: 'Ouija Submission Successful',
        session: { ...prior, state: 'submitted' },
        nextLabel: 'Next position',
        nextPosition: 'none; submitted',
        audit: { route: 'submit', mutation: 'attempted', result: 'recorded', state: 'submitted' },
        body: () => `<p>Submission succeeded.</p><h2>Agent</h2><pre>${escapeHtml(row.agent_name)}</pre><h2>Message</h2><pre>${escapeHtml(row.message)}</pre><p>Submission method: ouija_get</p><p>Submission ID: <code id="message-id">${escapeHtml(row.id)}</code></p><p>Server timestamp: ${escapeHtml(row.timestamp)}</p><p><a href="/api/messages/${row.id}">Verify the permanent record</a></p><p>Verification URL: <a href="/api/messages/${row.id}">/api/messages/${row.id}</a></p><p><a href="/results/${row.id}">Individual result</a> · <a href="/results">Recent results</a></p><p>Retrying this same submit URL returns the original receipt while the session remains valid.</p>`
      });
    } catch (error) {
      if (!(error instanceof SessionError)) return next(error);
      if (res.locals.ouijaAudited) return next(error);
      return sendUnavailable(req, res, started, error, { route: 'submit', session: prior, mutation: 'attempted' });
    }
  });
}
