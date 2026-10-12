'use strict';
/**
 * Tests for the settings store and the model client.
 *
 * The client tests run against a local HTTP server speaking the OpenAI
 * streaming format, so nothing here touches a real network or needs a key.
 * What is being checked is our own behaviour on top of pi-ai: that the key
 * never leaks through the public projection, that provider errors reach the
 * caller intact, and that our clocks — idle, total, caller — each fire and
 * say which one it was.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { listenLocal } = require('./listen');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Settings, mask } = require('../lib/settings');
const { chat, LlmError, toLlmError, stripReasoning, imagePart, createClocks } = require('../lib/llm');
const { modelFromSecrets } = require('../lib/model');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-settings-'));
}

// ---------------------------------------------------------------- settings

test('missing settings file yields defaults rather than an error', async () => {
  const dir = scratch();
  const s = await new Settings(dir).load();
  assert.equal(s.apiKey, '');
  assert.ok(s.baseUrl.startsWith('https://'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt settings file does not break startup', async () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ this is not json');
  const s = await new Settings(dir).load();
  assert.equal(s.apiKey, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save then load round-trips, and unknown keys are dropped', async () => {
  const dir = scratch();
  const store = new Settings(dir);
  await store.save({ apiKey: 'sk-test-abcdef123456', model: 'gpt-4o-mini', evil: 'ignored' });
  const reread = await new Settings(dir).load();
  assert.equal(reread.apiKey, 'sk-test-abcdef123456');
  assert.ok(!('evil' in reread), 'unknown key must not be persisted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('publicSettings never carries the key, only a hint', async () => {
  const dir = scratch();
  const store = new Settings(dir);
  await store.save({ apiKey: 'sk-test-abcdef123456' });
  const pub = await store.publicSettings();

  // The whole point of the projection: no field anywhere holds the secret.
  assert.ok(!JSON.stringify(pub).includes('sk-test-abcdef123456'));
  assert.equal(pub.hasKey, true);
  assert.equal(pub.keyHint, 'sk-…3456');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isConfigured requires all three of key, base URL and model', async () => {
  const dir = scratch();
  const store = new Settings(dir);
  assert.equal(await store.isConfigured(), false);
  await store.save({ apiKey: 'sk-x' });
  assert.equal(await store.isConfigured(), true);
  await store.save({ model: '' });
  assert.equal(await store.isConfigured(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mask keeps short keys opaque', () => {
  assert.equal(mask('short'), '****');
  assert.equal(mask('sk-1234567890abcd'), 'sk-…abcd');
});

test('the protocol defaults to OpenAI-compatible, including for an older file', async () => {
  const dir = scratch();
  const store = new Settings(dir);
  assert.equal((await store.secrets()).api, 'openai-completions');
  // A settings.json written before the key existed.
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiKey: 'sk-x', baseUrl: 'https://x/v1', model: 'm' }));
  const older = new Settings(dir);
  assert.equal((await older.secrets()).api, 'openai-completions');
  assert.equal((await older.publicSettings()).api, 'openai-completions');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a saved protocol round-trips; an unknown one reads as the default', async () => {
  const dir = scratch();
  const store = new Settings(dir);
  await store.save({ api: 'anthropic-messages' });
  assert.equal((await new Settings(dir).secrets()).api, 'anthropic-messages');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ api: 'bedrock-converse-stream' }));
  assert.equal((await new Settings(dir).secrets()).api, 'openai-completions');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('modelFromSecrets builds a custom model with conservative OpenAI compat', () => {
  const m = modelFromSecrets({ api: 'openai-completions', baseUrl: 'https://x.test/v1///', apiKey: 'k', model: 'qwen-max' });
  assert.equal(m.id, 'qwen-max');
  assert.equal(m.api, 'openai-completions');
  assert.equal(m.baseUrl, 'https://x.test/v1');
  assert.deepEqual(m.compat, { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false });
  const a = modelFromSecrets({ api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'c' });
  assert.equal(a.api, 'anthropic-messages');
  assert.equal(a.compat, undefined, 'OpenAI compat is not attached to other protocols');
});

// ------------------------------------------------------------------- client
//
// Against a real local HTTP server speaking the OpenAI streaming format. pi-ai
// always streams, and what can go wrong is chunk boundaries, a body that
// arrives after the headers, and a socket that goes quiet — none of which a
// stub that returns a finished string exercises.

const http = require('node:http');

/** Serve one scripted response per request; `script(res, req)` writes it. */
function sseServer(t, script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      script(res, req);
    });
  });
  return new Promise((resolve) => {
    listenLocal(server).then(() => {
      t.after(() => { server.closeAllConnections(); server.close(); });
      resolve({
        creds: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', model: 'm' },
        seen,
      });
    });
  });
}

// `connection: close`: each test starts a fresh server and may be given the
// port a previous one just released; a pooled keep-alive socket to the old
// server would take the new request and fail it.
const sseHead = (res) => res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
const delta = (d, finish = null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
const done = (res) => res.end(delta({}, 'stop') + 'data: [DONE]\n\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('chat returns the message content, with a bearer token, at /chat/completions', async (t) => {
  const { creds, seen } = await sseServer(t, (res) => {
    sseHead(res);
    res.write(delta({ role: 'assistant', content: 'hel' }));
    res.write(delta({ content: 'lo' }));
    done(res);
  });
  const out = await chat({ credentials: creds, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] });
  assert.equal(out, 'hello');
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].headers.authorization, 'Bearer sk-test');
  // Conservative compat: `system`, not `developer`, which most compatible
  // servers do not know.
  assert.equal(seen[0].body.messages[0].role, 'system');
  assert.equal(seen[0].body.temperature, 0, 'parsing wants repeatability, not creativity');
  assert.equal(seen[0].body.stream, true);
});

test('a trailing slash on baseUrl does not produce a doubled path', async (t) => {
  const { creds, seen } = await sseServer(t, (res) => { sseHead(res); res.write(delta({ content: 'x' })); done(res); });
  await chat({ credentials: { ...creds, baseUrl: `${creds.baseUrl}///` }, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(seen[0].url, '/v1/chat/completions');
});

test('an HTTP error surfaces the status and the provider message', async (t) => {
  const { creds } = await sseServer(t, (res) => {
    res.writeHead(401, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
  });
  await assert.rejects(
    () => chat({ credentials: creds, messages: [{ role: 'user', content: 'x' }] }),
    (err) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.status, 401);
      assert.match(err.message, /模型服务返回 401/);
      assert.match(err.message, /Incorrect API key/);
      return true;
    },
  );
});

test('a refused connection is reported as a connection problem', async (t) => {
  // Bind a port, then close it: nothing listens there now.
  const probe = http.createServer();
  await new Promise((r) => listenLocal(probe).then(r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  await assert.rejects(
    () => chat({ credentials: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' }, messages: [{ role: 'user', content: 'x' }] }),
    (err) => {
      assert.equal(err.code, 'network', err.message);
      assert.match(err.message, /无法连接模型服务/);
      return true;
    },
  );
});

test('missing credentials are refused before any request is made', async () => {
  await assert.rejects(
    () => chat({ credentials: { baseUrl: 'u', apiKey: '', model: 'm' }, messages: [] }),
    (err) => err.code === 'no-key',
  );
  await assert.rejects(
    () => chat({ credentials: { baseUrl: '', apiKey: 'k', model: 'm' }, messages: [] }),
    (err) => err.code === 'no-base-url',
  );
});

test('a streamed reply is assembled from its deltas, split anywhere', async (t) => {
  const { creds } = await sseServer(t, async (res) => {
    sseHead(res);
    // Split one event across two writes: a line is only complete at its newline.
    const first = delta({ role: 'assistant', content: '你好' });
    res.write(first.slice(0, 10));
    await wait(20);
    res.write(first.slice(10));
    res.write(delta({ content: '世界' }));
    done(res);
  });
  const out = await chat({ credentials: creds, messages: [{ role: 'user', content: 'x' }], idleTimeoutMs: 1000 });
  assert.equal(out, '你好世界');
});

test('separate reasoning deltas keep the stream alive but are not part of the answer', async (t) => {
  const { creds } = await sseServer(t, async (res) => {
    sseHead(res);
    for (let i = 0; i < 4; i++) {
      res.write(delta({ reasoning_content: '想' }));
      await wait(80);
    }
    res.write(delta({ content: '好' }));
    done(res);
  });
  // 320ms of reasoning with an idle limit of 200ms: only alive because each
  // reasoning chunk counts as activity.
  const out = await chat({ credentials: creds, messages: [{ role: 'user', content: 'x' }], idleTimeoutMs: 200 });
  assert.equal(out, '好');
});

test('a stream that goes quiet is aborted by the idle clock, not the total one', async (t) => {
  const { creds } = await sseServer(t, (res) => {
    sseHead(res);
    res.write(delta({ role: 'assistant', content: '{' }));
    // ...and then nothing, with the connection held open.
  });
  await assert.rejects(
    () => chat({ credentials: creds, messages: [{ role: 'user', content: 'x' }], idleTimeoutMs: 150, timeoutMs: 5000 }),
    (err) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'aborted');
      assert.match(err.message, /没有任何输出/);
      return true;
    },
  );
});

test('createClocks: touch(ms) arms that window for the next silence only', async () => {
  const clocks = createClocks({ timeoutMs: 5000, idleTimeoutMs: 40 });
  try {
    // A longer window survives a silence the default would not...
    clocks.touch(400);
    assert.equal(clocks.idleWindowMs(), 400);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(clocks.reason(), null);
    // ...and a plain touch goes back to the default, which then fires.
    clocks.touch();
    assert.equal(clocks.idleWindowMs(), 40);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(clocks.reason(), 'idle');
  } finally {
    clocks.dispose();
  }
});

test('toLlmError: an idle abort quotes the window that fired, not the default', () => {
  const clocks = { reason: () => 'idle', idleWindowMs: () => 180_000, idleTimeoutMs: 60_000, timeoutMs: 300_000 };
  const err = toLlmError({ stopReason: 'aborted' }, clocks);
  assert.match(err.message, /模型 180 秒没有任何输出/);
});

test('a stream that never stops still ends at the total cap', async (t) => {
  const { creds } = await sseServer(t, (res) => {
    sseHead(res);
    const tick = setInterval(() => res.write(delta({ content: '.' })), 30);
    res.on('close', () => clearInterval(tick));
  });
  await assert.rejects(
    () => chat({ credentials: creds, messages: [{ role: 'user', content: 'x' }], idleTimeoutMs: 200, timeoutMs: 400 }),
    (err) => /请求超时/.test(err.message),
  );
});

test('the caller can cancel', async (t) => {
  const { creds } = await sseServer(t, (res) => { sseHead(res); res.write(delta({ content: '.' })); });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  await assert.rejects(
    () => chat({ credentials: creds, messages: [{ role: 'user', content: 'x' }], timeoutMs: 5000, signal: ctrl.signal }),
    (err) => err.code === 'aborted' && /已取消/.test(err.message),
  );
});

test('an error reported mid-stream surfaces the provider message', async (t) => {
  const { creds } = await sseServer(t, (res) => {
    sseHead(res);
    res.end(`data: ${JSON.stringify({ error: { message: 'quota exhausted' } })}\n\n`);
  });
  await assert.rejects(
    () => chat({ credentials: creds, messages: [{ role: 'user', content: 'x' }], idleTimeoutMs: 1000 }),
    (err) => err instanceof LlmError && /quota exhausted/.test(err.message),
  );
});

test('toLlmError: a bare status line still yields the status', () => {
  const err = toLlmError({ stopReason: 'error', errorMessage: '429 status code (no body)' });
  assert.equal(err.status, 429);
  assert.match(err.message, /模型服务返回 429/);
});

test('stripReasoning removes an inline think block, and only that', () => {
  assert.equal(stripReasoning('<think>算一下\n再想想</think>答案是 3'), '答案是 3');
  assert.equal(stripReasoning('<think/>好'), '好');
  assert.equal(stripReasoning('我觉得 think 这个词没问题'), '我觉得 think 这个词没问题');
});

test('imagePart builds a data URL with the declared mime', () => {
  const part = imagePart(Buffer.from([1, 2, 3]), 'image/png');
  assert.equal(part.type, 'image_url');
  assert.equal(part.image_url.url, 'data:image/png;base64,AQID');
});

test('a provider that ignores stream:true is an error, not an empty answer', async (t) => {
  // pi-ai reads only the event stream; a whole-JSON body has no events in it
  // and would otherwise come back as an empty success.
  const { creds } = await sseServer(t, (res) => {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'whole' }, finish_reason: 'stop' }] }));
  });
  await assert.rejects(
    () => chat({ credentials: creds, messages: [{ role: 'user', content: 'x' }], timeoutMs: 3000 }),
    (err) => err.code === 'empty' && /流式输出/.test(err.message),
  );
});
