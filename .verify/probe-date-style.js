'use strict';
/**
 * Why does a date cell not read back as a Date through exceljs?
 *
 * Two possible causes and they need different fixes:
 *   a) the writer emitted a real date serial but no number FORMAT, so exceljs
 *      has no way to know it is a date and hands back the raw number; or
 *   b) the writer emitted something that is not a serial at all.
 *
 * This prints the raw cell after a round trip, plus the styles part, so the
 * answer is evidence rather than a guess.
 */

const path = require('node:path');
const { normalizeSpec, toSheets, dateToSerial } = require(path.join(__dirname, '..', 'lib', 'workbook'));
const { writeWorkbook } = require(path.join(__dirname, '..', 'lib', 'xlsx-writer'));
const ExcelJS = require(path.join(__dirname, 'node_modules', 'exceljs'));

async function main() {
  const { spec } = normalizeSpec({
    title: '日程',
    sheets: [{
      name: 'S',
      columns: [{ header: '签约日', type: 'date' }, { header: '备注' }],
      rows: [['2026-03-01', 'done']],
    }],
  });

  const { sheets } = toSheets(spec);
  console.log('built cells:');
  for (const c of sheets[0].cells) {
    console.log('  ' + c.ref + ' value=' + JSON.stringify(c.value) + ' styleIndex=' + c.styleIndex);
  }
  console.log('expected serial for 2026-03-01: ' + dateToSerial(new Date(Date.UTC(2026, 2, 1))));

  const buf = writeWorkbook({ sheets, title: spec.title });

  // What does the raw XML say about that cell?
  const { readZip } = require(path.join(__dirname, '..', 'lib', 'xlsx'));
  const parts = readZip(buf);
  const sheetXml = parts.get('xl/worksheets/sheet1.xml').toString('utf8');
  const cell = /<c r="A2"[^>]*>[\s\S]*?<\/c>/.exec(sheetXml);
  console.log('\nraw A2 xml: ' + (cell ? cell[0] : '(not found)'));
  const styles = parts.get('xl/styles.xml');
  console.log('styles part present: ' + Boolean(styles));
  if (styles) {
    const s = styles.toString('utf8');
    console.log('numFmts block: ' + (/<numFmts[\s\S]*?<\/numFmts>/.exec(s) || ['(none)'])[0].slice(0, 400));
    console.log('cellXfs block: ' + (/<cellXfs[\s\S]*?<\/cellXfs>/.exec(s) || ['(none)'])[0].slice(0, 600));
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const got = ws.getRow(2).getCell(1);
  console.log('\nexceljs read-back of A2:');
  console.log('  value    = ' + JSON.stringify(got.value));
  console.log('  typeof   = ' + typeof got.value);
  console.log('  numFmt   = ' + JSON.stringify(got.numFmt));
  console.log('  isDate   = ' + (got.value instanceof Date));
}

main().catch((e) => { console.error(e); process.exit(2); });
