'use strict';
/**
 * The session API over real HTTP: what a turn does outside the workbook.
 *
 * Saving files (only the landed table, never overwriting), fetching URLs
 * through the server's blocklist, and reading and writing local files under
 * the access setting.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { listenLocal } from '../helpers/listen.ts';

import { tmpdir, startServer, post, get, SPEC, ACTION } from '../helpers/session-server.ts';

// ── saving, downloading in other formats, fetching ──────────────────

const saveSettings = (dir) => ({ chatCanSave: true, exportDir: dir });

test('a turn that edits and saves writes the LANDED table and says where', async (t) => {
  const exportDir = tmpdir();
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const { base } = await startServer(t, {
    chatConfirmEdits: false,
    extra: saveSettings(exportDir),
    replies: [
      [{ tool: 'create_workbook', args: SPEC }, { tool: 'save_file', args: { format: 'csv' } }, '建好并保存了。'],
    ],
  });
  const {
    json: { session },
  } = await post(base, '/api/sessions', {});
  const r = await post(base, `/api/sessions/${session.id}/turn`, { message: '做个销售台账并保存成 csv' });
  assert.strictEqual(r.json.applied, true);
  assert.deepStrictEqual(
    r.json.saved.map((p) => path.basename(p)),
    ['销售台账.csv'],
  );
  const csv = fs.readFileSync(path.join(exportDir, '销售台账.csv'), 'utf8');
  assert.match(csv, /^﻿客户名称,金额\r\n甲,1000000\r\n/);
  assert.match(r.json.reply, /已保存：.*销售台账\.csv/);
  // The outcome is part of the stored transcript, not just this response.
  const again = await get(base, `/api/sessions/${session.id}`);
  const last = again.json.session.messages[again.json.session.messages.length - 1];
  assert.match(last.content, /已保存：/);
});

test('saving twice never overwrites', async (t) => {
  const exportDir = tmpdir();
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const save = [{ tool: 'save_file', args: { format: 'json' } }, '好了'];
  const { base } = await startServer(t, {
    chatConfirmEdits: false,
    extra: saveSettings(exportDir),
    replies: [ACTION, save, save],
  });
  const {
    json: { session },
  } = await post(base, '/api/sessions', {});
  await post(base, `/api/sessions/${session.id}/turn`, { message: '做表' });
  await post(base, `/api/sessions/${session.id}/turn`, { message: '保存成 json' });
  await post(base, `/api/sessions/${session.id}/turn`, { message: '再保存一次' });
  assert.deepStrictEqual(fs.readdirSync(exportDir).sort(), ['销售台账 (1).json', '销售台账.json']);
});

test('a held change is saved only once it is applied', async (t) => {
  const exportDir = tmpdir();
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const { base } = await startServer(t, {
    chatConfirmEdits: true,
    extra: saveSettings(exportDir),
    replies: [
      [
        { tool: 'create_workbook', args: SPEC },
        { tool: 'save_file', args: { format: 'xlsx', filename: '台账' } },
        '好了',
      ],
    ],
  });
  const {
    json: { session },
  } = await post(base, '/api/sessions', {});
  const r = await post(base, `/api/sessions/${session.id}/turn`, { message: '做表并保存' });
  assert.strictEqual(r.json.pending, true);
  assert.deepStrictEqual(r.json.saved, []);
  assert.match(r.json.reply, /确认修改后会保存文件/);
  assert.deepStrictEqual(fs.readdirSync(exportDir), []);

  const applied = await post(base, `/api/sessions/${session.id}/apply`, { accept: true });
  assert.strictEqual(applied.json.applied, true);
  assert.deepStrictEqual(
    applied.json.saved.map((p) => path.basename(p)),
    ['台账.xlsx'],
  );
  assert.strictEqual(fs.readFileSync(path.join(exportDir, '台账.xlsx')).subarray(0, 2).toString(), 'PK');
});

test('a rejected held change saves nothing', async (t) => {
  const exportDir = tmpdir();
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const { base } = await startServer(t, {
    chatConfirmEdits: true,
    extra: saveSettings(exportDir),
    replies: [[{ tool: 'create_workbook', args: SPEC }, { tool: 'save_file', args: { format: 'csv' } }, '好了']],
  });
  const {
    json: { session },
  } = await post(base, '/api/sessions', {});
  await post(base, `/api/sessions/${session.id}/turn`, { message: '做表并保存' });
  await post(base, `/api/sessions/${session.id}/apply`, { accept: false });
  assert.deepStrictEqual(fs.readdirSync(exportDir), []);
});

test('with saving switched off the tool is not offered and nothing is written', async (t) => {
  const exportDir = tmpdir();
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const seen = [];
  const { base } = await startServer(t, {
    chatConfirmEdits: false,
    extra: { chatCanSave: false, exportDir },
    seen,
    replies: [ACTION],
  });
  const {
    json: { session },
  } = await post(base, '/api/sessions', {});
  await post(base, `/api/sessions/${session.id}/turn`, { message: '做表并保存' });
  assert.doesNotMatch(seen[0], /save_file/);
  assert.deepStrictEqual(fs.readdirSync(exportDir), []);
});

test('a turn can fetch a CSV and import it as the table', async (t) => {
  const src = http.createServer((req, res) => {
    res.setHeader('connection', 'close');
    res.setHeader('content-type', 'text/csv');
    res.end('城市,人口\n杭州,1200\n宁波,950\n');
  });
  await new Promise((r) => listenLocal(src).then(r));
  t.after(() => new Promise((r) => src.close(r)));
  const url = `http://127.0.0.1:${src.address().port}/c.csv`;

  const { base } = await startServer(t, {
    chatConfirmEdits: false,
    extra: { chatCanFetch: true, fetchBlocklist: [] },
    fetchOptions: { allowPrivate: true },
    replies: [[{ tool: 'fetch_url', args: { url, importAs: '城市' } }, '导入了。']],
  });
  const {
    json: { session },
  } = await post(base, '/api/sessions', {});
  const r = await post(base, `/api/sessions/${session.id}/turn`, { message: `把 ${url} 导入` });
  assert.strictEqual(r.json.applied, true);
  const stored = await get(base, `/api/sessions/${session.id}`);
  assert.deepStrictEqual(stored.json.session.spec.sheets[0].rows, [
    ['杭州', 1200],
    ['宁波', 950],
  ]);
});

test('the server blocklist reaches the fetch tool', async (t) => {
  const seenResults = [];
  const { base } = await startServer(t, {
    extra: { chatCanFetch: true, fetchBlocklist: ['blocked.example'] },
    replies: [
      [
        { tool: 'fetch_url', args: { url: 'https://www.blocked.example/a.csv' } },
        (context) => {
          seenResults.push(...context.messages.filter((m) => m.role === 'toolResult'));
          return '被禁止了。';
        },
      ],
    ],
  });
  const {
    json: { session },
  } = await post(base, '/api/sessions', {});
  await post(base, `/api/sessions/${session.id}/turn`, { message: '抓 https://www.blocked.example/a.csv' });
  assert.strictEqual(seenResults.length, 1);
  assert.strictEqual(seenResults[0].isError, true);
  assert.match(seenResults[0].content[0].text, /禁止抓取/);
});

// ── local files ──────────────────────────────────────────────────────

test('a turn reads a local file, queries it, and the file stays as an attachment', async (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '订单.csv');
  fs.writeFileSync(file, '订单,状态\nA1,已签收\nA2,派送中\nA3,已签收\n');
  const results = [];
  const { base } = await startServer(t, {
    extra: { chatFileAccess: 'read', fileBlocklist: [] },
    replies: [
      [
        { tool: 'import_file', args: { path: file } },
        { tool: 'query_table', args: { attachment: '订单.csv', groupBy: ['状态'] } },
        (context) => {
          results.push(...context.messages.filter((m) => m.role === 'toolResult'));
          return '已签收 2 单，派送中 1 单。';
        },
      ],
    ],
  });
  const {
    json: { session },
  } = await post(base, '/api/sessions', {});
  const r = await post(base, `/api/sessions/${session.id}/turn`, { message: `${file} 统计订单状态` });
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(results[0].isError, false);
  assert.match(results[1].content[0].text, /已签收\t2\n派送中\t1/);
  const att = await get(base, `/api/sessions/${session.id}/attachments`);
  assert.deepStrictEqual(
    att.json.attachments.map((a) => a.name),
    [file],
  );
});

test('write and edit land after the turn, and only with readwrite access', async (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, '报告.md');
  let onDiskDuringTurn = null;
  const { base } = await startServer(t, {
    extra: { chatFileAccess: 'readwrite', fileBlocklist: [] },
    replies: [
      [
        { tool: 'write', args: { path: target, content: '# 汇总\n共 3 单' } },
        { tool: 'edit', args: { path: target, edits: [{ oldText: '3', newText: '4' }] } },
        () => {
          onDiskDuringTurn = fs.existsSync(target);
          return '写好了。';
        },
      ],
    ],
  });
  const {
    json: { session },
  } = await post(base, '/api/sessions', {});
  const r = await post(base, `/api/sessions/${session.id}/turn`, { message: `把汇总写到 ${target}` });
  assert.strictEqual(onDiskDuringTurn, false, 'nothing is written while the turn runs');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '# 汇总\n共 4 单');
  assert.match(r.json.reply, /已保存：.*报告\.md/);
});

test('with file access off no file tool is offered, and the note says how to turn it on', async (t) => {
  const seen = [];
  const { base } = await startServer(t, { seen, replies: ['好'] });
  const {
    json: { session },
  } = await post(base, '/api/sessions', {});
  await post(base, `/api/sessions/${session.id}/turn`, { message: 'D:\tmp\box3.zip 统计订单状态' });
  assert.doesNotMatch(seen[0], /import_file|\bgrep\b|\bedit\b|powershell|bash/);
  assert.match(seen[0], /允许读写本机文件/);
});
