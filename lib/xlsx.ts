'use strict';
/**
 * XLSX (SpreadsheetML) read/write on top of the ZIP container.
 *
 * Performance note: the XML is validated against the project's own writer and
 * Excel's output, so we use targeted pattern matching instead of a DOM. Parsing
 * a 5MB sheet as a tree would be orders of magnitude slower and allocation-happy.
 */

import { readZip, writeZip } from './zip.ts';

// Re-exported, not merely imported: `lib/xlsx` has always exposed `readZip` as
// part of its own surface (tests and probes destructure it from here rather
// than from `lib/zip`), so the ESM migration keeps that contract rather than
// making callers reach for a second module.
export { readZip, writeZip };

// ------------------------------------------------------------------ XML utils

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode XML text content, including _xHHHH_ escapes Excel uses for control chars. */
export function unescapeXml(s: string): string {
  if (s.indexOf('&') === -1 && s.indexOf('_x') === -1) return s;
  let out = s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[g] ?? m;
  });
  out = out.replace(/_x([0-9a-fA-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  return out;
}

export function escapeXml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 forbids most control characters; Excel's escape keeps them round-trippable.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => '_x' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') + '_');
}

/** Pull the text of the first <tag>...</tag> inside `xml`. */
export function tagText(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1] : null;
}

/** Read an attribute off the first occurrence of `<tag ... >`. */
export function tagAttr(xml: string, tag: string, attr: string): string | null {
  const m = xml.match(new RegExp('<' + tag + '\\b[^>]*\\b' + attr + '="([^"]*)"'));
  return m ? unescapeXml(m[1]) : null;
}

// -------------------------------------------------------------- column/address

export interface CellRef {
  col: number;
  row: number;
}

/** "BC12" -> { col: 54, row: 12 } (col is 1-based). */
export function parseRef(ref: string): CellRef | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || '');
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: parseInt(m[2], 10) };
}

/** 54 -> "BB" (1-based). */
export function colName(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export const cellRef = (col: number, row: number): string => colName(col) + row;

// ------------------------------------------------------------ shared strings

/** Shared string table -> flat array of strings (rich text flattened). */
export function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const itemRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const inner = m[1];
    if (inner == null) { out.push(''); continue; }
    // A <si> is either <t>text</t> or a run list <r><t>..</t></r>...; concat runs.
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    let t;
    while ((t = tRe.exec(inner))) text += unescapeXml(t[1] ?? '');
    out.push(text);
  }
  return out;
}

// ------------------------------------------------------------------ workbook

/**
 * A cell value as the reader represents it.
 *
 * `e` (error) becomes `{error}` rather than a bare string, so the writer cannot
 * re-emit `#DIV/0!` as a literal label. A formula cell carries `{formula,
 * cached}` when it comes back through the writer's own value path.
 */
export interface FormulaValue {
  formula: string;
  cached?: unknown;
}

export interface ErrorValue {
  error: unknown;
}

type CellValue = string | number | boolean | null | FormulaValue | ErrorValue;

export interface ParsedCell {
  ref: string;
  col: number;
  row: number;
  /** The cell KIND as xlsx stores it: s/n/b/e/d/blank. */
  type: string;
  value: CellValue;
  formula: string | null;
  styleIndex: number;
  hasFormula: boolean;
}

export interface ColSpec {
  min: number | null;
  max: number | null;
  width: number | null;
  hidden: boolean;
  style: number | null;
  customWidth: boolean;
}

export interface SheetXml {
  cells: ParsedCell[];
  merges: string[];
  cols: ColSpec[];
  dimensions: string | null;
  maxRow: number;
  maxCol: number;
}

export interface ParsedSheet {
  name: string;
  sheetId: string | null;
  state: string;
  rId: string | null;
  path: string | null;
  cells?: ParsedCell[];
  merges?: string[];
  cols?: ColSpec[];
  dimensions?: string | null;
  maxCol?: number;
  maxRow?: number;
}

export interface FontRecord {
  bold: boolean;
  italic: boolean;
  size: number | null;
  name: string;
  color: string | null;
}

export interface FillRecord {
  pattern: string;
  fgColor: string | null;
}

export interface XfRecord {
  numFmtId: number;
  fontId: number;
  fillId: number;
  borderId: number;
  applyNumFmt: boolean;
  align: string | null;
  wrapText: boolean;
  /** The raw attribute string, so a caller can re-emit the xf untouched. */
  raw: string;
}

export interface StylesTable {
  numFmts: Record<string, string>;
  cellXfs: XfRecord[];
  fonts: FontRecord[];
  fills: FillRecord[];
  borders: unknown[];
}

export interface Workbook {
  sheets: ParsedSheet[];
  sharedStrings: string[];
  styles: StylesTable;
  definedNames: Record<string, string>;
  zip: Map<string, import('./zip.ts').ZipEntry>;
}

/**
 * Parse an .xlsx/.xlsm Buffer into a workbook model.
 * Deleted/hidden sheets are kept but flagged, because templates often hide helpers.
 */
export function readWorkbook(buf: Buffer): Workbook {
  const zip = readZip(buf);
  const get = (name: string): string | null => {
    const e = zip.get(name);
    return e ? e.data.toString('utf8') : null;
  };

  const workbookXml = get('xl/workbook.xml');
  if (!workbookXml) throw new Error('not an xlsx: xl/workbook.xml missing');

  const sharedStrings = parseSharedStrings(get('xl/sharedStrings.xml'));
  const styles = parseStyles(get('xl/styles.xml'));
  const rels = parseRels(get('xl/_rels/workbook.xml.rels'));

  const sheets: ParsedSheet[] = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let m;
  while ((m = sheetRe.exec(workbookXml))) {
    const attrs = m[1];
    const a = (n: string): string | null => {
      const r = new RegExp('\\b' + n + '="([^"]*)"').exec(attrs);
      return r ? unescapeXml(r[1]) : null;
    };
    const rid = a('r:id');
    const target = rels.get(rid) ?? null;
    sheets.push({
      name: a('name') || 'Sheet',
      sheetId: a('sheetId') || null,
      state: a('state') || 'visible',
      rId: rid,
      // r:id points into workbook.xml.rels; targets are usually "worksheets/sheet1.xml"
      path: target ? normalizeTarget(target, 'xl/workbook.xml') : null,
    });
  }

  for (const sheet of sheets) {
    if (!sheet.path) continue;
    const xml = get(sheet.path) || get(sheet.path.replace(/^xl\//, ''));
    if (!xml) { sheet.cells = []; sheet.merges = []; sheet.dimensions = null; continue; }
    const parsed = parseSheet(xml, sharedStrings, styles);
    sheet.cells = parsed.cells;
    sheet.merges = parsed.merges;
    sheet.cols = parsed.cols;
    sheet.dimensions = parsed.dimensions;
    sheet.maxCol = parsed.maxCol;
    sheet.maxRow = parsed.maxRow;
  }

  return {
    sheets,
    sharedStrings,
    styles,
    definedNames: parseDefinedNames(workbookXml),
    zip,
  };
}

/** Resolve an OPC relationship target against the part that owns the rels. */
export function normalizeTarget(target: string, ownerPath: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const base = ownerPath.replace(/\/[^/]*$/, '');
  const parts = (base + '/' + target).split('/');
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  return stack.join('/');
}

export function parseRels(xml: string | null): Map<string | null, string | null> {
  const map = new Map<string | null, string | null>();
  if (!xml) return map;
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const a = (n: string): string | null => {
      const r = new RegExp('\\b' + n + '="([^"]*)"').exec(attrs);
      return r ? unescapeXml(r[1]) : null;
    };
    map.set(a('Id'), a('Target'));
  }
  return map;
}

function parseDefinedNames(xml: string): Record<string, string> {
  const names: Record<string, string> = {};
  const re = /<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g;
  let m;
  while ((m = re.exec(xml))) {
    const nm = /\bname="([^"]*)"/.exec(m[1]);
    if (nm) names[unescapeXml(nm[1])] = unescapeXml(m[2]);
  }
  return names;
}

// ------------------------------------------------------------------ styles

const BUILTIN_NUM_FMTS: Record<string, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%',
  11: '0.00E+00', 12: '# ?/?', 13: '# ??/??', 14: 'm/d/yyyy', 15: 'd-mmm-yy',
  16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm',
  21: 'h:mm:ss', 22: 'm/d/yyyy h:mm', 37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
};

/**
 * Parse the style table into per-xf records: numFmt code, alignment, font/format
 * hints. We need this to (a) infer a column's semantic type from its number
 * format and (b) inherit formatting when writing into a template row.
 */
export function parseStyles(xml: string | null): StylesTable {
  const result: StylesTable = {
    numFmts: { ...BUILTIN_NUM_FMTS },
    cellXfs: [],
    fonts: [],
    fills: [],
    borders: [],
  };
  if (!xml) return result;

  const numFmtRe = /<numFmt\b([^>]*)\/?>/g;
  let m;
  while ((m = numFmtRe.exec(xml))) {
    const id = /\bnumFmtId="(\d+)"/.exec(m[1]);
    const code = /\bformatCode="([^"]*)"/.exec(m[1]);
    if (id && code) result.numFmts[+id[1]] = unescapeXml(code[1]);
  }

  const fontsBlock = tagText(xml, 'fonts') || '';
  const fontRe = /<font\b[^>]*>([\s\S]*?)<\/font>/g;
  while ((m = fontRe.exec(fontsBlock))) {
    const b = m[1];
    result.fonts.push({
      bold: /<b\b(?![^>]*\bval="0")/.test(b),
      italic: /<i\b(?![^>]*\bval="0")/.test(b),
      size: Number((/<sz\b[^>]*val="([\d.]+)"/.exec(b) || [])[1]) || null,
      name: unescapeXml((/<name\b[^>]*val="([^"]*)"/.exec(b) || [])[1] || ''),
      color: (() => {
        const c = /<color\b[^>]*\brgb="([0-9A-Fa-f]{6,8})"/.exec(b);
        return c ? '#' + c[1].slice(-6) : null;
      })(),
    });
  }

  const fillsBlock = tagText(xml, 'fills') || '';
  const fillRe = /<fill\b[^>]*>([\s\S]*?)<\/fill>/g;
  while ((m = fillRe.exec(fillsBlock))) {
    result.fills.push({
      pattern: (/\bpatternType="([^"]*)"/.exec(m[1]) || [])[1] || 'none',
      fgColor: (() => {
        const c = /<fgColor\b[^>]*\brgb="([0-9A-Fa-f]{6,8})"/.exec(m[1]);
        return c ? '#' + c[1].slice(-6) : null;
      })(),
    });
  }

  const xfBlock = tagText(xml, 'cellXfs') || '';
  const xfRe = /<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g;
  while ((m = xfRe.exec(xfBlock))) {
    const attrs = m[1];
    const inner = m[2] || '';
    const al = /<alignment\b([^>]*)\/?>/.exec(inner);
    result.cellXfs.push({
      numFmtId: Number((/\bnumFmtId="(\d+)"/.exec(attrs) || [])[1] || 0),
      fontId: Number((/\bfontId="(\d+)"/.exec(attrs) || [])[1] || 0),
      fillId: Number((/\bfillId="(\d+)"/.exec(attrs) || [])[1] || 0),
      borderId: Number((/\bborderId="(\d+)"/.exec(attrs) || [])[1] || 0),
      applyNumFmt: /\bapplyNumberFormat="1"/.test(attrs),
      align: al ? (/\bhorizontal="([^"]*)"/.exec(al[1]) || [])[1] || null : null,
      wrapText: al ? /\bwrapText="1"/.test(al[1]) : false,
      raw: attrs,
    });
  }
  return result;
}

/** The number-format code applied to a cell, e.g. "#,##0.00" or "@". */
export function numFmtCodeFor(styles: StylesTable, styleIndex: number | null | undefined): string {
  const xf = styles.cellXfs[styleIndex || 0];
  if (!xf) return 'General';
  return styles.numFmts[xf.numFmtId] || 'General';
}

// ------------------------------------------------------------------ worksheet

/**
 * Parse a worksheet part into a sparse cell list.
 * Each cell: { ref, col, row, type, value, formula, styleIndex }.
 */
export function parseSheet(xml: string, sharedStrings: string[], styles: StylesTable): SheetXml {
  const cells: ParsedCell[] = [];
  let maxRow = 0, maxCol = 0;
  const merges: string[] = [];
  const cols: ColSpec[] = [];

  const colsBlock = tagText(xml, 'cols');
  if (colsBlock) {
    const re = /<col\b([^>]*)\/?>/g;
    let m;
    while ((m = re.exec(colsBlock))) {
      const attrs = m[1];
      const g = (n: string): number | null => {
        const r = new RegExp('\\b' + n + '="([^"]*)"').exec(attrs);
        return r ? Number(r[1]) : null;
      };
      cols.push({
        min: g('min'), max: g('max'),
        width: g('width'), hidden: g('hidden') === 1,
        style: g('style'),
        customWidth: /customWidth="1"/.test(attrs),
      });
    }
  }

  const mergeBlock = tagText(xml, 'mergeCells');
  if (mergeBlock) {
    const re = /<mergeCell\b[^>]*\bref="([^"]*)"/g;
    let m;
    while ((m = re.exec(mergeBlock))) merges.push(m[1]);
  }

  const dim = /<dimension\b[^>]*\bref="([^"]*)"/.exec(xml);
  const dimensions = dim ? dim[1] : null;

  // Rows carry cells; walking rows keeps row numbers reliable even when the
  // r= attribute is omitted on some rows.
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch;
  let implicitRow = 0;
  while ((rowMatch = rowRe.exec(xml))) {
    const rowAttrs = rowMatch[1];
    const rowInner = rowMatch[2] || '';
    const rAttr = /\br="(\d+)"/.exec(rowAttrs);
    const rowNum = rAttr ? Number(rAttr[1]) : implicitRow + 1;
    implicitRow = rowNum;
    let implicitCol = 0;

    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rowInner))) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const refAttr = /\br="([A-Z]+\d+)"/.exec(attrs);
      const parsed = refAttr ? parseRef(refAttr[1]) : null;
      const col = parsed ? parsed.col : implicitCol + 1;
      const row = parsed ? parsed.row : rowNum;
      implicitCol = col;

      const typeAttr = /\bt="([^"]*)"/.exec(attrs);
      const styleAttr = /\bs="(\d+)"/.exec(attrs);
      const type = typeAttr ? typeAttr[1] : null;
      const styleIndex = styleAttr ? Number(styleAttr[1]) : 0;

      const fBlock = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner);
      const formula = fBlock ? unescapeXml(fBlock[1]) : null;

      const vRaw = tagText(inner, 'v');
      const isRaw = tagText(inner, 'is');

      let value: CellValue = null;
      let kind = 'blank';
      if (isRaw != null) {
        // Inline string: concat <t> runs.
        let text = '';
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRe.exec(isRaw))) text += unescapeXml(t[1]);
        value = text; kind = 's';
      } else if (type === 's') {
        value = sharedStrings[Number(vRaw)] ?? '';
        kind = 's';
      } else if (type === 'str') {
        value = unescapeXml(vRaw ?? '');
        kind = 's';
      } else if (type === 'inlineStr') {
        value = ''; kind = 's';
      } else if (type === 'b') {
        value = vRaw === '1'; kind = 'b';
      } else if (type === 'e') {
        // Wrap in an object: a bare string would be re-emitted as text by the
        // writer, silently turning #DIV/0! into a literal label.
        value = { error: unescapeXml(vRaw ?? '') }; kind = 'e';
      } else if (type === 'd') {
        value = unescapeXml(vRaw ?? ''); kind = 'd';
      } else if (vRaw != null) {
        const n = Number(vRaw);
        value = Number.isFinite(n) ? n : unescapeXml(vRaw); kind = 'n';
      }

      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
      cells.push({ ref: cellRef(col, row), col, row, type: kind, value, formula, styleIndex, hasFormula: !!formula });
    }
  }

  // Empty rows carrying only styling still matter for field detection layout.
  const lastRowRe = /<row\b[^>]*\br="(\d+)"/g;
  let lr;
  while ((lr = lastRowRe.exec(xml))) maxRow = Math.max(maxRow, Number(lr[1]));

  return { cells, merges, cols, dimensions, maxRow, maxCol };
}
