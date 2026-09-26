'use strict';
/**
 * Hand-built XLSX fixtures that reproduce quirks of real Excel output, so the
 * reader can be validated without Excel installed.
 *
 * Fixture A mimics Excel's streaming writer:
 *   - local header sizes zeroed, real sizes in a trailing data descriptor
 *   - rich text: <is><r><t>..</t></r>...</is> and multi-run shared strings
 *   - cached formula values, styled-but-empty cells, merged cells
 *   - a hidden sheet, an inline-string column, a boolean and an error cell
 *   - ZIP64 extra field present on one entry (as large files have)
 */

const zlib = require('node:zlib');
const { readZip } = require('../lib/zip');
const { readWorkbook } = require('../lib/xlsx');

// ------------------------------------------------------------ raw ZIP builder
const SIG_LOC = 0x04034b50;
const SIG_CEN = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DD = 0x08074b50;
const SIG_LOC64 = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Build a ZIP using streaming style: local sizes = 0, bit 3 set, data descriptor.
 * @param {Array<{name:string, data:string|Buffer, zip64?:boolean, store?:boolean}>} files
 */
function buildStreamingZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw, { level: 6 });
    const useStore = f.store || deflated.length >= raw.length;
    const body = useStore ? raw : deflated;
    const method = useStore ? 0 : 8;

    let extra = Buffer.alloc(0);
    // ZIP64 extra on the local header: forces the reader down that path.
    if (f.zip64) {
      extra = Buffer.alloc(20);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOC, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0x808, 6);   // UTF-8 + data descriptor
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x5000, 10);
    local.writeUInt16LE(0x5a21, 12);
    local.writeUInt32LE(0, 14);      // crc = 0 (streaming)
    local.writeUInt32LE(0, 18);      // comp size = 0
    local.writeUInt32LE(0, 22);      // uncomp size = 0
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(extra.length, 28);

    chunks.push(local, nameBuf, extra, body);

    // Data descriptor: signature + crc + sizes.
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(SIG_DD, 0);
    dd.writeUInt32LE(crc, 4);
    dd.writeUInt32LE(body.length, 8);
    dd.writeUInt32LE(raw.length, 12);
    chunks.push(dd);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0);
    cen.writeUInt16LE(45, 4);
    cen.writeUInt16LE(45, 6);
    cen.writeUInt16LE(0x808, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0x5000, 12);
    cen.writeUInt16LE(0x5a21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);   // authoritative sizes
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + extra.length + body.length + dd.length;
  }

  const cdStart = offset;
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);   // no comment

  return Buffer.concat([...chunks, ...central, eocd]);
}

// ------------------------------------------------------------------ fixture A

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

// Note: sheet order differs from rId order, and rel Target uses a "../" hop.
const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="26110"/><workbookPr/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15840"/></bookViews><sheets><sheet name="订单明细" sheetId="1" r:id="rId1"/><sheet name="隐藏配置" sheetId="2" state="hidden" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">订单明细!$A$1:$D$5</definedName></definedNames><calcPr calcId="191029"/></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

// Rich text across runs; the second item splits "合同" + "总额" into two runs.
const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="9" uniqueCount="7"><si><t>客户名称</t></si><si><r><rPr><b/><sz val="11"/></rPr><t>合同</t></r><r><t>总额</t></r></si><si><t>订单日期</t></si><si><t>备注</t></si><si><t>北京示例科技有限公司</t></si><si><t>上海另一家（合作）</t></si><si><t xml:space="preserve"> 前后留空格 </t></si></sst>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/><numFmt numFmtId="165" formatCode="¥#,##0.00"/></numFmts><fonts count="3"><font><sz val="11"/><name val="等线"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="等线"/></font><font><i/><sz val="10"/><name val="Consolas"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

// Deliberately omitted r= on row 3; formula with cached value; inline string;
// a styled empty cell; a merge; an error cell; boolean.
const SHEET1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:E6"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="14.25"/><cols><col min="1" max="1" width="22.7109375" customWidth="1"/><col min="2" max="2" width="14.140625" customWidth="1"/><col min="4" max="4" width="30" customWidth="1" hidden="1"/></cols><sheetData><row r="1" spans="1:5" ht="22" customHeight="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c><c r="C1" s="1" t="s"><v>2</v></c><c r="D1" s="1" t="s"><v>3</v></c><c r="E1" s="1"/></row><row r="2" spans="1:5"><c r="A2" t="s"><v>4</v></c><c r="B2" s="2"><v>125000.5</v></c><c r="C2" s="3"><v>46037</v></c><c r="D2" s="4" t="inlineStr"><is><t>是</t></is></c><c r="E2"><v>1</v></c></row><row r="3" spans="1:5"><c r="A3" t="s"><v>5</v></c><c r="B3" s="2"><f>SUM(B2:B2)*2</f><v>250001</v></c><c r="C3" s="3"><f>DATE(2026,3,1)</f><v>46082</v></c><c r="D3" t="inlineStr"><is><r><t>部分</t></r><r><t>完成</t></r></is></c><c r="E3"/></row><row r="4" spans="1:5"><c r="A4" t="s"><v>6</v></c><c r="B4"><v>-8800.25</v></c><c r="C4" t="e"><v>#DIV/0!</v></c><c r="D4" t="b"><v>0</v></c></row><row r="5" spans="1:5"><c r="A5" s="1"/></row><row r="6" spans="1:5"><c r="B6" s="2"><v>0</v></c></row></sheetData><mergeCells count="2"><mergeCell ref="A5:D5"/><mergeCell ref="E1:E1"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;

const SHEET2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>字段</t></is></c><c r="B1" t="inlineStr"><is><t>取值</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>税率</t></is></c><c r="B2"><v>0.13</v></c></row></sheetData></worksheet>`;

function fixtureA() {
  return buildStreamingZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES, zip64: true },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
    { name: 'xl/sharedStrings.xml', data: SHARED_STRINGS },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET1 },
    { name: 'xl/worksheets/sheet2.xml', data: SHEET2, store: true },
  ]);
}

// ------------------------------------------------------------- fixture B: odd
/** Shared string index out of range, missing sharedStrings part, no styles. */
function fixtureB() {
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>`;
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1" t="s"><v>99</v></c><c r="B1" t="s"><v>0</v></c><c><v>7</v></c></row></sheetData></worksheet>`;
  return buildStreamingZip([
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

module.exports = { fixtureA, fixtureB, buildStreamingZip };
