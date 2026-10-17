'use strict';
/**
 * Turning bytes into something a grid can draw.
 *
 * Why this lives apart from the server
 * ------------------------------------
 * It reads a workbook back from bytes and hands out values WITH their number
 * formats. That is the whole reason it exists: a date cell stores 46082 and a
 * percent cell stores 0.06, both correct and both looking wrong on screen. The
 * fix belongs at the boundary where bytes become display data, and it needs to
 * be testable without starting an HTTP server.
 *
 * Formats travel on a SECOND GRID, aligned with the values grid, with null
 * wherever the plain default applies. Null rather than the string "General"
 * because "General" is the absence of a format, and shipping it for every cell
 * would be noise the client has to filter — and would hide a genuinely missing
 * format behind a value that renders identically either way.
 */

import { dateToSerial } from './workbook.ts';
import * as xlsx from '../formats/xlsx.ts';

/**
 * The spec types, named locally.
 *
 * `import type` and a namespace import are both compile-time here, so the spec
 * layer's exported types are referenced through inline `import(...)` positions
 * and given short local aliases.
 */
type WorkbookSpec = import('./workbook.ts').WorkbookSpec;
type ColumnType = import('./workbook.ts').ColumnType;
type ParsedSheet = import('../formats/xlsx.ts').ParsedSheet;
type ParsedWorkbook = import('../formats/xlsx.ts').Workbook;

/**
 * The first window, sent with every session and turn response. The rest of the
 * sheet is fetched a page at a time as the user scrolls (`PREVIEW_PAGE_ROWS`,
 * capped at `MAX_PAGE_ROWS` per request), so a turn's response stays small
 * however long the table is.
 */
export const MAX_PREVIEW_ROWS = 40;
export const PREVIEW_PAGE_ROWS = 200;
export const MAX_PAGE_ROWS = 500;
/**
 * Columns are not paged: a grid has to know its width before it can draw a
 * row. Fifty is wider than any table this app builds by conversation; past it
 * the grid says how many it is leaving out.
 */
export const MAX_PREVIEW_COLS = 50;

/** A cell in a preview grid: JSON-ready, so no Date ever travels. */
type PreviewValue = string | number | boolean | null;

/**
 * What the grid draws.
 *
 * `formats` is aligned cell-for-cell with `rows`; null means "the plain
 * default applies", so a cell with no format is sent nothing at all.
 */
interface PreviewGrid {
  name: string;
  rows: PreviewValue[][];
  formats: Array<Array<string | null>>;
  merged: string[];
  cols: Array<{ min: number | null; max: number | null; width: number | null }>;
  /** whether anything — rows or columns — lies outside this window */
  truncated: boolean;
  /** sheet row number (1-based) of `rows[0]` */
  startRow: number;
  /** rows and columns in the whole sheet, so a pager knows when it is done */
  totalRows: number;
  totalCols: number;
}

interface PreviewOptions {
  maxRows?: number;
  maxCols?: number;
  /** first sheet row (1-based) of the window; default 1 */
  startRow?: number;
}

/**
 * A small grid the UI can show as a spreadsheet preview.
 *
 * @param buffer     xlsx bytes
 * @param sheetName  preferred sheet; falls back to the first
 */
export function sheetPreview(buffer: Buffer, sheetName?: string, opts: PreviewOptions = {}): PreviewGrid {
  return sheetWindow(xlsx.readWorkbook(buffer), sheetName, opts);
}

/**
 * One window of an already-parsed workbook: `maxRows` rows from `startRow`.
 *
 * Split from `sheetPreview` so a pager can parse the bytes once and cut many
 * windows from them; the server keeps the parsed workbook for exactly that.
 */
export function sheetWindow(wb: ParsedWorkbook, sheetName?: string, opts: PreviewOptions = {}): PreviewGrid {
  const maxRows = opts.maxRows || MAX_PREVIEW_ROWS;
  const maxCols = opts.maxCols || MAX_PREVIEW_COLS;
  const startRow = Math.max(1, Math.floor(opts.startRow || 1));

  const sheet: ParsedSheet | undefined = wb.sheets.find((s) => s.name === sheetName) || wb.sheets[0];
  if (!sheet) {
    return {
      name: '',
      rows: [],
      formats: [],
      merged: [],
      cols: [],
      truncated: false,
      startRow,
      totalRows: 0,
      totalCols: 0,
    };
  }

  const totalRows = sheet.maxRow || 0;
  const totalCols = sheet.maxCol || 0;
  const lastRow = Math.min(totalRows, startRow + maxRows - 1);
  const rowCount = Math.max(0, lastRow - startRow + 1);
  const colLimit = Math.min(totalCols, maxCols);
  const rows: PreviewValue[][] = Array.from({ length: rowCount }, () => new Array<PreviewValue>(colLimit).fill(null));
  const formats: Array<Array<string | null>> = Array.from({ length: rowCount }, () =>
    new Array<string | null>(colLimit).fill(null),
  );

  for (const c of sheet.cells || []) {
    if (c.row < startRow || c.row > lastRow || c.col > colLimit) continue;
    const raw = c.value;
    // A reader-produced cell carries its kind on the value object. A formula's
    // cached result is what Excel shows before it recalculates, so that is what
    // the preview should show too — not the formula text.
    let v: PreviewValue;
    if (raw && typeof raw === 'object') {
      const cached = 'formula' in raw ? raw.cached : null;
      v = (cached == null ? null : cached) as PreviewValue;
    } else {
      v = raw;
    }
    rows[c.row - startRow][c.col - 1] = v;

    const fmt = xlsx.numFmtCodeFor(wb.styles, c.styleIndex);
    if (fmt && fmt !== 'General') formats[c.row - startRow][c.col - 1] = fmt;
  }

  return {
    name: sheet.name,
    rows,
    formats,
    merged: sheet.merges || [],
    cols: (sheet.cols || []).filter((c) => c.hidden !== true).map((c) => ({ min: c.min, max: c.max, width: c.width })),
    truncated: startRow > 1 || totalRows > lastRow || totalCols > colLimit,
    startRow,
    totalRows,
    totalCols,
  };
}

/**
 * A preview of a spec, with no file involved.
 *
 * Two ways in, one shape out, because the UI draws one grid. The file path is
 * used to confirm what was actually written; this path is used on every turn
 * where a round trip through bytes would be pure overhead.
 *
 * That the two can disagree is the point of having both — and the reason the
 * file path is the one that gets asserted in tests.
 */
export function specPreview(spec: WorkbookSpec | null | undefined): PreviewGrid {
  const sheet = (spec && spec.sheets && spec.sheets[0]) || null;
  if (!sheet)
    return {
      name: '',
      rows: [],
      formats: [],
      merged: [],
      cols: [],
      truncated: false,
      startRow: 1,
      totalRows: 0,
      totalCols: 0,
    };

  const cols = sheet.columns || [];
  const dataRows = sheet.rows || [];

  // Header row, then the data, matching the layout `toSheet` writes. Building
  // this by hand rather than writing the file keeps a preview from costing a
  // full serialisation on every keystroke-driven turn.
  const rows: PreviewValue[][] = [cols.map((c) => c.header)];
  const formats: Array<Array<string | null>> = [cols.map(() => null)];

  for (const r of dataRows) {
    rows.push(cols.map((_, i) => previewValue(r[i])));
    formats.push(cols.map((c) => numFmtForType(c.type)));
  }

  const totals = sheet.totals || { enabled: false, label: '', sumColumns: [] };
  if (totals.enabled && dataRows.length) {
    const labelRow: PreviewValue[] = cols.map(() => null);
    const labelCol = (totals.sumColumns || []).includes(0) ? 1 : 0;
    labelRow[labelCol] = totals.label || '合计';
    const fmtRow: Array<string | null> = cols.map(() => null);
    for (const i of totals.sumColumns || []) {
      const v = dataRows.reduce((sum: number, r) => {
        const cell = r[i];
        return sum + (typeof cell === 'number' && Number.isFinite(cell) ? cell : 0);
      }, 0);
      labelRow[i] = v;
      fmtRow[i] = numFmtForType(cols[i] && cols[i].type);
    }
    rows.push(labelRow);
    formats.push(fmtRow);
  }

  return {
    name: sheet.name || '',
    rows,
    formats,
    merged: [],
    cols: cols.map((c, i) => ({ min: i + 1, max: i + 1, width: c.width || null })),
    // Never cut: every row is built. (This used to compare the data rows with
    // the grid that contains them plus a header, which can never be larger.)
    truncated: false,
    startRow: 1,
    totalRows: rows.length,
    totalCols: cols.length,
  };
}

/** The number format a column type renders with, mirroring src/formats/xlsx-writer.ts. */
export function numFmtForType(type: ColumnType | null | undefined): string | null {
  switch (type) {
    case 'currency':
      return '¥#,##0.00';
    case 'percent':
      return '0.00%';
    case 'integer':
      return '#,##0';
    case 'number':
      return '#,##0.00';
    case 'date':
      return 'yyyy-mm-dd';
    default:
      return null;
  }
}

/**
 * A spec value in the form the grid renders.
 *
 * A Date becomes an Excel SERIAL, matching what `toSheet` writes and what the
 * bytes-then-parse path hands back. Dates must not travel as `Date` objects: the
 * response is JSON, so a Date arrives at the client as an ISO string, and the
 * client — which renders numbers — would either print the string raw or, if it
 * had been handed through a serial conversion, print a garbage number.
 *
 * Measured live: the preview showed `46030` where the date was 2026-01-08. The
 * file was correct the whole time; only this path skipped the conversion.
 */
export function previewValue(v: unknown): PreviewValue {
  if (v === undefined) return null;
  if (v instanceof Date) return dateToSerial(v);
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return null;
}
