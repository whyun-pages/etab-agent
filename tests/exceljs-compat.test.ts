'use strict';
/**
 * Our workbooks, judged by somebody else's reader.
 *
 * The rest of the suite proves the writer agrees with OUR reader — which says
 * nothing if both are wrong the same way. exceljs is an independent, mature
 * implementation: if it reads back what we wrote, the file is valid OOXML and
 * not just something our own reader happens to accept. Every bug this project
 * has found in the zip/XML layer was found this way.
 *
 * The check runs the other way too: a file exceljs wrote must read correctly
 * through our reader.
 *
 * exceljs is a devDependency for this file alone. It never reaches the bundle.
 */

import test from 'node:test';
import assert from 'node:assert';
import ExcelJS from 'exceljs';

import { normalizeSpec, validateSpec, writeSpec } from '../src/workbook/workbook.ts';
import { writeWorkbook, writeSimpleSheet } from '../src/formats/xlsx-writer.ts';
import { readWorkbook } from '../src/formats/xlsx.ts';
import { fixtureA } from './helpers/fixtures.ts';

/** Load bytes into exceljs. */
async function excel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

/**
 * Write a spec the way the server does: normalise AND validate first, so a
 * spec this file accepts is one the server would accept too.
 */
function specBytes(raw) {
  const { spec } = normalizeSpec(raw);
  const v = validateSpec(spec);
  assert.ok(v.ok, `spec rejected: ${v.blocking && v.blocking.join('; ')}`);
  return writeSpec(spec);
}

const row = (ws, r, cols) => cols.map((c) => ws.getRow(r).getCell(c).value);

// ── the low-level writer ────────────────────────────────────────────

test('writeSimpleSheet: values, entities and shape read back through exceljs', async () => {
  const ws = (await excel(writeSimpleSheet({
    sheetName: '订单',
    rows: [
      ['客户名称', '合同总额', '订单日期', '备注'],
      ['北京示例科技有限公司', 125000.5, '2026-01-15', '首次合作'],
      ['上海另一家 & <括号>', -8800.25, '2026-03-01', '备注"引号"'],
    ],
  }))).getWorksheet('订单');
  assert.ok(ws, 'the sheet is missing');
  assert.strictEqual(ws.getCell('A1').value, '客户名称');
  assert.strictEqual(ws.getCell('B2').value, 125000.5);
  assert.strictEqual(ws.getCell('A3').value, '上海另一家 & <括号>');
  assert.strictEqual(ws.getCell('B3').value, -8800.25);
  assert.strictEqual(ws.getCell('D3').value, '备注"引号"');
  assert.strictEqual(ws.rowCount, 3);
  assert.strictEqual(ws.columnCount, 4);
});

test('writing into a template keeps its values, styles, widths and merges', async () => {
  const template = fixtureA();
  const tw = readWorkbook(template);
  const tSheet = tw.sheets[0];
  const cells = tSheet.cells.map((c) => ({
    ref: c.ref, col: c.col, row: c.row, value: c.value, styleIndex: c.styleIndex, formula: c.formula,
  }));
  // New rows reuse the template's number-format styles (2 = ¥#,##0.00, 3 = date, 4 = text).
  cells.push({ ref: 'A7', col: 1, row: 7, value: '新生成的公司', styleIndex: 0 });
  cells.push({ ref: 'B7', col: 2, row: 7, value: 999.5, styleIndex: 2 });
  cells.push({ ref: 'C7', col: 3, row: 7, value: 46204, styleIndex: 3 });
  cells.push({ ref: 'D7', col: 4, row: 7, value: '已完成', styleIndex: 4 });

  const ws = (await excel(writeWorkbook({
    templateBuffer: template,
    sheets: [{ name: tSheet.name, cells, cols: tSheet.cols, merges: tSheet.merges, freeze: { rows: 1 } }],
    shared: tw.sharedStrings,
  }))).getWorksheet('订单明细');
  assert.ok(ws, 'the sheet name was not preserved');

  assert.strictEqual(ws.getCell('A1').value, '客户名称');
  assert.strictEqual(ws.getCell('B1').value, '合同总额', 'rich text joined');
  assert.strictEqual(ws.getCell('B2').value, 125000.5);
  assert.strictEqual(ws.getCell('D3').value, '部分完成', 'inline string joined');
  assert.strictEqual(ws.getCell('A7').value, '新生成的公司');
  assert.strictEqual(ws.getCell('B7').value, 999.5);
  // exceljs turns a date-formatted serial into a real Date — exactly the signal
  // that the inherited format is intact.
  const c7 = ws.getCell('C7').value;
  assert.ok(c7 instanceof Date, `C7 is ${typeof c7}`);
  assert.strictEqual(c7.toISOString().slice(0, 10), '2026-07-01');
  assert.strictEqual(ws.getCell('D7').value, '已完成');
  assert.strictEqual(ws.getCell('C4').value.error, '#DIV/0!', 'the error cell did not survive');

  // Style inheritance is the whole point: exceljs must still see the formats.
  assert.strictEqual(ws.getCell('B7').numFmt, '¥#,##0.00', 'a new cell inherits the currency format');
  assert.strictEqual(ws.getCell('B2').numFmt, '¥#,##0.00', 'an original cell keeps it');
  assert.strictEqual(ws.getCell('C7').numFmt, 'yyyy"年"m"月"d"日"');
  assert.strictEqual(ws.getCell('A1').font && ws.getCell('A1').font.bold, true);
  assert.strictEqual(ws.getCell('A1').fill.fgColor.argb, 'FF4472C4');
  assert.strictEqual(ws.getColumn(4).hidden, true);
  assert.strictEqual(Math.round(ws.getColumn(1).width * 100) / 100, 22.71);
  assert.deepStrictEqual(ws.model.merges, ['A5:D5', 'E1:E1']);
});

test('a file exceljs wrote reads correctly through our reader', async () => {
  const theirs = new ExcelJS.Workbook();
  const sheet = theirs.addWorksheet('我方');
  sheet.addRow(['字段', '值']);
  sheet.addRow(['税率', 0.13]);
  sheet.addRow(['厂家', '某公司 & co']);
  const ms = readWorkbook(Buffer.from(await theirs.xlsx.writeBuffer())).sheets[0];
  const at = (r) => ms.cells.find((c) => c.ref === r)?.value;
  assert.strictEqual(ms.name, '我方');
  assert.strictEqual(at('A1'), '字段');
  assert.strictEqual(at('B2'), 0.13);
  assert.strictEqual(at('B3'), '某公司 & co');
});

// ── specs, the way the server writes them ───────────────────────────

test('a typed table round-trips: names, values, number types, freeze pane', async () => {
  const ws = (await excel(specBytes({
    title: '销售汇总',
    sheets: [{
      name: '一月',
      columns: [
        { key: 'customer', header: '客户', type: 'text' },
        { key: 'amount', header: '金额', type: 'currency' },
        { key: 'count', header: '数量', type: 'integer' },
      ],
      rows: [['甲公司', 1234.5, 3], ['乙公司', 500, 7]],
    }],
  }))).worksheets[0];
  assert.strictEqual(ws.name, '一月');
  assert.deepStrictEqual(row(ws, 1, [1, 2, 3]), ['客户', '金额', '数量']);
  assert.deepStrictEqual(row(ws, 2, [1, 2, 3]), ['甲公司', 1234.5, 3]);
  assert.deepStrictEqual(row(ws, 3, [1, 2, 3]), ['乙公司', 500, 7]);
  assert.ok(ws.views && ws.views.length, 'no freeze pane');
});

test('messy input still produces a readable file, with a working totals row', async () => {
  const ws = (await excel(specBytes({
    title: '合同',
    sheets: [{
      name: '明细',
      columns: [{ header: '项目' }, { header: '金额', type: 'currency' }],
      rows: [['首款', '一百二十五万'], ['尾款', null], ['杂费', '不能解析']],
      totals: { enabled: true, label: '合计' },
    }],
  }))).worksheets[0];
  assert.strictEqual(ws.getRow(2).getCell(2).value, 1250000, 'the Chinese numeral is not a number');
  assert.strictEqual(ws.getRow(3).getCell(2).value, null, 'a blank did not stay blank');
  assert.strictEqual(ws.getRow(4).getCell(2).value, null, 'an unusable value became text');
  assert.strictEqual(ws.getRow(5).getCell(1).value, '合计');
  const sum = ws.getRow(5).getCell(2);
  assert.ok(sum.formula, 'the totals cell carries no formula');
  // exceljs reports SUM(B2:B4) as {formula, result}; the cached result is what
  // Excel shows before it recalculates.
  assert.strictEqual(sum.value.result, 1250000);
});

test('a date is a date, not a string', async () => {
  const ws = (await excel(specBytes({
    title: '日程',
    sheets: [{
      name: 'S',
      columns: [{ header: '签约日', type: 'date' }, { header: '备注' }],
      rows: [['2026-03-01', 'done'], ['2025-12-31', '']],
    }],
  }))).worksheets[0];
  const v = ws.getRow(2).getCell(1).value;
  assert.ok(v instanceof Date, `got ${typeof v}`);
  assert.strictEqual(v.toISOString().slice(0, 10), '2026-03-01');
  assert.match(String(ws.getRow(2).getCell(1).numFmt || ''), /yyyy|mm|dd/);
});

test('money, percent and integers carry their formats and stay numbers', async () => {
  const ws = (await excel(specBytes({
    title: 'T',
    sheets: [{
      name: 'S',
      columns: [
        { header: '金额', type: 'currency' },
        { header: '占比', type: 'percent' },
        { header: '数量', type: 'integer' },
      ],
      rows: [[1234.5, 0.1567, 42]],
    }],
  }))).worksheets[0];
  const fmt = (c) => String(ws.getRow(2).getCell(c).numFmt || '');
  assert.ok(fmt(1).includes('¥'), fmt(1));
  assert.ok(fmt(2).includes('%'), fmt(2));
  assert.ok(fmt(3).length > 0, 'the integer column has no format');
  assert.deepStrictEqual(row(ws, 2, [1, 2, 3]).map((x) => typeof x), ['number', 'number', 'number']);
});

test('more than one sheet', async () => {
  const wb = await excel(specBytes({
    title: '年报',
    sheets: [
      { name: '摘要', columns: [{ header: '项' }, { header: '值', type: 'number' }], rows: [['收入', 100]] },
      { name: '明细', columns: [{ header: '日期', type: 'date' }], rows: [['2026-01-05']] },
    ],
  }));
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['摘要', '明细']);
  assert.strictEqual(wb.worksheets[0].getRow(2).getCell(2).value, 100);
  assert.ok(wb.worksheets[1].getRow(2).getCell(1).value instanceof Date);
});

test('degenerate specs still produce a file exceljs can open', async () => {
  for (const [label, raw] of [
    ['empty spec', {}],
    ['no sheets', { sheets: [] }],
    ['null', null],
    ['only rows', { sheets: [{ name: 'S', rows: [['a', 1]] }] }],
  ]) {
    const wb = await excel(specBytes(raw));
    assert.ok(wb.worksheets.length >= 1, label);
  }
});
