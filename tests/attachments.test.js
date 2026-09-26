'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { writeZip } = require('../lib/zip');
const { writeSimpleSheet } = require('../lib/xlsx-writer');
const {
  readAttachment, parseCsv, guessDelimiter, decodeText, matrixToTable,
  detectHeaderRow, coerce, columnType, docxText, markupToText, sniffKind,
  imageDimensions, sheetToMatrix, jsonToTable,
} = require('../lib/attachments');

// ---------------------------------------------------------------------- CSV
test('CSV parsing handles quoting, embedded delimiters and newlines', () => {
  const rows = parseCsv('a,b,c\n1,"x,y",3\n');
  assert.deepStrictEqual(rows, [['a', 'b', 'c'], ['1', 'x,y', '3']]);

  const quoted = parseCsv('name,note\n"含,逗号","换\n行"\n');
  assert.deepStrictEqual(quoted, [['name', 'note'], ['含,逗号', '换\n行']]);

  // Doubled quotes unescape to one quote.
  assert.deepStrictEqual(parseCsv('"say ""hi""",2'), [['say "hi"', '2']]);
  // No trailing newline still yields the last record.
  assert.deepStrictEqual(parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
  // CRLF and lone CR both end records.
  assert.deepStrictEqual(parseCsv('a,b\r\nc,d\re,f'), [['a', 'b'], ['c', 'd'], ['e', 'f']]);
  // BOM is stripped.
  assert.deepStrictEqual(parseCsv('\ufeffa,b'), [['a', 'b']]);
});

test('delimiter sniffing picks tab and semicolon correctly', () => {
  assert.strictEqual(guessDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
  assert.strictEqual(guessDelimiter('a;b;c\n1;2;3\n'), ';');
  assert.strictEqual(guessDelimiter('a,b,c\n1,2,3\n'), ',');
  // Delimiters inside quotes must not count.
  assert.strictEqual(guessDelimiter('"a,b";c\n"1,2";3\n'), ';');
});

test('text decoding detects BOM and invalid UTF-8', () => {
  assert.strictEqual(decodeText(Buffer.from('\ufeffhi')).encoding, 'utf-8-bom');
  assert.strictEqual(decodeText(Buffer.from('hi')).text, 'hi');
  // A lone invalid byte should not silently become a replacement char.
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // 中文 in GBK
  const decoded = decodeText(gbk);
  assert.ok(decoded.encoding === 'gbk' || decoded.encoding === 'latin1');
});

// ------------------------------------------------------------------- table
test('header row detection prefers labels over numbers', () => {
  assert.strictEqual(detectHeaderRow([['名称', '数量'], ['甲', 1]]), 0);
  // A title row above the header is skipped.
  assert.strictEqual(detectHeaderRow([['销售报表', ''], ['名称', '数量'], ['甲', 1]]), 1);
  // Pure data has no real header; row 0 is used as a fallback.
  assert.strictEqual(detectHeaderRow([[1, 2], [3, 4]]), 0);
});

test('cell coercion turns obvious numerics and percentages into numbers', () => {
  assert.strictEqual(coerce('1,234.5'), 1234.5);
  assert.strictEqual(coerce('1,234.'), '1,234.');
  assert.strictEqual(coerce('13%'), 0.13);
  assert.strictEqual(coerce('  '), null);
  assert.strictEqual(coerce('abc'), 'abc');
  assert.strictEqual(coerce(7), 7);
  assert.strictEqual(coerce(true), true);
});

test('column typing uses label semantics for currency', () => {
  assert.strictEqual(columnType([1, 2, 3], '数量'), 'integer');
  assert.strictEqual(columnType([1.5, 2.5], '金额'), 'currency');
  assert.strictEqual(columnType([1, 2], '金额'), 'currency');
  assert.strictEqual(columnType(['a', 'b'], '名称'), 'text');
  assert.strictEqual(columnType([0.1, 0.2], '比例'), 'number');
  assert.strictEqual(columnType([true, false], '是否'), 'boolean');
});

test('matrixToTable builds headers, rows and column types', () => {
  const table = matrixToTable([
    ['客户名称', '合同金额', '签约日期'],
    ['甲公司', '1,000', '2026-01-01'],
    ['乙公司', '2,000', '2026-02-01'],
  ]);
  assert.deepStrictEqual(table.header, ['客户名称', '合同金额', '签约日期']);
  assert.strictEqual(table.rows.length, 2);
  assert.strictEqual(table.columns[1].type, 'currency');
  assert.deepStrictEqual(table.columns[1].values, [1000, 2000]);
  assert.strictEqual(table.columns[2].type, 'date');
});

test('empty cells produce stable column lengths', () => {
  // Raw string cells stay strings in rows; typing happens per column.
  const table = matrixToTable([['a', 'b', 'c'], ['1', '', '3']]);
  assert.strictEqual(table.rows[0].length, 3);
  assert.strictEqual(table.rows[0][1], null);
  // The empty cell is excluded from the column's value list.
  assert.deepStrictEqual(table.columns[1].values, []);
});

// ------------------------------------------------------------------- files
test('xlsx attachment is read into tables per sheet', async () => {
  const buf = writeSimpleSheet({
    sheetName: '明细',
    rows: [['项目', '金额'], ['甲', 100], ['乙', 250.5]],
  });
  const att = await readAttachment(buf, 'data.xlsx');
  assert.strictEqual(att.kind, 'table');
  assert.deepStrictEqual(att.meta.sheetNames, ['明细']);
  assert.deepStrictEqual(att.header, ['项目', '金额']);
  assert.strictEqual(att.table.rows.length, 2);
  assert.strictEqual(att.table.columns[1].type, 'currency');
});

test('csv attachment end-to-end', async () => {
  const att = await readAttachment(Buffer.from('名称,数量\n甲,3\n乙,5\n', 'utf8'), 'list.csv');
  assert.strictEqual(att.kind, 'table');
  assert.deepStrictEqual(att.header, ['名称', '数量']);
  assert.deepStrictEqual(att.table.columns[1].values, [3, 5]);
  assert.strictEqual(att.meta.rowCount, 2);
});

test('tsv is parsed with tabs regardless of content', async () => {
  const att = await readAttachment(Buffer.from('a\tb\n1\t2\n', 'utf8'), 'x.tsv');
  assert.deepStrictEqual(att.header, ['a', 'b']);
});

test('json array of objects becomes a table', async () => {
  const json = JSON.stringify([
    { 客户: '甲', 金额: 100 }, { 客户: '乙', 金额: 200 },
  ]);
  const att = await readAttachment(Buffer.from(json, 'utf8'), 'rows.json');
  assert.strictEqual(att.kind, 'table');
  assert.deepStrictEqual(att.header, ['客户', '金额']);
  assert.strictEqual(att.table.rows.length, 2);
});

test('nested json payload is found by searching for the object array', async () => {
  const json = JSON.stringify({ code: 0, data: { list: [{ a: 1 }, { a: 2 }] } });
  const att = await readAttachment(Buffer.from(json, 'utf8'), 'api.json');
  assert.strictEqual(att.kind, 'table');
  assert.deepStrictEqual(att.header, ['a']);
  assert.deepStrictEqual(att.table.rows, [[1], [2]]);
});

test('jsonl is supported', async () => {
  const jsonl = '{"a":1}\n{"a":2}\n';
  const att = await readAttachment(Buffer.from(jsonl, 'utf8'), 'x.jsonl');
  assert.strictEqual(att.kind, 'table');
  assert.deepStrictEqual(att.table.rows, [[1], [2]]);
});

test('invalid json falls back to text rather than throwing', async () => {
  const att = await readAttachment(Buffer.from('{not json at all', 'utf8'), 'broken.json');
  assert.strictEqual(att.kind, 'text');
  assert.match(att.text, /not json/);
});

// -------------------------------------------------------------------- docx
test('docx text and embedded tables are extracted', async () => {
  const doc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>报销说明</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">合计 </w:t></w:r><w:r><w:t>1250 元</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>交通</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
  const buf = writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: doc },
  ]);
  const att = await readAttachment(buf, 'note.docx');
  assert.strictEqual(att.kind, 'text');
  assert.match(att.text, /报销说明/);
  assert.match(att.text, /合计 1250 元/);
  assert.strictEqual(att.meta.embeddedTables, 1);
  assert.deepStrictEqual(att.table.header, ['项目', '金额']);
  // Table rows keep the document's raw text; the column is typed numerically.
  assert.deepStrictEqual(att.table.rows, [['交通', '120']]);
  assert.deepStrictEqual(att.table.columns[1].values, [120]);
  assert.strictEqual(att.table.columns[1].type, 'currency');
});

test('docx detection works from magic bytes even with a wrong extension', async () => {
  const buf = writeZip([
    { name: 'word/document.xml', data: '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>内容</w:t></w:r></w:p></w:body></w:document>' },
  ]);
  const att = await readAttachment(buf, 'mystery.bin');
  assert.strictEqual(att.kind, 'text');
  assert.match(att.text, /内容/);
});

// ------------------------------------------------------------------ images
test('image attachments report dimensions from their headers', async () => {
  // A minimal PNG header with declared 40x30 dimensions.
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(0x0d0a1a0a, 4);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12);
  png.writeUInt32BE(40, 16);
  png.writeUInt32BE(30, 20);

  const att = await readAttachment(png, 'shot.png');
  assert.strictEqual(att.kind, 'image');
  assert.strictEqual(att.meta.width, 40);
  assert.strictEqual(att.meta.height, 30);
  assert.strictEqual(att.meta.mime, 'image/png');
  assert.strictEqual(att.text, null);
});

test('image extractor hook is used when provided', async () => {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(0x0d0a1a0a, 4);
  png.write('IHDR', 12);
  const att = await readAttachment(png, 'invoice.png', {
    imageExtractor: async () => ({ text: '发票号码：12345', table: null }),
  });
  assert.strictEqual(att.text, '发票号码：12345');
});

test('a failing image extractor is recorded, not fatal', async () => {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  const att = await readAttachment(png, 'x.png', {
    imageExtractor: async () => { throw new Error('vision unavailable'); },
  });
  assert.strictEqual(att.kind, 'image');
  assert.match(att.extractError, /vision unavailable/);
});

// -------------------------------------------------------------------- misc
test('sniffKind identifies real types over extensions', () => {
  assert.strictEqual(sniffKind(writeSimpleSheet({ rows: [['a']] }), 'whatever.txt'), 'xlsx');
  assert.strictEqual(sniffKind(Buffer.from('%PDF-1.7\n'), 'x.txt'), 'pdf');
  assert.strictEqual(sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'x.png'), 'jpeg');
});

test('an unknown binary is reported without crashing', async () => {
  const bin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x99]);
  const att = await readAttachment(bin, 'blob.dat');
  assert.strictEqual(att.kind, 'unknown');
  assert.ok(att.note);
});

test('pdf is explicitly reported as unsupported', async () => {
  const att = await readAttachment(Buffer.from('%PDF-1.4\n%fake'), 'doc.pdf');
  assert.strictEqual(att.kind, 'unknown');
  assert.match(att.note, /PDF/);
});

test('html attachment is stripped to readable text', async () => {
  const html = '<html><body><h1>标题</h1><p>第一段 &amp; 更多</p><script>var x=1;</script><table><tr><td>甲</td><td>乙</td></tr></table></body></html>';
  const att = await readAttachment(Buffer.from(html, 'utf8'), 'page.html');
  assert.strictEqual(att.kind, 'text');
  assert.match(att.text, /标题/);
  assert.match(att.text, /第一段 & 更多/);
  assert.ok(!att.text.includes('var x'));
  assert.match(att.text, /甲\t乙/);
});

test('sheetToMatrix lays cells onto a dense grid using cached values', () => {
  const matrix = sheetToMatrix({
    maxRow: 2, maxCol: 3,
    cells: [
      { row: 1, col: 1, value: 'a' },
      { row: 1, col: 3, value: 'c' },
      { row: 2, col: 2, value: 5 },
      { row: 2, col: 3, value: { formula: 'B2*2', cached: 10 } },
      { row: 1, col: 2, value: { error: '#N/A' } },
    ],
  });
  assert.deepStrictEqual(matrix, [['a', null, 'c'], [null, 5, 10]]);
});

test('markupToText keeps block structure', () => {
  const out = markupToText('<div>一</div><div>二</div><br>三');
  assert.strictEqual(out, '一\n二\n三');
});

test('a workbook with several sheets can select a sheet explicitly', async () => {
  const { writeWorkbook } = require('../lib/xlsx-writer');
  const buf = writeWorkbook({
    sheets: [
      { name: '第一', cells: [{ ref: 'A1', value: '甲' }] },
      { name: '第二', cells: [{ ref: 'A1', value: '乙' }, { ref: 'B1', value: '丙' }] },
    ],
  });
  const att = await readAttachment(buf, 'multi.xlsx', { sheet: '第二' });
  assert.deepStrictEqual(att.header, ['乙', '丙']);
});
