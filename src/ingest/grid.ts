'use strict';
/**
 * A parsed worksheet laid onto the dense grid the table reader wants, sized
 * by the cells that hold values and capped.
 */

import type { ParsedCell, ParsedSheet } from '../formats/xlsx.ts';
import type { CellValue } from './types.ts';

/** Convert a parsed sheet into a dense matrix, using cached formula values. */
export function sheetToMatrix(sheet: ParsedSheet, maxCells = MATRIX_MAX_CELLS): CellValue[][] {
  const { rows, cols } = gridSize(sheet, maxCells);
  const grid: CellValue[][] = Array.from({ length: rows }, () => new Array<CellValue>(cols).fill(null));
  for (const c of sheet.cells || []) {
    if (!c.row || !c.col || c.row > rows || c.col > cols) continue;
    grid[c.row - 1][c.col - 1] = matrixValue(c.value);
  }
  return grid;
}

/**
 * The most cells a sheet is laid out onto. A dense grid is what the table
 * reader wants, and it is allocated up front, so its size has to come from
 * something the file cannot inflate for free.
 */
export const MATRIX_MAX_CELLS = 2_000_000;

/** A parsed cell's value as the grid holds it: a formula by its cached result, an error as empty. */
function matrixValue(raw: ParsedCell['value']): CellValue {
  if (raw && typeof raw === 'object') return 'formula' in raw ? ((raw.cached ?? null) as CellValue) : null;
  return raw;
}

/**
 * How big the grid for `sheet` is: the span of cells that hold a VALUE, then
 * cut to `maxCells` by dropping rows from the bottom.
 *
 * Not the sheet's `maxRow`/`maxCol`. Those count every <row> and <c> element,
 * and an ordinary workbook with a column formatted to the bottom carries
 * `<row r="1048576">`: the grid was a million rows of nothing, allocated
 * before a single value was read. And a 572-byte file with one value in
 * XFD1048576 asked for 1.7e10 cells.
 */
export function gridSize(
  sheet: ParsedSheet,
  maxCells = MATRIX_MAX_CELLS,
): { rows: number; cols: number; droppedRows: number } {
  let spanRows = 0;
  let spanCols = 0;
  for (const c of sheet.cells || []) {
    if (!c.row || !c.col) continue;
    const v = matrixValue(c.value);
    if (v === null || v === '') continue;
    if (c.row > spanRows) spanRows = c.row;
    if (c.col > spanCols) spanCols = c.col;
  }
  const cols = Math.max(spanCols, 1);
  const rows = Math.max(1, Math.min(spanRows, Math.floor(maxCells / cols)));
  return { rows, cols, droppedRows: Math.max(0, spanRows - rows) };
}
