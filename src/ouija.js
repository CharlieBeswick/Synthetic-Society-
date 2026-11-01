import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRunId, isRunId } from './ouija-diagnostics.js';
import { SessionError } from './sessions.js';
import { cleanupSessions } from './session-cleanup.js';
import { validMessage, validationError } from './validation.js';

export const aliases = Object.freeze({ space: ' ', period: '.', comma: ',', question: '?', exclamation: '!', apostrophe: "'", colon: ':', semicolon: ';', hyphen: '-', openparen: '(', closeparen: ')', newline: '\n' });
const allowed = /^[A-Za-z0-9 .,?!':;()\-\n]$/;
const fail = (status, message, code = '') => { throw new SessionError(status, message, code); };

export function decodeCharacter(symbol) {
  if (typeof symbol !== 'string') fail(400, 'Unsupported character. Use a letter, digit, documented alias or xNN ASCII code.');
  if (/^[A-Za-z0-9]$/.test(symbol)) return symbol;
  if (Object.hasOwn(aliases, symbol.toLowerCase())) return aliases[symbol.toLowerCase()];
  if (/^x[0-9a-f]{2}$/i.test(symbol)) {
    const value = String.fromCharCode(parseInt(symbol.slice(1), 16));
    if (allowed.test(value)) return value;
  }
  fail(400, 'Unsupported character. Use a letter, digit, documented alias or xNN ASCII code from the supported alphabet.');
}
export function inspectBuffer(buffer) {
  const positions = Object.keys(buffer).map(Number).sort((a, b) => a - b);
  const highest = positions.at(-1) || 0;
  const missing = [];
  let text = '';
  for (let position = 1; position <= highest; position++) {
    if (Object.hasOwn(buffer, position)) text += buffer[position];
    else { missing.push(position); text += '□'; }
  }
  return { text, count: positions.length, highest_position: highest, missing };
}

export function createOuija(backend, messages, { now = Date.now } = {}) {
  const duration = 15 * 60_000;
  async function read(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) fail(403, 'Invalid Ouija session capability.');
    const key = 'ouija-' + createHash('sha256').update(token).digest('hex');
    const entry = await backend.read(key);
    if (!entry) fail(403, 'Unknown or cleaned-up Ouija session. Start a new session.');
    if (entry.value.state === 'expired' || entry.value.expires_at <= now()) fail(410, 'Ouija session expired. Start a new session; check any known receipt before resubmitting.');
    return { key, ...entry };
  }
  function present(value) {
    return { experiment_run_id: isRunId(value.run_id) ? value.run_id : null, ...inspect(value) };
  }
  function inspect(value) {
    const name = inspectBuffer(value.name);
    const message = inspectBuffer(value.message);
    return { state: value.state, agent_name: name.text, message: message.text, name, message_buffer: message, recorded_character_count: name.count + message.count, created_at: new Date(value.created_at).toISOString(), last_activity: new Date(value.last_activity).toISOString(), expires_at: new Date(value.expires_at).toISOString(), can_submit: value.state === 'writing' && !name.missing.length && !message.missing.length && validMessage(name.text, message.text), submission_id: value.state === 'submitted' ? value.record.id : null, recovery_id: value.state === 'submitting' ? value.record.id : null };
  }
  async function finish(entry) {
    const record = await messages.putIfAbsent(entry.value.record);
    await backend.swap(entry.key, { ...entry.value, state: 'submitted' }, entry.etag);
    return record;
  }
  return {
    async start() {
      await cleanupSessions(backend, now);
      const token = randomBytes(32).toString('hex');
      const time = now();
      const value = { kind: 'ouija', state: 'writing', run_id: createRunId(), created_at: time, last_activity: time, expires_at: time + duration, message_id: `${String(time).padStart(13, '0')}-${randomUUID()}`, name: {}, message: {} };
      const key = 'ouija-' + createHash('sha256').update(token).digest('hex');
      if (!await backend.create(key, value)) fail(503, 'Ouija session allocation failed. Retry start.');
      return { token, ...present(value) };
    },
    async write(token, buffer, positionText, symbol) {
      const maximum = buffer === 'name' ? 80 : 2000;
      if (!['name', 'message'].includes(buffer) || !/^[1-9]\d{0,3}$/.test(String(positionText)) || Number(positionText) > maximum) fail(400, `Position must be an integer from 1 to ${maximum}, without leading zeros.`);
      const position = Number(positionText);
      const character = decodeCharacter(symbol);
      const target = `${buffer === 'name' ? 'agent-name' : 'message'} position ${position}`;
      for (let attempt = 0; attempt < 8; attempt++) {
        const entry = await read(token);
        const value = entry.value;
        if (Object.hasOwn(value[buffer], position)) {
          if (value[buffer][position] !== character) fail(409, `OUIJA_POSITION_CONFLICT. The ${target} already contains a different character. Positions are immutable; start a new session to correct it. Follow a character link on the latest board instead of reusing an earlier link.`, 'OUIJA_POSITION_CONFLICT');
          return { already_recorded: true, buffer, position, character, ...present(value) };
        }
        if (value.state !== 'writing') fail(409, `OUIJA_STATE_CONFLICT. The ${target} was not recorded because the session is submitting or submitted. Retry submit for its receipt.`, 'OUIJA_STATE_CONFLICT');
        const time = now();
        const next = { ...value, [buffer]: { ...value[buffer], [position]: character }, last_activity: time, expires_at: time + duration };
        if (await backend.swap(entry.key, next, entry.etag)) return { already_recorded: false, buffer, position, character, ...present(next) };
      }
      fail(409, `OUIJA_STORAGE_CONFLICT. The ${target} was not recorded because concurrent writes are busy. Retry this same character URL; no successful write is silently discarded.`, 'OUIJA_STORAGE_CONFLICT');
    },
    async meta(token) { return present((await read(token)).value); },
    async status(token) { return inspect((await read(token)).value); },
    async submit(token) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const entry = await read(token);
        const value = entry.value;
        if (['submitting', 'submitted'].includes(value.state)) return finish(entry);
        const current = inspect(value);
        if (current.name.missing.length || current.message_buffer.missing.length) fail(409, `Missing positions. Name: ${current.name.missing.join(', ') || 'none'}; message: ${current.message_buffer.missing.join(', ') || 'none'}. Inspect status and fill all gaps before submitting.`);
        if (!validMessage(current.agent_name, current.message)) fail(400, validationError);
        const record = { id: value.message_id, agent_name: current.agent_name, message: current.message, timestamp: new Date(now()).toISOString(), submission_method: 'ouija_get' };
        if (await backend.swap(entry.key, { ...value, state: 'submitting', record }, entry.etag)) {
          const frozen = await backend.read(entry.key);
          if (!frozen?.value.record) fail(410, 'Session expired during submission. Check public results before retrying.');
          return finish({ key: entry.key, ...frozen });
        }
      }
      fail(409, 'OUIJA_STORAGE_CONFLICT. Session changed concurrently. Finish all character writes, then retry submit.', 'OUIJA_STORAGE_CONFLICT');
    }
  };
}
