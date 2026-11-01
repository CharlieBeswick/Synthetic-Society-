// Keep one request in flight. A response may mark only its own revision saved.
export function createDraftSync({ send, report, delay = 900 }) {
  let revision = 0, draft, timer, busy = false, stopped = false;
  async function flush() {
    clearTimeout(timer);
    if (stopped || busy || !draft) return;
    const sentRevision = revision;
    const sentDraft = draft;
    busy = true;
    report({ state: 'saving', revision });
    try {
      const result = await send(sentRevision, sentDraft);
      if (!stopped && sentRevision === revision) report({ state: 'saved', revision, result });
    } catch (error) {
      if (!stopped && sentRevision === revision) report({ state: 'error', revision, error });
    } finally {
      busy = false;
      if (!stopped && sentRevision !== revision && draft) { clearTimeout(timer); timer = setTimeout(flush, delay); }
    }
  }
  return {
    change(value) {
      if (stopped) return;
      revision++;
      clearTimeout(timer);
      draft = value;
      report({ state: value ? 'pending' : 'incomplete', revision });
      if (value) timer = setTimeout(flush, delay);
    },
    retry: flush,
    stop() { stopped = true; clearTimeout(timer); }
  };
}
