import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { validMessage, validationError } from './validation.js';

const duration = 15 * 60_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const credential = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export class SessionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new SessionError(status, message); };

// State transitions use compare-and-swap. The frozen submission record is the
// recovery journal for a failed response/write: retries always use the same ID.
export function createSessions(backend, messages, { now = Date.now, chooseSlot = () => randomInt(1, 6) } = {}) {
  async function read(token) {
    if (!token) fail(401, 'Missing session token. Prepare a session on the homepage.');
    if (!credential(token)) fail(403, 'Invalid session token.');
    const key = hash(token);
    const entry = await backend.read(key);
    if (!entry) fail(403, 'Invalid or cleaned-up session token. Create a new session.');
    if (entry.value.state === 'expired' || entry.value.expires_at <= now()) fail(410, 'Session expired. Create a new session and save the draft again.');
    return { key, ...entry };
  }
  function authorizeEdit(value, editToken) {
    if (!credential(editToken) || !timingSafeEqual(Buffer.from(value.edit_hash, 'hex'), Buffer.from(hash(editToken), 'hex'))) fail(403, 'Invalid draft-edit credential.');
  }
  const status = value => ({ slot: value.slot, state: value.state, revision: value.revision, expires_at: new Date(value.expires_at).toISOString(), ready: value.state === 'draft-ready' });
  async function cleanup() {
    let removed = 0;
    for await (const key of backend.keys()) {
      const entry = await backend.read(key);
      if (!entry || entry.value.expires_at > now()) continue;
      // A tombstone prevents a concurrent save from extending a deleted session.
      if (entry.value.state === 'expired' || await backend.swap(key, { state: 'expired', expires_at: entry.value.expires_at }, entry.etag)) {
        await backend.remove(key);
        if (++removed >= 25) break;
      }
    }
    return removed;
  }
  async function finish(key, entry) {
    // A single atomic insert protects against duplicate GETs across instances.
    const record = await messages.putIfAbsent(entry.value.record);
    // If this marker fails, report failure; a retry recovers the original record.
    await backend.swap(key, { ...entry.value, state: 'submitted' }, entry.etag);
    return record;
  }
  async function submit(token, { slot, revision, normal, editToken } = {}) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await read(token);
      const value = entry.value;
      if (slot && value.slot !== slot) fail(403, 'Slot/session mismatch. Use this session’s assigned URL.');
      if (normal) authorizeEdit(value, editToken);
      if (['submitting', 'submitted'].includes(value.state)) return finish(entry.key, entry);
      if (!normal) {
        if (!value.draft) fail(409, 'No saved draft. Enter a name and message and wait for Draft saved.');
        if (!Number.isSafeInteger(revision) || revision !== value.revision) fail(409, 'Draft revision mismatch or synchronisation still pending. Wait for Draft saved and copy the latest URL.');
      }
      const draft = normal || value.draft;
      if (!validMessage(draft.agent_name, draft.message)) fail(400, validationError);
      const time = now();
      const record = { id: value.message_id, agent_name: draft.agent_name.trim(), message: draft.message.trim(), timestamp: new Date(time).toISOString(), submission_method: normal ? 'form' : 'session_get' };
      const frozen = { ...value, state: 'submitting', record, draft: null };
      if (await backend.swap(entry.key, frozen, entry.etag)) {
        // Re-read the persisted journal before touching permanent storage.
        const persisted = await backend.read(entry.key);
        if (!persisted || !persisted.value.record) fail(410, 'Session expired during submission. Verify results before retrying.');
        return finish(entry.key, persisted);
      }
    }
    fail(409, 'Session changed concurrently. Retry the same URL.');
  }
  return {
    async create() {
      await cleanup();
      const token = randomBytes(32).toString('hex');
      const edit_token = randomBytes(32).toString('hex');
      const time = now();
      const value = { slot: String(chooseSlot()).padStart(2, '0'), message_id: `${String(time).padStart(13, '0')}-${randomUUID()}`, edit_hash: hash(edit_token), draft: null, revision: 0, state: 'assigned', last_activity: time, expires_at: time + duration };
      if (!await backend.create(hash(token), value)) fail(503, 'Session allocation failed. Please retry.');
      return { ...status(value), token, edit_token };
    },
    async save(token, editToken, revision, draft) {
      if (!Number.isSafeInteger(revision) || revision < 1) fail(400, 'Draft revision must be a positive integer.');
      if (!validMessage(draft.agent_name, draft.message)) fail(400, validationError);
      for (let attempt = 0; attempt < 8; attempt++) {
        const entry = await read(token);
        authorizeEdit(entry.value, editToken);
        const value = entry.value;
        if (['submitting', 'submitted'].includes(value.state)) fail(409, 'This session is already submitted or submitting. Verify its receipt or start a new session.');
        const cleaned = { agent_name: draft.agent_name.trim(), message: draft.message.trim() };
        if (revision < value.revision || (revision === value.revision && JSON.stringify(value.draft) !== JSON.stringify(cleaned))) fail(409, 'Stale draft revision. A newer draft is already stored.');
        if (revision === value.revision) return status(value); // Safe retry after lost acknowledgement.
        const time = now();
        const next = { ...value, draft: cleaned, revision, state: 'draft-ready', last_activity: time, expires_at: time + duration };
        if (await backend.swap(entry.key, next, entry.etag)) return status(next);
      }
      fail(409, 'Draft changed concurrently. Retry with the latest text and revision.');
    },
    submit, cleanup
  };
}
