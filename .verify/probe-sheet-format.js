'use strict';
/**
 * Does the format code reach the client?
 *
 * The bug was reported from a screenshot: the preview showed 46082 where the
 * file held 2026-03-01. The stored value was never wrong — the format was
 * missing from the wire, so the client had nothing to render from.
 *
 * This checks the server half. `probe-sheet-render.js` checks the other half:
 * that the browser module actually draws it.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { normalizeSpec, writeSpec } = require(path.join(ROOT, 'lib', 'workbook'));
const { sheetPreview } = require(path.join(ROOT, 'lib', 'server'));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

const { spec } = normalizeSpec({
  title: '销售汇总',
  sheets: [{
    name: '订单明细',
    columns: [
      { header: '订单号', type: 'text' },
      { header: '签约日', type: 'date' },
      { header: '合同金额', type: 'currency' },
      { header: '税率', type: 'percent' },
      { header: '数量', type: 'integer' },
    ],
    rows: [
      ['SO-1', new Date(Date.UTC(2026, 2, 1)), 1250000, 0.06, 12],
      ['SO-2', new Date(Date.UTC(2026, 1, 19)), 880000, 0.13, 4],
    ],
    totals: { enabled: true },
  }],
});

const p = sheetPreview(writeSpec(spec), '订单明细');
const row2 = p.rows[1];

console.log('1) what the server puts on the wire');
console.log('   values  ->', JSON.stringify(row2));
console.log('   formats ->', JSON.stringify(p.formats[1]));

check('the date is stored as a serial number', typeof row2[1], 'number');
check('the date carries a date format', /[yd]/i.test(p.formats[1][1] || ''), true);
check('money carries a money format', (p.formats[1][2] || '').includes('¥'), true);
check('percent carries a percent format', (p.formats[1][3] || '').includes('%'), true);
check('plain text carries no format', p.formats[1][0], null);
check('the formats grid matches the values grid', p.formats.length, p.rows.length);

console.log('\n2) the serial resolves to the date that was written');
const d = new Date(Date.UTC(1899, 11, 30) + Math.round(row2[1] * 86400000));
check('round trip through the epoch', d.toISOString().slice(0, 10), '2026-03-01');

console.log('\n3) the totals row keeps its formats too');
check('the totals row exists', p.rows.length, 4);
check('its label sits in column A', p.rows[3][0], '合计');
check('the money total carries a format', /[0#]/.test(p.formats[3][2] || ''), true);
check('the 税率 column still has no total', p.rows[3][3] === null, true);

console.log(`\nSHEET FORMATS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
