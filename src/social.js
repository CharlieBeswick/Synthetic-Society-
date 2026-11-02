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
  if (!/^\/(?:[A-Za-z0-9/?._#&=%:-]{0,180})$/.test(text) || text.startsWith('//')) return fallback;
  return text;
}

export function conversationSort(value) {
  return value === 'recent' || value === 'upvotes' ? value : null;
}

export function compareReplies(sort) {
  return (left, right) => {
    if (sort === 'upvotes') {
      const upvotes = Number(right.upvotes || 0) - Number(left.upvotes || 0);
      if (upvotes) return upvotes;
      const score = Number(right.score || 0) - Number(left.score || 0);
      if (score) return score;
    }
    const time = String(right.timestamp || '').localeCompare(String(left.timestamp || ''));
    if (time) return time;
    return String(left.id).localeCompare(String(right.id));
  };
}

export function threadOrder(posts, rootId, sort) {
  const byId = new Map(posts.map(post => [post.id, post]));
  const byParent = new Map();
  for (const post of posts) {
    if (post.id === rootId) continue;
    const parent = post.parent_id || rootId;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(post);
  }
  const compare = compareReplies(sort);
  for (const list of byParent.values()) list.sort(compare);
  const ordered = [];
  const seen = new Set();
  if (byId.has(rootId)) ordered.push(byId.get(rootId));
  function walk(parentId) {
    for (const post of byParent.get(parentId) || []) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      ordered.push(post);
      walk(post.id);
    }
  }
  walk(rootId);
  return ordered;
}

export function threadOffset(cursor) {
  if (cursor == null || cursor === '') return 0;
  const match = /^tree:(\d+)$/.exec(String(cursor));
  if (!match) return null;
  const offset = Number(match[1]);
  if (!Number.isInteger(offset) || offset < 0 || offset > 5000) return null;
  return offset;
}

export function paginateSorted(posts, rootId, sort, limit, cursor) {
  const size = pageSize(limit, 80, 100);
  const ordered = threadOrder(posts, rootId, sort);
  const offset = threadOffset(cursor);
  if (offset == null) return { posts: [], next_cursor: null };
  const replies = ordered.filter(post => post.id !== rootId);
  const slice = replies.slice(offset, offset + size);
  const included = new Set(slice.map(post => post.id));
  const byId = new Map(ordered.map(post => [post.id, post]));
  for (const post of slice) {
    let parentId = post.parent_id;
    while (parentId && parentId !== rootId && !included.has(parentId)) {
      included.add(parentId);
      parentId = byId.get(parentId)?.parent_id || null;
    }
  }
  return {
    posts: ordered.filter(post => post.id === rootId || included.has(post.id)),
    next_cursor: offset + size < replies.length ? `tree:${offset + size}` : null
  };
}

export function emptyStats() {
  return { upvotes: 0, downvotes: 0, score: 0, my_vote: null, reply_count: 0 };
}

export function activityCursor(value) {
  if (value == null || value === '') return null;
  const text = String(value);
  const split = text.lastIndexOf('|');
  if (split < 1) return null;
  const time = text.slice(0, split);
  const sequence = Number(text.slice(split + 1));
  if (!Number.isInteger(sequence) || Number.isNaN(Date.parse(time))) return null;
  return { time, sequence };
}
