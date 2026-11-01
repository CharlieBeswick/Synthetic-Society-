// SDK client supplied lazily so Netlify request context is never cached.
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
