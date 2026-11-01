import { randomUUID } from 'node:crypto';

const idPattern = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// One immutable object per message: no shared index or multi-object transaction.
// Session IDs are allocated before submission, so recency uses stored timestamps.
export function createBlobsStore(blobs, { now = () => Date.now() } = {}) {
  return {
    async putIfAbsent(record) {
      await blobs.setJSON(`messages/${record.id}`, record, { onlyIfNew: true });
      const saved = await blobs.get(`messages/${record.id}`, { type: 'json', consistency: 'strong' });
      if (!saved || JSON.stringify(saved) !== JSON.stringify(record)) throw new Error('Stored record does not match submission journal.');
      return saved;
    },
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
      let records = [];
      // Read all pages in bounded batches: IDs alone no longer imply commit time.
      for await (const page of blobs.list({ prefix: 'messages/', paginate: true })) {
        const keys = page.blobs.map(blob => blob.key).filter(key => idPattern.test(key.slice('messages/'.length)));
        for (let i = 0; i < keys.length; i += 10) {
          records.push(...(await Promise.all(keys.slice(i, i + 10).map(key => blobs.get(key, { type: 'json', consistency: 'strong' })))).filter(Boolean));
          records.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
          records = records.slice(0, 100);
        }
      }
      return records;
    },
    async claimOuijaV2(claim) {
      const key = `ouija-v2-claims/${claim.composition_id}`;
      const { modified } = await blobs.setJSON(key, { composition_id: claim.composition_id, state_hash: claim.state_hash, record: claim.record }, { onlyIfNew: true });
      if (!modified) {
        let existing = null;
        for (let attempt = 0; attempt < 5 && !existing; attempt += 1) existing = await blobs.get(key, { type: 'json', consistency: 'strong' });
        if (!existing) throw new Error('Ouija v2 publication claim could not be read.');
        if (existing.state_hash !== claim.state_hash) return { outcome: 'different', record: existing.record };
        return { outcome: 'same', record: await this.putIfAbsent(existing.record) };
      }
      return { outcome: 'created', record: await this.putIfAbsent(claim.record) };
    }
  };
}
