'use strict';
/**
 * The two ways to build a preview must agree.
 *
 * There are two paths in: `specPreview` (straight from a spec, no file) and
 * `sheetPreview` (bytes written by `writeSpec`, then read back). The UI draws one
 * grid, so they have to produce the same thing — and if only one of them is
 * asserted, the other drifts silently.
 *
 * It already did. Live, `specPreview` sent a `Date` and the JSON response turned
 * it into an ISO string; the grid rendered `46030` where the date was
 * 2026-01-08. The file path was correct the whole time. This test is what would
 * have caught it.
 */

import test from 'node:test';
import assert from 'node:assert';

import { normalizeSpec, writeSpec, dateToSerial } from '../src/workbook/workbook.ts';
import { specPreview, sheetPreview } from '../src/workbook/preview.ts';

/** A spec exercising every type, including the ones that need converting. */
const SPEC = {
  title: '销售台账',
  sheets: [{
    name: '明细',
    columns: [
      { header: '客户名称', type: 'text' },
      { header: '金额', type: 'currency' },
      { header: '签约日期', type: 'date' },
      { header: '税率', type: 'percent' },
      { header: '数量', type: 'integer' },
      { header: '已回款', type: 'boolean' },
    ],
    rows: [
      ['甲', 1250000, '2026-01-08', 0.06, 12, true],
      ['乙', '86万', '2026-01-22', '百分之六', 8, false],
    ],
    totals: { enabled: true, sumColumns: ['金额', '数量'] },
  }],
};

const norm = () => normalizeSpec(SPEC).spec;

test('specPreview: a date becomes a serial number, not a Date', () => {
  const p = specPreview(norm());
  const cell = p.rows[1][2];
  assert.strictEqual(typeof cell, 'number', `got ${typeof cell}`);
  assert.strictEqual(cell, dateToSerial(new Date(Date.UTC(2026, 0, 8))));
  // The regression, stated directly: no ISO string anywhere in the grid.
  assert.strictEqual(JSON.stringify(p).includes('T00:00:00'), false, 'no ISO strings travel to the client');
});

test('sheetPreview: the date serial resolves to the date that was written', () => {
  // Checked against the epoch directly, not through dateToSerial: if that
  // helper were off by a day, the test above would agree with it.
  const serial = sheetPreview(writeSpec(norm()), '明细').rows[1][2];
  const back = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
  assert.strictEqual(back.toISOString().slice(0, 10), '2026-01-08');
});

test('specPreview: the grid can be serialised without losing a type', () => {
  // The response is JSON, so anything that survives is what the client sees.
  const round = JSON.parse(JSON.stringify(specPreview(norm())));
  assert.strictEqual(typeof round.rows[1][2], 'number');
  assert.strictEqual(round.formats[1][2], 'yyyy-mm-dd');
});

test('specPreview: formats follow the column types', () => {
  const p = specPreview(norm());
  assert.deepStrictEqual(p.formats[1], [null, '¥#,##0.00', 'yyyy-mm-dd', '0.00%', '#,##0', null]);
});

test('specPreview: the totals row sums only its sumColumns', () => {
  const p = specPreview(norm());
  const total = p.rows[p.rows.length - 1];
  assert.strictEqual(total[0], '合计');
  assert.strictEqual(total[1], 1250000 + 860000);
  assert.strictEqual(total[3], null, 'the 税率 column has no total');
  assert.strictEqual(total[4], 20);
});

test('specPreview and sheetPreview agree cell for cell', () => {
  // The assertion that keeps the two paths from drifting apart again.
  const spec = norm();
  const fromSpec = specPreview(spec);
  const fromBytes = sheetPreview(writeSpec(spec), '明细');

  assert.strictEqual(fromSpec.name, fromBytes.name);
  assert.deepStrictEqual(fromSpec.rows, fromBytes.rows,
    `spec path:  ${JSON.stringify(fromSpec.rows)}\nbytes path: ${JSON.stringify(fromBytes.rows)}`);

  // Format CODES differ in spelling between the two paths — the bytes path
  // reads whatever the writer put in styles.xml, this path derives from the
  // column type — so compare what they MEAN, not the strings. And only compare
  // cells that HOLD A VALUE: an empty total cell keeps a style in one path and
  // not the other, which is invisible because there is nothing to render.
  const kind = (f) => {
    if (!f) return null;
    if (f.includes('%')) return 'percent';
    if (/[¥￥]/.test(f)) return 'currency';
    if (/[yd]/i.test(f)) return 'date';
    return 'number';
  };
  for (let r = 0; r < fromSpec.formats.length; r++) {
    for (let c = 0; c < fromSpec.formats[r].length; c++) {
      const hasValue = fromBytes.rows[r][c] !== null && fromBytes.rows[r][c] !== undefined;
      if (!hasValue) continue;
      assert.strictEqual(
        kind(fromSpec.formats[r][c]),
        kind(fromBytes.formats[r][c]),
        `cell ${r + 1},${c + 1} (value ${JSON.stringify(fromBytes.rows[r][c])}): `
        + `spec=${fromSpec.formats[r][c]} bytes=${fromBytes.formats[r][c]}`,
      );
    }
  }
});

test('specPreview: an empty spec is an empty grid, not a throw', () => {
  for (const input of [null, {}, { sheets: [] }]) {
    const p = specPreview(input);
    assert.deepStrictEqual(p.rows, []);
    assert.deepStrictEqual(p.formats, []);
  }
});

test('specPreview: a sheet with no rows still shows its header', () => {
  const { spec } = normalizeSpec({
    title: 'T',
    sheets: [{ name: 'S', columns: [{ header: '客户' }, { header: '金额', type: 'currency' }], rows: [] }],
  });
  const p = specPreview(spec);
  assert.deepStrictEqual(p.rows, [['客户', '金额']]);
  assert.deepStrictEqual(p.formats, [[null, null]]);
});

test('sheetPreview: an unknown sheet name falls back to the first', () => {
  const spec = norm();
  const p = sheetPreview(writeSpec(spec), '不存在的表');
  assert.strictEqual(p.name, '明细');
  assert.ok(p.rows.length > 0);
});

test('sheetPreview: a row limit truncates and says so', () => {
  const big = {
    title: 'T',
    sheets: [{
      name: 'S',
      columns: [{ header: '客户' }],
      rows: Array.from({ length: 60 }, (_, i) => [`客户${i}`]),
    }],
  };
  const { spec } = normalizeSpec(big);
  const p = sheetPreview(writeSpec(spec), 'S', { maxRows: 10 });
  assert.strictEqual(p.rows.length, 10);
  assert.strictEqual(p.truncated, true);
});

test('sheetPreview: formats are null, not "General", on plain cells', () => {
  // "General" is the absence of a format. Shipping the string for every cell
  // would hide a genuinely missing format behind a value that renders the same.
  const { spec } = normalizeSpec({
    title: 'T',
    sheets: [{ name: 'S', columns: [{ header: '客户' }, { header: '金额', type: 'currency' }], rows: [['甲', 100]] }],
  });
  const p = sheetPreview(writeSpec(spec), 'S');
  assert.strictEqual(p.formats[1][0], null);
  assert.ok(p.formats[1][1]);
});

// ── windows ─────────────────────────────────────────────────────────

import { sheetWindow, MAX_PREVIEW_ROWS } from '../src/workbook/preview.ts';
import { readWorkbook } from '../src/formats/xlsx.ts';

const longSpec = (n) => normalizeSpec({
  title: 'T',
  sheets: [{ name: 'S', columns: [{ header: '名称' }, { header: '金额', type: 'currency' }],
    rows: Array.from({ length: n }, (_, i) => [`r${i + 1}`, i + 1]) }],
}).spec;

test('sheetPreview: the first window says how big the whole sheet is', () => {
  const p = sheetPreview(writeSpec(longSpec(100)));
  assert.strictEqual(p.rows.length, MAX_PREVIEW_ROWS);
  assert.strictEqual(p.startRow, 1);
  assert.strictEqual(p.totalRows, 101);
  assert.strictEqual(p.totalCols, 2);
  assert.strictEqual(p.truncated, true);
});

test('sheetWindow: windows tile the sheet exactly, values and formats alike', () => {
  const wb = readWorkbook(writeSpec(longSpec(100)));
  const whole = sheetWindow(wb, undefined, { maxRows: 1000 });
  assert.strictEqual(whole.truncated, false);

  const parts = [1, 31, 61, 91].map((startRow) => sheetWindow(wb, undefined, { startRow, maxRows: 30 }));
  assert.deepStrictEqual(parts.map((w) => w.startRow), [1, 31, 61, 91]);
  assert.deepStrictEqual(parts.flatMap((w) => w.rows), whole.rows);
  assert.deepStrictEqual(parts.flatMap((w) => w.formats), whole.formats);
  assert.deepStrictEqual(parts[1].rows[0], ['r30', 30], 'sheet row 31 is data row 30');
  assert.strictEqual(parts[3].rows.length, 11, 'the last window stops at the last row');
});

test('sheetWindow: a window past the end is empty, not a throw', () => {
  const w = sheetWindow(readWorkbook(writeSpec(longSpec(5))), undefined, { startRow: 50, maxRows: 10 });
  assert.deepStrictEqual(w.rows, []);
  assert.strictEqual(w.totalRows, 6);
});

test('specPreview: reports its size like the windowed path, and is never cut', () => {
  const p = specPreview(longSpec(100));
  assert.strictEqual(p.totalRows, 101);
  assert.strictEqual(p.truncated, false);
});
