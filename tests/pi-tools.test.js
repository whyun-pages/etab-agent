'use strict';
/**
 * Tests for pi's file and shell tools (lib/pi-tools/) as the agent gets them:
 * through the checked, deferred operations of lib/file-access.ts.
 *
 * What this file guards:
 *   - every tool refuses what checkPath refuses, and says why
 *   - ls, find and grep leave blocked entries out instead of failing
 *   - write and edit record, never touch the disk, and say so; a read in the
 *     same turn sees what was recorded
 *   - pi's output shapes survive the port: line paging, edit matching,
 *     grep's path:line format, the shell's exit-code reporting
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fileOperations } = require('../lib/file-access');
const tools = require('../lib/pi-tools/fs-tools');
const shell = require('../lib/pi-tools/shell');
const { loadPi } = require('../lib/pi');

/** A scratch tree: a fake home with a .ssh, a data folder, and some documents. */
function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-pt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const docs = path.join(home, 'docs');
  const data = path.join(root, 'appdata');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host x');
  fs.mkdirSync(path.join(docs, '订单', '深'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'settings.json'), '{"apiKey":"sk-secret"}');
  fs.writeFileSync(path.join(docs, '订单', '5月.csv'), '订单,状态\nA1,已签收\nA2,派送中\n');
  fs.writeFileSync(path.join(docs, '订单', '深', '6月.csv'), '订单,状态\nB1,已签收\n');
  fs.writeFileSync(path.join(docs, '订单', 'server.pem'), '已签收 KEY');
  fs.writeFileSync(path.join(docs, '说明.txt'), Array.from({ length: 30 }, (_, i) => `第${i + 1}行`).join('\n'));
  return { root, home, docs, data, opts: { home, dataDir: data } };
}

/** The tools for one turn over the scratch tree, sharing one list of writes. */
async function turnTools(s) {
  const { ai } = await loadPi();
  const writes = [];
  const ops = fileOperations(s.opts, writes);
  const cwd = s.home;
  const run = async (tool, args) => {
    const r = await tool.execute('t', tool.prepareArguments ? tool.prepareArguments(args) : args);
    return r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type} ${c.mimeType}]`)).join('\n');
  };
  return {
    writes,
    read: (a) => run(tools.createReadTool(ai.Type, cwd, ops.read, s.home), a),
    write: (a) => run(tools.createWriteTool(ai.Type, cwd, ops.write, s.home), a),
    edit: (a) => run(tools.createEditTool(ai.Type, cwd, ops.edit, s.home), a),
    ls: (a) => run(tools.createLsTool(ai.Type, cwd, ops.ls, s.home), a),
    find: (a) => run(tools.createFindTool(ai.Type, cwd, ops.find, s.home), a),
    grep: (a) => run(tools.createGrepTool(ai.Type, cwd, ops.grep, s.home), a),
  };
}

test('read: pages a text file the way pi does, relative to home', async (t) => {
  const s = scratch(t);
  const k = await turnTools(s);
  const out = await k.read({ path: 'docs/说明.txt', offset: 5, limit: 3 });
  assert.strictEqual(out, '第5行\n第6行\n第7行\n\n[23 more lines in file. Use offset=8 to continue.]');
  await assert.rejects(k.read({ path: 'docs/说明.txt', offset: 99 }), /beyond end of file/);
});

test('read: refuses blocked, data-folder and UNC paths with the reason', async (t) => {
  const s = scratch(t);
  const k = await turnTools(s);
  await assert.rejects(k.read({ path: '~/.ssh/config' }), /禁止访问/);
  await assert.rejects(k.read({ path: path.join(s.data, 'settings.json') }), /禁止访问/);
  await assert.rejects(k.read({ path: path.join(s.docs, '订单', 'server.pem') }), /禁止访问/);
  await assert.rejects(k.read({ path: '\\\\attacker\\share\\x.txt' }), /网络共享/);
  await assert.rejects(k.read({ path: path.join(s.docs, 'nope.txt') }), /不存在/);
});

test('read: an image comes back as an image block', async (t) => {
  const s = scratch(t);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  fs.writeFileSync(path.join(s.docs, 'a.png'), png);
  const k = await turnTools(s);
  assert.strictEqual(await k.read({ path: path.join(s.docs, 'a.png') }), 'Read image file [image/png]\n[image image/png]');
});

test('write and edit record without touching the disk, and a read sees the record', async (t) => {
  const s = scratch(t);
  const k = await turnTools(s);
  const target = path.join(s.docs, '报告', '汇总.md');
  const out = await k.write({ path: target, content: '# 汇总\n共 3 单\n' });
  assert.match(out, /^Successfully wrote to .*汇总\.md\n（尚未写入磁盘/);
  assert.strictEqual(fs.existsSync(target), false, 'nothing on disk during the turn');
  assert.strictEqual(await k.read({ path: target }), '# 汇总\n共 3 单\n');

  assert.match(await k.edit({ path: target, edits: [{ oldText: '共 3 单', newText: '共 4 单' }] }), /^Successfully replaced 1 block\(s\)/);
  assert.strictEqual(k.writes.length, 1, 'the edit replaced the recorded write, not added a second');
  assert.strictEqual(k.writes[0].content, '# 汇总\n共 4 单\n');

  // An edit to a file on disk records the new content and leaves the file alone.
  const csv = path.join(s.docs, '订单', '5月.csv');
  await k.edit({ path: csv, edits: { oldText: 'A2,派送中', newText: 'A2,已签收' } });
  assert.match(fs.readFileSync(csv, 'utf8'), /A2,派送中/);
  assert.match(k.writes[1].content, /A2,已签收/);
});

test('write and edit keep the write rules: text only, nothing blocked, unique match', async (t) => {
  const s = scratch(t);
  const k = await turnTools(s);
  await assert.rejects(k.write({ path: path.join(s.docs, 'run.bat'), content: 'x' }), /只能写文本类文件/);
  await assert.rejects(k.write({ path: path.join(s.data, 'notes.txt'), content: 'x' }), /禁止访问/);
  await assert.rejects(k.edit({ path: '~/.ssh/config', edits: [{ oldText: 'Host', newText: 'H' }] }), /Could not edit file.*禁止访问/);
  await assert.rejects(k.edit({ path: path.join(s.docs, '订单', '5月.csv'), edits: [{ oldText: 'A', newText: 'x' }] }), /Found 2 occurrences/);
  assert.strictEqual(k.writes.length, 0);
});

test('ls, find and grep leave blocked entries out', async (t) => {
  const s = scratch(t);
  const k = await turnTools(s);
  assert.strictEqual(await k.ls({ path: path.join(s.docs, '订单') }), '5月.csv\n深/');
  assert.strictEqual(await k.find({ pattern: '*.csv', path: s.docs }), '订单/5月.csv\n订单/深/6月.csv');
  assert.match(await k.find({ pattern: '*', path: s.home }), /^docs\//);
  assert.doesNotMatch(await k.find({ pattern: '*', path: s.home }), /\.ssh|server\.pem/);
  await assert.rejects(k.ls({ path: '~/.ssh' }), /禁止访问/);
});

test('grep: path:line output, glob filter, context, and the blocklist', async (t) => {
  const s = scratch(t);
  const k = await turnTools(s);
  assert.strictEqual(await k.grep({ pattern: '已签收', path: s.docs }), '订单/5月.csv:2: A1,已签收\n订单/深/6月.csv:2: B1,已签收');
  assert.strictEqual(await k.grep({ pattern: 'b1', ignoreCase: true, glob: '6月.csv', path: s.docs }), '订单/深/6月.csv:2: B1,已签收');
  assert.strictEqual(await k.grep({ pattern: '第2行', path: path.join(s.docs, '说明.txt'), context: 1 }), '说明.txt-1- 第1行\n说明.txt:2: 第2行\n说明.txt-3- 第3行');
  assert.strictEqual(await k.grep({ pattern: 'KEY', path: s.docs }), 'No matches found', 'server.pem is never opened');
  assert.strictEqual(await k.grep({ pattern: '.', literal: true, path: s.docs }), 'No matches found');
});

test('the shell tool runs a command and reports a failing exit code', async () => {
  const { ai } = await loadPi();
  const tool = process.platform === 'win32' ? shell.createPowerShellTool(ai.Type, os.tmpdir()) : shell.createBashTool(ai.Type, os.tmpdir());
  const ok = await tool.execute('t', { command: 'echo 你好' });
  assert.strictEqual(ok.isError, undefined);
  assert.strictEqual(ok.content[0].text.trim(), '你好');
  const bad = await tool.execute('t', { command: 'exit 3' });
  assert.strictEqual(bad.isError, true);
  assert.match(bad.content[0].text, /Command exited with code 3/);
});
