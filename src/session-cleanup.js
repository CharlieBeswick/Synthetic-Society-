// Shared expiry cleanup. No scans occur on character writes or status reads.
export async function cleanupSessions(backend, now = Date.now) {
  let removed = 0, inspected = 0;
  for await (const key of backend.keys()) {
    if (++inspected > 100) break;
    const entry = await backend.read(key);
    if (!entry || entry.value.expires_at > now()) continue;
    if (entry.value.state === 'expired' || await backend.swap(key, { state: 'expired', expires_at: entry.value.expires_at }, entry.etag)) {
      await backend.remove(key);
      if (++removed >= 25) break;
    }
  }
  return removed;
}
