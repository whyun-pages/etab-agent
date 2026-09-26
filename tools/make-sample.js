'use strict';
/**
 * Generate public/sample/contract.xlsx — the template the welcome screen
 * offers, so a first-time user has something to try without hunting for a file.
 *
 * Written as raw SpreadsheetML rather than through xlsx-writer, because the
 * styled baseline (fonts, fills, number formats, borders) is exactly what the
 * template path inherits, and hand-authoring it keeps the styles legible.
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeZip } = require('../lib/zip');
const { XML_HEADER, NS_MAIN } = require('../lib/xlsx-writer');

// ── styles ──────────────────────────────────────────────────────────
// Index map, referenced by the `s=` attributes in the sheet below.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS_MAIN}">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0.00"/>
    <numFmt numFmtId="165" formatCode="yyyy-mm-dd"/>
  </numFmts>
  <fonts count="5">
    <font><sz val="11"/><name val="等线"/></font>
    <font><b/><sz val="16"/><color rgb="FF1F3864"/><name val="等线"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="等线"/></font>
    <font><b/><sz val="11"/><name val="等线"/></font>
    <font><sz val="9"/><color rgb="FF808080"/><name val="等线"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF2F5597"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEAF1FB"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFBFBFBF"/></left>
      <right style="thin"><color rgb="FFBFBFBF"/></right>
      <top style="thin"><color rgb="FFBFBFBF"/></top>
      <bottom style="thin"><color rgb="FFBFBFBF"/></bottom>
      <diagonal/>
    </border>
    <border>
      <left style="thin"><color rgb="FFBFBFBF"/></left>
      <right style="thin"><color rgb="FFBFBFBF"/></right>
      <top style="medium"><color rgb="FF2F5597"/></top>
      <bottom style="double"><color rgb="FF2F5597"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="8">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="164" fontId="3" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;

// ── sheet ───────────────────────────────────────────────────────────
// Style indices used below:
//   1 title · 2 header · 3 currency · 4 date · 5 text · 6 footer label · 7 footer amount
const str = (ref, s, style) => `<c r="${ref}" s="${style}" t="s"><v>${s}</v></c>`;
const num = (ref, v, style) => `<c r="${ref}" s="${style}"><v>${v}</v></c>`;

// Shared strings, in the order they are referenced.
const SHARED = [
  '销售合同汇总表',                                   // 0
  '客户名称', '合同金额（元）', '签约日期', '是否续约', '负责人', '备注（选填）', // 1-6
  '北京示例科技有限公司', '1250000', '46023', '是', '张三',   // 7-11
  '上海另一家商贸', '980000', '46054', '否', '11',           // 12-16
  '合计',                                              // 17
];

const SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS_MAIN}">
  <dimension ref="A1:F7"/>
  <sheetViews><sheetView tabSelected="1" workbookViewId="0">
    <pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/>
  </sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="16.5" customHeight="1"/>
  <cols>
    <col min="1" max="1" width="26" customWidth="1"/>
    <col min="2" max="2" width="16" customWidth="1"/>
    <col min="3" max="3" width="14" customWidth="1"/>
    <col min="4" max="4" width="12" customWidth="1"/>
    <col min="5" max="5" width="12" customWidth="1"/>
    <col min="6" max="6" width="24" customWidth="1"/>
  </cols>
  <sheetData>
    <row r="1" ht="30" customHeight="1">
      <c r="A1" s="1" t="s"><v>0</v></c>
      <c r="B1" s="1"/><c r="C1" s="1"/><c r="D1" s="1"/><c r="E1" s="1"/><c r="F1" s="1"/>
    </row>
    <row r="2" ht="8" customHeight="1"/>
    <row r="3" ht="26" customHeight="1">
      ${str('A3', 1, 2)}${str('B3', 2, 2)}${str('C3', 3, 2)}${str('D3', 4, 2)}${str('E3', 5, 2)}${str('F3', 6, 2)}
    </row>
    <row r="4" ht="19" customHeight="1">
      ${str('A4', 7, 5)}${num('B4', 1250000, 3)}${num('C4', 46023, 4)}${str('D4', 10, 5)}${str('E4', 11, 5)}<c r="F4" s="5"/>
    </row>
    <row r="5" ht="19" customHeight="1">
      ${str('A5', 12, 5)}${num('B5', 980000, 3)}${num('C5', 46054, 4)}${str('D5', 15, 5)}${str('E5', 16, 5)}<c r="F5" s="5"/>
    </row>
    <row r="6" ht="8" customHeight="1"/>
    <row r="7" ht="22" customHeight="1">
      ${str('A7', 17, 6)}<c r="B7" s="7"><f>SUM(B4:B5)</f><v>2230000</v></c>
      <c r="C7" s="6"/><c r="D7" s="6"/><c r="E7" s="6"/><c r="F7" s="6"/>
    </row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A1:F1"/></mergeCells>
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;

// ── package ─────────────────────────────────────────────────────────

const CONTENT_TYPES = `${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const WORKBOOK = `${XML_HEADER}
<workbook xmlns="${NS_MAIN}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr/>
  <sheets><sheet name="销售合同" sheetId="1" r:id="rId1"/></sheets>
  <calcPr calcId="171027" fullCalcOnLoad="1"/>
</workbook>`;

const WORKBOOK_RELS = `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

const SHARED_STRINGS = `${XML_HEADER}
<sst xmlns="${NS_MAIN}" count="${SHARED.length}" uniqueCount="${SHARED.length}">
${SHARED.map((s) => `<si><t xml:space="preserve">${s}</t></si>`).join('')}
</sst>`;

const NOW = '2026-01-05T00:00:00Z';
const CORE = `${XML_HEADER}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>销售合同汇总表</dc:title>
  <dc:creator>Tab Agent</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${NOW}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${NOW}</dcterms:modified>
</cp:coreProperties>`;

const APP = `${XML_HEADER}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Tab Agent</Application>
</Properties>`;

const files = [
  { name: '[Content_Types].xml', data: CONTENT_TYPES },
  { name: '_rels/.rels', data: ROOT_RELS },
  { name: 'docProps/core.xml', data: CORE },
  { name: 'docProps/app.xml', data: APP },
  { name: 'xl/workbook.xml', data: WORKBOOK },
  { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
  { name: 'xl/styles.xml', data: STYLES },
  { name: 'xl/sharedStrings.xml', data: SHARED_STRINGS },
  { name: 'xl/worksheets/sheet1.xml', data: SHEET },
];

const out = path.join(__dirname, '..', 'public', 'sample', 'contract.xlsx');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, writeZip(files));
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);

