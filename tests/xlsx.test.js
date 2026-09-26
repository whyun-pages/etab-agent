'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fixtureA, fixtureB } = require('./fixtures');
const { readWorkbook, parseRef, colName, cellRef, numFmtCodeFor } = require('../lib/xlsx');
const { readZip } = require('../lib/zip');

// ------------------------------------------------------------------ addresses
test('cell address helpers round-trip', () => {
  assert.deepStrictEqual(parseRef('A1'), { col: 1, row: 1 });
  assert.deepStrictEqual(parseRef('Z9'), { col: 26, row: 9 });
  assert.deepStrictEqual(parseRef('AA10'), { col: 27, row: 10 });
  assert.deepStrictEqual(parseRef('BC12'), { col: 55, row: 12 });
  assert.strictEqual(colName(1), 'A');
  assert.strictEqual(colName(26), 'Z');
  assert.strictEqual(colName(27), 'AA');
  assert.strictEqual(colName(55), 'BC');
  for (const col of [1, 26, 27, 55, 702, 703]) {
    assert.strictEqual(parseRef(colName(col) + 7).col, col);
  }
  assert.strictEqual(cellRef(28, 3), 'AB3');
  assert.strictEqual(parseRef('not-a-ref'), null);
});

// -------------------------------------------------------------- zip structure
test('reads a streaming-style zip with data descriptors and zip64 extra', () => {
  const zip = readZip(fixtureA());
  assert.ok(zip.has('xl/workbook.xml'));
  assert.ok(zip.has('xl/worksheets/sheet1.xml'));
  const wt = zip.get('[Content_Types].xml').data.toString('utf8');
  assert.match(wt, /spreadsheetml\.sheet\.main/);
  // Stored (method 0) entry must survive too.
  assert.ok(zip.get('xl/worksheets/sheet2.xml').data.length > 0);
});

// ------------------------------------------------------------------ workbook
test('parses sheets, order, hidden state and relationship targets', () => {
  const wb = readWorkbook(fixtureA());
  assert.deepStrictEqual(wb.sheets.map((s) => s.name), ['订单明细', '隐藏配置']);
  assert.strictEqual(wb.sheets[0].state, 'visible');
  assert.strictEqual(wb.sheets[1].state, 'hidden');
  assert.strictEqual(wb.sheets[0].path, 'xl/worksheets/sheet1.xml');
  assert.strictEqual(wb.sheets[1].path, 'xl/worksheets/sheet2.xml');
  assert.strictEqual(wb.definedNames['_xlnm.Print_Area'], '订单明细!$A$1:$D$5');
});

test('flattens rich-text runs in the shared string table', () => {
  const wb = readWorkbook(fixtureA());
  assert.strictEqual(wb.sharedStrings[1], '合同总额');
  assert.strictEqual(wb.sharedStrings[6], ' 前后留空格 ');
});

test('resolves inline string runs into a single value', () => {
  const wb = readWorkbook(fixtureA());
  const sheet = wb.sheets[0];
  const d3 = sheet.cells.find((c) => c.ref === 'D3');
  assert.strictEqual(d3.value, '部分完成');
});

test('reads numbers, booleans, errors, formulas and cached values', () => {
  const wb = readWorkbook(fixtureA());
  const sheet = wb.sheets[0];
  const at = (ref) => sheet.cells.find((c) => c.ref === ref);

  assert.strictEqual(at('B2').value, 125000.5);
  assert.strictEqual(at('B2').type, 'n');
  assert.strictEqual(at('E2').value, 1);
  assert.strictEqual(at('C4').type, 'e');
  assert.deepStrictEqual(at('C4').value, { error: '#DIV/0!' });
  assert.strictEqual(at('D4').type, 'b');
  assert.strictEqual(at('D4').value, false);

  // Formula cell keeps both the formula and Excel's cached result.
  assert.strictEqual(at('B3').hasFormula, true);
  assert.strictEqual(at('B3').formula, 'SUM(B2:B2)*2');
  assert.strictEqual(at('B3').value, 250001);
  assert.strictEqual(at('C3').formula, 'DATE(2026,3,1)');

  // Numeric zero is a value, not a blank.
  assert.strictEqual(at('B6').value, 0);
});

test('infers implicit row and column positions when r= is omitted', () => {
  const wb = readWorkbook(fixtureB());
  const sheet = wb.sheets[0];
  // <row> with no r= is row 1; cells with no r= take the next column.
  const refs = sheet.cells.map((c) => c.ref).sort();
  assert.deepStrictEqual(refs, ['A1', 'B1', 'C1']);
  assert.strictEqual(sheet.cells.find((c) => c.ref === 'C1').value, 7);
});

test('survives an out-of-range shared string index', () => {
  const wb = readWorkbook(fixtureB());
  const a1 = wb.sheets[0].cells.find((c) => c.ref === 'A1');
  assert.strictEqual(a1.value, '');
});

test('handles absolute relationship targets and a missing styles part', () => {
  const wb = readWorkbook(fixtureB());
  assert.strictEqual(wb.sheets[0].path, 'xl/worksheets/sheet1.xml');
  assert.deepStrictEqual(wb.styles.cellXfs, []);
  assert.strictEqual(numFmtCodeFor({ cellXfs: [], numFmts: {} }, 0), 'General');
});

test('captures layout metadata: merges, cols, dimensions, max extent', () => {
  const wb = readWorkbook(fixtureA());
  const sheet = wb.sheets[0];
  assert.deepStrictEqual(sheet.merges, ['A5:D5', 'E1:E1']);
  assert.strictEqual(sheet.dimensions, 'A1:E6');
  assert.strictEqual(sheet.maxCol, 5);
  assert.strictEqual(sheet.maxRow, 6);
  const hidden = sheet.cols.find((c) => c.min === 4);
  assert.strictEqual(hidden.hidden, true);
  assert.strictEqual(hidden.width, 30);
});

// ---------------------------------------------------------------- style table
test('parses number formats, fonts and fills', () => {
  const wb = readWorkbook(fixtureA());
  const st = wb.styles;
  assert.strictEqual(st.numFmts[164], 'yyyy"年"m"月"d"日"');
  assert.strictEqual(st.numFmts[165], '¥#,##0.00');
  assert.strictEqual(st.numFmts[14], 'm/d/yyyy');       // builtin survives
  assert.strictEqual(st.fonts[1].bold, true);
  assert.strictEqual(st.fonts[1].color, '#FFFFFF');
  assert.strictEqual(st.fonts[2].italic, true);
  assert.strictEqual(st.fonts[2].name, 'Consolas');
  assert.strictEqual(st.fills[2].fgColor, '#4472C4');
  assert.strictEqual(st.cellXfs[1].align, 'center');
  assert.strictEqual(st.cellXfs[1].wrapText, true);
  assert.strictEqual(st.cellXfs[2].numFmtId, 165);
  assert.strictEqual(numFmtCodeFor(st, 2), '¥#,##0.00');
  assert.strictEqual(numFmtCodeFor(st, 4), '@');
  // Wrapped </xf> form is handled the same as self-closing.
  assert.strictEqual(st.cellXfs.length, 5);
});

test('reads a hidden sheet body independently of the main sheet', () => {
  const wb = readWorkbook(fixtureA());
  const s2 = wb.sheets[1];
  assert.strictEqual(s2.maxRow, 2);
  assert.strictEqual(s2.cells.find((c) => c.ref === 'B2').value, 0.13);
});
