'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fixtureA } = require('./fixtures');
const { readWorkbook, writeZip, readZip } = require('../lib/xlsx');
const { writeWorkbook, writeSimpleSheet, CellBuilder, formatNumber } = require('../lib/xlsx-writer');

// ------------------------------------------------------------------- builder
test('CellBuilder emits the right cell kind for each value type', () => {
  const shared = [];
  const b = new CellBuilder({ shared });

  assert.strictEqual(b.write(42, { ref: 'A1' }), '<c r="A1"><v>42</v></c>');
  assert.strictEqual(b.write(12.5, { ref: 'A1' }), '<c r="A1"><v>12.5</v></c>');
  assert.strictEqual(b.write(true, { ref: 'A1' }), '<c r="A1" t="b"><v>1</v></c>');
  // Strings are interned: same text, same index, emitted once.
  const first = b.write('你好', { ref: 'A1' });
  const second = b.write('你好', { ref: 'A2' });
  assert.strictEqual(first, '<c r="A1" t="s"><v>0</v></c>');
  assert.strictEqual(second, '<c r="A2" t="s"><v>0</v></c>');
  assert.deepStrictEqual(shared, ['你好']);
  // Empty renders as an empty cell so styling still applies.
  assert.strictEqual(b.write('', { ref: 'A1', styleIndex: 3 }), '<c r="A1" s="3"/>');
  assert.strictEqual(b.write(null, { ref: 'A1' }), '<c r="A1"/>');
  // A formula with a cached value.
  assert.strictEqual(b.write({ formula: 'A1+1', cached: 3 }, { ref: 'B1' }), '<c r="B1"><f>A1+1</f><v>3</v></c>');
  // Errors keep their spreadsheet type.
  assert.strictEqual(b.write({ error: '#N/A' }, { ref: 'C1' }), '<c r="C1" t="e"><v>#N/A</v></c>');
  // Dates become serial numbers.
  const serial = b.write(new Date(Date.UTC(2026, 0, 1)), { ref: 'D1' });
  assert.match(serial, /<v>46023\./);
});

test('CellBuilder escapes XML metacharacters in text values', () => {
  const b = new CellBuilder({ shared: [] });
  // Escaping happens at serialization time, so the raw string stays intact.
  const xml = b.write('<a>&"b"</a>', { ref: 'A1' });
  assert.strictEqual(xml, '<c r="A1" t="s"><v>0</v></c>');
  const { escapeXml, unescapeXml } = require('../lib/xlsx');
  assert.strictEqual(escapeXml('<a>&"b"</a>'), '&lt;a&gt;&amp;&quot;b&quot;&lt;/a&gt;');
  assert.strictEqual(unescapeXml(escapeXml('线&<>"\'报')), '线&<>"\'报');
});

test('formatNumber keeps integers exact and trims float noise', () => {
  assert.strictEqual(formatNumber(3), '3');
  assert.strictEqual(formatNumber(-0), '0');
  assert.strictEqual(formatNumber(0.1 + 0.2), '0.3');
  assert.strictEqual(formatNumber(1234567.890123), '1234567.890123');
});

// -------------------------------------------------------- scratch workbooks
test('round-trips a from-scratch workbook through the reader', () => {
  const buf = writeSimpleSheet({
    sheetName: '数据',
    rows: [['名称', '数量'], ['甲', 1], ['乙', 2.5]],
  });
  const wb = readWorkbook(buf);
  assert.strictEqual(wb.sheets.length, 1);
  assert.strictEqual(wb.sheets[0].name, '数据');
  assert.strictEqual(wb.sheets[0].cells.find((c) => c.ref === 'A1').value, '名称');
  assert.strictEqual(wb.sheets[0].cells.find((c) => c.ref === 'B3').value, 2.5);
});

test('writes multiple sheets with correct indices and relationships', () => {
  const buf = writeWorkbook({
    sheets: [
      { name: '一', cells: [{ ref: 'A1', value: 'x' }] },
      { name: '二', cells: [{ ref: 'A1', value: 'y' }] },
      { name: '三', state: 'hidden', cells: [{ ref: 'A1', value: 'z' }] },
    ],
  });
  const wb = readWorkbook(buf);
  assert.deepStrictEqual(wb.sheets.map((s) => s.name), ['一', '二', '三']);
  assert.deepStrictEqual(wb.sheets.map((s) => s.state), ['visible', 'visible', 'hidden']);
  assert.deepStrictEqual(wb.sheets.map((s) => s.cells[0].value), ['x', 'y', 'z']);
  // Sheet order must follow rId order, not part numbering.
  assert.deepStrictEqual(wb.sheets.map((s) => s.path), [
    'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml',
  ]);
});

// ------------------------------------------------------------- template mode
test('writing into a template inherits styles and keeps indices valid', () => {
  const template = fixtureA();
  const tw = readWorkbook(template);
  const tSheet = tw.sheets[0];

  // Copy the template's rows, then append generated rows using the template's
  // own style indices — the core of "generate into a template".
  const cells = tSheet.cells.map((c) => ({
    ref: c.ref, col: c.col, row: c.row, value: c.value, styleIndex: c.styleIndex,
  }));
  cells.push({ ref: 'A7', col: 1, row: 7, value: '新生成的公司', styleIndex: 0 });
  cells.push({ ref: 'B7', col: 2, row: 7, value: 999.5, styleIndex: 2 });   // ¥#,##0.00
  cells.push({ ref: 'D7', col: 4, row: 7, value: '已完成', styleIndex: 4 }); // @ text
  cells.push({ ref: 'A8', col: 1, row: 8, value: '<尖&括号>', styleIndex: 1 });

  const out = writeWorkbook({
    templateBuffer: template,
    sheets: [{ name: tSheet.name, cells, cols: tSheet.cols, merges: tSheet.merges, freeze: { rows: 1 } }],
    // Seeding with the template's table keeps row-1 string indices stable.
    shared: tw.sharedStrings,
  });

  const wb = readWorkbook(out);
  const sheet = wb.sheets[0];
  const at = (ref) => sheet.cells.find((c) => c.ref === ref);

  // Original content survives.
  assert.strictEqual(at('A1').value, '客户名称');
  assert.strictEqual(at('B1').value, '合同总额');
  assert.strictEqual(at('B2').value, 125000.5);
  assert.strictEqual(at('D3').value, '部分完成');

  // New content lands correctly, including escaped characters.
  assert.strictEqual(at('A7').value, '新生成的公司');
  assert.strictEqual(at('B7').value, 999.5);
  assert.strictEqual(at('D7').value, '已完成');
  assert.strictEqual(at('A8').value, '<尖&括号>');

  // The template's style table came along, so style indices still mean something.
  assert.strictEqual(wb.styles.numFmts[165], '¥#,##0.00');
  assert.strictEqual(at('B7').styleIndex, 2);
  assert.strictEqual(at('A7').styleIndex, 0);
  const { numFmtCodeFor } = require('../lib/xlsx');
  assert.strictEqual(numFmtCodeFor(wb.styles, at('B7').styleIndex), '¥#,##0.00');

  // Number formats for the original rows are untouched.
  assert.strictEqual(numFmtCodeFor(wb.styles, at('B2').styleIndex), '¥#,##0.00');
  assert.strictEqual(numFmtCodeFor(wb.styles, at('C2').styleIndex), 'yyyy"年"m"月"d"日"');

  // Hidden sheet and column metadata are preserved as well.
  assert.strictEqual(wb.sheets.length, 1);
  assert.strictEqual(sheet.cols.find((c) => c.min === 4).hidden, true);
});

test('template output stays a valid package: every part is declared', () => {
  const template = fixtureA();
  const out = writeWorkbook({
    templateBuffer: template,
    sheets: [{ name: 'S', cells: [{ ref: 'A1', value: 'q' }] }],
  });
  const zip = readZip(out);
  const names = [...zip.keys()];

  // styles.xml must be present AND referenced, or formats silently drop.
  assert.ok(names.includes('xl/styles.xml'), 'styles part carried over');
  const rels = zip.get('xl/_rels/workbook.xml.rels').data.toString('utf8');
  assert.match(rels, /Target="styles\.xml"/);
  const ct = zip.get('[Content_Types].xml').data.toString('utf8');
  assert.match(ct, /PartName="\/xl\/styles\.xml"/);
  assert.match(ct, /PartName="\/xl\/sharedStrings\.xml"/);
  assert.match(ct, /PartName="\/xl\/worksheets\/sheet1\.xml"/);
  // Root rels must point at the workbook.
  assert.match(zip.get('_rels/.rels').data.toString('utf8'), /Target="xl\/workbook\.xml"/);
  // No stray worksheet parts left over from the template.
  const sheetParts = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  assert.deepStrictEqual(sheetParts, ['xl/worksheets/sheet1.xml']);
  // workbook.xml sheet count matches the declared parts.
  const wbx = zip.get('xl/workbook.xml').data.toString('utf8');
  assert.strictEqual((wbx.match(/<sheet /g) || []).length, 1);
  assert.strictEqual((rels.match(/worksheet"/g) || []).length, 1);
});

test('sharedStrings part is omitted when nothing is a string', () => {
  const out = writeWorkbook({
    sheets: [{ name: 'N', cells: [{ ref: 'A1', value: 1 }, { ref: 'A2', value: 2 }] }],
  });
  const zip = readZip(out);
  assert.ok(!zip.has('xl/sharedStrings.xml'));
  const ct = zip.get('[Content_Types].xml').data.toString('utf8');
  assert.ok(!ct.includes('sharedStrings'));
  const wb = readWorkbook(out);
  assert.strictEqual(wb.sheets[0].cells.find((c) => c.ref === 'A2').value, 2);
});

// --------------------------------------------------------------------- zip
test('zip writer round-trips through the reader, including unicode names', () => {
  const files = [
    { name: 'a/b/c.xml', data: '<x/>' },
    { name: '中文/文件.txt', data: '内容' },
    { name: 'random.bin', data: Buffer.from([0, 1, 2, 250, 251]) },
  ];
  const zip = readZip(writeZip(files));
  assert.strictEqual(zip.get('a/b/c.xml').data.toString('utf8'), '<x/>');
  assert.strictEqual(zip.get('中文/文件.txt').data.toString('utf8'), '内容');
  assert.deepStrictEqual([...zip.get('random.bin').data], [0, 1, 2, 250, 251]);
});

test('zip writer output is byte-identical across runs', () => {
  const files = [{ name: 'x.txt', data: 'hello'.repeat(50) }, { name: 'y.bin', data: Buffer.alloc(10, 7) }];
  assert.ok(writeZip(files).equals(writeZip(files)));
});

test('zip reader rejects non-zip input', () => {
  assert.throws(() => readZip(Buffer.from('definitely not a zip file at all')), /not a zip/);
});
