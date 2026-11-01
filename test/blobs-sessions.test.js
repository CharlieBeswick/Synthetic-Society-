import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobsSessions } from '../src/session-backends.js';
import { createSessions } from '../src/sessions.js';
import { createBlobsStore } from '../src/blobs-store.js';
import { createOuija } from '../src/ouija.js';

test('Ouija Blobs CAS preserves concurrent positions and one frozen receipt across workers', async () => {
  const blobs = atomicBlobs();
  const messages = createBlobsStore(blobs);
  const workers = Array.from({ length: 6 }, () => createOuija(blobsSessions(() => blobs), messages));
  const { token } = await workers[0].start();
  await workers[0].write(token, 'name', 1, 'A');
  await Promise.all(workers.map((worker, i) => worker.write(token, 'message', i + 1, 'ABCdef'[i])));
  const conflicts = await Promise.allSettled([workers[0].write(token, 'message', 7, 'X'), workers[1].write(token, 'message', 7, 'Y')]);
  assert.equal(conflicts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(conflicts.find(r => r.status === 'rejected').reason.status, 409);
  const receipts = await Promise.all(workers.map(worker => worker.submit(token)));
  assert.equal(new Set(receipts.map(r => r.id)).size, 1);
  assert.match(receipts[0].message, /^ABCdef[XY]$/);
  assert.equal(receipts[0].submission_method, 'ouija_get');
  assert.equal((await messages.recent()).length, 1);
});

// Models the documented service's atomic conditional-write contract, not the
// file-based SDK emulator's check-then-write implementation.
function atomicBlobs() {
  const entries = new Map();
  let version = 0;
  return {
    async getWithMetadata(key, options) {
      assert.equal(options.consistency, 'strong');
      const entry = entries.get(key);
      return entry ? structuredClone({ data: entry.data, etag: entry.etag }) : null;
    },
    async get(key) { return structuredClone(entries.get(key)?.data || null); },
    async setJSON(key, data, options) {
      const entry = entries.get(key);
      if ((options.onlyIfNew && entry) || (options.onlyIfMatch && entry?.etag !== options.onlyIfMatch)) return { modified: false };
      const etag = String(++version);
      entries.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
    async delete(key) { entries.delete(key); },
    async *list({ prefix }) { yield { blobs: [...entries.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; }
  };
}

test('Blobs conditional writes isolate concurrent revisions and freeze one submission across workers', async () => {
  const blobs = atomicBlobs();
  const messages = createBlobsStore(blobs);
  const backend = blobsSessions(() => blobs);
  const workers = Array.from({ length: 6 }, () => createSessions(backend, messages, { chooseSlot: () => 3 }));
  const session = await workers[0].create();
  await workers[0].save(session.token, session.edit_token, 1, { agent_name: 'Atomic test', message: 'First' });
  await Promise.allSettled(workers.map((worker, i) => worker.save(session.token, session.edit_token, i + 2, { agent_name: 'Atomic test', message: `Revision ${i + 2}` })));
  const receipts = await Promise.all(workers.map(worker => worker.submit(session.token, { slot: '03', revision: 7 })));
  assert.equal(new Set(receipts.map(row => row.id)).size, 1);
  assert.equal(receipts[0].message, 'Revision 7');
  assert.equal((await messages.recent()).length, 1);
  assert.equal(receipts[0].submission_method, 'session_get');
});

test('Blobs recent results sort by commit timestamp, not session ID allocation time', async () => {
  const blobs = atomicBlobs();
  const messages = createBlobsStore(blobs);
  let time = 1800000000000;
  const service = createSessions(blobsSessions(() => blobs), messages, { now: () => time });
  const early = await service.create();
  time += 1000;
  const late = await service.create();
  await service.save(early.token, early.edit_token, 1, { agent_name: 'Early', message: 'Submitted later' });
  await service.save(late.token, late.edit_token, 1, { agent_name: 'Late', message: 'Submitted first' });
  await service.submit(late.token, { revision: 1 });
  time += 1000;
  const newest = await service.submit(early.token, { revision: 1 });
  assert.equal((await messages.recent())[0].id, newest.id);
});

test('renewed draft survives cleanup after its original expiry time', async () => {
  const blobs = atomicBlobs();
  const backend = blobsSessions(() => blobs);
  let time = 1800000000000;
  const service = createSessions(backend, createBlobsStore(blobs), { now: () => time });
  const session = await service.create();
  time += 14 * 60_000;
  await service.save(session.token, session.edit_token, 1, { agent_name: 'Alive', message: 'New activity' });
  time += 2 * 60_000;
  assert.equal(await service.cleanup(), 0);
  assert.equal((await service.submit(session.token, { revision: 1 })).agent_name, 'Alive');
});
