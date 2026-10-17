'use strict';
/**
 * Integration tests for the model plumbing over the real HTTP surface.
 *
 * These matter because the unit tests stub the layers below. Here the server is
 * driven the way the UI drives it, with a local HTTP server standing in for
 * the provider. The assertions are about behaviour the user would notice:
 *
 *   - the key never comes back out of the API
 *   - a reasoning block is stripped from the connection test
 *   - an unreachable provider is reported rather than swallowed
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { listenLocal } from '../helpers/listen.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createServer, AppState } from '../../src/http/server.ts';

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/** Boot a server over a scratch dir; returns {base, dir, close}. */
async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-model-'));
  const server = createServer({
    state: new AppState({ dataDir: dir }),
    staticDir: PUBLIC_DIR,
  });
  await new Promise((r) => listenLocal(server).then(r));
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

/**
 * A local provider speaking the OpenAI streaming format. `script(res)` writes
 * each response; every request body is kept in `seen`. Returns its base URL.
 */
function provider(t, script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      seen.push(raw ? JSON.parse(raw) : null);
      script(res);
    });
  });
  return new Promise((resolve) => {
    listenLocal(server).then(() => {
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      resolve({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, seen });
    });
  });
}

const chunk = (d, finish = null) =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;

/** A streamed reply: each item is one delta. */
function streamed(...deltas) {
  return (res) => {
    // `connection: close`: each test starts a fresh provider and may be given
    // the port a previous one just released. A pooled keep-alive socket to the
    // old server would then take the new request and fail it — a flake that
    // says nothing about the code under test.
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    for (const d of deltas) res.write(chunk(d));
    res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
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

test('the protocol is saved, echoed, and an unknown one refused', async (t) => {
  const { base } = await boot(t);
  assert.equal((await getJson(base, '/api/settings')).body.settings.api, 'openai-completions');
  const saved = await postJson(base, '/api/settings', { api: 'google-generative-ai' });
  assert.equal(saved.body.settings.api, 'google-generative-ai');
  const bad = await postJson(base, '/api/settings', { api: 'bedrock-converse-stream' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /不支持的接口协议/);
  assert.equal(
    (await getJson(base, '/api/settings')).body.settings.api,
    'google-generative-ai',
    'a refused value changes nothing',
  );
});

test('saving and fetching settings: defaults, normalisation, and refusals', async (t) => {
  const { base } = await boot(t);
  const fresh = (await getJson(base, '/api/settings')).body.settings;
  assert.equal(fresh.chatCanFetch, false, 'fetching is off until the user turns it on');
  assert.equal(fresh.chatCanSave, true);
  assert.equal(fresh.exportDir, '');
  assert.ok(path.isAbsolute(fresh.exportDirResolved), fresh.exportDirResolved);
  assert.deepEqual(fresh.fetchBlocklist, []);

  const dir = path.join(os.tmpdir(), 'tab-agent-exports');
  const saved = await postJson(base, '/api/settings', {
    chatCanFetch: true,
    chatCanSave: false,
    exportDir: dir,
    fetchBlocklist: ['https://Evil.example/x', '*.ads.example', '', 'evil.example'].join('\n'),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.chatCanFetch, true);
  assert.equal(saved.body.settings.chatCanSave, false);
  assert.equal(saved.body.settings.exportDir, dir);
  assert.equal(saved.body.settings.exportDirResolved, dir);
  assert.deepEqual(saved.body.settings.fetchBlocklist, ['evil.example', 'ads.example']);

  const relative = await postJson(base, '/api/settings', { exportDir: 'exports' });
  assert.equal(relative.status, 400);
  assert.match(relative.body.error, /完整路径/);
  assert.equal((await getJson(base, '/api/settings')).body.settings.exportDir, dir, 'a refused value changes nothing');
});

test('/api/settings/test reports a provider failure verbatim', async (t) => {
  const { base } = await boot(t);
  const p = await provider(t, (res) => {
    res.writeHead(401, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
  });
  await postJson(base, '/api/settings', { apiKey: 'sk-bad', baseUrl: p.baseUrl, model: 'm' });
  const { body } = await postJson(base, '/api/settings/test', {});
  assert.equal(body.ok, false);
  assert.match(body.error, /401/);
  assert.match(body.error, /Incorrect API key/);
});

test('/api/settings/test reports an unreachable provider', async (t) => {
  const { base } = await boot(t);
  const probe = http.createServer();
  await new Promise((r) => listenLocal(probe).then(r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  await postJson(base, '/api/settings', { apiKey: 'sk', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' });
  const { body } = await postJson(base, '/api/settings/test', {});
  assert.equal(body.ok, false);
  assert.match(body.error, /无法连接模型服务/);
});

// Reasoning models (MiniMax-M3, DeepSeek, …) think before they answer. Two
// things about that were found only by talking to a real provider: the
// thinking must not be shown as the answer, and the test endpoint's token
// budget must be large enough to cover the thinking or the answer never comes.
test('an inline reasoning block does not leak into the connection-test reply', async (t) => {
  const { base } = await boot(t);
  const p = await provider(
    t,
    streamed({ role: 'assistant', content: '<think>The user wants two characters.</think>\n\n可用' }),
  );
  await postJson(base, '/api/settings', { apiKey: 'sk-ok', baseUrl: p.baseUrl, model: 'MiniMax-M3' });
  const { body } = await postJson(base, '/api/settings/test', {});
  assert.equal(body.ok, true);
  assert.equal(body.reply, '可用');
  assert.doesNotMatch(body.reply, /think/i);
});

test('separately streamed reasoning is not part of the connection-test reply', async (t) => {
  const { base } = await boot(t);
  const p = await provider(t, streamed({ role: 'assistant', reasoning_content: '用户要两个字' }, { content: '可用' }));
  await postJson(base, '/api/settings', { apiKey: 'sk-ok', baseUrl: p.baseUrl, model: 'deepseek-reasoner' });
  const { body } = await postJson(base, '/api/settings/test', {});
  assert.equal(body.ok, true);
  assert.equal(body.reply, '可用');
});

test('a thinking-only reply is reported as a failure, not as success', async (t) => {
  // Exactly what a too-small token budget produces: reasoning, no answer —
  // inline or as a separate stream.
  for (const reply of [
    streamed({ role: 'assistant', content: '<think>用户要求回复“可用”两个字。我应该遵循。</think>' }),
    streamed({ role: 'assistant', reasoning_content: '用户要求回复“可用”两个字。' }),
  ]) {
    const { base } = await boot(t);
    const p = await provider(t, reply);
    await postJson(base, '/api/settings', { apiKey: 'sk-ok', baseUrl: p.baseUrl, model: 'MiniMax-M3' });
    const { body } = await postJson(base, '/api/settings/test', {});
    assert.equal(body.ok, false, 'an answer-less reply must not read as success');
    assert.match(body.error, /思考/);
  }
});

test('the connection test gives the model room to think', async (t) => {
  const { base } = await boot(t);
  const p = await provider(t, streamed({ role: 'assistant', content: '可用' }));
  await postJson(base, '/api/settings', { apiKey: 'sk-ok', baseUrl: p.baseUrl, model: 'MiniMax-M3' });
  await postJson(base, '/api/settings/test', {});
  // 16 was the original value and it was consumed by reasoning alone.
  const sent = p.seen[0];
  const budget = sent.max_tokens ?? sent.max_completion_tokens;
  assert.ok(budget >= 256, `token budget too small for a reasoning model: ${budget}`);
});

test('file access: off by default, validated, and the blocklist normalised', async (t) => {
  const { base } = await boot(t);
  const fresh = (await getJson(base, '/api/settings')).body.settings;
  assert.equal(fresh.chatFileAccess, 'off', 'local files are off until the user turns them on');
  assert.deepEqual(fresh.fileBlocklist, []);
  const bad = await postJson(base, '/api/settings', { chatFileAccess: 'everything' });
  assert.equal(bad.status, 400);
  const ok = await postJson(base, '/api/settings', { chatFileAccess: 'read', fileBlocklist: 'D:\\财务\n\n*.bak' });
  assert.equal(ok.body.settings.chatFileAccess, 'read');
  assert.deepEqual(ok.body.settings.fileBlocklist, ['D:\\财务', '*.bak']);
});
