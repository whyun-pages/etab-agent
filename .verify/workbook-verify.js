'use strict';
/**
 * External check: does a spec-built workbook open in a real spread sheet engine?
 *
 * The in-repo tests prove the spec layer agrees with ITSELF. exceljs is a
 * separate implementation — if it reads back the same values, the file is
 * actually valid OOXML and not just something our own reader happens to accept.
 * Every bug this project has found in the zip/XML layer was found this way.
 *
 * Run: node .verify/workbook-verify.js
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const { normalizeSpec, validateSpec, toSheets, specStats, writeSpec } = require(path.join(ROOT, 'lib', 'workbook'));
const { writeSimpleSheet } = require(path.join(ROOT, 'lib', 'xlsx-writer'));

const ExcelJS = require(path.join(__dirname, 'node_modules', 'exceljs'));

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); } else {
    fail++;
    console.log('  FAIL ' + label);
    console.log('         expected: ' + JSON.stringify(expected));
    console.log('         actual:   ' + JSON.stringify(actual));
  }
}

/**
 * Write a spec the way the server will.
 *
 * Symmetric to the real path on purpose: it normalises AND validates before
 * writing, so a spec this file accepts is one the server would accept too.
 */
function buildBuffer(rawSpec) {
  const { spec, notes } = normalizeSpec(rawSpec);
  const v = validateSpec(spec);
  if (!v.ok) throw new Error('spec rejected: ' + v.blocking.join('; '));
  return { buffer: writeSpec(spec), notes, v, spec };
}

async function main() {
  console.log('=== workbook spec → xlsx, judged by exceljs ===\n');

  // ── 1. a plain typed table ────────────────────────────────────────
  console.log('1) typed table round-trips');
  {
    const { buffer, spec } = buildBuffer({
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
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];

    check('the sheet name survives', ws.name, '一月');
    check('header row', [1, 2, 3].map((c) => ws.getRow(1).getCell(c).value), ['客户', '金额', '数量']);
    check('first row', [1, 2, 3].map((c) => ws.getRow(2).getCell(c).value), ['甲公司', 1234.5, 3]);
    check('second row', [1, 2, 3].map((c) => ws.getRow(3).getCell(c).value), ['乙公司', 500, 7]);
    check('numbers stay numbers', typeof ws.getRow(2).getCell(2).value, 'number');
    check('integers stay integers', typeof ws.getRow(2).getCell(3).value, 'number');
    check('the freeze pane is set', Boolean(ws.views && ws.views.length), true);

    console.log('     bytes: ' + buffer.length + '  stats: ' + JSON.stringify(specStats(spec)));
  }

  // ── 2. Chinese numerals, blanks, and the totals row ───────────────
  console.log('\n2) messy input still produces a readable file');
  {
    const { buffer } = buildBuffer({
      title: '合同',
      sheets: [{
        name: '明细',
        columns: [
          { header: '项目' },
          { header: '金额', type: 'currency' },
        ],
        rows: [
          ['首款', '一百二十五万'],
          ['尾款', null],
          ['杂费', '不能解析'],
        ],
        totals: { enabled: true, label: '合计' },
      }],
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];

    check('the Chinese numeral became a number', ws.getRow(2).getCell(2).value, 1250000);
    check('a blank stayed blank', ws.getRow(3).getCell(2).value, null);
    check('the unusable value is blank, not text', ws.getRow(4).getCell(2).value, null);
    check('the totals label is present', ws.getRow(5).getCell(1).value, '合计');

    const sum = ws.getRow(5).getCell(2);
    check('the totals cell carries a formula', Boolean(sum.formula), true);
    // exceljs reports SUM(B2:B4) as {formula, result} — the cached result is
    // what Excel shows before it recalculates.
    check('its cached result is the sum', sum.value.result, 1250000);
  }

  // ── 3. dates become real dates ────────────────────────────────────
  console.log('\n3) a date is a date, not a string');
  {
    const { buffer } = buildBuffer({
      title: '日程',
      sheets: [{
        name: 'S',
        columns: [{ header: '签约日', type: 'date' }, { header: '备注' }],
        rows: [['2026-03-01', 'done'], ['2025-12-31', '']],
      }],
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    const v = ws.getRow(2).getCell(1).value;

    check('the date cell is a Date', v instanceof Date, true);
    check('the day is right', v.toISOString().slice(0, 10), '2026-03-01');
    check('its number format is a date format', /yyyy|mm|dd/.test(String(ws.getRow(2).getCell(1).numFmt || '')), true);
  }

  // ── 4. a multi-sheet workbook ─────────────────────────────────────
  console.log('\n4) more than one sheet');
  {
    const { buffer } = buildBuffer({
      title: '年报',
      sheets: [
        { name: '摘要', columns: [{ header: '项' }, { header: '值', type: 'number' }], rows: [['收入', 100]] },
        { name: '明细', columns: [{ header: '日期', type: 'date' }], rows: [['2026-01-05']] },
      ],
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    check('both sheets are present', wb.worksheets.map((w) => w.name), ['摘要', '明细']);
    check('sheet 1 content', wb.worksheets[0].getRow(2).getCell(2).value, 100);
    check('sheet 2 content is a date',
      wb.worksheets[1].getRow(2).getCell(1).value instanceof Date, true);
  }

  // ── 5. the degenerate cases that must not throw ───────────────────
  console.log('\n5) degenerate specs produce a file, not an exception');
  for (const [label, raw] of [
    ['empty spec', {}],
    ['no sheets', { sheets: [] }],
    ['null', null],
    ['only rows', { sheets: [{ name: 'S', rows: [['a', 1]] }] }],
  ]) {
    try {
      const { buffer } = buildBuffer(raw);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      check(`${label} → openable`, wb.worksheets.length >= 1, true);
    } catch (err) {
      fail++;
      console.log(`  FAIL ${label} → threw: ${err.message}`);
    }
  }

  // ── 6. the file is a real OOXML zip ───────────────────────────────
  console.log('\n6) the container itself');
  {
    const { buffer } = buildBuffer({
      title: 'T',
      sheets: [{ name: 'S', columns: [{ header: 'A' }], rows: [['x']] }],
    });
    check('starts with the zip magic', buffer.subarray(0, 2).toString('binary'), 'PK');
    const asText = buffer.toString('binary');
    check('contains the content-types part', asText.includes('[Content_Types].xml'), true);
    check('contains a worksheet part', /xl\/worksheets\/sheet1\.xml/.test(asText), true);
    check('contains a styles part', asText.includes('xl/styles.xml'), true);
  }

  // ── 6b. number formats actually take effect ──────────────────────
  console.log('\n6b) money, percent and plain numbers carry their formats');
  {
    const { buffer } = buildBuffer({
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
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    const fmt = (c) => String(ws.getRow(2).getCell(c).numFmt || '');

    check('currency has a money format', fmt(1).includes('¥'), true);
    check('percent has a percent format', fmt(2).includes('%'), true);
    check('integer has a thousands format', fmt(3).length > 0, true);
    check('the values are still numbers',
      [1, 2, 3].map((c) => typeof ws.getRow(2).getCell(c).value), ['number', 'number', 'number']);
  }

  // ── 7. writeSimpleSheet still works (no regression) ───────────────
  console.log('\n7) the older simple path is untouched');
  {
    const buffer = writeSimpleSheet({ sheetName: 'S', rows: [['a', 'b'], [1, 2]] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    check('writeSimpleSheet still round-trips', wb.worksheets[0].getRow(2).getCell(1).value, 1);
  }

  console.log(`\nWORKBOOK VERIFY: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack || err);
  process.exit(2);
});

void fs;
