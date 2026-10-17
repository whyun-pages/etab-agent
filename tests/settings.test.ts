'use strict';
/**
 * Tests for the settings store: the record on disk, what leaves it, and the
 * serialisation that async I/O made necessary.
 *
 * `save` is a read-modify-write that spans an `await` — exactly the window
 * `writeFileSync` used to close for free. `#run` (the per-instance queue) closes
 * it again; the concurrency test below is what proves the queue is load-bearing.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Settings } from '../src/store/settings.ts';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a fresh directory loads defaults and is not configured', async (t) => {
  const store = new Settings(scratch(t));
  const rec = await store.load();
  assert.strictEqual(rec.apiKey, '');
  assert.ok(rec.baseUrl.startsWith('https://'), rec.baseUrl);
  assert.strictEqual(await store.isConfigured(), false);
});

test('save -> load round-trips, drops unknown keys, writes one file', async (t) => {
  const dir = scratch(t);
  const store = new Settings(dir);
  await store.save({ apiKey: 'sk-test-abcdef123456', model: 'gpt-4o-mini', evil: 'ignored' });

  const reread = await new Settings(dir).load();
  assert.strictEqual(reread.apiKey, 'sk-test-abcdef123456');
  assert.strictEqual(reread.model, 'gpt-4o-mini');
  assert.ok(!('evil' in reread), 'an unknown key must not be persisted');
  assert.strictEqual(await store.isConfigured(), true);
  // temp+rename: a torn write cannot leave truncated JSON (and a lost key).
  assert.deepStrictEqual(fs.readdirSync(dir), ['settings.json']);
});

test('publicSettings never carries the key, only that there is one', async (t) => {
  const store = new Settings(scratch(t));
  await store.save({ apiKey: 'sk-test-abcdef123456' });
  const pub = await store.publicSettings();
  assert.ok(!JSON.stringify(pub).includes('sk-test-abcdef123456'), 'the key leaked');
  assert.strictEqual(pub.hasKey, true);
  assert.strictEqual(pub.keyHint, 'sk-…3456');
});

test('concurrent saves apply in call order and lose none', async (t) => {
  // Twenty saves, each touching one of six keys. With the queue they apply in
  // the order they were called, so every key ends at the value of its LAST
  // save. Without it each save reads the same old file and clobbers the
  // others — or, on Windows, the second concurrent rename onto settings.json
  // fails with EPERM (measured).
  //
  // Checking only that the six keys are present would prove nothing: a fresh
  // record already has every key, from the defaults.
  const dir = scratch(t);
  const store = new Settings(dir);
  const keys = ['baseUrl', 'apiKey', 'model', 'useForAttachments', 'chatCanEdit', 'chatConfirmEdits'];
  const valueFor = (k, i) => (k === 'baseUrl' ? `https://host-${i}.test/v1`
    : k === 'apiKey' ? `sk-${i}`
      : k === 'model' ? `model-${i}`
        : Boolean(i % 2));

  const expected = {};
  const ops = [];
  for (let i = 0; i < 20; i++) {
    const k = keys[i % keys.length];
    expected[k] = valueFor(k, i);
    ops.push(store.save({ [k]: expected[k] }));
  }
  await Promise.all(ops);

  const final = await new Settings(dir).load();
  for (const k of keys) assert.deepStrictEqual(final[k], expected[k], `${k}: an earlier save won over a later one`);
  assert.deepStrictEqual(fs.readdirSync(dir), ['settings.json'], 'stray temp files');
});
