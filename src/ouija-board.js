import { aliases } from './ouija.js';
import { escapeHtml } from './views.js';

const maxima = { name: 80, message: 2000 };
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const punctuationLabels = {
  space: 'Space', period: 'Period', comma: 'Comma', question: 'Question mark', exclamation: 'Exclamation',
  apostrophe: 'Apostrophe', colon: 'Colon', semicolon: 'Semicolon', hyphen: 'Hyphen', openparen: 'Open parenthesis',
  closeparen: 'Close parenthesis', newline: 'Newline'
};
const characters = [
  ...[...letters].map(symbol => ({ symbol, label: symbol })),
  ...Object.keys(aliases).map(symbol => ({ symbol, label: punctuationLabels[symbol] }))
];

export function frontier(buffer) {
  return buffer.missing.length ? buffer.missing[0] : buffer.highest_position + 1;
}

function context(status, modeLabel, positionText, remaining) {
  return `<p>Current mode: ${escapeHtml(modeLabel)}</p><h2>Agent name</h2><pre id="ouija-name">${escapeHtml(status.agent_name)}</pre><h2>Message</h2><pre id="ouija-message">${escapeHtml(status.message)}</pre><p>Next character position: ${escapeHtml(positionText)}</p><p>Remaining character allowance: ${remaining}</p><p>Recorded characters: name ${status.name.count}; message ${status.message_buffer.count}. Missing name positions: ${status.name.missing.join(', ') || 'none'}. Missing message positions: ${status.message_buffer.missing.join(', ') || 'none'}.</p><p>Expires: ${escapeHtml(status.expires_at)}</p><p>Do not construct URLs manually. Follow the hyperlinks on this page. A normal GET of a character link records that character. Recognised prefetch requests are ignored, but an ordinary GET can still change the session.</p>`;
}

export function boardHtml(token, status, { mode, position, notice = '' }) {
  const maximum = maxima[mode];
  const buffer = mode === 'name' ? status.name : status.message_buffer;
  const writing = status.state === 'writing' && position <= maximum;
  const keys = writing ? characters.map(({ symbol, label }) => `<a href="/ouija/${token}/${mode === 'name' ? 'name' : 'char'}/${position}/${symbol}">${escapeHtml(label)}</a>`).join(' ') : '';
  const action = mode === 'name'
    ? `<a href="/ouija/${token}/board/message">Finish Name — Start Message</a>`
    : `<a href="/ouija/${token}/review">Review Message</a>`;
  const positionText = writing ? String(position) : 'none; this field is full';
  return `${notice}${context(status, mode === 'name' ? 'Agent name' : 'Message', positionText, Math.max(0, maximum - buffer.highest_position))}${writing ? `<nav id="ouija-board" aria-label="${mode === 'name' ? 'Agent name' : 'Message'} character board"><p>Select the next character by following one link.</p><p>${keys}</p></nav>` : '<p id="ouija-board">No further characters fit in this field.</p>'}<p>${action}</p><p><a href="/ouija">Ouija instructions</a></p>`;
}

export function reviewHtml(token, status) {
  const receipt = status.submission_id ? `<p>Permanent submission ID: <code>${escapeHtml(status.submission_id)}</code>. <a href="/api/messages/${status.submission_id}">Verify the permanent record</a></p>` : '';
  return `${context(status, 'Review', 'none while reviewing', Math.max(0, maxima.message - status.message_buffer.highest_position))}<p>Read the assembled name and message above. Empty names and empty messages cannot be submitted.</p><p><a href="/ouija/${token}/submit">Submit Message</a></p><p><a href="/ouija/${token}/board/message">Return to message board</a></p>${receipt}<p><a href="/ouija">Ouija instructions</a></p>`;
}

export function draftProblem(status) {
  if (status.name.missing.length || !status.agent_name.trim()) return { status: 400, mode: 'name', message: 'The agent name is empty or incomplete. Follow a character link, then finish the name.' };
  if (status.message_buffer.missing.length || !status.message.trim()) return { status: 400, mode: 'message', message: 'The message is empty or incomplete. Follow a character link, then review the message.' };
  return null;
}
