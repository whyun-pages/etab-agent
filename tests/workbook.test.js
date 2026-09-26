'use strict';
/**
 * Tests for the workbook spec layer.
 *
 * The point of this module is that a model can propose anything and the result
 * is still a usable workbook. So the tests lean on malformed input: missing
 * columns, ragged rows, wrong types, Chinese numerals, duplicate headers. A
 * spec layer that only works on well-formed input is not doing its job.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeSpec,
  normalizeType,
  validateSpec,
  toSheet,
  toSheets,
  specStats,
  coerce,
  dateToSerial,
  displayWidth,
  writeSpec,
} = require('../lib/workbook');

// ── normalisation ───────────────────────────────────────────────────

test('normalizeSpec: a well-formed spec survives intact', () => {
  const { spec, notes } = normalizeSpec({
    title: '销售汇总',
    sheets: [{
      name: '一月',
      columns: [
        { key: 'customer', header: '客户', type: 'text' },
        { key: 'amount', header: '金额', type: 'currency' },
      ],
      rows: [['甲公司', 1000], ['乙公司', 2500]],
    }],
  });

  assert.strictEqual(spec.title, '销售汇总');
  assert.strictEqual(spec.sheets.length, 1);
  assert.strictEqual(spec.sheets[0].name, '一月');
  assert.strictEqual(spec.sheets[0].columns.length, 2);
  assert.strictEqual(spec.sheets[0].rows.length, 2);
  assert.strictEqual(spec.sheets[0].rows[1][1], 2500);
  assert.strictEqual(notes.length, 0);
});

test('normalizeSpec: strings as columns are accepted', () => {
  const { spec } = normalizeSpec({
    title: 'T',
    sheets: [{ name: 'S', columns: ['客户', '金额'], rows: [['甲', 5]] }],
  });
  assert.deepStrictEqual(spec.sheets[0].columns.map((c) => c.header), ['客户', '金额']);
  assert.strictEqual(spec.sheets[0].columns[0].type, 'text');
  assert.strictEqual(spec.sheets[0].rows[0][0], '甲');
});

test('normalizeSpec: a bare table without a sheet wrapper is accepted', () => {
  const { spec } = normalizeSpec({
    title: '表',
    columns: [{ header: '名称' }, { header: '数量' }],
    rows: [['笔', 3]],
  });
  assert.strictEqual(spec.sheets.length, 1);
  // The columns declare no type, so text is the honest reading — this layer
  // must not guess "3" is a number and be wrong about a part number.
  assert.strictEqual(spec.sheets[0].rows[0][0], '笔');
  assert.strictEqual(spec.sheets[0].rows[0][1], '3');
  assert.strictEqual(spec.sheets[0].columns[0].type, 'text');
});

test('normalizeSpec: object rows are mapped onto columns by header', () => {
  const { spec } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: '客户' }, { header: '金额', type: 'number' }],
      rows: [{ 金额: '1200', 客户: '甲' }],
    }],
  });
  assert.strictEqual(spec.sheets[0].rows[0][0], '甲');
  assert.strictEqual(spec.sheets[0].rows[0][1], 1200);
});

test('normalizeSpec: total garbage does not throw, it degrades', () => {
  for (const bad of [null, undefined, 42, 'hello', [], { sheets: 'no' }, { sheets: [null] }]) {
    const { spec } = normalizeSpec(bad);
    assert.ok(spec && Array.isArray(spec.sheets), `spec for ${JSON.stringify(bad)}`);
    assert.ok(spec.sheets.length >= 1);
    assert.ok(Array.isArray(spec.sheets[0].columns));
    assert.ok(Array.isArray(spec.sheets[0].rows));
  }
});

test('normalizeSpec: duplicate sheet names are made unique', () => {
  const { spec } = normalizeSpec({
    sheets: [{ name: '数据', rows: [] }, { name: '数据', rows: [] }, { name: '数据', rows: [] }],
  });
  const names = spec.sheets.map((s) => s.name);
  assert.strictEqual(new Set(names).size, 3, names.join(','));
});

test('normalizeSpec: duplicate column keys are made unique', () => {
  const { spec } = normalizeSpec({
    sheets: [{ name: 'S', columns: [{ header: '金额' }, { header: '金额' }], rows: [] }],
  });
  const keys = spec.sheets[0].columns.map((c) => c.key);
  assert.strictEqual(new Set(keys).size, 2, keys.join(','));
});

test('normalizeSpec: Excel-illegal characters are stripped from names', () => {
  const { spec } = normalizeSpec({
    sheets: [{ name: 'a/b:c*?[]d', columns: [], rows: [] }],
  });
  assert.ok(!/[:\\/?*[\]]/.test(spec.sheets[0].name), spec.sheets[0].name);
});

test('normalizeSpec: ragged rows are reported and padded to the column count', () => {
  const { spec, notes } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: 'A' }, { header: 'B' }, { header: 'C' }],
      rows: [['x', 1], ['y', 2, 3, 4]],
    }],
  });
  assert.strictEqual(spec.sheets[0].rows[0].length, 3);
  assert.ok(spec.sheets[0].rows[0][2] === null, 'short row padded with null');
  assert.ok(notes.some((n) => /不一致/.test(n.message)), JSON.stringify(notes));
});

test('normalizeSpec: rows without columns get inferred columns', () => {
  const { spec, notes } = normalizeSpec({
    sheets: [{ name: 'S', rows: [['甲', 1, true], ['乙', 2, false]] }],
  });
  assert.strictEqual(spec.sheets[0].columns.length, 3);
  assert.ok(notes.some((n) => /推断/.test(n.message)));
});

test('normalizeSpec: the row cap is enforced with a note, not an error', () => {
  const rows = Array.from({ length: 5100 }, (_, i) => [i]);
  const { spec, notes } = normalizeSpec({ sheets: [{ name: 'S', columns: ['n'], rows }] });
  assert.ok(spec.sheets[0].rows.length <= 5000);
  assert.ok(notes.some((n) => /只保留/.test(n.message)));
});

// ── types ───────────────────────────────────────────────────────────

test('normalizeType: aliases and Chinese names resolve', () => {
  assert.strictEqual(normalizeType('number'), 'number');
  assert.strictEqual(normalizeType('int'), 'integer');
  assert.strictEqual(normalizeType('金额'), 'currency');
  assert.strictEqual(normalizeType('money'), 'currency');
  assert.strictEqual(normalizeType('百分比'), 'percent');
  assert.strictEqual(normalizeType('datetime'), 'date');
  assert.strictEqual(normalizeType('bool'), 'boolean');
  assert.strictEqual(normalizeType('currency (CNY)'), 'currency');
  assert.strictEqual(normalizeType('something odd'), 'text');
  assert.strictEqual(normalizeType(null), 'text');
});

test('coerce: Chinese numerals become numbers', () => {
  assert.strictEqual(coerce('一百二十五万', 'currency').value, 1250000);
  assert.strictEqual(coerce('125万', 'currency').value, 1250000);
  assert.strictEqual(coerce('1,200.50', 'number').value, 1200.5);
});

test('coerce: an unusable number is left blank AND reported', () => {
  const r = coerce('四十几万吧', 'currency');
  assert.strictEqual(r.value, null);
  assert.ok(r.note, 'a reason is required — silence would look like an empty cell');
});

test('coerce: integer rounds', () => {
  assert.strictEqual(coerce(3.7, 'integer').value, 4);
  assert.strictEqual(coerce('3.7', 'integer').value, 4);
});

test('coerce: an existing Excel serial is a date', () => {
  const r = coerce(46023, 'date');
  assert.ok(r.value instanceof Date);
  assert.strictEqual(r.value.toISOString().slice(0, 10), '2026-01-01');
});

test('coerce: dates parse and invalid ones are reported', () => {
  const good = coerce('2026-03-01', 'date');
  assert.ok(good.value instanceof Date);
  assert.strictEqual(good.value.toISOString().slice(0, 10), '2026-03-01');

  const bad = coerce('不知道什么时候', 'date');
  assert.strictEqual(bad.value, null);
  assert.ok(bad.note);
});

test('coerce: booleans accept the usual spellings', () => {
  assert.strictEqual(coerce('是', 'boolean').value, true);
  assert.strictEqual(coerce('否', 'boolean').value, false);
  assert.strictEqual(coerce('true', 'boolean').value, true);
  assert.strictEqual(coerce('0', 'boolean').value, false);
  assert.strictEqual(coerce('也许', 'boolean').value, null);
});

test('coerce: blank stays blank and is not a failure', () => {
  for (const v of [null, undefined, '']) {
    const r = coerce(v, 'number');
    assert.strictEqual(r.value, null);
    assert.strictEqual(r.note, null, 'a blank cell is not an error');
  }
});

test('coerce: a blank in one column does not stop the others', () => {
  const { spec } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: '客户' }, { header: '金额', type: 'number' }],
      rows: [['甲', null], ['乙', '不是数字'], ['丙', 100]],
    }],
  });
  const rows = spec.sheets[0].rows;
  assert.strictEqual(rows[0][0], '甲');
  assert.strictEqual(rows[0][1], null);
  assert.strictEqual(rows[2][1], 100);
});

test('coerce: a huge string is clamped rather than passed through', () => {
  const r = coerce('x'.repeat(50000), 'text');
  assert.ok(r.value.length <= 20001, String(r.value.length));
});

// ── validation ──────────────────────────────────────────────────────

test('validateSpec: a normal spec passes', () => {
  const { spec } = normalizeSpec({
    sheets: [{ name: 'S', columns: [{ header: 'A' }], rows: [['x']] }],
  });
  const v = validateSpec(spec);
  assert.strictEqual(v.ok, true, JSON.stringify(v.blocking));
  assert.strictEqual(v.blocking.length, 0);
});

test('validateSpec: data without columns is blocked', () => {
  const v = validateSpec({
    title: 'T',
    sheets: [{ name: 'S', columns: [], rows: [['a', 'b']] }],
  });
  assert.strictEqual(v.ok, false);
  assert.ok(/没有列定义/.test(v.blocking.join('')));
});

test('validateSpec: all-unnamed columns are blocked', () => {
  const v = validateSpec({
    title: 'T',
    sheets: [{ name: 'S', columns: [{ key: 'a', header: '' }, { key: 'b', header: '' }], rows: [['x', 'y']] }],
  });
  assert.strictEqual(v.ok, false);
  assert.ok(/都没有名称/.test(v.blocking.join('')));
});

test('validateSpec: an empty workbook is a warning, not a block', () => {
  const v = validateSpec({ title: 'T', sheets: [{ name: 'S', columns: [{ header: 'A' }], rows: [] }] });
  assert.strictEqual(v.ok, true);
  assert.ok(v.warnings.some((w) => /空的/.test(w)));
});

test('validateSpec: no sheets at all is blocked', () => {
  assert.strictEqual(validateSpec({ sheets: [] }).ok, false);
  assert.strictEqual(validateSpec(null).ok, false);
});

// ── sheet conversion ────────────────────────────────────────────────

test('toSheet: header occupies row 1 and data starts at row 2', () => {
  const { spec } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: '客户' }, { header: '金额', type: 'number' }],
      rows: [['甲', 100], ['乙', 200]],
    }],
  });
  const s = toSheet(spec.sheets[0]);
  const at = (ref) => s.cells.find((c) => c.ref === ref);

  assert.strictEqual(at('A1').value, '客户');
  assert.strictEqual(at('B1').value, '金额');
  assert.strictEqual(at('A2').value, '甲');
  assert.strictEqual(at('B2').value, 100);
  assert.strictEqual(at('B3').value, 200);
  assert.strictEqual(s.freeze, 1);
  assert.strictEqual(s.dimensions, 'A1:B3');
});

test('toSheet: blank cells are omitted rather than written empty', () => {
  const { spec } = normalizeSpec({
    sheets: [{ name: 'S', columns: [{ header: 'A' }, { header: 'B' }], rows: [['x', null]] }],
  });
  const s = toSheet(spec.sheets[0]);
  assert.ok(!s.cells.find((c) => c.ref === 'B2'), 'a null must not become a cell');
});

test('toSheet: a Date becomes an Excel serial', () => {
  const { spec } = normalizeSpec({
    sheets: [{ name: 'S', columns: [{ header: '日期', type: 'date' }], rows: [['2026-03-01']] }],
  });
  const s = toSheet(spec.sheets[0]);
  const cell = s.cells.find((c) => c.ref === 'A2');
  assert.strictEqual(typeof cell.value, 'number');
  assert.strictEqual(cell.value, dateToSerial(new Date(Date.UTC(2026, 2, 1))));
});

test('toSheet: totals row carries a real SUM formula and a cached value', () => {
  const { spec } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: '客户' }, { header: '金额', type: 'number' }],
      rows: [['甲', 100], ['乙', 250]],
      totals: { enabled: true, label: '合计' },
    }],
  });
  const s = toSheet(spec.sheets[0]);

  assert.strictEqual(s.totalRow, 4);
  const label = s.cells.find((c) => c.ref === 'A4');
  const sum = s.cells.find((c) => c.ref === 'B4');
  assert.strictEqual(label.value, '合计');
  assert.strictEqual(sum.formula, 'SUM(B2:B3)');
  assert.strictEqual(sum.value, 350, 'the cached value must match the formula');
});

test('normalizeTotals: a percent column is NOT summed', () => {
  // The sum of a column of tax rates is a meaningless number. It shipped in a
  // preview once — 0.5 sitting under 6% / 13% — and it looked deliberate.
  const { spec } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [
        { header: '客户' },
        { header: '金额', type: 'currency' },
        { header: '税率', type: 'percent' },
        { header: '数量', type: 'integer' },
      ],
      rows: [['甲', 100, 0.06, 2], ['乙', 200, 0.13, 3]],
      totals: { enabled: true },
    }],
  });
  const t = spec.sheets[0].totals;
  assert.ok(t.enabled);
  // Indices 1 (金额) and 3 (数量), and NOT 2 (税率).
  assert.deepStrictEqual(t.sumColumns, [1, 3]);

  const s = toSheet(spec.sheets[0]);
  const letters = s.cells.filter((c) => c.formula).map((c) => c.ref);
  assert.deepStrictEqual(letters, ['B4', 'D4']);
});

test('normalizeTotals: an explicit sumColumns list is honoured, percent included', () => {
  // If the caller explicitly asks for it, that is their call — the guard is
  // only against a sum nobody requested.
  const { spec } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: '税率', type: 'percent' }],
      rows: [[0.06], [0.13]],
      totals: { enabled: true, sumColumns: ['税率'] },
    }],
  });
  assert.deepStrictEqual(spec.sheets[0].totals.sumColumns, [0]);
});

test('normalizeTotals: an unknown sumColumns entry is reported and dropped', () => {
  const { spec, notes } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: '金额', type: 'currency' }],
      rows: [[100]],
      totals: { enabled: true, sumColumns: ['金额', '不存在的列'] },
    }],
  });
  assert.deepStrictEqual(spec.sheets[0].totals.sumColumns, [0]);
  assert.ok(notes.some((n) => /不存在/.test(n.message)), JSON.stringify(notes));
});

test('normalizeTotals: a bare NUMBER is a column index, not an unknown name', () => {
  // Real bug: the model was told to name columns and emitted `sumColumns: [1]`.
  // That resolved to nothing, `enabled` was `indices.length > 0`, and a request
  // to total a column produced NO totals row at all — the reply said 435000
  // while the preview showed three rows.
  const { spec, notes } = normalizeSpec({
    sheets: [{
      name: '销售台账',
      columns: [
        { header: '客户', type: 'text' },
        { header: '金额', type: 'currency' },
        { header: '签约日期', type: 'date' },
      ],
      rows: [['A', 120000, '2026-01-15'], ['B', 85000, '2026-02-20'], ['C', 230000, '2026-03-10']],
      totals: { enabled: true, label: '合计', sumColumns: [1] },
    }],
  });
  const t = spec.sheets[0].totals;
  assert.strictEqual(t.enabled, true, 'index 1 is 金额, so the totals row must exist');
  assert.deepStrictEqual(t.sumColumns, [1]);
  assert.deepStrictEqual(notes, [], 'an accepted index is not a warning');
});

test('normalizeTotals: an index that is not summable is dropped, not honoured', () => {
  // 0-based indices match how this module refers to columns. A one-based slip
  // that lands on a text or date column must not become a meaningless total,
  // and the fallback then totals the columns that DO sum.
  const { spec, notes } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: '客户', type: 'text' }, { header: '金额', type: 'currency' }],
      rows: [['A', 100]],
      totals: { enabled: true, sumColumns: [1, 0] },
    }],
  });
  assert.deepStrictEqual(spec.sheets[0].totals.sumColumns, [1], 'index 0 is text and must be refused');
  assert.ok(notes.some((n) => /不可加/.test(n.message)), JSON.stringify(notes));
});

test('normalizeTotals: an explicit but unusable list falls back, not to nothing', () => {
  // Before: a bad explicit list produced `enabled: false`, while an EMPTY list
  // summed every numeric column — so naming a column wrong was worse than
  // naming none. The user asked for a 合计; total the summable columns.
  const { spec } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: '客户', type: 'text' }, { header: '金额', type: 'currency' }],
      rows: [['A', 100]],
      totals: { enabled: true, sumColumns: ['没有这一列'] },
    }],
  });
  const t = spec.sheets[0].totals;
  assert.strictEqual(t.enabled, true, 'an unusable explicit list must not delete the totals row');
  assert.deepStrictEqual(t.sumColumns, [1], 'it falls back to the summable column');
});

test('normalizeTotals: normalising twice changes nothing (the reload path)', () => {
  // The actual bug, in full. A spec is normalised once on the way IN (runTurn)
  // and AGAIN on the way OUT of the store (`SessionStore#loadFile`, for the
  // date round trip). The first pass rewrites `sumColumns: ['金额']` into the
  // resolved index `[1]`; the second pass then sees a bare number. When numbers
  // were not understood, pass two read `[1]`, matched no column, and set
  // `enabled: false` — so a totals row that was correct on the turn that made it
  // VANISHED the moment the session was reopened. Not idempotent = a latent bug
  // that only shows up after a reload.
  const once = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: '客户', type: 'text' }, { header: '金额', type: 'currency' }],
      rows: [['A', 100], ['B', 200]],
      totals: { enabled: true, label: '合计', sumColumns: ['金额'] },
    }],
  }).spec;

  const twice = normalizeSpec(JSON.parse(JSON.stringify(once))).spec;

  assert.deepStrictEqual(twice.sheets[0].totals, once.sheets[0].totals,
    'a second normalise pass must be a no-op; the store runs one on every load');
  assert.strictEqual(twice.sheets[0].totals.enabled, true);

  // And the row still reaches the bytes.
  const bytes = writeSpec(twice);
  const parsed = require('../lib/xlsx').readWorkbook(bytes);
  assert.strictEqual(parsed.sheets[0].maxRow, 4, 'header + 2 data + 合计');
});

test('toSheet: totals ignore non-numeric cells instead of producing NaN', () => {
  // The type is declared UP FRONT on purpose: normalisation coerces rows as it
  // builds them, so a type set afterwards would leave the cells as the text
  // they were coerced to and the sum would silently skip them.
  const { spec } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: 'A' }, { header: '金额', type: 'number' }],
      rows: [['x', 100], ['y', 'n/a'], ['z', 50]],
      totals: { enabled: true },
    }],
  });
  const s = toSheet(spec.sheets[0]);
  // 'n/a' cannot be a number, so it is blank — and a blank row must not make
  // the cached total diverge from what SUM() will compute.
  assert.strictEqual(spec.sheets[0].rows[1][1], null);
  const sum = s.cells.find((c) => c.formula);
  assert.strictEqual(sum.value, 150);
  // The range spans EVERY data row, blank one included: a range that skipped
  // it would stop covering the table as soon as the user filled it in.
  assert.strictEqual(sum.formula, 'SUM(B2:B4)');
});

test('toSheet: totals are opt-in, so no 合计 row appears uninvited', () => {
  const { spec } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: 'A' }, { header: '金额', type: 'number' }],
      rows: [['x', 100], ['z', 50]],
    }],
  });
  const s = toSheet(spec.sheets[0]);
  assert.strictEqual(s.totalRow, null);
  assert.ok(!s.cells.some((c) => c.formula), 'a totals row nobody asked for is an unrequested edit');
  assert.ok(!s.cells.some((c) => c.value === '合计'));
});

test('toSheet: cached totals agree with formula.js recomputation', () => {
  // The whole reason a cached value is written is that Excel shows the number
  // before it recalculates. If the two disagree, the file shows one figure on
  // open and a different one after any edit — the worst kind of wrong.
  //
  // `recomputeCachedValues` returns only the cells that CHANGED, so total
  // agreement is an empty list, not a list of matches.
  const { recomputeCachedValues } = require('../lib/formula');
  const { spec } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: '客户' }, { header: '金额', type: 'number' }, { header: '数量', type: 'integer' }],
      rows: [['甲', 1234.5, 3], ['乙', 500, 7], ['丙', 0.25, 1]],
      totals: { enabled: true, sumColumns: ['金额', '数量'] },
    }],
  });
  const s = toSheet(spec.sheets[0]);
  const { recomputed, unresolved } = recomputeCachedValues(s.cells);

  assert.deepStrictEqual(unresolved, [], 'every totals formula must be evaluable');
  assert.deepStrictEqual(recomputed, [],
    'a non-empty list means the written cache disagreed with the formula: ' + JSON.stringify(recomputed));

  // And the value itself, so this cannot pass by both sides being empty.
  const sums = s.cells.filter((c) => c.formula).map((c) => c.value);
  assert.deepStrictEqual(sums, [1734.75, 11]);
});

test('toSheet: no totals requested means no totals row', () => {
  const { spec } = normalizeSpec({
    sheets: [{ name: 'S', columns: [{ header: 'A' }], rows: [['x']], totals: false }],
  });
  const s = toSheet(spec.sheets[0]);
  assert.strictEqual(s.totalRow, null);
  assert.ok(!s.cells.find((c) => /SUM/.test(String(c.formula || ''))));
});

test('toSheet: declared width is honoured, otherwise it is sized', () => {
  const { spec } = normalizeSpec({
    sheets: [{
      name: 'S',
      columns: [{ header: '很长的中文表头名称', width: 30 }, { header: '金额' }],
      rows: [],
    }],
  });
  const s = toSheet(spec.sheets[0]);
  assert.strictEqual(s.cols[0].width, 30);
  assert.ok(s.cols[1].width >= 10);
});

test('toSheets: every sheet comes through with a name', () => {
  const { spec } = normalizeSpec({
    sheets: [{ name: '一', columns: [{ header: 'A' }], rows: [['x']] }, { name: '二', columns: [{ header: 'B' }], rows: [['y']] }],
  });
  const out = toSheets(spec);
  assert.strictEqual(out.sheets.length, 2);
  assert.deepStrictEqual(out.sheets.map((s) => s.name), ['一', '二']);
  assert.strictEqual(out.title, '工作簿');
});

// ── misc ────────────────────────────────────────────────────────────

test('specStats: counts sheets, rows and columns', () => {
  const { spec } = normalizeSpec({
    sheets: [
      { name: 'A', columns: [{ header: 'x' }, { header: 'y' }], rows: [['a', 'b'], ['c', 'd']] },
      { name: 'B', columns: [{ header: 'z' }], rows: [['e']] },
    ],
  });
  const st = specStats(spec);
  assert.strictEqual(st.sheets, 2);
  assert.strictEqual(st.rows, 3);
  assert.strictEqual(st.columns, 3);
});

test('dateToSerial: the epoch matches what Excel ships', () => {
  // 1900-01-01 in Excel's own (buggy) calendar is serial 2.
  assert.strictEqual(dateToSerial(new Date(Date.UTC(1899, 11, 30))), 0);
  assert.strictEqual(dateToSerial(new Date(Date.UTC(1900, 0, 1))), 2);
  assert.strictEqual(dateToSerial(new Date(Date.UTC(2026, 0, 1))), 46023);
});

test('displayWidth: CJK counts double, which is why widths look right', () => {
  assert.strictEqual(displayWidth('abcd'), 4);
  assert.strictEqual(displayWidth('客户'), 4);
  assert.strictEqual(displayWidth('客户ab'), 6);
});
