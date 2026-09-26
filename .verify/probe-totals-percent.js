'use strict';
// Does the percent-total fix actually hold end to end?
//
// The symptom was seen in a screenshot, so the check has to come back from the
// same place: normalise a spec that has a percent column, write real bytes,
// and read them back with exceljs — not with our own reader.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { normalizeSpec, toSheet, writeSpec } = require(path.join(ROOT, 'lib', 'workbook'));

const ExcelJS = require(path.join(__dirname, 'node_modules', 'exceljs'));

const spec = {
  title: '销售汇总',
  sheets: [{
    name: '订单明细',
    columns: [
      { header: '订单号', type: 'text' },
      { header: '合同金额', type: 'currency' },
      { header: '税率', type: 'percent' },
      { header: '数量', type: 'integer' },
    ],
    rows: [
      ['SO-1', 1250000, 0.06, 12],
      ['SO-2', 860000, 0.06, 8],
      ['SO-3', 880000, 0.13, 4],
    ],
    totals: { enabled: true },
  }],
};

const { spec: norm, notes } = normalizeSpec(spec);
const sheet = norm.sheets[0];
console.log('sumColumns ->', JSON.stringify(sheet.totals.sumColumns), '(expect [1, 3])');

const s = toSheet(sheet);
const sums = s.cells.filter((c) => c.formula).map((c) => ({ ref: c.ref, formula: c.formula, value: c.value }));
console.log('formula cells ->', JSON.stringify(sums));

(async () => {
  const buf = writeSpec(norm);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const totalRow = ws.rowCount;
  const cells = [];
  for (let c = 1; c <= 4; c++) {
    const cell = ws.getRow(totalRow).getCell(c);
    cells.push({ col: c, value: cell.value && cell.value.result !== undefined ? cell.value.result : cell.value, formula: cell.formula || null });
  }
  console.log('totals row from exceljs ->', JSON.stringify(cells));

  const pctCell = cells[2];
  const ok = pctCell.formula === null && pctCell.value === null;
  console.log(ok ? 'PASS: 税率 column has no total' : 'FAIL: 税率 column still totals -> ' + JSON.stringify(pctCell));
  console.log('notes ->', JSON.stringify(notes));
  process.exit(ok ? 0 : 1);
})();
