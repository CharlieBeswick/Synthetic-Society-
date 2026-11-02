import { AUDIT_RETENTION_MS, correlateEvents, isCompositionId, isRunId, summarizeRuns } from './ouija-diagnostics.js';

// SDK client supplied lazily so Netlify request context is never cached.
export function blobsIdentity(getBlobs) {
  return {
    async get(key) {
      const row = await getBlobs().getWithMetadata(`identity/${key}`, { type: 'json', consistency: 'strong' });
      return row?.data ? { value: row.data, version: row.etag } : null;
    },
    async create(key, value) { return (await getBlobs().setJSON(`identity/${key}`, value, { onlyIfNew: true })).modified; },
    async swap(key, value, etag) { return (await getBlobs().setJSON(`identity/${key}`, value, { onlyIfMatch: etag })).modified; },
    async remove(key) { await getBlobs().delete(`identity/${key}`); },
    async keys(prefix = '') {
      const out = [];
      for await (const page of getBlobs().list({ prefix: `identity/${prefix}`, paginate: true })) {
        for (const blob of page.blobs) {
          out.push(blob.key.slice('identity/'.length));
          if (out.length >= 500) return out;
        }
      }
      return out;
    }
  };
}

export function blobsSessions(getBlobs) {
  return {
    async read(key) {
      const row = await getBlobs().getWithMetadata(`sessions/${key}`, { type: 'json', consistency: 'strong' });
      return row ? { value: row.data, etag: row.etag } : null;
    },
    async create(key, value) { return (await getBlobs().setJSON(`sessions/${key}`, value, { onlyIfNew: true })).modified; },
    async swap(key, value, etag) { return (await getBlobs().setJSON(`sessions/${key}`, value, { onlyIfMatch: etag })).modified; },
    remove: key => getBlobs().delete(`sessions/${key}`),
    async *keys() {
      for await (const page of getBlobs().list({ prefix: 'sessions/', paginate: true })) for (const blob of page.blobs) yield blob.key.slice('sessions/'.length);
    }
  };
}

export function blobsAudit(getBlobs, { now = Date.now } = {}) {
  let sweptAt = 0;
  async function sweep() {
    const time = now();
    if (time - sweptAt < 60 * 60 * 1000) return;
    sweptAt = time;
    const cutoff = time - AUDIT_RETENTION_MS;
    let seen = 0;
    for await (const page of getBlobs().list({ prefix: 'ouija-audit/', paginate: true })) {
      for (const blob of page.blobs) {
        if (++seen > 200) return;
        const data = await getBlobs().get(blob.key, { type: 'json', consistency: 'strong' });
        if (data?.at && Date.parse(data.at) < cutoff) await getBlobs().delete(blob.key);
      }
    }
  }
  return {
    async append(event) {
      const stamp = String(event.at || '').replace(/\D/g, '') || String(now());
      const folder = isRunId(event.run_id) ? event.run_id : isCompositionId(event.composition_id) ? event.composition_id : 'legacy';
      await getBlobs().setJSON(`ouija-audit/${folder}/${stamp}-${event.response_id}`, event, { onlyIfNew: true });
      try { await sweep(); } catch (error) { console.error('Ouija audit retention failed', error.name); }
    },
    async events(runId) {
      if (!isRunId(runId) && !isCompositionId(runId)) return [];
      const events = [];
      for await (const page of getBlobs().list({ prefix: `ouija-audit/${runId}/`, paginate: true })) {
        for (const blob of page.blobs) {
          const data = await getBlobs().get(blob.key, { type: 'json', consistency: 'strong' });
          if (data) events.push(data);
          if (events.length >= 500) break;
        }
      }
      events.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.response_id).localeCompare(String(b.response_id)));
      return correlateEvents(events);
    },
    async summaries(limit = 50) {
      const events = [];
      let seen = 0;
      for await (const page of getBlobs().list({ prefix: 'ouija-audit/', paginate: true })) {
        for (const blob of page.blobs) {
          if (++seen > 500) break;
          const data = await getBlobs().get(blob.key, { type: 'json', consistency: 'strong' });
          if (data) events.push(data);
        }
      }
      return summarizeRuns(events, limit);
    }
  };
}
