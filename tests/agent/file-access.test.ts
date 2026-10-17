'use strict';
/**
 * Tests for src/agent/file-access.ts — the path checks, the import into
 * attachments, and the writes performed after a turn. The checks as pi's
 * tools see them are in tests/agent/pi-tools.test.ts.
 *
 * What this file guards:
 *   - the built-in blocklist (keys, browser data, this app's data folder)
 *     holds whatever the user's list says, and is checked after symlinks
 *   - UNC, relative and stream paths are refused before any disk access
 *   - writes are text-only and replace the file atomically
 *   - a folder read is bounded, skips hidden and blocked entries, opens zips
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkPath, readPath, performWrite, FileAccessError } from '../../src/agent/file-access.ts';
import { writeZip } from '../../src/formats/zip.ts';

/** A scratch tree: a fake home with a .ssh, a data folder, and some documents. */
function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-fa-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const docs = path.join(root, 'docs');
  const data = path.join(root, 'appdata');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host x');
  fs.mkdirSync(path.join(docs, '订单', '深'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'settings.json'), '{"apiKey":"sk-secret"}');
  fs.writeFileSync(path.join(docs, '订单', '5月.csv'), '订单,状态\nA1,已签收\nA2,派送中\n');
  fs.writeFileSync(path.join(docs, '订单', '说明.txt'), '说明');
  fs.writeFileSync(path.join(docs, '订单', 'server.pem'), 'KEY');
  fs.writeFileSync(path.join(docs, '订单', 'tool.exe'), 'MZ');
  fs.writeFileSync(path.join(docs, '订单', '.hidden.csv'), 'a\n1\n');
  fs.writeFileSync(path.join(docs, '订单', '深', '6月.csv'), '订单,状态\nB1,拒签\n');
  fs.writeFileSync(path.join(docs, 'box3.zip'), writeZip([{ name: '内/7月.csv', data: '订单\nC1\n' }]));
  return { root, home, docs, data, opts: { home, dataDir: data } };
}

test('checkPath: built-in blocks hold — keys, the app data folder — and say why', async (t) => {
  const s = scratch(t);
  await assert.rejects(checkPath(path.join(s.home, '.ssh', 'config'), s.opts), /禁止访问/);
  await assert.rejects(checkPath('~/.ssh/config', s.opts), /禁止访问/);
  await assert.rejects(checkPath(path.join(s.data, 'settings.json'), s.opts), /禁止访问/);
  await assert.rejects(checkPath(path.join(s.docs, '订单', 'server.pem'), s.opts), /\*\.pem/);
  assert.strictEqual(
    await checkPath(path.join(s.docs, '订单', '5月.csv'), s.opts),
    fs.realpathSync(path.join(s.docs, '订单', '5月.csv')),
  );
});

test('checkPath: the user list adds locations and name patterns', async (t) => {
  const s = scratch(t);
  const opts = { ...s.opts, blocklist: [path.join(s.docs, '订单', '深'), '说明.*'] };
  await assert.rejects(checkPath(path.join(s.docs, '订单', '深', '6月.csv'), opts), /禁止访问/);
  await assert.rejects(checkPath(path.join(s.docs, '订单', '说明.txt'), opts), /说明\.\*/);
  await checkPath(path.join(s.docs, '订单', '5月.csv'), opts);
});

test('checkPath: refuses UNC, relative and missing paths before touching the disk', async (t) => {
  const s = scratch(t);
  await assert.rejects(checkPath('\\\\attacker\\share\\x.csv', s.opts), /网络共享/);
  await assert.rejects(checkPath('//attacker/share/x.csv', s.opts), /网络共享/);
  await assert.rejects(checkPath('订单/5月.csv', s.opts), /不是完整路径/);
  await assert.rejects(checkPath(path.join(s.docs, 'nope.csv'), s.opts), /不存在/);
  await assert.rejects(checkPath('', s.opts), FileAccessError);
});

test('checkPath: a symlink into a blocked folder is refused as that folder', async (t) => {
  const s = scratch(t);
  const link = path.join(s.docs, 'innocent');
  try {
    fs.symlinkSync(path.join(s.home, '.ssh'), link, 'junction');
  } catch {
    t.skip('symlinks not permitted here');
    return;
  }
  await assert.rejects(checkPath(path.join(link, 'config'), s.opts), /实际指向禁止访问的位置/);
});

// Order is the zh-CN collator's: Chinese names before Latin ones, fixed for any machine.
test('readPath: a folder reads its readable files, recursing; a zip is opened', async (t) => {
  const s = scratch(t);
  const r = await readPath(s.docs, s.opts);
  const names = r.items.map((i) => path.relative(s.docs, i.name).split(path.sep).join('/'));
  assert.deepStrictEqual(names, ['订单/5月.csv', '订单/深/6月.csv', '订单/说明.txt', 'box3.zip/内/7月.csv']);
  assert.ok(r.items.every((i) => i.att));
  assert.ok(r.skipped.some((p) => p.endsWith('tool.exe')));
  assert.ok(!r.skipped.some((p) => p.endsWith('.pem')), 'a blocked file is not even listed as skipped');
  const one = await readPath(path.join(s.docs, '订单', '5月.csv'), s.opts);
  assert.strictEqual(one.items[0].att.table.rows.length, 2);
});

test('performWrite: text only; creates folders, replaces whole, leaves no temp file', async (t) => {
  const s = scratch(t);
  const target = path.join(s.docs, '报告', '汇总.md');
  assert.strictEqual(
    await performWrite({ path: target, content: '# 一' }, s.opts),
    fs.realpathSync(path.join(s.docs, '报告')) + path.sep + '汇总.md',
  );
  await performWrite({ path: target, content: '# 四' }, s.opts);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '# 四');
  assert.deepStrictEqual(fs.readdirSync(path.join(s.docs, '报告')), ['汇总.md'], 'no temp file left behind');

  await assert.rejects(performWrite({ path: path.join(s.docs, 'run.bat'), content: 'x' }, s.opts), /只能写文本类文件/);
  await assert.rejects(performWrite({ path: path.join(s.data, 'notes.txt'), content: 'x' }, s.opts), /禁止访问/);
});

test('readPath: a folder wider than the walk limit stops there, and says so', async (t) => {
  // Depth was bounded, breadth was not: a wide tree was read in full. The
  // limit is lowered through the seam, so the test needs 60 files, not 20,000.
  const s = scratch(t);
  const wide = path.join(s.docs, 'wide');
  fs.mkdirSync(wide);
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(wide, `f${String(i).padStart(2, '0')}.csv`), 'a\n1\n');
  const r = await readPath(wide, { ...s.opts, walkLimit: 50 });
  assert.strictEqual(r.items.length, 50, 'the first 50 entries, in name order');
  assert.ok(
    r.skipped.some((p) => p.includes('超过 50 项')),
    r.skipped.join('\n'),
  );
});
