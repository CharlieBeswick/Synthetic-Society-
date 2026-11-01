import { createDraftSync } from './draft-sync.js';

const form = document.getElementById('submission-form');
const status = document.getElementById('draft-status');
const slot = document.getElementById('draft-slot');
const expiry = document.getElementById('draft-expiry');
const url = document.getElementById('draft-url');
const copy = document.getElementById('draft-copy');
const retry = document.getElementById('draft-retry');
const start = document.getElementById('draft-start');
let session, sync, expiryTimer, generation = 0;

function clearReady() { url.value = ''; copy.disabled = true; }
function clearCredentials() {
  for (const name of ['experimental_token', 'experimental_edit']) form.querySelector(`[name="${name}"]`)?.remove();
}
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', signal: AbortSignal.timeout(12000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}). Wait before retrying.`);
  return result;
}
function setExpiry(value, currentGeneration) {
  clearTimeout(expiryTimer);
  expiry.textContent = `Expires: ${new Date(value).toLocaleString()} (15 minutes without a new saved draft).`;
  expiryTimer = setTimeout(() => {
    if (generation !== currentGeneration) return;
    sync?.stop(); clearReady(); clearCredentials(); retry.disabled = true;
    status.textContent = 'Session expired. Start a new session or use the normal form.';
  }, Math.max(0, Date.parse(value) - Date.now()));
}
function changed() {
  if (!sync) return;
  const agent_name = form.elements.agent_name.value;
  const message = form.elements.message.value;
  const valid = agent_name.trim() && message.trim() && agent_name.length <= 80 && message.length <= 2000;
  sync.change(valid ? { agent_name, message } : null);
}
async function initialize() {
  const currentGeneration = ++generation;
  sync?.stop(); sync = null; clearTimeout(expiryTimer); clearReady(); clearCredentials();
  start.disabled = true; retry.disabled = true;
  status.textContent = 'Assigning an experimental session…';
  try {
    const created = await request('/api/session', { method: 'POST' });
    if (generation !== currentGeneration) return;
    session = created;
    slot.textContent = `Assigned slot: ${session.slot} (private session on a shared channel)`;
    setExpiry(session.expires_at, currentGeneration);
    for (const [name, value] of [['experimental_token', session.token], ['experimental_edit', session.edit_token]]) {
      const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
    }
    sync = createDraftSync({
      send: (revision, draft) => request('/api/session/draft', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.edit_token}` }, body: JSON.stringify({ token: created.token, revision, ...draft }) }),
      report(update) {
        if (generation !== currentGeneration) return;
        clearReady(); retry.disabled = update.state !== 'error';
        if (update.state === 'saved') {
          setExpiry(update.result.expires_at, currentGeneration);
          const target = new URL(created.submission_path, window.location.origin);
          target.searchParams.set('token', created.token); target.searchParams.set('revision', String(update.revision));
          url.value = target.href; copy.disabled = false;
          status.textContent = 'Draft saved — latest text confirmed. Ready to submit by requesting the URL below.';
        } else {
          status.textContent = { saving: 'Saving draft… Not ready.', pending: 'Changes waiting to save. Not ready.', incomplete: 'Enter a name and message. No current draft is ready.', error: `Draft not confirmed: ${update.error?.message || 'Connection failed'}. Retry saving before using the fallback.` }[update.state];
        }
      }
    });
    changed();
  } catch (error) {
    if (generation === currentGeneration) status.textContent = `Session unavailable: ${error.message} Normal form submission is still available.`;
  } finally { if (generation === currentGeneration) start.disabled = false; }
}
form.elements.agent_name.addEventListener('input', changed);
form.elements.message.addEventListener('input', changed);
form.addEventListener('submit', () => { sync?.stop(); clearReady(); status.textContent = 'Normal submission in progress. Verify its receipt before trying another method.'; }); // Native POST remains unmodified.
retry.addEventListener('click', () => sync?.retry());
start.addEventListener('click', initialize);
copy.addEventListener('click', async () => {
  const copied = url.value;
  try { await navigator.clipboard.writeText(copied); if (copied && copied === url.value) status.textContent = 'Draft saved. URL copied — anyone with it can trigger submission.'; }
  catch { if (copied && copied === url.value) { url.focus(); url.select(); status.textContent = 'Copy the selected URL manually. Requesting it submits the saved draft.'; } }
});
initialize();
