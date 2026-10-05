'use strict';
/**
 * Tests for the settings store and the model client.
 *
 * The client tests use a stubbed global fetch, so nothing here touches a real
 * network or needs a key. What is being checked is our own behaviour: that the
 * key never leaks through the public projection, that provider errors reach the
 * caller intact, and that a poisoned reply fails loudly instead of silently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Settings, mask } = require('../lib/settings');
const { chat, LlmError, parseJsonReply, repairStrings, imagePart } = require('../lib/llm');

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

// ------------------------------------------------------------------- client

/** Install a fetch stub for the duration of a test. */
function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}

function okResponse(content, extra = {}) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content } }], ...extra,
    }),
  };
}

const CREDS = { baseUrl: 'https://example.test/v1', apiKey: 'sk-test', model: 'm' };

test('chat returns the message content and sends a bearer token', async () => {
  let seenUrl = null;
  let seenAuth = null;
  await withFetch(async (url, init) => {
    seenUrl = url;
    seenAuth = init.headers.authorization;
    return okResponse('hello');
  }, async () => {
    const out = await chat({ credentials: CREDS, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out, 'hello');
  });
  assert.equal(seenUrl, 'https://example.test/v1/chat/completions');
  assert.equal(seenAuth, 'Bearer sk-test');
});

test('a trailing slash on baseUrl does not produce a doubled path', async () => {
  let seenUrl = null;
  await withFetch(async (url) => { seenUrl = url; return okResponse('x'); }, async () => {
    await chat({
      credentials: { ...CREDS, baseUrl: 'https://example.test/v1///' },
      messages: [],
    });
  });
  assert.equal(seenUrl, 'https://example.test/v1/chat/completions');
});

test('an HTTP error surfaces the provider message, not a generic failure', async () => {
  await withFetch(async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
  }), async () => {
    await assert.rejects(
      () => chat({ credentials: CREDS, messages: [] }),
      (err) => {
        assert.ok(err instanceof LlmError);
        assert.equal(err.status, 401);
        assert.match(err.message, /401/);
        assert.match(err.message, /Incorrect API key/);
        return true;
      },
    );
  });
});

test('a network failure is reported as a connection problem', async () => {
  await withFetch(async () => { throw Object.assign(new Error('boom'), { cause: { code: 'ECONNREFUSED' } }); }, async () => {
    await assert.rejects(
      () => chat({ credentials: CREDS, messages: [] }),
      (err) => {
        assert.equal(err.code, 'network');
        assert.match(err.message, /ECONNREFUSED/);
        return true;
      },
    );
  });
});

test('missing credentials are refused before any request is made', async () => {
  await withFetch(async () => { throw new Error('must not be called'); }, async () => {
    await assert.rejects(
      () => chat({ credentials: { baseUrl: 'u', apiKey: '', model: 'm' }, messages: [] }),
      (err) => err.code === 'no-key',
    );
  });
});

test('json mode asks the provider for a JSON object', async () => {
  let body = null;
  await withFetch(async (_url, init) => { body = JSON.parse(init.body); return okResponse('{}'); }, async () => {
    await chat({ credentials: CREDS, messages: [], json: true });
  });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.temperature, 0, 'parsing wants repeatability, not creativity');
});

// ---------------------------------------------------------------- streaming
//
// Against a real local HTTP server rather than a fetch stub: what can go wrong
// here is chunk boundaries, a body that arrives after the headers, and a socket
// that goes quiet — none of which a stub that returns a finished string exercises.

const http = require('node:http');

/** Serve one scripted SSE response; `script(res)` writes it. Returns creds. */
function sseServer(t, script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      script(res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => { server.closeAllConnections(); server.close(); });
      resolve({
        creds: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'k', model: 'm' },
        seen,
      });
    });
  });
}

const sseHead = (res) => res.writeHead(200, { 'content-type': 'text/event-stream' });
const delta = (d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a streamed reply is assembled from its deltas, split anywhere', async (t) => {
  const { creds, seen } = await sseServer(t, async (res) => {
    sseHead(res);
    // Split one event across two writes: a line is only complete at its newline.
    const first = delta({ content: '{"intent":' });
    res.write(first.slice(0, 10));
    await wait(20);
    res.write(first.slice(10));
    res.write(delta({ content: '"answer"}' }));
    res.end('data: [DONE]\n\n');
  });
  const out = await chat({ credentials: creds, messages: [], stream: true, idleTimeoutMs: 1000 });
  assert.equal(out, '{"intent":"answer"}');
  assert.equal(seen[0].stream, true);
});

test('separate reasoning deltas keep the stream alive but are not part of the answer', async (t) => {
  const { creds } = await sseServer(t, async (res) => {
    sseHead(res);
    for (let i = 0; i < 4; i++) {
      res.write(delta({ reasoning_content: '想' }));
      await wait(80);
    }
    res.end(delta({ content: '好' }) + 'data: [DONE]\n\n');
  });
  // 320ms of reasoning with an idle limit of 200ms: only alive because each
  // reasoning chunk counts as activity.
  const out = await chat({ credentials: creds, messages: [], stream: true, idleTimeoutMs: 200 });
  assert.equal(out, '好');
});

test('a stream that goes quiet is aborted by the idle clock, not the total one', async (t) => {
  const { creds } = await sseServer(t, (res) => {
    sseHead(res);
    res.write(delta({ content: '{' }));
    // ...and then nothing, with the connection held open.
  });
  await assert.rejects(
    () => chat({ credentials: creds, messages: [], stream: true, idleTimeoutMs: 150, timeoutMs: 5000 }),
    (err) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'aborted');
      assert.match(err.message, /没有任何输出/);
      return true;
    },
  );
});

test('a stream that never stops still ends at the total cap', async (t) => {
  const { creds } = await sseServer(t, (res) => {
    sseHead(res);
    const tick = setInterval(() => res.write(delta({ content: '.' })), 30);
    res.on('close', () => clearInterval(tick));
  });
  await assert.rejects(
    () => chat({ credentials: creds, messages: [], stream: true, idleTimeoutMs: 200, timeoutMs: 400 }),
    (err) => /请求超时/.test(err.message),
  );
});

test('an error reported mid-stream surfaces the provider message', async (t) => {
  const { creds } = await sseServer(t, (res) => {
    sseHead(res);
    res.end(`data: ${JSON.stringify({ error: { message: 'quota exhausted' } })}\n\n`);
  });
  await assert.rejects(
    () => chat({ credentials: creds, messages: [], stream: true, idleTimeoutMs: 1000 }),
    (err) => err instanceof LlmError && /quota exhausted/.test(err.message),
  );
});

test('a provider that ignores stream:true and answers whole is still read', async (t) => {
  const { creds } = await sseServer(t, (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'whole' } }] }));
  });
  const out = await chat({ credentials: creds, messages: [], stream: true, idleTimeoutMs: 1000 });
  assert.equal(out, 'whole');
});

// -------------------------------------------------------------- json parsing

test('parseJsonReply accepts a bare object', () => {
  assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 });
});

test('parseJsonReply digs the object out of fences and prose', () => {
  assert.deepEqual(parseJsonReply('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Here you go: {"a":1} hope that helps'), { a: 1 });
});

test('parseJsonReply repairs bare quotes inside a string value', () => {
  // The live MiniMax-M3 shape: the reply quotes a word with ASCII quotes.
  const raw = '{"intent":"answer","reply":"没有一个参考系是"绝对"的。","reason":"提问","spec":null}';
  const v = parseJsonReply(raw);
  assert.equal(v.intent, 'answer');
  assert.equal(v.reply, '没有一个参考系是"绝对"的。');
  assert.equal(v.spec, null);
});

test('parseJsonReply repairs raw newlines inside a string value', () => {
  const v = parseJsonReply('{"intent":"answer","reply":"第一行\n第二行"}');
  assert.equal(v.reply, '第一行\n第二行');
});

test('repairStrings leaves valid JSON byte-for-byte unchanged', () => {
  const valid = JSON.stringify({ a: 'x "q" y', b: ['1,2', { c: 'd\ne' }], n: 1 });
  assert.equal(repairStrings(valid), valid);
});

test('parseJsonReply fails loudly, keeping the raw text', () => {
  assert.throws(
    () => parseJsonReply('absolutely not json'),
    (err) => {
      assert.match(err.message, /无法解析为 JSON/);
      assert.match(String(err.body), /absolutely not json/);
      return true;
    },
  );
});

test('imagePart builds a data URL with the declared mime', () => {
  const part = imagePart(Buffer.from([1, 2, 3]), 'image/png');
  assert.equal(part.type, 'image_url');
  assert.equal(part.image_url.url, 'data:image/png;base64,AQID');
});
