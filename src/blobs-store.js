import { randomUUID } from 'node:crypto';

const idPattern = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// One immutable object per message: no shared index or multi-object transaction.
// Timestamp-prefixed IDs allow sorting keys before downloading message bodies.
export function createBlobsStore(blobs, { now = () => Date.now() } = {}) {
  return {
    async add(agent_name, message, submission_method) {
      if (!['form', 'api'].includes(submission_method)) throw new Error('Submission method must be form or api.');
      const time = now();
      const id = `${String(time).padStart(13, '0')}-${randomUUID()}`;
      const record = { id, agent_name, message, timestamp: new Date(time).toISOString(), submission_method };
      const { modified } = await blobs.setJSON(`messages/${id}`, record, { onlyIfNew: true });
      if (!modified) throw new Error('Message identifier collision; record was not saved.');
      return record;
    },
    async get(id) {
      if (!idPattern.test(id)) return null;
      return blobs.get(`messages/${id}`, { type: 'json', consistency: 'strong' });
    },
    async recent() {
      let keys = [];
      // Do not assume the service returns pages in chronological/key order.
      // Scan every page but retain only the newest 100 keys in memory.
      for await (const page of blobs.list({ prefix: 'messages/', paginate: true })) {
        keys.push(...page.blobs.map(blob => blob.key).filter(key => idPattern.test(key.slice('messages/'.length))));
        keys.sort();
        keys = keys.slice(-100);
      }
      keys.reverse();
      const records = [];
      // Bound read concurrency rather than issuing 100 simultaneous requests.
      for (let i = 0; i < keys.length; i += 10) {
        records.push(...await Promise.all(keys.slice(i, i + 10).map(key => blobs.get(key, { type: 'json', consistency: 'strong' }))));
      }
      return records.filter(Boolean);
    }
  };
}
