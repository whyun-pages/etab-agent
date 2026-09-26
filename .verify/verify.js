'use strict';
/**
 * External validation: feed our generated workbooks to exceljs (a mature,
 * independently written xlsx library) and assert it reads back what we wrote.
 * This is the check that our own round-trip tests cannot make.
 *
 * Dev-only. Lives outside the app's runtime dependency graph.
 */
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { writeWorkbook, writeSimpleSheet } = require('../lib/xlsx-writer');
const { readWorkbook } = require('../lib/xlsx');
const { fixtureA } = require('../tests/fixtures');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`  FAIL ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok   ${label}`);
  }
}

async function load(buf, name) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, buf);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  return wb;
}

(async () => {
  // ---------------------------------------------------- 1. scratch workbook
  console.log('\n[1] from-scratch workbook read by exceljs');
  const simple = writeSimpleSheet({
    sheetName: '订单',
    rows: [
      ['客户名称', '合同总额', '订单日期', '备注'],
      ['北京示例科技有限公司', 125000.5, '2026-01-15', '首次合作'],
      ['上海另一家 & <括号>', -8800.25, '2026-03-01', '备注"引号"'],
    ],
  });
  const wb1 = await load(simple, 'simple.xlsx');
  const ws1 = wb1.getWorksheet('订单');
  check('sheet exists', !!ws1, true);
  check('header A1', ws1.getCell('A1').value, '客户名称');
  check('number B2', ws1.getCell('B2').value, 125000.5);
  check('string A3 with entities', ws1.getCell('A3').value, '上海另一家 & <括号>');
  check('negative B3', ws1.getCell('B3').value, -8800.25);
  check('quotes D3', ws1.getCell('D3').value, '备注"引号"');
  check('row count', ws1.rowCount, 3);
  check('column count', ws1.columnCount, 4);

  // ------------------------------------------ 2. template round-trip via exceljs
  console.log('\n[2] generated-into-template workbook read by exceljs');
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

  const tpl = writeWorkbook({
    templateBuffer: template,
    sheets: [{ name: tSheet.name, cells, cols: tSheet.cols, merges: tSheet.merges, freeze: { rows: 1 } }],
    shared: tw.sharedStrings,
  });
  const wb2 = await load(tpl, 'template.xlsx');
  const ws2 = wb2.getWorksheet('订单明细');
  check('sheet name preserved', !!ws2, true);
  check('original header', ws2.getCell('A1').value, '客户名称');
  check('rich-text joined', ws2.getCell('B1').value, '合同总额');
  check('original number', ws2.getCell('B2').value, 125000.5);
  check('inline string joined', ws2.getCell('D3').value, '部分完成');
  check('new string', ws2.getCell('A7').value, '新生成的公司');
  check('new number', ws2.getCell('B7').value, 999.5);
  // exceljs interprets the date-formatted serial into a real Date, which is
  // exactly the signal that the inherited format is intact.
  check('new date serial', ws2.getCell('C7').value instanceof Date && ws2.getCell('C7').value.toISOString().slice(0, 10), '2026-07-01');
  check('new text-format cell', ws2.getCell('D7').value, '已完成');
  check('error cell survives', ws2.getCell('C4').value.error, '#DIV/0!');

  // Style inheritance is the whole point: exceljs must still see the formats.
  const numFmtB7 = ws2.getCell('B7').numFmt;
  const numFmtB2 = ws2.getCell('B2').numFmt;
  const numFmtC7 = ws2.getCell('C7').numFmt;
  check('new cell inherits currency format', numFmtB7, '¥#,##0.00');
  check('original cell keeps currency format', numFmtB2, '¥#,##0.00');
  check('new cell inherits date format', numFmtC7, 'yyyy"年"m"月"d"日"');
  check('header bold via font', ws2.getCell('A1').font && ws2.getCell('A1').font.bold, true);
  check('header fill colour', ws2.getCell('A1').fill && ws2.getCell('A1').fill.fgColor && ws2.getCell('A1').fill.fgColor.argb, 'FF4472C4');
  check('hidden column preserved', ws2.getColumn(4).hidden, true);
  check('column width preserved', Math.round(ws2.getColumn(1).width * 100) / 100, 22.71);
  check('merges preserved', ws2.model.merges, ['A5:D5', 'E1:E1']);

  // ------------------------------------------------- 3. writers match on values
  console.log('\n[3] cross-check: exceljs output re-read by our reader');
  const theirWb = new ExcelJS.Workbook();
  const theirSheet = theirWb.addWorksheet('我方');
  theirSheet.addRow(['字段', '值']);
  theirSheet.addRow(['税率', 0.13]);
  theirSheet.addRow(['厂家', '某公司 & co']);
  const p3 = path.join(OUT, 'exceljs-written.xlsx');
  await theirWb.xlsx.writeFile(p3);
  const mine = readWorkbook(fs.readFileSync(p3));
  const ms = mine.sheets[0];
  const at = (r) => ms.cells.find((c) => c.ref === r);
  check('our reader: A1', at('A1') && at('A1').value, '字段');
  check('our reader: B2', at('B2') && at('B2').value, 0.13);
  check('our reader: B3 entities', at('B3') && at('B3').value, '某公司 & co');
  check('our reader: sheet name', ms.name, '我方');

  console.log(failures === 0 ? '\nALL EXTERNAL CHECKS PASSED' : `\n${failures} EXTERNAL CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
