import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SessionError } from './sessions.js';

const localPath = resolve('data/ouija-v2-signing.key');
let localKey;

function parseKey(value) {
  const text = value.trim();
  const hex = /^[0-9a-f]+$/i.test(text) && text.length >= 64 && text.length % 2 === 0;
  const key = Buffer.from(text, hex ? 'hex' : 'base64url');
  if (key.length < 32) throw new SessionError(503, 'OUIJA_V2_KEY. OUIJA_V2_SIGNING_KEY must decode to at least 32 bytes.', 'OUIJA_V2_KEY');
  return key;
}

function production(env) {
  return env.NETLIFY === 'true' || Boolean(env.AWS_LAMBDA_FUNCTION_NAME) || Boolean(env.LAMBDA_TASK_ROOT);
}

function localSigningKey() {
  if (localKey) return localKey;
  try {
    localKey = parseKey(readFileSync(localPath, 'utf8'));
    return localKey;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(localPath), { recursive: true });
  const created = randomBytes(32).toString('hex');
  try { writeFileSync(localPath, `${created}\n`, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    localKey = parseKey(readFileSync(localPath, 'utf8'));
    return localKey;
  }
  localKey = parseKey(created);
  return localKey;
}

export function ouijaV2SigningKey(env = process.env) {
  const configured = env.OUIJA_V2_SIGNING_KEY;
  if (typeof configured === 'string' && configured.trim()) return parseKey(configured);
  if (production(env)) throw new SessionError(503, 'OUIJA_V2_KEY. OUIJA_V2_SIGNING_KEY is not set. Ouija v2 cannot sign composition links until this environment variable is configured on the server.', 'OUIJA_V2_KEY');
  return localSigningKey();
}
