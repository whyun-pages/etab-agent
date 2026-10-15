'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { readCfb, readXls, decodeRk, isCfb } = require('../lib/xls');
const { readAttachment, sniffKind, sheetToMatrix } = require('../lib/attachments');

// ------------------------------------------------------------- fixtures
//
// No binary fixture is checked in: the tests build their .xls bytes here, so
// each case shows exactly which records it exercises. The builders write the
// smallest valid file, not what Excel writes — Excel adds dozens of records
// (fonts, XFs, window settings) that the reader skips anyway.

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

function rec(type, data) {
  const h = Buffer.alloc(4);
  h.writeUInt16LE(type, 0);
  h.writeUInt16LE(data.length, 2);
  return Buffer.concat([h, data]);
}
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const f64 = (n) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
const cell = (r, c, xf = 0) => Buffer.concat([u16(r), u16(c), u16(xf)]);

/** XLUnicodeString body: 16-bit when any char needs it, else compressed. */
function ustr(s, lenBytes = 2) {
  const wide = /[^\x00-\xff]/.test(s);
  const len = lenBytes === 1 ? Buffer.from([s.length]) : u16(s.length);
  return Buffer.concat([len, Buffer.from([wide ? 1 : 0]), Buffer.from(s, wide ? 'utf16le' : 'latin1')]);
}

const bof = (dt) => rec(0x0809, Buffer.concat([u16(0x0600), u16(dt), Buffer.alloc(12)]));
const EOF = rec(0x000a, Buffer.alloc(0));

/**
 * A Workbook stream. `sheets` is [{ name, body: Buffer of cell records }];
 * `sst` is either an array of strings or a ready-made SST(+CONTINUE) buffer.
 */
function biff({ sheets, sst = [] }) {
  const sstRec = Buffer.isBuffer(sst) ? sst
    : rec(0x00fc, Buffer.concat([u32(sst.length), u32(sst.length), ...sst.map((s) => ustr(s))]));
  const bounds = sheets.map((s) => Buffer.concat([u32(0), Buffer.from([0, 0]), ustr(s.name, 1)]));
  const globalsLen = bof(5).length + sstRec.length + bounds.reduce((n, b) => n + 4 + b.length, 0) + EOF.length;
  const subs = sheets.map((s) => Buffer.concat([bof(0x10), s.body, EOF]));
  let pos = globalsLen;
  for (let i = 0; i < bounds.length; i++) { bounds[i].writeUInt32LE(pos, 0); pos += subs[i].length; }
  return Buffer.concat([bof(5), sstRec, ...bounds.map((b) => rec(0x0085, b)), EOF, ...subs]);
}

function dirEntry(name, type, start, size, child = FREESECT) {
  const e = Buffer.alloc(128);
  if (name) {
    e.write(name, 0, 'utf16le');
    e.writeUInt16LE((name.length + 1) * 2, 64);
  }
  e[66] = type;
  e.writeUInt32LE(FREESECT, 68);
  e.writeUInt32LE(FREESECT, 72);
  e.writeUInt32LE(child, 76);
  e.writeUInt32LE(start, 116);
  e.writeUInt32LE(size, 120);
  return e;
}

/**
 * A 512-byte-sector compound file holding one stream. Under 4096 bytes the
 * stream goes into the mini stream, as Excel does for a tiny workbook; at or
 * over it, into regular sectors. Both paths are tested.
 */
function cfb(stream, streamName = 'Workbook') {
  const SS = 512;
  const pad = (b, n) => Buffer.concat([b, Buffer.alloc((n - (b.length % n)) % n)]);
  const fat = new Array(SS / 4).fill(FREESECT);
  fat[0] = 0xfffffffd; // the FAT's own sector
  fat[1] = ENDOFCHAIN; // directory
  const sectors = [null, null];
  const chainOf = (buf) => {
    const first = sectors.length;
    const parts = pad(buf, SS);
    for (let o = 0; o < parts.length; o += SS) sectors.push(parts.subarray(o, o + SS));
    for (let i = first; i < sectors.length; i++) fat[i] = i + 1 < sectors.length ? i + 1 : ENDOFCHAIN;
    return first;
  };

  let rootStart = ENDOFCHAIN, rootSize = 0, miniFatStart = ENDOFCHAIN, streamStart;
  if (stream.length < 4096) {
    const n = Math.ceil(stream.length / 64);
    const mf = new Array(SS / 4).fill(FREESECT);
    for (let i = 0; i < n; i++) mf[i] = i + 1 < n ? i + 1 : ENDOFCHAIN;
    miniFatStart = chainOf(Buffer.concat(mf.map(u32)));
    const mini = pad(stream, 64);
    rootStart = chainOf(mini);
    rootSize = mini.length;
    streamStart = 0;
  } else {
    streamStart = chainOf(stream);
  }

  const dir = Buffer.concat([
    dirEntry('Root Entry', 5, rootStart, rootSize, 1),
    dirEntry(streamName, 2, streamStart, stream.length),
    dirEntry('', 0, 0, 0),
    dirEntry('', 0, 0, 0),
  ]);
  sectors[0] = Buffer.concat(fat.map(u32));
  sectors[1] = dir;

  const h = Buffer.alloc(512);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(h, 0);
  h.writeUInt16LE(0x3e, 0x18);
  h.writeUInt16LE(3, 0x1a);
  h.writeUInt16LE(0xfffe, 0x1c);
  h.writeUInt16LE(9, 0x1e);
  h.writeUInt16LE(6, 0x20);
  h.writeUInt32LE(1, 0x2c);
  h.writeUInt32LE(1, 0x30);
  h.writeUInt32LE(4096, 0x38);
  h.writeUInt32LE(miniFatStart, 0x3c);
  h.writeUInt32LE(miniFatStart === ENDOFCHAIN ? 0 : 1, 0x40);
  h.writeUInt32LE(ENDOFCHAIN, 0x44);
  for (let i = 0; i < 109; i++) h.writeUInt32LE(i === 0 ? 0 : FREESECT, 0x4c + i * 4);
  return Buffer.concat([h, ...sectors]);
}

const rk = (n) => (n << 2) | 0x02; // integer RK

// ---------------------------------------------------------------- tests

test('RK numbers decode as integers, truncated doubles and ×100 variants', () => {
  assert.strictEqual(decodeRk(rk(42)), 42);
  assert.strictEqual(decodeRk(rk(-7)), -7);
  assert.strictEqual(decodeRk(rk(1234) | 0x01), 12.34);
  // 1.5 as a double has a zero low dword, so the top 30 bits carry it whole.
  assert.strictEqual(decodeRk(0x3ff80000), 1.5);
});

test('a small workbook in the mini stream reads into sheets and cells', () => {
  const body = Buffer.concat([
    rec(0x00fd, Buffer.concat([cell(0, 0), u32(0)])),            // LABELSST 姓名
    rec(0x00fd, Buffer.concat([cell(0, 1), u32(1)])),            // LABELSST 金额
    rec(0x00fd, Buffer.concat([cell(1, 0), u32(2)])),
    rec(0x0203, Buffer.concat([cell(1, 1), f64(250.5)])),        // NUMBER
    rec(0x0204, Buffer.concat([cell(2, 0), ustr('老李')])),       // LABEL
    rec(0x027e, Buffer.concat([cell(2, 1), u32(rk(100))])),      // RK
  ]);
  const buf = cfb(biff({ sheets: [{ name: '名单', body }], sst: ['姓名', '金额', '老王'] }));
  assert.ok(isCfb(buf));
  const wb = readXls(buf);
  assert.deepStrictEqual(wb.sheets.map((s) => s.name), ['名单']);
  assert.deepStrictEqual(sheetToMatrix(wb.sheets[0]), [['姓名', '金额'], ['老王', 250.5], ['老李', 100]]);
});

test('a stream over the mini cutoff is read from regular sectors', () => {
  // 500 rows of NUMBER records is ~9 KB: well past the 4096-byte cutoff and
  // across several FAT-chained sectors.
  const body = Buffer.concat(Array.from({ length: 500 }, (_, i) => rec(0x0203, Buffer.concat([cell(i, 0), f64(i * 1.5)]))));
  const stream = biff({ sheets: [{ name: 'S', body }] });
  assert.ok(stream.length > 4096);
  const buf = cfb(stream);
  assert.strictEqual(readCfb(buf).get('Workbook').length, stream.length);
  const m = sheetToMatrix(readXls(buf).sheets[0]);
  assert.strictEqual(m.length, 500);
  assert.strictEqual(m[499][0], 499 * 1.5);
});

test('MULRK, BOOLERR and formula cached results', () => {
  const mulrk = Buffer.concat([u16(0), u16(0), u16(0), u32(rk(1)), u16(0), u32(rk(2)), u16(0), u32(rk(3)), u16(2)]);
  const formula = (r, c, result) => rec(0x0006, Buffer.concat([cell(r, c), result, u16(0), u32(0), u16(0)]));
  const special = (kind, v) => Buffer.from([kind, 0, v, 0, 0, 0, 0xff, 0xff]);
  const body = Buffer.concat([
    rec(0x00bd, mulrk),
    rec(0x0205, Buffer.concat([cell(1, 0), Buffer.from([1, 0])])),     // TRUE
    rec(0x0205, Buffer.concat([cell(1, 1), Buffer.from([0x07, 1])])),  // #DIV/0!
    formula(2, 0, f64(6)),
    formula(2, 1, special(0, 0)),
    rec(0x0207, ustr('合计')),                                         // STRING after FORMULA
    formula(2, 2, special(1, 1)),
  ]);
  const m = sheetToMatrix(readXls(cfb(biff({ sheets: [{ name: 'S', body }] }))).sheets[0]);
  assert.deepStrictEqual(m[0], [1, 2, 3]);
  assert.strictEqual(m[1][0], true);
  // sheetToMatrix drops error objects to null; the error survives on the cell.
  const errCell = readXls(cfb(biff({ sheets: [{ name: 'S', body }] }))).sheets[0].cells.find((c) => c.type === 'e');
  assert.deepStrictEqual(errCell.value, { error: '#DIV/0!' });
  assert.deepStrictEqual(m[2], [6, '合计', true]);
});

test('an SST string split by CONTINUE switches width at the boundary', () => {
  // "ab" compressed in the SST record, then "中文" 16-bit in the CONTINUE —
  // the continuation starts with its own option byte, which is the whole point.
  const sstHead = Buffer.concat([u32(2), u32(2), u16(4), Buffer.from([0]), Buffer.from('ab', 'latin1')]);
  const cont = Buffer.concat([Buffer.from([1]), Buffer.from('中文', 'utf16le'), ustr('次')]);
  const sst = Buffer.concat([rec(0x00fc, sstHead), rec(0x003c, cont)]);
  const body = Buffer.concat([
    rec(0x00fd, Buffer.concat([cell(0, 0), u32(0)])),
    rec(0x00fd, Buffer.concat([cell(0, 1), u32(1)])),
  ]);
  const m = sheetToMatrix(readXls(cfb(biff({ sheets: [{ name: 'S', body }], sst }))).sheets[0]);
  assert.deepStrictEqual(m, [['ab中文', '次']]);
});

test('cells after an embedded chart substream are kept', () => {
  const body = Buffer.concat([
    rec(0x0203, Buffer.concat([cell(0, 0), f64(1)])),
    bof(0x20), rec(0x0203, Buffer.concat([cell(9, 9), f64(99)])), EOF, // chart, nested
    rec(0x0203, Buffer.concat([cell(1, 0), f64(2)])),
  ]);
  const cells = readXls(cfb(biff({ sheets: [{ name: 'S', body }] }))).sheets[0].cells;
  assert.ok(cells.some((c) => c.row === 2 && c.value === 2));
});

test('sniffKind recognises .xls by content, even under a wrong extension', async () => {
  const buf = cfb(biff({ sheets: [{ name: 'S', body: rec(0x0203, Buffer.concat([cell(0, 0), f64(1)])) }] }));
  assert.strictEqual(sniffKind(buf, 'x.xls'), 'xls');
  assert.strictEqual(sniffKind(buf, 'renamed.xlsx'), 'xls');
  // A compound file without a Workbook stream (a .doc) is not an .xls.
  assert.strictEqual(sniffKind(cfb(Buffer.alloc(100), 'WordDocument'), 'a.doc'), 'doc');
  const att = await readAttachment(buf, 'renamed.xlsx');
  assert.strictEqual(att.kind, 'table');
});

test('xls attachment end-to-end: header found below a notes block', async () => {
  // The shape of a typical import template: instructions on top, then a blank
  // row, then the real header and sample rows.
  const strings = ['填写须知', '1、姓名不超过 32 个字符', '姓名（必填）', '手机号/邮箱（必填）', '部门', '老王', '西南大区', '老李', '东北大区'];
  const s = (r, c, i) => rec(0x00fd, Buffer.concat([cell(r, c), u32(i)]));
  const body = Buffer.concat([
    s(0, 0, 0), s(1, 0, 1),
    s(3, 0, 2), s(3, 1, 3), s(3, 2, 4),
    s(4, 0, 5), rec(0x0203, Buffer.concat([cell(4, 1), f64(12111112002)])), s(4, 2, 6),
    s(5, 0, 7), rec(0x0203, Buffer.concat([cell(5, 1), f64(12111112003)])), s(5, 2, 8),
  ]);
  const att = await readAttachment(cfb(biff({ sheets: [{ name: 'Sheet1', body }], sst: strings })), 'member.xls');
  assert.strictEqual(att.kind, 'table');
  assert.deepStrictEqual(att.meta.sheetNames, ['Sheet1']);
  assert.deepStrictEqual(att.header, ['姓名（必填）', '手机号/邮箱（必填）', '部门']);
  assert.deepStrictEqual(att.rows, [['老王', 12111112002, '西南大区'], ['老李', 12111112003, '东北大区']]);
});

test('encrypted and BIFF5 workbooks are reported, not misread', async () => {
  const filepass = Buffer.concat([bof(5), rec(0x002f, Buffer.alloc(6)), EOF]);
  const enc = await readAttachment(cfb(filepass), 'locked.xls');
  assert.strictEqual(enc.kind, 'unknown');
  assert.match(enc.note, /加密/);

  const biff5 = await readAttachment(cfb(Buffer.alloc(64), 'Book'), 'old.xls');
  assert.strictEqual(biff5.kind, 'unknown');
  assert.match(biff5.note, /Excel 95/);
});
