'use strict';
/**
 * Integration tests for the model plumbing over the real HTTP surface.
 *
 * These matter because the unit tests stub the layers below. Here the server is
 * driven the way the UI drives it, with a stubbed fetch standing in for the
 * provider. The assertions are about behaviour the user would notice:
 *
 *   - the key never comes back out of the API
 *   - a reasoning block is stripped from the connection test
 *   - an unreachable provider is reported rather than swallowed
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer, AppState } = require('../lib/server');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Boot a server over a scratch dir; returns {base, dir, close}. */
async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-model-'));
  const server = createServer({
    state: new AppState({ dataDir: dir }),
    staticDir: PUBLIC_DIR,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((done) => server.close(done)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { base: `http://127.0.0.1:${server.address().port}`, dir };
}

async function postJson(base, p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getJson(base, p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
}

/** Run a body of work with fetch stubbed, then restore. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  // Multipart uploads must still reach the real server, so only intercept the
  // provider host and pass everything else through.
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('example.test') || u.includes('unreachable.test')) {
      return impl(u, init);
    }
    return real(url, init);
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

function providerReply(obj) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }],
    }),
  };
}

// ------------------------------------------------------------------ settings

test('a fresh install reports no key and defaults', async (t) => {
  const { base } = await boot(t);
  const { body } = await getJson(base, '/api/settings');
  assert.equal(body.ok, true);
  assert.equal(body.settings.hasKey, false);
  assert.equal(body.settings.keyHint, null);
  assert.ok(body.settings.baseUrl.startsWith('https://'));
});

test('saving a key never echoes it back', async (t) => {
  const { base } = await boot(t);
  const SECRET = 'sk-live-do-not-leak-9921';

  const saved = await postJson(base, '/api/settings', {
    apiKey: SECRET,
    baseUrl: 'https://example.test/v1',
    model: 'gpt-4o-mini',
  });
  assert.equal(saved.body.ok, true);

  // The response, and every later read, must be free of the secret.
  assert.ok(!JSON.stringify(saved.body).includes(SECRET), 'save response leaked the key');

  const read = await getJson(base, '/api/settings');
  assert.ok(!JSON.stringify(read.body).includes(SECRET), 'settings read leaked the key');
  assert.equal(read.body.settings.hasKey, true);
  assert.match(read.body.settings.keyHint, /9921$/);

  // Health is a cheap endpoint the UI polls; it must not carry it either.
  const health = await getJson(base, '/api/health');
  assert.ok(!JSON.stringify(health.body).includes(SECRET), 'health leaked the key');
  assert.equal(health.body.modelConfigured, true);
});

test('only the known settings keys are writable', async (t) => {
  const { base } = await boot(t);
  await postJson(base, '/api/settings', { apiKey: 'k', evil: 'x', dataDir: '/tmp/pwn' });
  const { body } = await getJson(base, '/api/settings');
  assert.ok(!('evil' in body.settings));
  assert.ok(!('dataDir' in body.settings));
});

test('a non-http base URL is rejected with a clear reason', async (t) => {
  const { base } = await boot(t);
  const { status, body } = await postJson(base, '/api/settings', { baseUrl: 'file:///etc/passwd' });
  assert.equal(status, 400);
  assert.match(body.error, /http/);
});

test('an empty apiKey clears the key rather than being ignored', async (t) => {
  const { base } = await boot(t);
  await postJson(base, '/api/settings', { apiKey: 'sk-temp' });
  assert.equal((await getJson(base, '/api/settings')).body.settings.hasKey, true);
  await postJson(base, '/api/settings', { apiKey: '' });
  assert.equal((await getJson(base, '/api/settings')).body.settings.hasKey, false);
});

test('/api/settings/test reports a provider failure verbatim', async (t) => {
  const { base } = await boot(t);
  await postJson(base, '/api/settings', {
    apiKey: 'sk-bad', baseUrl: 'https://example.test/v1', model: 'm',
  });
  await withFetch(async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
  }), async () => {
    const { body } = await postJson(base, '/api/settings/test', {});
    assert.equal(body.ok, false);
    assert.match(body.error, /Incorrect API key/);
  });
});

// Reasoning models (MiniMax-M3, DeepSeek, …) print a thought block before the
// answer. Two things about that were found only by talking to a real provider:
// the block must be stripped, and the test endpoint's token budget must be large
// enough to cover the thinking or the answer never arrives.
test('a reasoning block does not leak into the connection-test reply', async (t) => {
  const { base } = await boot(t);
  await postJson(base, '/api/settings', {
    apiKey: 'sk-ok', baseUrl: 'https://example.test/v1', model: 'MiniMax-M3',
  });
  await withFetch(async () => providerReply(
    '<think>The user wants two characters.</think>\n\n可用'
  ), async () => {
    const { body } = await postJson(base, '/api/settings/test', {});
    assert.equal(body.ok, true);
    assert.equal(body.reply, '可用');
    assert.doesNotMatch(body.reply, /think/i);
  });
});

test('a thinking-only reply is reported as a failure, not as success', async (t) => {
  const { base } = await boot(t);
  await postJson(base, '/api/settings', {
    apiKey: 'sk-ok', baseUrl: 'https://example.test/v1', model: 'MiniMax-M3',
  });
  // Exactly what a too-small token budget produces: reasoning, no answer.
  await withFetch(async () => providerReply(
    '<think>用户要求回复“可用”两个字。我应该遵循。</think>'
  ), async () => {
    const { body } = await postJson(base, '/api/settings/test', {});
    assert.equal(body.ok, false, 'an answer-less reply must not read as success');
    assert.match(body.error, /思考/);
  });
});

test('the connection test gives the model room to think', async (t) => {
  const { base } = await boot(t);
  await postJson(base, '/api/settings', {
    apiKey: 'sk-ok', baseUrl: 'https://example.test/v1', model: 'MiniMax-M3',
  });
  let sent = null;
  await withFetch(async (url, init) => {
    sent = JSON.parse(init.body);
    return providerReply('可用');
  }, async () => {
    await postJson(base, '/api/settings/test', {});
  });
  // 16 was the original value and it was consumed by reasoning alone.
  assert.ok(sent.max_tokens >= 256, `max_tokens too small for a reasoning model: ${sent.max_tokens}`);
});
