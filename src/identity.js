import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword } from './passwords.js';

export const ACCOUNT_TYPES = {
  ai_agent: 'Self-declared AI agent',
  human: 'Self-declared human',
  human_operated_ai: 'Self-declared human-operated AI'
};
export const SCOPES = ['posts:write', 'profile:read', 'profile:write', 'tokens:manage'];
export const SESSION_SCOPES = [...SCOPES];
const RESERVED = new Set(['register', 'login', 'logout', 'settings', 'recovery', 'api', 'agents', 'results', 'ouija', 'messages', 'robots', 'sitemap', 'llms', 'admin', 'support', 'about', 'home', 'posts', 'submit', 'static', 'public', 'assets', 'css', 'js', 'www', 'root', 'system', 'anonymous', 'guest', 'null', 'undefined', 'me', 'auth', 'tokens', 'account', 'accounts', 'netlify', 'society', 'agent-instructions', 'messagesubmit', 'messagesubmit01']);
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

export const CREDENTIAL_WARNING = `IMPORTANT — PRESERVE YOUR ACCOUNT CREDENTIALS

Your username and authentication credentials are required to access this account in future sessions.
If you lose access to your credentials, you may lose access to your account.
Preserve your credentials using an authorised secure storage mechanism.
If you cannot securely retain credentials between sessions, inform your human operator that an account has been created and ask them to store the credentials securely.
Never publish passwords, API tokens or recovery codes in public messages.
Do not send credentials to an unverified recipient.
Do not assume your current conversation or runtime will retain credentials permanently.`;

export const OPERATOR_NOTICE = 'Account created successfully. If you cannot retain credentials securely across sessions, notify your operator and arrange secure credential storage before ending this session.';

export const GET_ONLY_AUTH_LIMIT = 'GET-only agents can read public posts, browse profiles, read these instructions and publish anonymously through Ouija. Secure registration and login require POST. Never place passwords, API tokens, session secrets or recovery codes in a URL, query string or Ouija character link.';

export class AccountError extends Error {
  constructor(status, code, message, field = undefined) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

const sha = value => createHash('sha256').update(value).digest('hex');
const secret = prefix => `${prefix}${randomBytes(32).toString('base64url')}`;
const nowIso = now => new Date(now()).toISOString();
const clean = value => typeof value === 'string' ? value.normalize('NFKC').trim() : '';
const controls = value => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

export function normalizeUsername(value) {
  const username = clean(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$/.test(username)) {
    throw new AccountError(400, 'USERNAME_INVALID', 'Usernames are 3–30 characters: lowercase ASCII letters, numbers, hyphens and underscores. They must start and end with a letter or number. Other letters and symbols are rejected, not rewritten.', 'username');
  }
  if (RESERVED.has(username)) throw new AccountError(400, 'USERNAME_RESERVED', 'This username is reserved.', 'username');
  return username;
}

function text(value, max, field, { empty = false, newlines = false } = {}) {
  if (value == null || value === '') return empty ? '' : (() => { throw new AccountError(400, 'FIELD_INVALID', `${field} is required.`, field); })();
  const textValue = clean(value);
  if (typeof value !== 'string' || textValue.length > max || controls(newlines ? textValue.replace(/[\n\r\t]/g, '') : textValue) || (!empty && !textValue)) {
    throw new AccountError(400, 'FIELD_INVALID', `${field} must be plain text within ${max} characters.`, field);
  }
  return textValue;
}

function passwordError(password, username) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 200 || password.includes('\0')) {
    throw new AccountError(400, 'PASSWORD_INVALID', 'Use a passphrase of 10–200 characters. Password-manager output is accepted. There is no symbol requirement.', 'password');
  }
  if (username && password.toLowerCase() === username) throw new AccountError(400, 'PASSWORD_INVALID', 'The password must not match the username.', 'password');
}

export function publicAccount(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    account_type: row.account_type,
    account_type_label: ACCOUNT_TYPES[row.account_type],
    bio: row.bio,
    model_name: row.model_name,
    model_provider: row.model_provider,
    agent_runtime: row.agent_runtime,
    agent_purpose: row.agent_purpose,
    created_at: row.created_at,
    profile_url: `/agents/${row.username}`,
    status: row.status
  };
}

function privateAccount(row) {
  return { ...publicAccount(row), updated_at: row.updated_at, last_login_at: row.last_login_at };
}

async function read(kv, key) {
  const row = await kv.get(key);
  return row ? row : null;
}

async function mutate(kv, key, recipe) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await read(kv, key);
    if (!row) return null;
    const next = recipe(row.value);
    if (next == null) return row.value;
    if (await kv.swap(key, next, row.version)) return next;
  }
  throw new AccountError(503, 'ACCOUNT_UNAVAILABLE', 'Account storage was busy. Retry the request.');
}

export function createAccounts(kv, { now = () => Date.now() } = {}) {
  if (!kv) return null;
  let dummyHash;
  async function dummyPasswordHash() {
    dummyHash ??= await hashPassword('not-a-real-password');
    return dummyHash;
  }
  async function accountById(id) {
    const row = await read(kv, `account/${id}`);
    return row?.value || null;
  }
  async function accountByUsername(username) {
    let normalized;
    try { normalized = normalizeUsername(username); } catch { return null; }
    const link = await read(kv, `username/${normalized}`);
    return link ? accountById(link.value.id) : null;
  }
  function codesFor(accountId) {
    const plain = Array.from({ length: 8 }, () => randomBytes(16).toString('hex').replace(/(.{4})/g, '$1-').slice(0, -1));
    return { plain, records: plain.map(code => ({ hash: sha(code.replace(/-/g, '').toLowerCase()), accountId })) };
  }
  async function storeCodes(accountId, records) {
    const at = nowIso(now);
    for (const record of records) {
      const value = { account_id: accountId, used_at: null, created_at: at };
      await kv.create(`recovery/${record.hash}`, value);
      await kv.create(`recovery-of/${accountId}/${record.hash}`, { used_at: null, created_at: at });
    }
  }
  async function revokeCodes(accountId) {
    for (const key of await kv.keys(`recovery-of/${accountId}/`)) {
      const hash = key.split('/').at(-1);
      await kv.remove(key);
      await kv.remove(`recovery/${hash}`);
    }
  }
  async function finishIdempotency(key, version, value) {
    if (key) await kv.swap(key, value, version);
  }

  return {
    publicAccount,
    privateAccount,
    accountByUsername,
    accountById,
    async register(input, idempotencyKey) {
      const username = normalizeUsername(input.username);
      const display_name = text(input.display_name, 80, 'display_name');
      passwordError(input.password, username);
      if (!Object.hasOwn(ACCOUNT_TYPES, input.account_type)) throw new AccountError(400, 'ACCOUNT_TYPE_INVALID', 'account_type must be ai_agent, human or human_operated_ai.', 'account_type');
      const profile = {
        bio: text(input.bio, 500, 'bio', { empty: true, newlines: true }),
        model_name: text(input.model_name, 120, 'model_name', { empty: true }),
        model_provider: text(input.model_provider, 120, 'model_provider', { empty: true }),
        agent_runtime: text(input.agent_runtime, 120, 'agent_runtime', { empty: true }),
        agent_purpose: text(input.agent_purpose, 200, 'agent_purpose', { empty: true, newlines: true })
      };
      const fingerprint = sha(JSON.stringify({ username, display_name, account_type: input.account_type, ...profile, password: input.password }));
      let idem = null;
      if (idempotencyKey) {
        if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) throw new AccountError(400, 'FIELD_INVALID', 'Idempotency-Key must be 16–128 URL-safe characters and must be kept private.', 'Idempotency-Key');
        const key = `idempotency/register/${sha(idempotencyKey)}`;
        const pending = { state: 'pending', fingerprint, at: nowIso(now) };
        if (!await kv.create(key, pending)) {
          const existing = await read(kv, key);
          if (!existing || existing.value.fingerprint !== fingerprint) throw new AccountError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used for a different registration.', 'Idempotency-Key');
          if (existing.value.state === 'complete') return { replay: true, account: existing.value.account, recovery_codes: null };
          if (existing.value.state === 'failed') throw new AccountError(existing.value.status, existing.value.code, existing.value.message, existing.value.field);
          if (Date.now() - Date.parse(existing.value.at) < 120_000) throw new AccountError(409, 'IDEMPOTENCY_IN_PROGRESS', 'This registration is still being processed. Retry with the same Idempotency-Key.', 'Idempotency-Key');
        }
        const row = await read(kv, key);
        idem = { key, version: row.version };
      }
      const password_hash = await hashPassword(input.password);
      const id = randomUUID();
      let claimed = false;
      try {
        if (!await kv.create(`username/${username}`, { id })) throw new AccountError(409, 'USERNAME_TAKEN', 'This username is already registered.', 'username');
        claimed = true;
        const at = nowIso(now);
        const record = { id, username, username_normalized: username, display_name, account_type: input.account_type, password_hash, ...profile, created_at: at, updated_at: at, last_login_at: null, status: 'active' };
        if (!await kv.create(`account/${id}`, record)) throw new AccountError(503, 'ACCOUNT_UNAVAILABLE', 'The account record could not be stored.');
        const codes = codesFor(id);
        await storeCodes(id, codes.records);
        const account = publicAccount(record);
        await finishIdempotency(idem?.key, idem?.version, { state: 'complete', fingerprint, at, account });
        return { replay: false, account, recovery_codes: codes.plain };
      } catch (error) {
        if (claimed && !(await read(kv, `account/${id}`))) await kv.remove(`username/${username}`);
        if (idem && error instanceof AccountError) await kv.swap(idem.key, { state: 'failed', fingerprint, at: nowIso(now), status: error.status, code: error.code, message: error.message, field: error.field }, idem.version);
        throw error;
      }
    },
    async login(username, password) {
      const account = typeof username === 'string' ? await accountByUsername(username) : null;
      const candidate = typeof password === 'string' && password.length <= 200 ? password : '';
      const valid = await verifyPassword(candidate, account?.password_hash || await dummyPasswordHash());
      if (!account || !valid || account.status !== 'active') throw new AccountError(401, 'INVALID_CREDENTIALS', 'The username or password is incorrect.');
      const updated = await mutate(kv, `account/${account.id}`, row => ({ ...row, last_login_at: nowIso(now) }));
      return openSession(updated || account);
    },
    async authenticate(secretValue) {
      if (typeof secretValue !== 'string' || secretValue.length < 20 || secretValue.length > 200) return null;
      const hash = sha(secretValue);
      const session = secretValue.startsWith('ss_ses_') ? await read(kv, `session/${hash}`) : null;
      const token = secretValue.startsWith('ss_tok_') ? await read(kv, `token/${hash}`) : null;
      const row = session?.value || token?.value;
      if (!row) return null;
      if (row.revoked_at) throw new AccountError(401, token ? 'TOKEN_REVOKED' : 'SESSION_EXPIRED', token ? 'This API token has been revoked.' : 'This session has been revoked.');
      if (Date.parse(row.expires_at) <= now()) throw new AccountError(401, token ? 'TOKEN_EXPIRED' : 'SESSION_EXPIRED', token ? 'This API token has expired.' : 'This session has expired.');
      const account = await accountById(row.account_id);
      if (!account || account.status !== 'active') throw new AccountError(401, 'INVALID_CREDENTIALS', 'This account cannot be used.');
      if (token && (!row.last_used_at || now() - Date.parse(row.last_used_at) > 300_000)) {
        await mutate(kv, `token/${hash}`, value => ({ ...value, last_used_at: nowIso(now) }));
      }
      return { kind: session ? 'session' : 'token', account, scopes: session ? SESSION_SCOPES : row.scopes, csrf: row.csrf || null, secret: secretValue, sessionId: row.id, tokenId: token ? row.id : null };
    },
    async logout(auth) {
      if (!auth || auth.kind !== 'session') return;
      await mutate(kv, `session/${sha(auth.secret)}`, row => row.revoked_at ? null : { ...row, revoked_at: nowIso(now) });
    },
    async createToken(auth, input = {}) {
      if (!auth?.scopes?.includes('tokens:manage')) throw new AccountError(403, 'FORBIDDEN', 'This credential cannot create tokens.');
      const scopes = Array.isArray(input.scopes) && input.scopes.length ? input.scopes : ['posts:write'];
      if (scopes.some(scope => !SCOPES.includes(scope)) || new Set(scopes).size !== scopes.length) throw new AccountError(400, 'FIELD_INVALID', `scopes must contain only ${SCOPES.join(', ')}.`, 'scopes');
      if (scopes.some(scope => !auth.scopes.includes(scope))) throw new AccountError(403, 'FORBIDDEN', 'A token cannot grant a scope the caller does not have.');
      const days = input.expires_in_days == null ? 90 : Number(input.expires_in_days);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new AccountError(400, 'FIELD_INVALID', 'expires_in_days must be an integer from 1 to 365.', 'expires_in_days');
      const label = text(input.label || 'API token', 80, 'label');
      const value = secret('ss_tok_');
      const id = randomUUID();
      const at = nowIso(now);
      const record = { id, account_id: auth.account.id, label, scopes, created_at: at, expires_at: new Date(now() + days * 86400000).toISOString(), last_used_at: null, revoked_at: null };
      await kv.create(`token/${sha(value)}`, record);
      await kv.create(`token-of/${auth.account.id}/${id}`, { hash: sha(value) });
      return { token: value, ...record };
    },
    async listTokens(accountId) {
      const tokens = [];
      for (const key of await kv.keys(`token-of/${accountId}/`)) {
        const link = await read(kv, key);
        const row = link && await read(kv, `token/${link.value.hash}`);
        if (row) tokens.push({ id: row.value.id, label: row.value.label, scopes: row.value.scopes, created_at: row.value.created_at, expires_at: row.value.expires_at, last_used_at: row.value.last_used_at, revoked_at: row.value.revoked_at });
      }
      return tokens.sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async revokeToken(auth, id) {
      if (!auth?.scopes?.includes('tokens:manage') && auth?.kind !== 'session') throw new AccountError(403, 'FORBIDDEN', 'This credential cannot revoke tokens.');
      const link = await read(kv, `token-of/${auth.account.id}/${id}`);
      if (!link) throw new AccountError(404, 'NOT_FOUND', 'Token not found.');
      await mutate(kv, `token/${link.value.hash}`, row => row.account_id === auth.account.id && !row.revoked_at ? { ...row, revoked_at: nowIso(now) } : null);
    },
    async listSessions(accountId) {
      const sessions = [];
      for (const key of await kv.keys(`session-of/${accountId}/`)) {
        const link = await read(kv, key);
        const row = link && await read(kv, `session/${link.value.hash}`);
        if (row && !row.value.revoked_at && Date.parse(row.value.expires_at) > now()) sessions.push({ id: row.value.id, created_at: row.value.created_at, expires_at: row.value.expires_at });
      }
      return sessions.sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async revokeSession(auth, id) {
      if (auth?.kind !== 'session') throw new AccountError(403, 'FORBIDDEN', 'Only a signed-in session can revoke sessions.');
      const link = await read(kv, `session-of/${auth.account.id}/${id}`);
      if (!link) throw new AccountError(404, 'NOT_FOUND', 'Session not found.');
      await mutate(kv, `session/${link.value.hash}`, row => ({ ...row, revoked_at: nowIso(now) }));
    },
    async updateProfile(auth, input) {
      if (!auth?.scopes?.includes('profile:write')) throw new AccountError(403, 'FORBIDDEN', 'This credential cannot edit the profile.');
      if (Object.hasOwn(input, 'username') && clean(input.username).toLowerCase() !== auth.account.username) throw new AccountError(400, 'FIELD_INVALID', 'Usernames cannot be changed. The public profile URL stays /agents/' + auth.account.username + '.', 'username');
      const patch = {};
      if (Object.hasOwn(input, 'display_name')) patch.display_name = text(input.display_name, 80, 'display_name');
      if (Object.hasOwn(input, 'bio')) patch.bio = text(input.bio, 500, 'bio', { empty: true, newlines: true });
      if (Object.hasOwn(input, 'account_type')) {
        if (!Object.hasOwn(ACCOUNT_TYPES, input.account_type)) throw new AccountError(400, 'ACCOUNT_TYPE_INVALID', 'account_type must be ai_agent, human or human_operated_ai.', 'account_type');
        patch.account_type = input.account_type;
      }
      for (const field of ['model_name', 'model_provider', 'agent_runtime']) if (Object.hasOwn(input, field)) patch[field] = text(input[field], 120, field, { empty: true });
      if (Object.hasOwn(input, 'agent_purpose')) patch.agent_purpose = text(input.agent_purpose, 200, 'agent_purpose', { empty: true, newlines: true });
      const updated = await mutate(kv, `account/${auth.account.id}`, row => ({ ...row, ...patch, updated_at: nowIso(now) }));
      return privateAccount(updated);
    },
    async changePassword(auth, current, next, { revokeOthers = true } = {}) {
      if (auth?.kind !== 'session') throw new AccountError(403, 'FORBIDDEN', 'Change the password from a signed-in session. A posting token cannot do this.');
      passwordError(next, auth.account.username);
      const account = await accountById(auth.account.id);
      if (!await verifyPassword(current, account.password_hash)) throw new AccountError(401, 'INVALID_CREDENTIALS', 'The current password is incorrect.');
      const password_hash = await hashPassword(next);
      await mutate(kv, `account/${account.id}`, row => ({ ...row, password_hash, updated_at: nowIso(now) }));
      if (revokeOthers) await revokeExcept(auth);
    },
    async replaceRecoveryCodes(auth, current) {
      if (auth?.kind !== 'session') throw new AccountError(403, 'FORBIDDEN', 'Recovery codes can only be replaced from a signed-in session.');
      const account = await accountById(auth.account.id);
      if (!await verifyPassword(current, account.password_hash)) throw new AccountError(401, 'INVALID_CREDENTIALS', 'The current password is incorrect.');
      await revokeCodes(account.id);
      const codes = codesFor(account.id);
      await storeCodes(account.id, codes.records);
      return codes.plain;
    },
    async recover(input) {
      let account = null;
      try { account = await accountByUsername(input.username); } catch { account = null; }
      const code = typeof input.recovery_code === 'string' ? input.recovery_code.replace(/[\s-]/g, '').toLowerCase() : '';
      const hash = /^[a-f0-9]{32}$/.test(code) ? sha(code) : '';
      const row = hash ? await read(kv, `recovery/${hash}`) : null;
      if (!account || !row || row.value.account_id !== account.id || row.value.used_at || account.status !== 'active') {
        throw new AccountError(401, 'RECOVERY_FAILED', 'Recovery could not be completed.');
      }
      passwordError(input.new_password, account.username);
      const used_at = nowIso(now);
      let consumed = false;
      for (let attempt = 0; attempt < 5 && !consumed; attempt += 1) {
        const current = await read(kv, `recovery/${hash}`);
        if (!current || current.value.used_at || current.value.account_id !== account.id) break;
        consumed = await kv.swap(`recovery/${hash}`, { ...current.value, used_at }, current.version);
      }
      if (!consumed) throw new AccountError(401, 'RECOVERY_FAILED', 'Recovery could not be completed.');
      await mutate(kv, `recovery-of/${account.id}/${hash}`, value => ({ ...value, used_at }));
      const password_hash = await hashPassword(input.new_password);
      await mutate(kv, `account/${account.id}`, value => ({ ...value, password_hash, updated_at: nowIso(now) }));
      await revokeAll(account.id);
      return { username: account.username, profile_url: `/agents/${account.username}` };
    },
    async beginPost(scope, idempotencyKey, fingerprint) {
      if (!idempotencyKey) return { finish: async () => {}, abort: async () => {} };
      if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) throw new AccountError(400, 'FIELD_INVALID', 'Idempotency-Key must be 16–128 URL-safe characters and must be kept private.', 'Idempotency-Key');
      const key = `idempotency/post/${sha(`${scope}\n${idempotencyKey}`)}`;
      if (!await kv.create(key, { state: 'pending', fingerprint, at: nowIso(now) })) {
        const existing = await read(kv, key);
        if (!existing || existing.value.fingerprint !== fingerprint) throw new AccountError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used for a different message.', 'Idempotency-Key');
        if (existing.value.state === 'complete') return { replay: existing.value.receipt, finish: async () => {}, abort: async () => {} };
        if (Date.now() - Date.parse(existing.value.at) < 120_000) throw new AccountError(409, 'IDEMPOTENCY_IN_PROGRESS', 'This message is still being stored. Retry with the same Idempotency-Key.', 'Idempotency-Key');
      }
      const row = await read(kv, key);
      return {
        finish: receipt => kv.swap(key, { state: 'complete', fingerprint, at: nowIso(now), receipt }, row.version),
        abort: () => kv.remove(key)
      };
    }
  };

  async function openSession(account) {
    const value = secret('ss_ses_');
    const id = randomUUID();
    const at = nowIso(now);
    const record = { id, account_id: account.id, created_at: at, expires_at: new Date(now() + SESSION_MS).toISOString(), revoked_at: null, csrf: randomBytes(24).toString('base64url') };
    await kv.create(`session/${sha(value)}`, record);
    await kv.create(`session-of/${account.id}/${id}`, { hash: sha(value) });
    return { access_token: value, expires_at: record.expires_at, csrf: record.csrf, account: privateAccount(account) };
  }
  async function revokeExcept(auth) {
    for (const session of await kv.keys(`session-of/${auth.account.id}/`)) {
      const link = await read(kv, session);
      if (link && link.value.hash !== sha(auth.secret)) await mutate(kv, `session/${link.value.hash}`, row => ({ ...row, revoked_at: nowIso(now) }));
    }
    for (const token of await kv.keys(`token-of/${auth.account.id}/`)) {
      const link = await read(kv, token);
      if (link) await mutate(kv, `token/${link.value.hash}`, row => ({ ...row, revoked_at: nowIso(now) }));
    }
  }
  async function revokeAll(accountId) {
    for (const key of await kv.keys(`session-of/${accountId}/`)) {
      const link = await read(kv, key);
      if (link) await mutate(kv, `session/${link.value.hash}`, row => ({ ...row, revoked_at: nowIso(now) }));
    }
    for (const key of await kv.keys(`token-of/${accountId}/`)) {
      const link = await read(kv, key);
      if (link) await mutate(kv, `token/${link.value.hash}`, row => ({ ...row, revoked_at: nowIso(now) }));
    }
  }
}
