import { randomBytes } from 'node:crypto';
import { escapeHtml } from './views.js';

const hex = bytes => randomBytes(bytes).toString('hex');
export const createRunId = () => `run_${hex(6)}`;
export const createResponseId = () => `resp_${hex(4)}`;
export const createNavId = () => `nav_${hex(4)}`;
export const isRunId = value => typeof value === 'string' && /^run_[0-9a-f]{12}$/.test(value);
export const isResponseId = value => typeof value === 'string' && /^resp_[0-9a-f]{8}$/.test(value);
export const isNavId = value => typeof value === 'string' && /^nav_[0-9a-f]{8}$/.test(value);
export const navIdFrom = value => isNavId(value) ? value : null;
export const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const AUDIT_ROW_CAP = 2000;

const routes = new Set(['start', 'name', 'message', 'finish-name', 'review', 'status', 'submit', 'other']);

export function classifyOuijaPath(path) {
  const value = String(path || '');
  if (/^\/ouija\/start\/?$/i.test(value)) return { route: 'start', buffer: null, position: null };
  const name = value.match(/^\/ouija\/[^/]+\/name\/([^/]+)\/[^/]+$/i);
  if (name) return { route: 'name', buffer: 'name', position: safePosition(name[1]) };
  const message = value.match(/^\/ouija\/[^/]+\/char\/([^/]+)\/[^/]+$/i);
  if (message) return { route: 'message', buffer: 'message', position: safePosition(message[1]) };
  if (/^\/ouija\/[^/]+\/board\/message\/?$/i.test(value)) return { route: 'finish-name', buffer: null, position: null };
  if (/^\/ouija\/[^/]+\/review\/?$/i.test(value)) return { route: 'review', buffer: null, position: null };
  if (/^\/ouija\/[^/]+\/status(?:\.json)?\/?$/i.test(value)) return { route: 'status', buffer: null, position: null };
  if (/^\/ouija\/[^/]+\/submit\/?$/i.test(value)) return { route: 'submit', buffer: null, position: null };
  return { route: 'other', buffer: null, position: null };
}

function safePosition(value) {
  return /^[1-9]\d{0,3}$/.test(value) ? Number(value) : null;
}

export function buildAuditEvent(fields) {
  const route = routes.has(fields.route) ? fields.route : 'other';
  const buffer = fields.buffer === 'name' || fields.buffer === 'message' ? fields.buffer : null;
  const result = ['not_attempted', 'recorded', 'idempotent', 'rejected'].includes(fields.result) ? fields.result : 'not_attempted';
  return {
    schema: 1,
    at: fields.at,
    method: fields.method === 'HEAD' ? 'HEAD' : 'GET',
    route,
    run_id: isRunId(fields.run_id) ? fields.run_id : null,
    response_id: isResponseId(fields.response_id) ? fields.response_id : createResponseId(),
    recovery_of: isResponseId(fields.recovery_of) ? fields.recovery_of : null,
    nav_id: navIdFrom(fields.nav_id),
    followed_nav_id: navIdFrom(fields.followed_nav_id),
    status: Number.isInteger(fields.status) ? fields.status : 0,
    code: typeof fields.code === 'string' && /^OUIJA_[A-Z_]+$/.test(fields.code) ? fields.code : '',
    buffer,
    position: Number.isInteger(fields.position) ? fields.position : null,
    expected_position: Number.isInteger(fields.expected_position) ? fields.expected_position : null,
    mutation: fields.mutation === 'attempted' ? 'attempted' : 'none',
    result,
    duration_ms: Number.isFinite(fields.duration_ms) ? Math.max(0, Math.round(fields.duration_ms)) : 0
  };
}

export function correlateEvents(events) {
  const minted = new Map();
  return events.map(event => {
    const copy = { ...event };
    if (copy.followed_nav_id && minted.has(copy.followed_nav_id)) copy.origin_response_id = minted.get(copy.followed_nav_id);
    if (copy.nav_id) minted.set(copy.nav_id, copy.response_id);
    return copy;
  });
}

export function diagnosticsBlock({ responseId, navId, runId, generated, created, expires, state, nameCount, messageCount, nextLabel, nextPosition }) {
  const line = value => value === null || value === undefined || value === '' ? 'unavailable' : String(value);
  const text = [
    'Ouija Protocol — Phase 1.4 Diagnostics',
    '',
    `Experiment run: ${line(isRunId(runId) ? runId : null)}`,
    `Response: ${line(responseId)}`,
    `Navigation: ${line(navIdFrom(navId))}`,
    `Generated: ${line(generated)}`,
    `Session created: ${line(created)}`,
    `Session expires: ${line(expires)}`,
    '',
    `State: ${line(state)}`,
    `Name characters: ${line(nameCount)}`,
    `Message characters: ${line(messageCount)}`,
    `${nextLabel || 'Next position'}: ${line(nextPosition)}`
  ].join('\n');
  return `<pre id="ouija-diagnostics">${escapeHtml(text)}</pre>`;
}

export function summarizeRuns(events, limit = 50) {
  const runs = new Map();
  for (const event of events) {
    if (!isRunId(event.run_id)) continue;
    const row = runs.get(event.run_id) || { run_id: event.run_id, created: event.at, last_at: event.at, requests: 0, writes: 0, conflicts: 0, last_route: event.route, last_status: event.status, last_result: event.result };
    row.requests += 1;
    if (event.at < row.created) row.created = event.at;
    if (event.at >= row.last_at) { row.last_at = event.at; row.last_route = event.route; row.last_status = event.status; row.last_result = event.result; }
    if (event.result === 'recorded' && (event.route === 'name' || event.route === 'message')) row.writes += 1;
    if (event.status === 409) row.conflicts += 1;
    runs.set(event.run_id, row);
  }
  return [...runs.values()].sort((a, b) => b.last_at.localeCompare(a.last_at)).slice(0, limit);
}

export function formatRun(events) {
  return correlateEvents(events).map(event => [
    event.at,
    event.run_id || '-',
    event.method,
    event.route,
    event.buffer || '-',
    `pos ${event.position ?? '-'}`,
    `expected ${event.expected_position ?? '-'}`,
    event.status,
    event.code || event.result,
    event.response_id,
    event.nav_id ? `advertises ${event.nav_id}` : 'advertises -',
    event.followed_nav_id ? `followed ${event.followed_nav_id}` : 'followed -',
    event.origin_response_id ? `origin ${event.origin_response_id}` : 'origin -',
    event.recovery_of ? `recovery ${event.recovery_of}` : 'recovery -'
  ].join(' ')).join('\n');
}

export async function writeAudit(audit, fields) {
  if (!audit?.append) return;
  try { await audit.append(buildAuditEvent(fields)); }
  catch (error) { console.error('Ouija audit failed', error.name); }
}
