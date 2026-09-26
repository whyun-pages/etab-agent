'use strict';
/**
 * Focused probe: how does exceljs represent an error cell, and is our
 * template output preserving C4 at all? Distinguishes "our writer dropped it"
 * from "exceljs models it differently than assumed".
 */
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { writeWorkbook } = require('../lib/xlsx-writer');
const { readWorkbook, readZip } = require('../lib/xlsx');
const { fixtureA } = require('../tests/fixtures');

(async () => {
  const template = fixtureA();
  const tw = readWorkbook(template);
  const tSheet = tw.sheets[0];

  // 1. What does the TEMPLATE itself say C4 is?
  const tC4 = tSheet.cells.find((c) => c.ref === 'C4');
  console.log('template C4 (our reader):', JSON.stringify(tC4));

  // 2. What is the raw XML in the template, and in our output?
  const tzXml = readZip(template).get('xl/worksheets/sheet1.xml').data.toString('utf8');
  console.log('template XML has t="e":', /t="e"/.test(tzXml));

  const cells = tSheet.cells.map((c) => ({
    ref: c.ref, col: c.col, row: c.row, value: c.value, styleIndex: c.styleIndex,
  }));
  const out = writeWorkbook({
    templateBuffer: template,
    sheets: [{ name: tSheet.name, cells, cols: tSheet.cols }],
    shared: tw.sharedStrings,
  });

  const outXml = readZip(out).get('xl/worksheets/sheet1.xml').data.toString('utf8');
  const c4Tag = /<c r="C4".*?(?:\/>|<\/c>)/.exec(outXml);
  console.log('our output C4 element:', c4Tag ? c4Tag[0] : 'NOT FOUND');
  console.log('our output still has t="e":', /t="e"/.test(outXml));

  // 3. Re-read our own output.
  const mine = readWorkbook(out);
  const mC4 = mine.sheets[0].cells.find((c) => c.ref === 'C4');
  console.log('our output C4 (our reader):', JSON.stringify(mC4));

  // 4. What does exceljs make of it?
  const p = path.join(__dirname, 'out', 'probe-c4.xlsx');
  fs.writeFileSync(p, out);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.getWorksheet('订单明细');
  const cell = ws.getCell('C4');
  console.log('exceljs C4 .value:', JSON.stringify(cell.value));
  console.log('exceljs C4 .type:', cell.type);
  console.log('exceljs C4 .text:', JSON.stringify(cell.text));
  console.log('exceljs C4 .error:', JSON.stringify(cell.error));

  // 5. Control: what does exceljs do with its OWN error cell?
  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet('Ctrl');
  ws2.getCell('A1').value = { error: '#DIV/0!' };
  const p2 = path.join(__dirname, 'out', 'probe-ctrl.xlsx');
  await wb2.xlsx.writeFile(p2);
  const rt = new ExcelJS.Workbook();
  await rt.xlsx.readFile(p2);
  const c1 = rt.getWorksheet('Ctrl').getCell('A1');
  console.log('exceljs native error cell .value:', JSON.stringify(c1.value), 'type:', c1.type);
})();
