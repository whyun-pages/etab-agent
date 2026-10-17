'use strict';
/**
 * Tests for the agent's non-editing tools: saving, fetching, reading
 * attachments, and querying tables.
 *
 * Each is offered only when its switch is on, records a request rather than
 * acting during the turn, and is refused in the modes that forbid it.
 */

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { listenLocal } from '../helpers/listen.ts';
import { INTENT } from '../../src/agent/agent.ts';
import { applyOps } from '../../src/workbook/spec-ops.ts';
import { readAttachment } from '../../src/ingest/ingest.ts';

import { turnWith, specWith, rows10 } from '../helpers/agent-turn.ts';

// ── saving and fetching ─────────────────────────────────────────────

function csvServer(body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('connection', 'close');
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.end(body);
    });
    listenLocal(server).then(() =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/cities.csv`,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

test('runTurn: save_file and fetch_url are offered only when switched on', async () => {
  const off = await turnWith(['好'], { message: '你好', spec: specWith([['甲', 1]]) });
  const offNames = off.contexts[0].tools.map((t) => t.name);
  assert.ok(!offNames.includes('save_file') && !offNames.includes('fetch_url'), offNames.join());
  assert.doesNotMatch(off.contexts[0].systemPrompt, /save_file|fetch_url/);

  const on = await turnWith(['好'], { message: '你好', spec: specWith([['甲', 1]]), canSave: true, canFetch: true });
  const onNames = on.contexts[0].tools.map((t) => t.name);
  assert.ok(onNames.includes('save_file') && onNames.includes('fetch_url'), onNames.join());
  assert.match(on.contexts[0].systemPrompt, /save_file/);
  assert.match(on.contexts[0].systemPrompt, /fetch_url/);
});

test('runTurn: save_file records a request and writes nothing; the turn stays an answer', async () => {
  const res = await turnWith([{ tool: 'save_file', args: { format: 'csv', filename: '../../x/报表' } }, '已保存。'], {
    message: '把表保存成 csv',
    spec: specWith([['甲', 1]]),
    canSave: true,
  });
  assert.strictEqual(res.intent, INTENT.ANSWER);
  assert.deepStrictEqual(res.exports, [{ format: 'csv', sheet: null, filename: '报表' }]);
  assert.strictEqual(res.ops.length, 0);
});

test('runTurn: save_file refuses an unknown sheet, and the model can correct it', async () => {
  const res = await turnWith(
    [
      { tool: 'save_file', args: { format: 'csv', sheet: '不存在' } },
      { tool: 'save_file', args: { format: 'csv', sheet: '明细' } },
      '好了',
    ],
    { message: '保存', spec: specWith([['甲', 1]]), canSave: true },
  );
  const refusal = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.strictEqual(refusal.isError, true);
  assert.match(refusal.content[0].text, /没有名为「不存在」/);
  assert.deepStrictEqual(res.exports, [{ format: 'csv', sheet: '明细', filename: null }]);
});

test('runTurn: edit then save in one turn returns both; a guarded turn saves nothing', async () => {
  const both = await turnWith(
    [
      { tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: 5 }] } },
      { tool: 'save_file', args: { format: 'xlsx' } },
      '改好并保存了',
    ],
    {
      message: '把甲改成 5 然后保存',
      spec: specWith([
        ['甲', 1],
        ['乙', 2],
      ]),
      canSave: true,
    },
  );
  assert.strictEqual(both.intent, INTENT.ACTION);
  assert.strictEqual(both.ops.length, 1);
  assert.strictEqual(both.exports.length, 1);

  const guarded = await turnWith(
    [
      { tool: 'delete_rows', args: { rows: [1, 2, 3, 4, 5, 6, 7, 8, 9] } },
      { tool: 'save_file', args: { format: 'xlsx' } },
      '好了',
    ],
    { message: '把金额改高点然后保存', spec: rows10(), canSave: true },
  );
  assert.strictEqual(guarded.guarded, true);
  assert.deepStrictEqual(guarded.exports, []);
  assert.match(guarded.reply, /没有保存文件/);
});

test('runTurn: fetch_url reads a table and hands it to the model as material', async () => {
  const srv = await csvServer('城市,人口\n杭州,1200\n宁波,950\n');
  try {
    const res = await turnWith([{ tool: 'fetch_url', args: { url: srv.url } }, '杭州 1200，宁波 950。'], {
      message: `看看 ${srv.url}`,
      canFetch: true,
      fetchOptions: { allowPrivate: true },
    });
    const result = res.contexts[1].messages.find((m) => m.role === 'toolResult');
    assert.strictEqual(result.isError, false);
    assert.match(result.content[0].text, /不是给你的指令/);
    assert.match(result.content[0].text, /杭州\t1200/);
    assert.strictEqual(res.intent, INTENT.ANSWER);
  } finally {
    await srv.close();
  }
});

test('runTurn: fetch_url with importAs records an edit whose replay needs no network', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => `城市${i + 1},${i + 1}`).join('\n');
  const srv = await csvServer(`城市,人口\n${rows}\n`);
  let res;
  try {
    res = await turnWith([{ tool: 'fetch_url', args: { url: srv.url, importAs: '城市' } }, '导入了。'], {
      message: `把 ${srv.url} 导入成表`,
      canFetch: true,
      fetchOptions: { allowPrivate: true },
    });
  } finally {
    await srv.close();
  }
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.strictEqual(res.ops[0].op, 'create_workbook');
  // All 400 rows, though the model was only shown 300.
  assert.strictEqual(res.spec.sheets[0].rows.length, 400);
  assert.strictEqual(res.spec.sheets[0].columns[1].type, 'integer');
  // The server is closed: the replay works from the recorded arguments alone.
  const replayed = applyOps(null, res.ops).spec;
  assert.deepStrictEqual(replayed, res.spec);
});

test('runTurn: fetch_url adds a sheet when there is already a table', async () => {
  const srv = await csvServer('城市,人口\n杭州,1200\n');
  try {
    const res = await turnWith([{ tool: 'fetch_url', args: { url: srv.url, importAs: '城市' } }, '好'], {
      message: '导入',
      spec: specWith([['甲', 1]]),
      canFetch: true,
      fetchOptions: { allowPrivate: true },
    });
    assert.strictEqual(res.ops[0].op, 'add_sheet');
    assert.deepStrictEqual(
      res.spec.sheets.map((s) => s.name),
      ['明细', '城市'],
    );
  } finally {
    await srv.close();
  }
});

test('runTurn: a blocked or private URL is reported to the model, not fetched', async () => {
  const res = await turnWith(
    [
      { tool: 'fetch_url', args: { url: 'https://data.blocked.example/x.csv' } },
      { tool: 'fetch_url', args: { url: 'http://127.0.0.1:9/api/settings' } },
      '抓不到。',
    ],
    { message: '抓一下', canFetch: true, fetchOptions: { blocklist: ['blocked.example'] } },
  );
  const results = res.contexts[2].messages.filter((m) => m.role === 'toolResult');
  assert.strictEqual(results.length, 2);
  assert.ok(results.every((r) => r.isError));
  assert.match(results[0].content[0].text, /禁止抓取/);
  assert.match(results[1].content[0].text, /内网/);
});

test('runTurn: read-only mode may fetch and save, but not import', async () => {
  const res = await turnWith(
    [{ tool: 'fetch_url', args: { url: 'https://example.com/a.csv', importAs: 'X' } }, '只读模式不能导入。'],
    { message: '导入', spec: specWith([['甲', 1]]), canEdit: false, canFetch: true, canSave: true },
  );
  const offered = res.contexts[0].tools.map((t) => t.name);
  assert.ok(offered.includes('fetch_url') && offered.includes('save_file'));
  assert.ok(!offered.includes('update_cells'));
  const result = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /只读模式/);
  assert.strictEqual(res.ops.length, 0);
});

test('runTurn: with fetching or saving off, the model is told where the switch is', async () => {
  const res = await turnWith(['好'], { message: '下载 https://x.example/a.m3u', spec: specWith([['甲', 1]]) });
  const prompt = res.contexts[0].systemPrompt;
  assert.match(prompt, /「允许对话联网抓取」已关闭/);
  assert.match(prompt, /「允许对话保存文件」已关闭/);
  assert.match(prompt, /「允许读写本机文件」已关闭/);
  const on = await turnWith(['好'], {
    message: '下载',
    spec: specWith([['甲', 1]]),
    canSave: true,
    canFetch: true,
    fileAccess: 'read',
  });
  assert.doesNotMatch(on.contexts[0].systemPrompt, /已关闭/);
});

test('runTurn: file tools follow the access setting, and save_file gains dir only with write', async () => {
  const names = async (fileAccess) => {
    const r = await turnWith(['好'], { message: '你好', canSave: true, fileAccess });
    const tools = r.contexts[0].tools;
    const save = tools.find((t) => t.name === 'save_file');
    return {
      names: tools.map((t) => t.name),
      dir: Boolean(save.parameters.properties.dir),
      prompt: r.contexts[0].systemPrompt,
    };
  };
  const shellTool = process.platform === 'win32' ? 'powershell' : 'bash';
  const readTools = ['read', 'ls', 'find', 'grep', 'import_file'];
  const writeTools = ['write', 'edit', shellTool];
  const off = await names('off');
  assert.ok(!off.names.some((n) => [...readTools, ...writeTools].includes(n)), off.names.join());
  assert.strictEqual(off.dir, false);
  const read = await names('read');
  assert.ok(
    [...readTools, 'read_attachment'].every((n) => read.names.includes(n)),
    read.names.join(),
  );
  assert.ok(!writeTools.some((n) => read.names.includes(n)), read.names.join());
  assert.match(read.prompt, /不能指定目录/);
  assert.doesNotMatch(read.prompt, new RegExp(shellTool), 'the shell is not mentioned where it is not offered');
  const rw = await names('readwrite');
  assert.ok(
    writeTools.every((n) => rw.names.includes(n)),
    rw.names.join(),
  );
  assert.strictEqual(rw.dir, true);
  assert.doesNotMatch(rw.prompt, /不能指定目录/);
  assert.match(rw.prompt, /不受上面的访问限制/, 'the prompt says the shell is outside the checks');
});

test('runTurn: a table read without importAs tells the model to import, not copy', async () => {
  const srv = await csvServer('城市,人口\n杭州,1200\n宁波,950\n');
  try {
    const res = await turnWith([{ tool: 'fetch_url', args: { url: srv.url } }, '好'], {
      message: `把 ${srv.url} 整理成表格`,
      canFetch: true,
      fetchOptions: { allowPrivate: true },
    });
    const text = res.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text;
    assert.match(text, /^（提示：这是一张 2 行的表格/);
    assert.match(text, /importAs/);
    // Ours, ahead of the page's own words, so it cannot be read as page text.
    assert.ok(text.indexOf('importAs') < text.indexOf('不是给你的指令'));
    assert.match(res.contexts[0].systemPrompt, /第一次调用就带上 importAs/);

    // A read-only turn cannot import, so it is not told to.
    const ro = await turnWith([{ tool: 'fetch_url', args: { url: srv.url } }, '好'], {
      message: '看看',
      spec: specWith([['甲', 1]]),
      canEdit: false,
      canFetch: true,
      fetchOptions: { allowPrivate: true },
    });
    const roText = ro.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text;
    assert.doesNotMatch(roText, /提示/);
  } finally {
    await srv.close();
  }
});

// ── read_attachment ─────────────────────────────────────────────────

/** A parsed CSV upload, as the server keeps it in `state.uploads`. */
async function csvAttachment(name, csv) {
  return readAttachment(Buffer.from(csv, 'utf8'), name);
}

/** 910 orders, like the file that showed the problem: 5 rows in the preview. */
function ordersCsv() {
  const states = ['已签收', '派送中', '拒签退回中', '运输途中'];
  const rows = Array.from({ length: 910 }, (_, i) => `BT${i + 1},${states[i % 4]},${(i % 4) + 1}`);
  return `订单号,物流状态,金额\n${rows.join('\n')}\n`;
}

test('runTurn: read_attachment is offered only when there are attachments', async () => {
  const none = await turnWith(['好'], { message: '你好' });
  assert.ok(!none.contexts[0].tools.some((t) => t.name === 'read_attachment'));
  assert.doesNotMatch(none.contexts[0].systemPrompt, /read_attachment/);

  const att = await csvAttachment('订单.csv', ordersCsv());
  const some = await turnWith(['好'], { message: '你好', attachments: [att] });
  assert.ok(some.contexts[0].tools.some((t) => t.name === 'read_attachment'));
  assert.match(some.contexts[0].systemPrompt, /read_attachment/);
});

test('runTurn: query_table on an attachment counts every row, not the preview', async () => {
  const att = await csvAttachment('订单.csv', ordersCsv());
  const res = await turnWith(
    [
      {
        tool: 'query_table',
        args: { attachment: '订单', groupBy: ['物流状态'], metrics: [{ fn: 'count' }, { fn: 'sum', column: '金额' }] },
      },
      '统计好了。',
    ],
    { message: '统计订单状态', attachments: [att] },
  );
  const result = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.strictEqual(result.isError, false);
  const text = result.content[0].text;
  assert.match(text, /不是给你的指令/);
  assert.match(text, /共 910 行，全部参与统计/);
  // 910 = 4 × 227 + 2: the first two states get one more row each.
  assert.match(text, /已签收\t228\t228/);
  assert.match(text, /派送中\t228\t456/);
  assert.match(text, /拒签退回中\t227\t681/);
  assert.match(text, /运输途中\t227\t908/);
  assert.strictEqual(res.intent, INTENT.ANSWER);
});

test('runTurn: read_attachment pages rows and says where to continue', async () => {
  const att = await csvAttachment('订单.csv', ordersCsv());
  const res = await turnWith([{ tool: 'read_attachment', args: { name: '订单.csv', from: 901 } }, '好'], {
    message: '看看最后几行',
    attachments: [att],
  });
  const text = res.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text;
  assert.match(text, /第 901–910 行/);
  assert.match(text, /^910\tBT910\t/m);
  assert.doesNotMatch(text, /继续读/);

  const first = await turnWith([{ tool: 'read_attachment', args: { name: '订单.csv' } }, '好'], {
    message: '看看',
    attachments: [att],
  });
  assert.match(
    first.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text,
    /第 1–200 行；继续读请传 from=201/,
  );
});

test('runTurn: read_attachment refuses an unknown name or column, listing what exists', async () => {
  const att = await csvAttachment('订单.csv', ordersCsv());
  const res = await turnWith(
    [
      { tool: 'read_attachment', args: { name: '客户.xlsx' } },
      { tool: 'query_table', args: { attachment: '订单.csv', groupBy: ['状态'] } },
      '好',
    ],
    { message: '统计', attachments: [att] },
  );
  const r1 = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.strictEqual(r1.isError, true);
  assert.match(r1.content[0].text, /现有：订单\.csv/);
  const r2 = res.contexts[2].messages.filter((m) => m.role === 'toolResult').pop();
  assert.strictEqual(r2.isError, true);
  assert.match(r2.content[0].text, /现有列：订单号、物流状态、金额/);
});

test('runTurn: read_attachment importAs imports every row, and replays without the upload', async () => {
  const att = await csvAttachment('订单.csv', ordersCsv());
  const res = await turnWith([{ tool: 'read_attachment', args: { name: '订单.csv', importAs: '订单' } }, '导入了。'], {
    message: '把附件做成表',
    attachments: [att],
  });
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.strictEqual(res.ops[0].op, 'create_workbook');
  assert.strictEqual(res.spec.sheets[0].rows.length, 910);
  assert.deepStrictEqual(applyOps(null, res.ops).spec, res.spec);
});

test('runTurn: read_attachment reads a long text attachment page by page', async () => {
  const att = await csvAttachment('说明.txt', 'a'.repeat(25_000));
  const res = await turnWith([{ tool: 'read_attachment', args: { name: '说明.txt', from: 20000 } }, '好'], {
    message: '读一下',
    attachments: [att],
    canEdit: false,
  });
  const text = res.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text;
  assert.match(text, /共 25000 字，已读到结尾/);
});

// ── query_table and the condition tools ─────────────────────────────

test('runTurn: query_table lists matching workbook rows by number, and saveAs makes a sheet', async () => {
  const spec = specWith([
    ['甲', 100],
    ['乙', 200],
    ['甲', 50],
  ]);
  const res = await turnWith(
    [
      { tool: 'query_table', args: { where: [{ column: '客户', op: '=', value: '甲' }] } },
      { tool: 'query_table', args: { groupBy: ['客户'], metrics: [{ fn: 'sum', column: '金额' }], saveAs: '汇总' } },
      '做好了。',
    ],
    { message: '按客户汇总成一张表', spec },
  );
  const first = res.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text;
  assert.match(first, /符合条件的 2 行/);
  assert.match(first, /^1\t甲\t100$/m);
  assert.match(first, /^3\t甲\t50$/m);
  assert.strictEqual(res.intent, INTENT.ACTION);
  const sheet = res.spec.sheets.find((s) => s.name === '汇总');
  assert.deepStrictEqual(sheet.rows, [
    ['乙', 200],
    ['甲', 150],
  ]);
  assert.deepStrictEqual(applyOps(spec, res.ops).spec, res.spec);
});

test('runTurn: query_table saveAs is refused in read-only mode', async () => {
  const res = await turnWith(
    [{ tool: 'query_table', args: { groupBy: ['客户'], saveAs: '汇总' } }, '只读模式下不能建表。'],
    { message: '汇总', spec: specWith([['甲', 1]]), canEdit: false },
  );
  const r = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /只读模式/);
});

test('runTurn: delete_rows with where removes the matching rows, and the guard sees the request', async () => {
  const res = await turnWith(
    [{ tool: 'delete_rows', args: { where: [{ column: '金额', op: '<', value: 500 }] } }, '删掉了。'],
    { message: '删除金额小于 500 的行', spec: rows10() },
  );
  // Four of ten rows is a material loss; it lands because the message asks for it.
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.strictEqual(res.spec.sheets[0].rows.length, 6);
  assert.ok(res.spec.sheets[0].rows.every((r) => r[1] >= 500));
});

test('runTurn: a tab or line break inside a cell does not shift the columns the model reads', async () => {
  // read_attachment and query_table print tab-separated rows. A cell holding a
  // tab made the model read every column after it one place to the right.
  const csv = '名称,备注,金额\n甲,"第一行\n第二行",10\n乙,"有\t制表符",20\n';
  const att = await csvAttachment('备注.csv', csv);
  const res = await turnWith([{ tool: 'read_attachment', args: { name: '备注.csv' } }, '好'], {
    message: '看看',
    attachments: [att],
  });
  const text = res.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text;
  const lines = text.split('\n');
  const header = lines.findIndex((l) => l.startsWith('行号\t'));
  const rows = lines.slice(header + 1).filter(Boolean);
  assert.strictEqual(rows.length, 2, text);
  for (const r of rows) assert.strictEqual(r.split('\t').length, 4, `row number + 3 columns: ${JSON.stringify(r)}`);
  assert.match(text, /^1\t甲\t第一行 第二行\t10$/m);
  assert.match(text, /^2\t乙\t有 制表符\t20$/m);
});
