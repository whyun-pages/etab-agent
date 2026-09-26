'use strict';
/**
 * XLSX writer — builds a workbook from scratch, or from a template as base.
 *
 * When a template is supplied we keep its shared strings, styles and theme
 * parts verbatim and only swap the worksheet parts. Style indices then stay
 * valid, which is what lets us drop generated rows into a template's formatted
 * table without losing borders, fonts or number formats.
 */

import { writeZip, readZip } from './zip.ts';
import { escapeXml, colName, cellRef, parseRef } from './xlsx.ts';

export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/**
 * What a caller may hand the writer as a cell value.
 *
 * A reader-produced cell carries its kind on the value object — an error box or
 * a formula with its cached result — so those two object shapes are part of the
 * input type rather than something the writer sniffs for.
 */
interface ErrorInput {
  error: unknown;
}

interface FormulaInput {
  formula: string;
  cached?: unknown;
}

/**
 * Narrow a value to the formula shape.
 *
 * A plain `'formula' in value` check does not narrow an `ErrorInput |
 * FormulaInput` union — `in` only takes effect on union members with an
 * optional property of that name, not on two closed shapes.
 */
function isFormulaInput(v: WriteValue): v is FormulaInput {
  return typeof v === 'object' && v !== null && !(v instanceof Date)
    && 'formula' in v && typeof v.formula === 'string';
}

type WriteValue = string | number | boolean | Date | ErrorInput | FormulaInput | null | undefined;

interface WriteOpts {
  ref?: string;
  styleIndex?: number | null;
  styleAttr?: number | null;
  formula?: string;
}

interface CellBuilderOptions {
  /** mutable shared-string table */
  shared?: string[];
  /** style xf index for every cell */
  styleIndex?: number | null;
  /** dedupe strings through the table */
  reuseShared?: boolean;
}

export class CellBuilder {
  shared: string[];
  styleIndex: number | null;
  reuseShared: boolean;
  _intern: Map<string, number>;

  constructor({ shared = [], styleIndex = null, reuseShared = true }: CellBuilderOptions = {}) {
    this.shared = shared;
    this.styleIndex = styleIndex;
    this.reuseShared = reuseShared;
    this._intern = new Map();
  }

  /** Shared element assembly for the two structured cell kinds. */
  _attrs(opts: WriteOpts): { styleAttr: string; ref: string } {
    const s = opts.styleIndex != null ? opts.styleIndex : this.styleIndex;
    const styleAttr = opts.styleAttr != null ? ` s="${opts.styleAttr}"` : (s != null && s !== 0 ? ` s="${s}"` : '');
    const ref = opts.ref ? ` r="${opts.ref}"` : '';
    return { styleAttr, ref };
  }

  _formulaCell(formula: string, cached: unknown, opts: WriteOpts): string {
    const { styleAttr, ref } = this._attrs(opts);
    const cachedXml = cached == null ? ''
      : `<v>${typeof cached === 'number' ? formatNumber(cached) : escapeXml(cached)}</v>`;
    return `<c${ref}${styleAttr}><f>${escapeXml(formula)}</f>${cachedXml}</c>`;
  }

  _errorCell(error: unknown, opts: WriteOpts): string {
    const { styleAttr, ref } = this._attrs(opts);
    return `<c${ref}${styleAttr} t="e"><v>${escapeXml(error)}</v></c>`;
  }

  /** Convert a JS value into the (attrs, inner) pair for a <c> element. */
  write(value: WriteValue, opts: WriteOpts = {}): string {
    // Normalise input: reader-produced cells carry their kind on the value
    // object (errors, formula+cached), everything else is a plain JS value.
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('error' in value && value.error != null) return this._errorCell(value.error, opts);
      if (isFormulaInput(value)) return this._formulaCell(value.formula, value.cached, opts);
    }

    const s = opts.styleIndex != null ? opts.styleIndex : this.styleIndex;
    const sAttr = opts.styleAttr != null ? opts.styleAttr : null;
    const styleAttr = sAttr != null ? ` s="${sAttr}"` : (s != null && s !== 0 ? ` s="${s}"` : '');
    const ref = opts.ref ? ` r="${opts.ref}"` : '';
    const formula = opts.formula ? `<f>${escapeXml(opts.formula)}</f>` : '';

    if (value === null || value === undefined || value === '') {
      return formula
        ? `<c${ref}${styleAttr}>${formula}</c>`
        // Self-closing: an empty element carrying only a style is valid, and the
        // skip-if-empty logic above relies on this shape.
        : `<c${ref}${styleAttr}/>`;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return `<c${ref}${styleAttr}>${formula}<v>${formatNumber(value)}</v></c>`;
    }
    if (typeof value === 'boolean') {
      return `<c${ref}${styleAttr} t="b">${formula}<v>${value ? 1 : 0}</v></c>`;
    }
    if (value instanceof Date) {
      // Serial dates: days since 1899-12-30 (Excel's 1900 leap-year quirk).
      const serial = (value.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
      return `<c${ref}${styleAttr}>${formula}<v>${serial.toFixed(6)}</v></c>`;
    }
    if (isFormulaInput(value)) {
      return this._formulaCell(value.formula, value.cached, opts);
    }
    if (typeof value === 'object' && 'error' in value && value.error != null) {
      return this._errorCell(value.error, opts);
    }

    const text = String(value);
    if (this.reuseShared) {
      let idx = this._intern.get(text);
      if (idx === undefined) {
        idx = this.shared.indexOf(text);
        if (idx === -1) { idx = this.shared.length; this.shared.push(text); }
        this._intern.set(text, idx);
      }
      return `<c${ref}${styleAttr} t="s">${formula}<v>${idx}</v></c>`;
    }
    return `<c${ref}${styleAttr} t="inlineStr">${formula}<is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
  }
}

/** Trim float noise while keeping integers exact. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const r = Math.round(n * 1e10) / 1e10;
  return String(r);
}

/**
 * A complete styles part for a workbook built from scratch.
 *
 * Why this has to exist
 * ---------------------
 * `writeWorkbook` only ever emitted `xl/styles.xml` by INHERITING it from a
 * template. That was fine while every workbook was an edit of an existing one —
 * but a spec-built workbook has no template, so every `styleIndex` a caller set
 * pointed at a style table that did not exist. The symptom is quiet and awful:
 * `s="3"` in a date cell, no styles part in the zip, and Excel (or exceljs)
 * showing a raw serial number like 46082 instead of 2026-03-01.
 *
 * The indices below are a fixed contract. `lib/workbook.js` refers to them by
 * number, so they are exported by name rather than left as magic integers.
 *
 *   0  default          — plain text
 *   1  header           — bold, light fill, bottom border
 *   2  number           — #,##0.00
 *   3  date             — yyyy-mm-dd
 *   4  currency         — ¥#,##0.00
 *   5  percent          — 0.00%
 *   6  integer          — #,##0
 *   7  total            — bold, top border, #,##0.00
 *   8  currency total   — bold, top border, ¥#,##0.00
 *   9  percent total    — bold, top border, 0.00%
 *
 * 8 and 9 exist because a totals cell has to keep its column's sign and scale
 * without losing the totals styling: a bare `2,130,000` sitting under a column
 * of `¥1,250,000` reads as a different number, not as the sum of that column.
 *
 * Build the table through `STYLE` so a reader can tell 3 from 7 at a glance.
 */
export const STYLE = {
  DEFAULT: 0,
  HEADER: 1,
  NUMBER: 2,
  DATE: 3,
  CURRENCY: 4,
  PERCENT: 5,
  INTEGER: 6,
  TOTAL: 7,
  CURRENCY_TOTAL: 8,
  PERCENT_TOTAL: 9,
} as const;

/**
 * Custom number formats, indexed from 164 (the first id Excel leaves free for
 * user formats; 0–163 are reserved for the built-in table).
 */
export const NUM_FMT = {
  number: 164,
  date: 165,
  currency: 166,
  percent: 167,
  integer: 168,
  total: 169,
} as const;

const FONT_HEADER = 1;
const FONT_TOTAL = 2;
const FILL_HEADER = 2;

/**
 * The styles part for a fresh workbook.
 * @returns xl/styles.xml
 */
export function buildStylesXml(): string {
  const numFmts =
    `<numFmts count="6">` +
    `<numFmt numFmtId="${NUM_FMT.number}" formatCode="#,##0.00"/>` +
    `<numFmt numFmtId="${NUM_FMT.date}" formatCode="yyyy-mm-dd"/>` +
    `<numFmt numFmtId="${NUM_FMT.currency}" formatCode="¥#,##0.00"/>` +
    `<numFmt numFmtId="${NUM_FMT.percent}" formatCode="0.00%"/>` +
    `<numFmt numFmtId="${NUM_FMT.integer}" formatCode="#,##0"/>` +
    `<numFmt numFmtId="${NUM_FMT.total}" formatCode="#,##0.00"/>` +
    `</numFmts>`;

  // Ordered to match STYLE: index 0..7.
  const xfs = [
    // 0 default
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`,
    // 1 header
    `<xf numFmtId="0" fontId="${FONT_HEADER}" fillId="${FILL_HEADER}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`,
    // 2 number
    `<xf numFmtId="${NUM_FMT.number}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
    // 3 date
    `<xf numFmtId="${NUM_FMT.date}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
    // 4 currency
    `<xf numFmtId="${NUM_FMT.currency}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
    // 5 percent
    `<xf numFmtId="${NUM_FMT.percent}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
    // 6 integer
    `<xf numFmtId="${NUM_FMT.integer}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
    // 7 total
    `<xf numFmtId="${NUM_FMT.total}" fontId="${FONT_TOTAL}" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>`,
    // 8 currency total — same styling, keeps the ¥
    `<xf numFmtId="${NUM_FMT.currency}" fontId="${FONT_TOTAL}" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>`,
    // 9 percent total — same styling, keeps the %
    `<xf numFmtId="${NUM_FMT.percent}" fontId="${FONT_TOTAL}" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>`,
  ].join('');

  return XML_HEADER +
    `<styleSheet xmlns="${NS_MAIN}">` +
    numFmts +
    // 0 = normal, 1 = bold, 2 = bold (totals). A theme-less palette keeps the
    // file self-contained; there is no theme1.xml to reference.
    `<fonts count="3">` +
    `<font><sz val="11"/><name val="等线"/><color theme="1"/></font>` +
    `<font><b/><sz val="11"/><name val="等线"/><color rgb="FF1F3A5F"/></font>` +
    `<font><b/><sz val="11"/><name val="等线"/></font>` +
    `</fonts>` +
    `<fills count="3">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFE8F0F7"/><bgColor indexed="64"/></patternFill></fill>` +
    `</fills>` +
    `<borders count="3">` +
    `<border><left/><right/><top/><bottom/><diagonal/></border>` +
    `<border><left/><right/><top/><bottom style="thin"><color rgb="FFB7CBDD"/></bottom><diagonal/></border>` +
    `<border><left/><right/><top style="thin"><color rgb="FFB7CBDD"/></top><bottom/><diagonal/></border>` +
    `</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${10}">${xfs}</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;
}

/**
 * A cell as the sheet builder consumes it.
 *
 * Either a `ref`, or `col`/`row`; the builder resolves one from the other.
 */
interface SheetCellSpec {
  ref?: string;
  col?: number;
  row?: number;
  value?: WriteValue;
  formula?: string;
  styleIndex?: number | null;
  styleAttr?: number | null;
}

interface SheetRowSpec {
  row: number;
  cells?: SheetCellSpec[];
  height?: number;
}

interface ColSpecOut {
  min: number;
  max: number;
  width?: number | null;
  style?: number | null;
  hidden?: boolean;
}

interface DataValidation {
  type?: string;
  formula1?: string;
  formula2?: string;
  allowBlank?: boolean;
  showError?: boolean;
  sqref: string;
}

interface SheetSpecForWriter {
  name?: string;
  cells?: SheetCellSpec[];
  rows?: SheetRowSpec[];
  cols?: ColSpecOut[];
  merges?: string[];
  freeze?: number | { rows?: number; cols?: number };
  validations?: DataValidation[];
  styleIndex?: number | null;
  reuseShared?: boolean;
  dimensions?: string | null;
  defaultRowHeight?: number;
  state?: string;
}

interface WorkbookSpecForWriter {
  sheets: SheetSpecForWriter[];
  title?: string;
  shared?: string[];
  templateBuffer?: Buffer;
  stylesXml?: string;
}

/**
 * Write a workbook with no template behind it.
 *
 * This is the entry point the spec layer uses: it supplies the styles part that
 * `writeWorkbook` would otherwise have inherited, so number formats and dates
 * survive instead of dangling.
 */
export function writeFreshWorkbook(wb: WorkbookSpecForWriter): Buffer {
  return writeWorkbook({ ...wb, stylesXml: buildStylesXml() });
}

/**
 * Serialize one worksheet.
 */
export function buildSheetXml(sheet: SheetSpecForWriter, shared: string[]): string {
  const builder = new CellBuilder({ shared, styleIndex: sheet.styleIndex ?? null, reuseShared: sheet.reuseShared !== false });

  // Group cells by row, sorted, so output is deterministic.
  const rows = new Map<number, SheetCellSpec[]>();
  const push = (cell: SheetCellSpec) => {
    const parsedRef = cell.ref ? parseRef(cell.ref) : null;
    const rowNum = cell.row ?? (parsedRef ? parsedRef.row : null);
    if (!rowNum) return;
    if (!rows.has(rowNum)) rows.set(rowNum, []);
    rows.get(rowNum)!.push(cell);
  };
  for (const c of sheet.cells || []) push(c);
  for (const r of sheet.rows || []) {
    for (const c of r.cells || []) push({ ...c, row: r.row });
  }

  const rowNums = [...rows.keys()].sort((a, b) => a - b);
  const heightByRow = new Map<number, number>();
  for (const r of sheet.rows || []) if (r.height) heightByRow.set(r.row, r.height);

  let body = '';
  for (const rowNum of rowNums) {
    const cells = rows.get(rowNum)!.slice().sort((a, b) => {
      const pa = a.ref ? parseRef(a.ref) : null;
      const pb = b.ref ? parseRef(b.ref) : null;
      const ca = a.col ?? (pa ? pa.col : 0);
      const cb = b.col ?? (pb ? pb.col : 0);
      return ca - cb;
    });
    // span attribute is optional; Excel recomputes it. Omit for smaller output.
    const h = heightByRow.get(rowNum);
    let inner = '';
    let wrote = false;
    for (const c of cells) {
      const ref = c.ref || cellRef(c.col!, rowNum);
      const xml = builder.write(c.value, {
        ref,
        styleIndex: c.styleIndex,
        styleAttr: c.styleAttr,
        formula: c.formula,
      });
      if (/<c r="[^"]*"(?:\s[^>]*)?\/>$/.test(xml)) continue; // truly empty cell
      inner += xml;
      wrote = true;
    }
    if (!wrote && !h) continue;
    body += `<row r="${rowNum}"${h ? ` ht="${h}" customHeight="1"` : ''}>${inner}</row>`;
  }

  const colsXml = buildCols(sheet.cols);
  const paneXml = buildPane(sheet.freeze);

  return XML_HEADER +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    (sheet.dimensions ? `<dimension ref="${sheet.dimensions}"/>` : '') +
    `<sheetViews><sheetView workbookViewId="0">${paneXml}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="${sheet.defaultRowHeight || 15}"/>` +
    colsXml +
    `<sheetData>${body}</sheetData>` +
    (sheet.merges && sheet.merges.length
      ? `<mergeCells count="${sheet.merges.length}">` + sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('') + `</mergeCells>`
      : '') +
    buildDataValidation(sheet.validations) +
    `</worksheet>`;
}

function buildCols(cols: ColSpecOut[] | undefined): string {
  if (!cols || !cols.length) return '';
  const items = cols.map((c) => {
    const attrs = [
      `min="${c.min}"`, `max="${c.max}"`,
      c.width ? `width="${round(c.width)}" customWidth="1"` : '',
      c.style ? `style="${c.style}"` : '',
      c.hidden ? 'hidden="1"' : '',
    ].filter(Boolean).join(' ');
    return `<col ${attrs}/>`;
  }).join('');
  return `<cols>${items}</cols>`;
}

const round = (n: number): number => Math.round(n * 100) / 100;

function buildPane(freeze: SheetSpecForWriter['freeze']): string {
  if (!freeze) return '';
  const f = typeof freeze === 'number' ? { rows: freeze, cols: 0 } : freeze;
  const topLeft = cellRef((f.cols || 0) + 1, (f.rows || 0) + 1);
  const activePane = f.cols && f.rows ? 'bottomRight' : f.cols ? 'topRight' : 'bottomLeft';
  return `<pane${f.cols ? ` xSplit="${f.cols}"` : ''}${f.rows ? ` ySplit="${f.rows}"` : ''}` +
    ` topLeftCell="${topLeft}" activePane="${activePane}" state="frozen"/>` +
    `<selection pane="${activePane}" activeCell="${topLeft}" sqref="${topLeft}"/>`;
}

function buildDataValidation(validations: DataValidation[] | undefined): string {
  if (!validations || !validations.length) return '';
  const items = validations.map((v) => {
    const f = v.formula1 ? `<formula1>${escapeXml(v.formula1)}</formula1>` : '';
    const f2 = v.formula2 ? `<formula2>${escapeXml(v.formula2)}</formula2>` : '';
    return `<dataValidation type="${v.type || 'list'}"${v.allowBlank ? ' allowBlank="1"' : ''}` +
      `${v.showError === false ? ' showErrorMessage="0"' : ''} sqref="${v.sqref}">${f}${f2}</dataValidation>`;
  }).join('');
  return `<dataValidations count="${validations.length}">${items}</dataValidations>`;
}

/**
 * Assemble the complete package.
 *
 * `templateBuffer` is the original xlsx to inherit non-worksheet parts from;
 * `shared` seeds the shared-string table so a template's own table can be
 * reused.
 */
export function writeWorkbook(wb: WorkbookSpecForWriter): Buffer {
  const shared = wb.shared ? wb.shared.slice() : [];
  const files: Array<{ name: string; data: Buffer | string }> = [];
  const sheets = wb.sheets;

  // Inherit non-worksheet parts (styles, theme, fonts, docProps) from template.
  const inherited = new Map<string, Buffer>();
  if (wb.templateBuffer) {
    const tz = readZip(wb.templateBuffer);
    for (const [name, entry] of tz) {
      const isSheetPart = /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
      const isSharedStrings = name === 'xl/sharedStrings.xml';
      if (isSheetPart || isSharedStrings) continue;
      inherited.set(name, entry.data);
    }
  }

  // A workbook built from scratch has no template to inherit styles from, so
  // the caller may supply one outright. Without this, every styleIndex a caller
  // set silently pointed at a table that was not in the file — and a date cell
  // came back as a bare serial number.
  if (wb.stylesXml && !inherited.has('xl/styles.xml')) {
    inherited.set('xl/styles.xml', Buffer.from(wb.stylesXml, 'utf8'));
  }

  const sheetEntries = sheets.map((s, i) => ({
    name: s.name || `Sheet${i + 1}`,
    file: `sheet${i + 1}.xml`,
    xml: buildSheetXml(s, shared),
    state: s.state || 'visible',
  }));

  files.push({ name: '[Content_Types].xml', data: buildContentTypes(inherited, sheetEntries.length, shared.length) });
  files.push({ name: '_rels/.rels', data: buildRootRels(inherited) });
  files.push({ name: 'xl/workbook.xml', data: buildWorkbookXml(sheetEntries) });
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: buildWorkbookRels(sheetEntries, inherited, shared.length > 0),
  });

  for (const s of sheetEntries) {
    files.push({ name: `xl/worksheets/${s.file}`, data: s.xml });
  }

  if (shared.length) {
    files.push({ name: 'xl/sharedStrings.xml', data: buildSharedStrings(shared) });
  }

  // Carry over remaining inherited parts (styles, theme, docProps...).
  for (const [name, data] of inherited) {
    if (name === '[Content_Types].xml' || name === '_rels/.rels') continue;
    if (name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels') continue;
    files.push({ name, data });
  }

  return writeZip(files);
}

function buildSharedStrings(shared: string[]): string {
  const items = shared.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('');
  return XML_HEADER +
    `<sst xmlns="${NS_MAIN}" count="${shared.length}" uniqueCount="${shared.length}">${items}</sst>`;
}

interface SheetEntry {
  name: string;
  file: string;
  xml: string;
  state: string;
}

function buildWorkbookXml(sheets: SheetEntry[]): string {
  const sheetTags = sheets.map((s, i) =>
    `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}"${s.state !== 'visible' ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`
  ).join('');
  return XML_HEADER +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheets>${sheetTags}</sheets>` +
    `<calcPr calcId="171027" fullCalcOnLoad="1"/>` +
    `</workbook>`;
}

function buildWorkbookRels(sheets: SheetEntry[], inherited: Map<string, Buffer>, hasShared: boolean): string {
  const rels = sheets.map((s, i) =>
    `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/${s.file}"/>`
  );
  let next = sheets.length + 1;
  const extra: string[] = [];
  if (hasShared) {
    extra.push(`<Relationship Id="rId${next++}" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/>`);
  }
  // styles.xml must be referenced or number formats silently vanish.
  const hasStyles = inherited.has('xl/styles.xml');
  if (hasStyles) {
    extra.push(`<Relationship Id="rId${next++}" Type="${NS_REL}/styles" Target="styles.xml"/>`);
  }
  if (inherited.has('xl/theme/theme1.xml')) {
    extra.push(`<Relationship Id="rId${next++}" Type="${NS_REL}/theme" Target="theme/theme1.xml"/>`);
  }
  return XML_HEADER + `<Relationships xmlns="${NS_PKG_REL}">${rels.join('')}${extra.join('')}</Relationships>`;
}

function buildRootRels(inherited: Map<string, Buffer>): string {
  const rels = [`<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>`];
  if (inherited.has('docProps/core.xml')) {
    rels.push(`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`);
  }
  if (inherited.has('docProps/app.xml')) {
    rels.push(`<Relationship Id="rId3" Type="${NS_REL}/extended-properties" Target="docProps/app.xml"/>`);
  }
  return XML_HEADER + `<Relationships xmlns="${NS_PKG_REL}">${rels.join('')}</Relationships>`;
}

function buildContentTypes(inherited: Map<string, Buffer>, sheetCount: number, sharedCount: number): string {
  const overrides: string[] = [];
  for (let i = 1; i <= sheetCount; i++) {
    overrides.push(`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  }
  if (sharedCount > 0) {
    overrides.push(`<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>`);
  }
  if (inherited.has('xl/styles.xml')) {
    overrides.push(`<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`);
  }
  if (inherited.has('xl/theme/theme1.xml')) {
    overrides.push(`<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`);
  }
  if (inherited.has('docProps/core.xml')) {
    overrides.push(`<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`);
  }
  if (inherited.has('docProps/app.xml')) {
    overrides.push(`<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`);
  }
  return XML_HEADER +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    overrides.join('') +
    `</Types>`;
}

interface SimpleSheetOptions {
  sheetName?: string;
  rows?: WriteValue[][];
  cols?: ColSpecOut[];
  freeze?: number | { rows?: number; cols?: number };
  headerStyle?: number;
  bodyStyle?: number;
}

/** Convenience: single-sheet workbook from a 2D array. */
export function writeSimpleSheet({ sheetName = 'Sheet1', rows = [], cols, freeze = 0, headerStyle = 1, bodyStyle = 0 }: SimpleSheetOptions = {}): Buffer {
  const cells: SheetCellSpec[] = [];
  rows.forEach((row, r) => {
    const rowNum = r + 1;
    row.forEach((value, c) => {
      if (value === null || value === undefined || value === '') return;
      cells.push({
        ref: cellRef(c + 1, rowNum),
        col: c + 1, row: rowNum, value,
        styleIndex: rowNum === 1 ? headerStyle : bodyStyle,
      });
    });
  });
  const maxCol = Math.max(1, ...rows.map((r) => r.length));
  return writeWorkbook({
    sheets: [{
      name: sheetName,
      cells,
      cols: cols || [{ min: 1, max: maxCol, width: 18 }],
      freeze: freeze || 0,
      dimensions: `A1:${colName(maxCol)}${Math.max(1, rows.length)}`,
    }],
  });
}
