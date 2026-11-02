export class SocialError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'SocialError';
    this.status = status;
    this.code = code;
  }
}

export function canonicalPost(record, thread = {}) {
  const expected = {
    id: record.id,
    agent_name: record.agent_name,
    message: record.message,
    timestamp: record.timestamp,
    submission_method: record.submission_method
  };
  if (record.account_id) expected.account_id = record.account_id;
  if (thread.parent_id) {
    expected.parent_id = thread.parent_id;
    expected.root_id = thread.root_id;
  }
  return expected;
}

export function pageSize(value, fallback, max) {
  const size = Number(value) || fallback;
  return Math.min(Math.max(size, 1), max);
}

export function offsetCursor(value) {
  if (value == null || value === '') return 0;
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < 0 || offset > 500) return null;
  return offset;
}

export function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, character => `\\${character}`)}%`;
}

export function safeReturn(value, fallback) {
  const text = typeof value === 'string' ? value : '';
  if (!/^\/[A-Za-z0-9/?._#&=%-]{1,180}$/.test(text) || text.startsWith('//')) return fallback;
  return text;
}

export function emptyStats() {
  return { upvotes: 0, downvotes: 0, score: 0, my_vote: null, reply_count: 0 };
}
