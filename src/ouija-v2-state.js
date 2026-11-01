import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { aliases } from './ouija.js';
import { SessionError } from './sessions.js';

export const NAME_LIMIT = 80;
export const MESSAGE_LIMIT = 2000;
const allowed = /^[A-Za-z0-9 .,?!':;()\-\n]$/;
const phases = ['name', 'message', 'review'];
const punctuationLabels = {
  space: 'Space', period: 'Period', comma: 'Comma', question: 'Question mark', exclamation: 'Exclamation',
  apostrophe: 'Apostrophe', colon: 'Colon', semicolon: 'Semicolon', hyphen: 'Hyphen', openparen: 'Open parenthesis',
  closeparen: 'Close parenthesis', newline: 'Newline'
};

export const v2Characters = [
  ...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'].map(symbol => ({ symbol, label: symbol, value: symbol })),
  ...Object.keys(aliases).map(symbol => ({ symbol, label: punctuationLabels[symbol], value: aliases[symbol] }))
];

const fail = (status, message, code) => { throw new SessionError(status, message, code); };
const hashPattern = /^[0-9a-f]{64}$/;

export function isCompositionId(value) {
  return typeof value === 'string' && /^cmp_[A-Za-z0-9_-]{22}$/.test(value);
}

export function createCompositionId() {
  return `cmp_${randomBytes(16).toString('base64url')}`;
}

export function emptyComposition() {
  return { protocol: 2, compositionId: createCompositionId(), phase: 'name', name: '', message: '', parentHash: null };
}

function textOk(value, maximum) {
  return typeof value === 'string' && value.length <= maximum && [...value].every(character => allowed.test(character));
}

function assertState(state) {
  if (!state || state.protocol !== 2 || !isCompositionId(state.compositionId) || !phases.includes(state.phase)) fail(400, 'OUIJA_V2_STATE. The composition link is malformed.', 'OUIJA_V2_STATE');
  if (!textOk(state.name, NAME_LIMIT) || !textOk(state.message, MESSAGE_LIMIT)) fail(400, 'OUIJA_V2_STATE. The composition contains an unsupported character or is too long.', 'OUIJA_V2_STATE');
  if (state.parentHash !== null && !hashPattern.test(state.parentHash)) fail(400, 'OUIJA_V2_STATE. The composition link is malformed.', 'OUIJA_V2_STATE');
}

function canonical(state) {
  assertState(state);
  const name = Buffer.from(state.name, 'utf8');
  const message = Buffer.from(state.message, 'utf8');
  const id = Buffer.from(state.compositionId.slice(4), 'base64url');
  if (id.length !== 16) fail(400, 'OUIJA_V2_STATE. The composition link is malformed.', 'OUIJA_V2_STATE');
  const parent = Buffer.alloc(32);
  if (state.parentHash) parent.set(Buffer.from(state.parentHash, 'hex'));
  const body = Buffer.alloc(1 + 1 + 16 + 1 + name.length + 2 + message.length + 32);
  let offset = 0;
  body[offset++] = 2;
  body[offset++] = phases.indexOf(state.phase) + 1;
  id.copy(body, offset); offset += 16;
  body[offset++] = name.length;
  name.copy(body, offset); offset += name.length;
  body.writeUInt16BE(message.length, offset); offset += 2;
  message.copy(body, offset); offset += message.length;
  parent.copy(body, offset);
  return body;
}

export function stateHash(state) {
  return createHash('sha256').update(canonical(state)).digest('hex');
}

function child(state, changes) {
  return { protocol: 2, compositionId: state.compositionId, phase: state.phase, name: state.name, message: state.message, parentHash: stateHash(state), ...changes };
}

export function appendCharacter(state, character) {
  assertState(state);
  if (!allowed.test(character) || !['name', 'message'].includes(state.phase)) return null;
  const field = state.phase;
  const limit = field === 'name' ? NAME_LIMIT : MESSAGE_LIMIT;
  if (state[field].length + character.length > limit) return null;
  return child(state, { [field]: state[field] + character });
}

export function finishName(state) {
  assertState(state);
  if (state.phase !== 'name' || state.name.trim().length < 1) return null;
  return child(state, { phase: 'message' });
}

export function reviewComposition(state) {
  assertState(state);
  if (state.phase !== 'message' || state.name.trim().length < 1 || state.message.trim().length < 1) return null;
  return child(state, { phase: 'review' });
}

export function resumeComposition(state) {
  assertState(state);
  if (state.phase !== 'review') return null;
  return child(state, { phase: 'message' });
}

export function sealState(state, key) {
  const body = canonical(state);
  const mac = createHmac('sha256', key).update(body).digest('hex');
  return `${body.toString('hex')}.${mac}`;
}

export function openState(token, key) {
  const normalized = String(token || '').trim().toLowerCase();
  const match = /^([0-9a-f]+)\.([0-9a-f]{64})$/.exec(normalized);
  if (!match || match[1].length % 2 !== 0) fail(400, 'OUIJA_V2_STATE. The composition link is malformed or its signature does not match.', 'OUIJA_V2_STATE');
  const body = Buffer.from(match[1], 'hex');
  const actual = Buffer.from(match[2], 'hex');
  const expected = createHmac('sha256', key).update(body).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(400, 'OUIJA_V2_STATE. The composition link is malformed or its signature does not match.', 'OUIJA_V2_STATE');
  if (body.length < 53 || body[0] !== 2 || body[1] < 1 || body[1] > 3) fail(400, 'OUIJA_V2_STATE. The composition link is malformed or its signature does not match.', 'OUIJA_V2_STATE');
  const compositionId = `cmp_${body.subarray(2, 18).toString('base64url')}`;
  const nameLength = body[18];
  const nameEnd = 19 + nameLength;
  if (body.length < nameEnd + 2) fail(400, 'OUIJA_V2_STATE. The composition link is malformed or its signature does not match.', 'OUIJA_V2_STATE');
  const messageLength = body.readUInt16BE(nameEnd);
  const messageEnd = nameEnd + 2 + messageLength;
  if (body.length !== messageEnd + 32) fail(400, 'OUIJA_V2_STATE. The composition link is malformed or its signature does not match.', 'OUIJA_V2_STATE');
  const parent = body.subarray(messageEnd).toString('hex');
  const state = {
    protocol: 2,
    compositionId,
    phase: phases[body[1] - 1],
    name: body.subarray(19, nameEnd).toString('utf8'),
    message: body.subarray(nameEnd + 2, messageEnd).toString('utf8'),
    parentHash: /^0{64}$/.test(parent) ? null : parent
  };
  assertState(state);
  return state;
}

export function publicationId(compositionId, hash) {
  const hex = createHash('sha256').update(`ouija-v2\0${compositionId}\0${hash}`).digest('hex');
  const prefix = BigInt(`0x${hex.slice(0, 11)}`).toString(10).padStart(13, '0').slice(-13);
  const rest = hex.slice(11);
  return `${prefix}-${rest.slice(0, 8)}-${rest.slice(8, 12)}-4${rest.slice(13, 16)}-a${rest.slice(17, 20)}-${rest.slice(20, 32)}`;
}
