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
const { chat, LlmError, parseJsonReply, imagePart } = require('../lib/llm');

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

// -------------------------------------------------------------- json parsing

test('parseJsonReply accepts a bare object', () => {
  assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 });
});

test('parseJsonReply digs the object out of fences and prose', () => {
  assert.deepEqual(parseJsonReply('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Here you go: {"a":1} hope that helps'), { a: 1 });
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
