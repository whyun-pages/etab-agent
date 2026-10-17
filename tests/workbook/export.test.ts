'use strict';
/**
 * Tests for exporting a spec (src/workbook/export.ts).
 *
 * What this file guards:
 *   - CSV is something Excel opens correctly: BOM, CRLF, RFC 4180 quoting
 *   - a text cell that Excel would evaluate as a formula is neutralised;
 *     numbers (negative ones included) are left alone
 *   - the totals row in a CSV matches the one in the xlsx
 *   - the same spec exports to the same bytes
 *   - saving never overwrites a file, even when two saves race
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { exportSpec, writeExports, cleanBaseName, ExportError } from '../../src/workbook/export.ts';
import { normalizeSpec } from '../../src/workbook/workbook.ts';

const spec = () => normalizeSpec({
  title: '销售',
  sheets: [
    {
      name: '明细',
      columns: [
        { header: '客户', type: 'text' },
        { header: '金额', type: 'currency' },
        { header: '日期', type: 'date' },
        { header: '已付', type: 'boolean' },
      ],
      rows: [
        ['甲, "大"客户', 100, '2026-01-02', true],
        ['=HYPERLINK("http://x")', -50, null, false],
        ['多行\n备注', 0.5, '2026-03-01', null],
      ],
      totals: { sumColumns: ['金额'] },
    },
    { name: '汇总', columns: [{ header: '项', type: 'text' }], rows: [['a']] },
  ],
}).spec;

const text = (f) => f.bytes.toString('utf8');

test('CSV starts with a BOM, uses CRLF, and quotes what needs quoting', () => {
  const [f] = exportSpec(spec(), { format: 'csv', sheet: '明细' });
  assert.strictEqual(f.name, '销售.csv');
  const s = text(f);
  assert.ok(s.startsWith('\uFEFF客户,金额,日期,已付\r\n'), JSON.stringify(s.slice(0, 40)));
  assert.ok(s.includes('"甲, ""大""客户",100,2026-01-02,TRUE\r\n'), s);
  assert.ok(s.includes('"多行\n备注",0.5,2026-03-01,\r\n'), s);
  assert.ok(s.endsWith('\r\n'));
});

test('a formula-looking text cell gets a leading quote; a negative number does not', () => {
  const s = text(exportSpec(spec(), { format: 'csv', sheet: '明细' })[0]);
  assert.ok(s.includes(`"'=HYPERLINK(""http://x"")",-50,,FALSE`), s);
});

test('the CSV totals row carries the sum the xlsx computes', () => {
  const lines = text(exportSpec(spec(), { format: 'csv', sheet: '明细' })[0]).trim().split('\r\n');
  assert.strictEqual(lines[lines.length - 1], '合计,50.5,,');
});

test('several sheets export as several CSV files, named apart', () => {
  const files = exportSpec(spec(), { format: 'csv' });
  assert.deepStrictEqual(files.map((f) => f.name), ['销售-明细.csv', '销售-汇总.csv']);
});

test('JSON keeps column order, writes dates as YYYY-MM-DD and names the totals', () => {
  const [f] = exportSpec(spec(), { format: 'json' });
  const data = JSON.parse(text(f));
  assert.strictEqual(data.title, '销售');
  assert.deepStrictEqual(Object.keys(data.sheets[0].rows[0]), ['客户', '金额', '日期', '已付']);
  assert.strictEqual(data.sheets[0].rows[0]['日期'], '2026-01-02');
  assert.strictEqual(data.sheets[0].rows[1]['日期'], null);
  assert.deepStrictEqual(data.sheets[0].totals, { label: '合计', sumColumns: ['金额'] });
  assert.strictEqual(data.sheets[1].totals, undefined);
});

test('xlsx of one named sheet is a workbook of that sheet; unnamed is the whole workbook', () => {
  const one = exportSpec(spec(), { format: 'xlsx', sheet: '汇总' })[0];
  const all = exportSpec(spec(), { format: 'xlsx' })[0];
  assert.strictEqual(one.bytes.subarray(0, 2).toString(), 'PK');
  assert.ok(one.bytes.length < all.bytes.length);
});

test('the same spec exports to the same bytes', () => {
  for (const format of ['xlsx', 'csv', 'json']) {
    const a = exportSpec(spec(), { format });
    const b = exportSpec(spec(), { format });
    assert.deepStrictEqual(a.map((f) => f.bytes.toString('base64')), b.map((f) => f.bytes.toString('base64')), format);
  }
});

test('an unknown sheet or format, or no table at all, is refused', () => {
  assert.throws(() => exportSpec(spec(), { format: 'csv', sheet: '没有' }), ExportError);
  assert.throws(() => exportSpec(spec(), { format: 'pdf' }), ExportError);
  assert.throws(() => exportSpec({ title: 'x', sheets: [] }, { format: 'csv' }), ExportError);
});

test('a file name never names a directory and keeps only our extension', () => {
  assert.strictEqual(cleanBaseName('..\\..\\Windows\\evil'), 'evil');
  assert.strictEqual(cleanBaseName('C:/x/报表.csv'), '报表');
  assert.strictEqual(cleanBaseName('a:b*c?'), 'a_b_c_');
  assert.strictEqual(cleanBaseName('  ..  '), '工作簿');
  assert.strictEqual(cleanBaseName('长'.repeat(200)).length, 80);
});

test('writeExports never overwrites, even when saves race', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
  try {
    fs.writeFileSync(path.join(dir, '表.csv'), 'mine');
    const f = { name: '表.csv', bytes: Buffer.from('new'), mime: 'text/csv' };
    const results = await Promise.all([writeExports(dir, [f]), writeExports(dir, [f]), writeExports(dir, [f])]);
    const names = results.flat().map((p) => path.basename(p)).sort();
    assert.deepStrictEqual(names, ['表 (1).csv', '表 (2).csv', '表 (3).csv']);
    assert.strictEqual(fs.readFileSync(path.join(dir, '表.csv'), 'utf8'), 'mine');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeExports creates the directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
  try {
    const dir = path.join(root, 'a', 'b');
    const [p] = await writeExports(dir, [{ name: 'x.json', bytes: Buffer.from('{}'), mime: 'application/json' }]);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), '{}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
