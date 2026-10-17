'use strict';
/**
 * Tests for the spec operations behind the agent's edit tools.
 *
 * What this file guards:
 *   - every operation addresses rows by number and columns by header, and a
 *     wrong address is refused — never applied to a neighbour
 *   - an operation leaves everything it was not asked to touch unchanged
 *   - values go through the same coercion `create_workbook` uses
 *   - operations are pure: same spec and operations, same result — the server
 *     replays them and depends on it
 */

import test from 'node:test';
import assert from 'node:assert';

import { applyOp, applyOps, readRows, SpecOpError, OPS } from '../../src/workbook/spec-ops.ts';
import { normalizeSpec, MAX_ROWS } from '../../src/workbook/workbook.ts';

const base = () =>
  normalizeSpec({
    title: '销售',
    sheets: [
      {
        name: '明细',
        columns: [
          { header: '客户', type: 'text' },
          { header: '金额', type: 'currency' },
          { header: '日期', type: 'date' },
        ],
        rows: [
          ['甲', 100, '2026-01-02'],
          ['乙', 300, '2026-01-01'],
          ['丙', 200, null],
        ],
        totals: { sumColumns: ['金额'] },
      },
    ],
  }).spec;

const op = (name, args) => ({ op: name, args });
const run = (spec, name, args) => applyOp(spec, op(name, args)).spec;
const rows = (spec, i = 0) => spec.sheets[i].rows;
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

// ── round trip ───────────────────────────────────────────────────────

test('an operation that changes nothing reproduces the spec exactly', () => {
  // The raw round-trip every operation goes through must be the identity,
  // dates and totals included, or every edit would quietly alter the rest.
  const spec = base();
  const same = run(spec, 'update_cells', { cells: [{ row: 1, column: '客户', value: '甲' }] });
  assert.deepStrictEqual(same, spec);
});

test('the input spec is never mutated', () => {
  const spec = base();
  const before = JSON.stringify(spec);
  run(spec, 'update_cells', { cells: [{ row: 1, column: '金额', value: 1 }] });
  run(spec, 'delete_rows', { rows: [1] });
  run(spec, 'add_columns', { columns: [{ header: '备注', type: 'text' }] });
  assert.strictEqual(JSON.stringify(spec), before);
});

// ── cells and rows ───────────────────────────────────────────────────

test('update_cells: by row number and header, coerced like any other value', () => {
  const next = run(base(), 'update_cells', {
    cells: [
      { row: 2, column: '金额', value: '40万' },
      { row: 3, column: '日期', value: '2026-03-01' },
    ],
  });
  assert.strictEqual(rows(next)[1][1], 400000);
  assert.strictEqual(iso(rows(next)[2][2]), '2026-03-01');
  assert.strictEqual(rows(next)[0][1], 100, 'other rows untouched');
});

test('update_cells: an uncoercible value is blanked and reported, not guessed', () => {
  const r = applyOp(base(), op('update_cells', { cells: [{ row: 1, column: '金额', value: '四十几万吧' }] }));
  assert.strictEqual(rows(r.spec)[0][1], null);
  assert.ok(
    r.notes.some((n) => /不是金额/.test(n.message)),
    JSON.stringify(r.notes),
  );
});

test('a row number out of range is refused, with the range in the message', () => {
  assert.throws(
    () => run(base(), 'update_cells', { cells: [{ row: 4, column: '金额', value: 1 }] }),
    /行号 4 超出范围.*共 3 行/,
  );
  assert.throws(() => run(base(), 'update_cells', { cells: [{ row: 0, column: '金额', value: 1 }] }), SpecOpError);
});

test('an unknown header is refused, listing the real ones', () => {
  assert.throws(
    () => run(base(), 'update_cells', { cells: [{ row: 1, column: '价格', value: 1 }] }),
    /没有列「价格」.*「金额」/,
  );
});

test('add_rows: appends by default, inserts before a row number when asked', () => {
  const appended = run(base(), 'add_rows', { rows: [['丁', 400, '2026-02-01']] });
  assert.deepStrictEqual(
    rows(appended).map((r) => r[0]),
    ['甲', '乙', '丙', '丁'],
  );
  const inserted = run(base(), 'add_rows', { rows: [['丁', 400, null]], before: 2 });
  assert.deepStrictEqual(
    rows(inserted).map((r) => r[0]),
    ['甲', '丁', '乙', '丙'],
  );
});

test('add_rows: an object row is mapped by header, and an unknown key is refused', () => {
  const next = run(base(), 'add_rows', { rows: [{ 金额: 9, 客户: '丁' }] });
  assert.deepStrictEqual(rows(next)[3], ['丁', 9, null]);
  assert.throws(() => run(base(), 'add_rows', { rows: [{ 价钱: 9 }] }), /没有列「价钱」/);
});

test('delete_rows: numbers refer to the table before deletion', () => {
  const next = run(base(), 'delete_rows', { rows: [1, 3] });
  assert.deepStrictEqual(
    rows(next).map((r) => r[0]),
    ['乙'],
  );
});

test('delete_rows: one bad number deletes nothing', () => {
  assert.throws(() => run(base(), 'delete_rows', { rows: [1, 7] }), /行号 7/);
});

test('sort_rows: numeric, dates, text; blanks last in both directions; stable', () => {
  const byAmount = run(base(), 'sort_rows', { by: '金额', order: 'desc' });
  assert.deepStrictEqual(
    rows(byAmount).map((r) => r[0]),
    ['乙', '丙', '甲'],
  );
  const byDate = run(base(), 'sort_rows', { by: '日期' });
  assert.deepStrictEqual(
    rows(byDate).map((r) => r[0]),
    ['乙', '甲', '丙'],
    'blank date last',
  );
  const byDateDesc = run(base(), 'sort_rows', { by: '日期', order: 'desc' });
  assert.deepStrictEqual(
    rows(byDateDesc).map((r) => r[0]),
    ['甲', '乙', '丙'],
    'blank date still last',
  );
});

// ── columns ──────────────────────────────────────────────────────────

test('add_columns: appended or placed before a header, with optional values', () => {
  const next = run(base(), 'add_columns', {
    columns: [{ header: '税率', type: 'percent', before: '日期', values: [0.06, '13%'] }],
  });
  assert.deepStrictEqual(
    next.sheets[0].columns.map((c) => c.header),
    ['客户', '金额', '税率', '日期'],
  );
  assert.deepStrictEqual(
    rows(next).map((r) => r[2]),
    [0.06, 0.13, null],
  );
  assert.strictEqual(iso(rows(next)[0][3]), '2026-01-02', 'the moved column kept its values');
});

test('add_columns: a duplicate header is refused', () => {
  assert.throws(() => run(base(), 'add_columns', { columns: [{ header: '金额', type: 'number' }] }), /已经存在/);
});

test('remove_columns: removes the column and its cells', () => {
  const next = run(base(), 'remove_columns', { headers: ['日期'] });
  assert.deepStrictEqual(
    next.sheets[0].columns.map((c) => c.header),
    ['客户', '金额'],
  );
  assert.deepStrictEqual(rows(next)[0], ['甲', 100]);
});

test('remove_columns: removing the only summed column removes the totals', () => {
  // Otherwise normalizeSpec would read an empty list as "total every numeric
  // column" — a totals row nobody picked.
  const r = applyOp(base(), op('remove_columns', { headers: ['金额'] }));
  assert.strictEqual(r.spec.sheets[0].totals.enabled, false);
  assert.match(r.summary, /合计行一并去掉/);
});

test('update_columns: rename keeps the totals pointing at the same column', () => {
  const next = run(base(), 'update_columns', { changes: [{ header: '金额', newHeader: '合同金额' }] });
  const s = next.sheets[0];
  assert.strictEqual(s.columns[1].header, '合同金额');
  assert.deepStrictEqual(s.totals.sumColumns, [1]);
});

test('update_columns: a type change re-coerces the column', () => {
  const textual = normalizeSpec({
    title: 'T',
    sheets: [{ name: 'S', columns: [{ header: '金额', type: 'text' }], rows: [['125万'], ['3']] }],
  }).spec;
  const next = run(textual, 'update_columns', { changes: [{ header: '金额', type: 'currency' }] });
  assert.deepStrictEqual(rows(next), [[1250000], [3]]);
});

test('update_columns: order must be a full permutation', () => {
  const next = run(base(), 'update_columns', { order: ['日期', '客户', '金额'] });
  assert.deepStrictEqual(
    next.sheets[0].columns.map((c) => c.header),
    ['日期', '客户', '金额'],
  );
  assert.strictEqual(rows(next)[1][1], '乙');
  assert.throws(() => run(base(), 'update_columns', { order: ['日期', '客户'] }), /全部 3 列/);
});

test('an unknown column type is refused rather than read as text', () => {
  assert.throws(() => run(base(), 'add_columns', { columns: [{ header: 'X', type: 'money' }] }), /未知的列类型/);
});

// ── totals, sheets, names ────────────────────────────────────────────

test('set_totals: named columns, or off', () => {
  const plain = run(base(), 'set_totals', { enabled: false });
  assert.strictEqual(plain.sheets[0].totals.enabled, false);
  const back = applyOp(plain, op('set_totals', { enabled: true, sumColumns: ['金额'] }));
  assert.deepStrictEqual(back.spec.sheets[0].totals.sumColumns, [1]);
  assert.match(back.summary, /合计列：金额/);
});

test('sheets: add, rename, remove; the sheet name may be omitted only with one sheet', () => {
  let spec = run(base(), 'add_sheet', { name: '二月', columns: [{ header: '客户', type: 'text' }], rows: [['戊']] });
  assert.strictEqual(spec.sheets.length, 2);
  assert.throws(() => run(spec, 'update_cells', { cells: [{ row: 1, column: '客户', value: 'x' }] }), /请指明 sheet/);
  spec = run(spec, 'update_cells', { sheet: '二月', cells: [{ row: 1, column: '客户', value: '己' }] });
  assert.strictEqual(rows(spec, 1)[0][0], '己');
  spec = run(spec, 'rename', { sheet: '二月', newName: '2月', title: '全年' });
  assert.strictEqual(spec.title, '全年');
  assert.strictEqual(spec.sheets[1].name, '2月');
  spec = run(spec, 'remove_sheet', { sheet: '明细' });
  assert.deepStrictEqual(
    spec.sheets.map((s) => s.name),
    ['2月'],
  );
  assert.throws(() => run(spec, 'remove_sheet', { sheet: '2月' }), /唯一的工作表/);
});

test('with no workbook yet, only create_workbook and add_sheet apply', () => {
  assert.throws(() => run(null, 'add_rows', { rows: [['a']] }), /还没有表格/);
  const created = run(null, 'add_sheet', { name: 'S', columns: [{ header: 'A', type: 'text' }] });
  assert.strictEqual(created.sheets[0].name, 'S');
  const fresh = run(null, 'create_workbook', {
    title: 'T',
    sheets: [{ name: 'S', columns: [{ header: 'A', type: 'text' }], rows: [['x']] }],
  });
  assert.deepStrictEqual(rows(fresh), [['x']]);
});

// ── replay ───────────────────────────────────────────────────────────

test('applyOps is deterministic: the same list twice gives the same spec', () => {
  const ops = [
    op('add_columns', { columns: [{ header: '备注', type: 'text' }] }),
    op('update_cells', { cells: [{ row: 1, column: '备注', value: '大客户' }] }),
    op('sort_rows', { by: '金额', order: 'desc' }),
    op('delete_rows', { rows: [3] }),
  ];
  const a = applyOps(base(), ops).spec;
  const b = applyOps(base(), ops).spec;
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(
    rows(a).map((r) => r[0]),
    ['乙', '丙'],
  );
});

test('applyOps stops at the first failing operation', () => {
  assert.throws(
    () =>
      applyOps(base(), [
        op('delete_rows', { rows: [1, 2, 3] }),
        op('update_cells', { cells: [{ row: 1, column: '金额', value: 1 }] }),
      ]),
    /行号 1/,
  );
  assert.throws(() => applyOps(base(), [op('drop_table', {})]), /未知的操作/);
});

test('every operation the agent offers is implemented', () => {
  for (const name of [
    'create_workbook',
    'add_columns',
    'remove_columns',
    'update_columns',
    'add_rows',
    'update_cells',
    'delete_rows',
    'update_rows',
    'compute_column',
    'lookup_columns',
    'sort_rows',
    'set_totals',
    'add_sheet',
    'remove_sheet',
    'rename',
  ]) {
    assert.strictEqual(typeof OPS[name], 'function', name);
  }
});

test('readRows: numbered, clamped to the table, dates as YYYY-MM-DD', () => {
  const text = readRows(base(), { from: 2, to: 99 });
  assert.match(text, /第 2–3 行（共 3 行）/);
  assert.match(text, /2\. \["乙",300,"2026-01-01"\]/);
  assert.match(text, /3\. \["丙",200,null\]/);
});

// ── column widths ────────────────────────────────────────────────────

test('set_column_widths: sets a width by header, clamped like a declared one, and keeps it through later edits', () => {
  let spec = run(base(), 'set_column_widths', {
    widths: [
      { header: '客户', width: 23.4 },
      { header: '金额', width: 500 },
    ],
  });
  assert.strictEqual(spec.sheets[0].columns[0].width, 23.4);
  assert.strictEqual(spec.sheets[0].columns[1].width, 80, 'clamped to 80');
  assert.strictEqual(spec.sheets[0].columns[2].width, null, 'untouched');
  // A later edit goes through toRaw/normalise again; the width must survive it.
  spec = run(spec, 'update_cells', { cells: [{ row: 1, column: '金额', value: 1 }] });
  spec = run(spec, 'add_columns', { columns: [{ header: '备注', type: 'text' }] });
  assert.strictEqual(spec.sheets[0].columns[0].width, 23.4);
});

test('set_column_widths: an unknown header or a width that is not a positive number is refused', () => {
  assert.throws(() => run(base(), 'set_column_widths', { widths: [{ header: '没有', width: 10 }] }), SpecOpError);
  for (const width of [0, -3, 'abc', null, undefined]) {
    assert.throws(
      () => run(base(), 'set_column_widths', { widths: [{ header: '客户', width }] }),
      SpecOpError,
      String(width),
    );
  }
  assert.throws(() => run(base(), 'set_column_widths', { widths: [] }), SpecOpError);
});

// ── by condition ─────────────────────────────────────────────────────

const orders = () =>
  normalizeSpec({
    title: '订单',
    sheets: [
      {
        name: '订单',
        columns: [
          { header: '订单号', type: 'text' },
          { header: '状态', type: 'text' },
          { header: '单价', type: 'number' },
          { header: '数量', type: 'integer' },
          { header: '客户编号', type: 'text' },
        ],
        rows: [
          ['A1', '已签收', 10, 2, 'C1'],
          ['A2', '派送中', 5, 3, 'C2'],
          ['A3', '已签收', 'abc', 1, 'C9'],
          ['A4', '拒签', 8, 0, 'C1'],
        ],
      },
      {
        name: '客户',
        columns: [
          { header: '编号', type: 'text' },
          { header: '客户名', type: 'text' },
          { header: '城市', type: 'text' },
        ],
        rows: [
          ['C1', '张三', '杭州'],
          ['C2', '李四', '宁波'],
          ['C1', '重复', '不该用'],
        ],
      },
    ],
  }).spec;

test('delete_rows: where deletes every matching row; rows and where are exclusive', () => {
  const r = applyOp(
    orders(),
    op('delete_rows', { sheet: '订单', where: [{ column: '状态', op: '=', value: '已签收' }] }),
  );
  assert.deepStrictEqual(
    rows(r.spec).map((x) => x[0]),
    ['A2', 'A4'],
  );
  assert.match(r.summary, /符合「状态 = 已签收」的 2 行/);
  assert.throws(
    () => run(orders(), 'delete_rows', { sheet: '订单', rows: [1], where: [{ column: '状态', op: '=', value: 'x' }] }),
    /只能给一个/,
  );
  assert.throws(
    () => run(orders(), 'delete_rows', { sheet: '订单', where: [{ column: '没有', op: '=', value: 'x' }] }),
    SpecOpError,
  );
});

test('delete_rows: a where replayed on a newer table hits the rows that match THERE', () => {
  const recorded = op('delete_rows', { sheet: '订单', where: [{ column: '状态', op: 'in', value: ['拒签'] }] });
  const newer = run(orders(), 'add_rows', { sheet: '订单', rows: [['A5', '拒签', 1, 1, 'C2']], before: 1 });
  assert.deepStrictEqual(
    rows(applyOp(newer, recorded).spec).map((x) => x[0]),
    ['A1', 'A2', 'A3'],
  );
});

test('update_rows: sets fixed values on matching rows only', () => {
  const s = run(orders(), 'update_rows', {
    sheet: '订单',
    where: [{ column: '状态', op: '=', value: '派送中' }],
    set: { 状态: '已签收' },
  });
  assert.deepStrictEqual(
    rows(s).map((x) => x[1]),
    ['已签收', '已签收', '已签收', '拒签'],
  );
  assert.throws(() => run(orders(), 'update_rows', { sheet: '订单', set: { 不存在: 1 } }), /没有列「不存在」/);
});

test('compute_column: adds a column from an expression; bad rows are blank and counted', () => {
  // Normalisation already blanked the 'abc' in the number column, and a blank
  // multiplies as 0, as in Excel.
  const r = applyOp(orders(), op('compute_column', { sheet: '订单', column: '金额', expression: '[单价]*[数量]' }));
  assert.deepStrictEqual(
    rows(r.spec).map((x) => x[5]),
    [20, 15, 0, 0],
  );
  assert.strictEqual(r.spec.sheets[0].columns[5].type, 'integer');
  const per = applyOp(orders(), op('compute_column', { sheet: '订单', column: '每件', expression: '100/[数量]' }));
  assert.deepStrictEqual(
    rows(per.spec).map((x) => x[5]),
    [50, 33.333333, 100, null],
  );
  assert.match(per.summary, /1 行无法计算.*第 4 行（除数为 0）/);
});

test('compute_column: overwrites only the selected rows of an existing column', () => {
  const s = run(orders(), 'compute_column', {
    sheet: '订单',
    column: '状态',
    expression: 'IF([数量]>=2,"大单","小单")',
    where: [{ column: '状态', op: '!=', value: '拒签' }],
  });
  assert.deepStrictEqual(
    rows(s).map((x) => x[1]),
    ['大单', '大单', '小单', '拒签'],
  );
});

test('compute_column: refuses an unknown column or function before touching anything', () => {
  assert.throws(
    () => run(orders(), 'compute_column', { sheet: '订单', column: 'x', expression: '[价格]*2' }),
    /没有名为「价格」的列/,
  );
  assert.throws(
    () => run(orders(), 'compute_column', { sheet: '订单', column: 'x', expression: 'EVAL("1")' }),
    /不认识的函数/,
  );
  assert.throws(
    () => run(orders(), 'compute_column', { sheet: '订单', column: 'x', expression: '单价*2' }),
    /列名要写在 \[ \] 里/,
  );
});

test('lookup_columns: first match wins, misses are blank and counted', () => {
  const r = applyOp(
    orders(),
    op('lookup_columns', {
      sheet: '订单',
      key: '客户编号',
      fromSheet: '客户',
      fromKey: '编号',
      columns: ['客户名', '城市'],
      names: ['客户'],
    }),
  );
  const s = r.spec.sheets[0];
  assert.deepStrictEqual(
    s.columns.slice(5).map((c) => c.header),
    ['客户', '城市'],
  );
  assert.deepStrictEqual(
    s.rows.map((x) => x.slice(5)),
    [
      ['张三', '杭州'],
      ['李四', '宁波'],
      [null, null],
      ['张三', '杭州'],
    ],
  );
  assert.match(r.summary, /1 行在「客户」里找不到/);
});

test('condition ops are replay-stable: same spec and ops, same bytes', () => {
  const ops = [
    op('compute_column', { sheet: '订单', column: '金额', expression: 'ROUND([单价]*[数量]*1.1, 2)' }),
    op('update_rows', { sheet: '订单', where: [{ column: '金额', op: '>', value: 15 }], set: { 状态: '大单' } }),
    op('delete_rows', { sheet: '订单', where: [{ column: '数量', op: '=', value: 0 }] }),
  ];
  assert.strictEqual(JSON.stringify(applyOps(orders(), ops).spec), JSON.stringify(applyOps(orders(), ops).spec));
});

// ── relative dates ──────────────────────────────────────────────────

test('an op carries its own today, so a replay lands the same day', () => {
  const create = (today) => ({
    op: 'create_workbook',
    args: {
      title: 't',
      sheets: [{ name: 'S', columns: [{ header: '签约日', type: 'date' }], rows: [['今天'], ['明天']] }],
    },
    ...(today ? { today } : {}),
  });
  const day = (spec, r) => spec.sheets[0].rows[r][0]?.toISOString().slice(0, 10) ?? null;

  const stamped = applyOp(null, create('2026-02-28')).spec;
  assert.deepStrictEqual([day(stamped, 0), day(stamped, 1)], ['2026-02-28', '2026-03-01']);
  // The same op replayed later — say, a held change applied tomorrow — reads
  // its recorded day, not the clock.
  const replay = applyOps(null, [create('2026-02-28')]).spec;
  assert.deepStrictEqual(replay, stamped);

  // No day recorded: not a date, and said so.
  const r = applyOp(null, create(null));
  assert.strictEqual(day(r.spec, 0), null);
  assert.ok(
    r.notes.some((n) => /不是日期/.test(n.message)),
    JSON.stringify(r.notes),
  );
});

test('add_rows past the row cap is refused, and the existing rows are kept', () => {
  // Inserting at the top of a full sheet used to succeed: normalizeSpec kept
  // the first MAX_ROWS rows, so the user's own last rows fell off the end,
  // and the count — still exactly at the cap — gave the guard nothing to see.
  const full = normalizeSpec({
    title: 't',
    sheets: [{ name: 'S', columns: ['n'], rows: Array.from({ length: MAX_ROWS }, (_, i) => [i]) }],
  }).spec;
  assert.throws(
    () => applyOp(full, { op: 'add_rows', args: { sheet: 'S', before: 1, rows: [['new']] } }),
    (err) => err instanceof SpecOpError && /超过每个工作表 \d+ 行的上限/.test(err.message),
  );
  assert.strictEqual(String(full.sheets[0].rows.at(-1)[0]), String(MAX_ROWS - 1), 'the last row is still there');
});
