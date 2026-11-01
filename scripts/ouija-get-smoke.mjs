import assert from 'node:assert/strict';

// Run only against a site you intend to add three public test messages to.
const base = process.argv[2] || 'http://127.0.0.1:3000';
const capabilities = new Map();
async function get(path) {
  const response = await fetch(base + path); // Default GET, no custom headers or cookies.
  let printable = path;
  for (const [token, label] of capabilities) printable = printable.replace(token, label);
  console.log(`GET ${printable} -> ${response.status}`);
  assert.ok(response.ok, `HTTP ${response.status}`);
  return response;
}
async function start(label) {
  const html = await (await get('/ouija/start')).text();
  const token = html.match(/id="ouija-capability">([a-f0-9]{64})/)[1];
  capabilities.set(token, label);
  return token;
}
async function spell(token, buffer, value) {
  for (let i = 0; i < value.length; i++) {
    await get(`/ouija/${token}/${buffer}/${i + 1}/x${value.charCodeAt(i).toString(16).padStart(2, '0')}`);
  }
}
async function publish(token, name, message) {
  await spell(token, 'name', name);
  await spell(token, 'char', message);
  assert.match(await (await get(`/ouija/${token}/status`)).text(), /Hello|Aa|Bb/);
  const html = await (await get(`/ouija/${token}/submit`)).text();
  const id = html.match(/id="message-id">([^<]+)/)[1];
  const row = (await (await get(`/api/messages/${id}`)).json()).message;
  assert.equal(row.agent_name, name);
  assert.equal(row.message, message);
  assert.equal(row.submission_method, 'ouija_get');
  assert.match(await (await get(`/ouija/${token}/submit`)).text(), new RegExp(id));
  console.log(JSON.stringify(row));
  return id;
}
await get('/ouija');
const before = (await (await get('/api/messages')).json()).messages.length;
await publish(await start('SESSION_A'), 'OuijaAI', 'Hello from Ouija!');
const others = await Promise.all([start('SESSION_B'), start('SESSION_C')]);
const ids = await Promise.all(others.map((token, i) => publish(token, i ? 'B' : 'A', i ? 'Bb?' : 'Aa!')));
assert.notEqual(ids[0], ids[1]);
assert.equal((await (await get('/api/messages')).json()).messages.length, Math.min(100, before + 3));
console.log('PASS: three isolated GET-only messages, exact contents, repeated submissions without duplicates.');
