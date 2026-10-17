'use strict';
/**
 * A spec laid out as cells for the xlsx writer: header and data rows, the
 * totals row with real formulas, a style per cell, column widths, and
 * writeSpec on top.
 */

import { cellRef, colName } from '../formats/xlsx.ts';
// STYLE is the writer's: the indices are a contract with its buildStylesXml().
// workbook.ts kept a copy once, to keep the spec layer off the XML layer, but
// it already called the writer, and two tables can drift.
import { STYLE, writeFreshWorkbook } from '../formats/xlsx-writer.ts';
import type {
  StyleIndex,
  ColumnType,
  CellValue,
  ColumnSpec,
  TotalsSpec,
  SheetSpec,
  WorkbookSpec,
  WriteCell,
  SheetForWriter,
} from './spec-types.ts';
import { isBlank, dateToSerial, linkTarget } from './coerce.ts';

/**
 * A style index for a totals cell, given the column it summarises.
 *
 * A total inherits the SIGN and the SCALE of its column but not the cell
 * styling: `¥2,130,000` under a column of `¥1,250,000` reads as one table, while
 * a bare `2,130,000` under it reads as a different number. Only cells whose
 * value is a plain number need this — apply the format of the column, keep the
 * bold/bordered totals styling.
 */
function totalStyleFor(column: ColumnSpec | undefined): StyleIndex {
  const t = column && column.type;
  if (t === 'currency') return STYLE.CURRENCY_TOTAL;
  if (t === 'percent') return STYLE.PERCENT_TOTAL;
  return STYLE.TOTAL;
}

// ------------------------------------------------------------------ totals

/**
 * Where the totals label goes: the first column that is not itself summed.
 * `null` when every column is summed — the sums are the point of the row, so
 * none of them gives way to the word 合计.
 *
 * Shared by the xlsx writer, the CSV/JSON export and the preview. They each
 * had their own rule once, and all three were wrong the same way when column A
 * was summed: the label landed on the next SUMMED column and its total was
 * dropped (or, in the preview, the label was).
 */
export function totalsLabelColumn(totals: TotalsSpec, width: number): number | null {
  for (let i = 0; i < width; i++) if (!totals.sumColumns.includes(i)) return i;
  return null;
}

/** The total of column `i`: finite numbers only, anything else counts as 0. */
export function columnTotal(rows: CellValue[][], i: number): number {
  return rows.reduce<number>((sum, r) => {
    const v = r[i];
    return sum + (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  }, 0);
}

// ------------------------------------------------------------------ sheet

/**
 * Flatten a sheet into the cell list `writeWorkbook` expects.
 *
 * Layout: row 1 is the header, data starts at row 2, and a totals row (when
 * enabled) sits directly under the last data row. The totals cells are real
 * formulas with cached values, so Excel shows the right number immediately and
 * still recalculates if the user edits a row.
 */
export function toSheet(sheet: SheetSpec): SheetForWriter {
  const columns = sheet.columns || [];
  const rows = sheet.rows || [];
  const width = Math.max(1, columns.length);
  const cells: WriteCell[] = [];

  columns.forEach((c, i) => {
    cells.push({
      ref: cellRef(i + 1, 1),
      col: i + 1,
      row: 1,
      value: c.header,
      styleIndex: STYLE.HEADER,
    });
  });

  rows.forEach((row, r) => {
    const rowNum = r + 2;
    for (let i = 0; i < width; i++) {
      const v = row[i];
      if (isBlank(v)) continue;
      const value = v instanceof Date ? dateToSerial(v) : v;
      const link = columns[i]?.type === 'url' ? linkTarget(v) : null;
      const cell: WriteCell = {
        ref: cellRef(i + 1, rowNum),
        col: i + 1,
        row: rowNum,
        value,
        styleIndex: link ? STYLE.LINK : styleFor(columns[i], v),
      };
      if (link) cell.link = link;
      cells.push(cell);
    }
  });

  let totalRow: number | null = null;
  const totals = sheet.totals || { enabled: false, label: '', sumColumns: [] };
  if (totals.enabled && rows.length) {
    totalRow = rows.length + 2;
    const labelCol = totalsLabelColumn(totals, width);
    if (labelCol !== null) {
      cells.push({
        ref: cellRef(labelCol + 1, totalRow),
        col: labelCol + 1,
        row: totalRow,
        value: totals.label || '合计',
        styleIndex: STYLE.HEADER,
      });
    }

    for (const i of totals.sumColumns) {
      const letter = colName(i + 1);
      const first = 2;
      const last = rows.length + 1;
      const formula = `SUM(${letter}${first}:${letter}${last})`;
      cells.push({
        ref: cellRef(i + 1, totalRow),
        col: i + 1,
        row: totalRow,
        value: columnTotal(rows, i),
        formula,
        styleIndex: totalStyleFor(columns[i]),
      });
    }
  }

  const height = Math.max(1, totalRow || rows.length + 1);
  return {
    name: sheet.name,
    cells,
    cols: columnWidths(columns, width, rows, totals),
    freeze: 1,
    dimensions: `A1:${colName(width)}${height}`,
    headerRow: 1,
    totalRow,
  };
}

/**
 * A style index for a value, so numbers align and dates format.
 *
 * Driven by the resolved VALUE, not the declared type: a date column holding an
 * unparseable string has already been blanked by `coerce`, so whatever is left
 * here is a real number or a real Date.
 */
function styleFor(column: ColumnSpec | undefined, value: CellValue): StyleIndex {
  if (value instanceof Date) return STYLE.DATE;
  if (typeof value === 'number') {
    const byType: Partial<Record<ColumnType, StyleIndex>> = {
      currency: STYLE.CURRENCY,
      percent: STYLE.PERCENT,
      integer: STYLE.INTEGER,
      number: STYLE.NUMBER,
    };
    return (column && byType[column.type]) || STYLE.NUMBER;
  }
  return STYLE.DEFAULT;
}

/** Bounds of an automatic width, in characters: Excel's default, and a cap. */
const AUTO_MIN = 10;
const AUTO_MAX = 40;

/**
 * Column widths: declared, or sized from the widest of the header and the cells.
 *
 * The cells count, not just the header. Sizing from the header alone gave a
 * column headed 台标 holding 40-character URLs the same 10 characters as one
 * holding 是/否 — every long value cut off, in the file and (since the preview
 * draws the file's widths) on screen. Values are measured as they will be
 * DISPLAYED (`cellChars`), so 1250000 in a currency column counts as
 * ¥1,250,000.00. Capped at AUTO_MAX: one long note should not make a column
 * wider than the window; the cell still holds all of it.
 */
function columnWidths(
  columns: ColumnSpec[],
  width: number,
  rows: CellValue[][],
  totals: TotalsSpec,
): Array<{ min: number; max: number; width: number }> {
  const out: Array<{ min: number; max: number; width: number }> = [];
  for (let i = 0; i < width; i++) {
    const c = columns[i];
    if (c && c.width) {
      out.push({ min: i + 1, max: i + 1, width: c.width });
      continue;
    }
    // A bold header is a little wider than its characters, hence the larger pad.
    let widest = displayWidth((c && c.header) || '') + 4;
    for (const r of rows) {
      if (widest >= AUTO_MAX) break;
      widest = Math.max(widest, cellChars(r[i], c && c.type) + 2);
    }
    if (totals.enabled && totals.sumColumns.includes(i) && rows.length) {
      widest = Math.max(widest, cellChars(columnTotal(rows, i), c && c.type) + 2);
    }
    out.push({ min: i + 1, max: i + 1, width: Math.max(AUTO_MIN, Math.min(AUTO_MAX, widest)) });
  }
  return out;
}

/**
 * How many characters a value takes once Excel formats it with the style
 * `styleFor` gives it: grouped digits, two decimals unless the column is
 * integer, a ¥ for currency, a % for percent. Text is measured on its first
 * AUTO_MAX * 2 characters, which is enough to know it hits the cap.
 */
function cellChars(v: CellValue | undefined, type: ColumnType | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  if (v instanceof Date) return 10; // yyyy-mm-dd
  if (typeof v === 'boolean') return 5; // TRUE / FALSE
  if (typeof v === 'number') {
    const n = type === 'percent' ? v * 100 : v;
    const digits = Math.abs(n).toFixed(type === 'integer' ? 0 : 2);
    const whole = digits.split('.')[0].length;
    return (
      digits.length +
      Math.floor((whole - 1) / 3) +
      (n < 0 ? 1 : 0) +
      (type === 'currency' || type === 'percent' ? 1 : 0)
    );
  }
  return displayWidth(String(v).slice(0, AUTO_MAX * 2));
}

/** Approximate rendered width of a string, counting CJK as two columns. */
export function displayWidth(s: unknown): number {
  let n = 0;
  for (const ch of String(s))
    n += /[\u1100-\u115f\u2e80-\ua4cf\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return n;
}

export interface SheetsForWriter {
  sheets: SheetForWriter[];
  title: string;
}

/**
 * Turn a spec into a single-sheet-per-file cell layout.
 */
export function toSheets(spec: WorkbookSpec): SheetsForWriter {
  return { sheets: (spec.sheets || []).map(toSheet), title: spec.title || '工作簿' };
}

/**
 * Build the .xlsx bytes for a spec.
 *
 * Uses `writeFreshWorkbook`, not `writeWorkbook`: a spec-built file has no
 * template to inherit `xl/styles.xml` from, so the styles part has to be
 * generated. Without it every date cell shows as a five-digit serial number.
 */
export function writeSpec(spec: WorkbookSpec): Buffer {
  const { sheets, title } = toSheets(spec);
  return writeFreshWorkbook({ sheets, title });
}
