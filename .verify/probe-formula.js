'use strict';
/**
 * Does the 合计 SUM formula survive generation and cover the inserted row?
 *
 * Earlier probes looked for the formula at `cell.value.formula`. It actually
 * lives at `cell.formula` (a string), so those probes reported "no formulas"
 * regardless of the truth. Also note renderPlan is async.
 */

const fs = require('node:fs');
const path = require('node:path');
const { readWorkbook } = require('../lib/xlsx');
const { renderPlan } = require('../lib/render');
const { extractTemplateSchema } = require('../lib/schema');
const { buildPlan } = require('../lib/generate');

const ROOT = path.join(__dirname, '..');

async function main() {
  const buf = fs.readFileSync(path.join(ROOT, 'public', 'sample', 'contract.xlsx'));
  const schema = extractTemplateSchema(buf);
  const plan = buildPlan({ schema, prompt: '客户名称：甲公司，合同金额：12万，签约日期：2026年3月1日' });

  // renderPlan is async.
  const { buffer, report } = await renderPlan({ templateBuffer: buf, schema, plan });
  const wb = readWorkbook(buffer);
  const sheet = wb.sheets[0];

  console.log('--- every cell carrying formula= in the generated sheet ---');
  let found = 0;
  for (const c of sheet.cells || []) {
    if (c.formula) { console.log(`  ${c.ref}  formula=${JSON.stringify(c.formula)}  value=${JSON.stringify(c.value)}`); found++; }
  }
  if (!found) console.log('  (none)');

  console.log('\n--- rows 6..8 ---');
  for (let r = 6; r <= 8; r++) {
    const parts = [];
    for (let c = 1; c <= 3; c++) {
      const cell = (sheet.cells || []).find((x) => x.row === r && x.col === c);
      parts.push(`${c}:${cell ? JSON.stringify(cell.formula || cell.value) : '·'}`);
    }
    console.log(`  r${r}  ${parts.join('  ')}`);
  }

  console.log('\n--- report ---');
  console.log('  insertAt=' + report.insertAt + '  shifted=' + report.shifted + '  written=' + report.written);

  console.log('\n--- template footer for comparison ---');
  const tplWb = readWorkbook(buf);
  for (const c of tplWb.sheets[0].cells || []) {
    if (c.formula) console.log(`  ${c.ref}  formula=${JSON.stringify(c.formula)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
