'use strict';
/**
 * The workbook spec as the rest of the tree types against it — columns,
 * sheets, totals, the notes normalisation leaves — and its limits.
 */

import type { STYLE } from '../formats/xlsx-writer.ts';

/** A style index understood by src/formats/xlsx-writer.ts. */
export type StyleIndex = (typeof STYLE)[keyof typeof STYLE];

/** Column types this module understands. */
export const TYPES = ['text', 'number', 'integer', 'currency', 'percent', 'date', 'boolean', 'url'] as const;

/** One of the recognised column types. */
export type ColumnType = (typeof TYPES)[number];

/** What a cell may hold after coercion. */
export type CellValue = string | number | boolean | Date | null;

/** A normalised column. */
export interface ColumnSpec {
  key: string;
  header: string;
  type: ColumnType;
  format: string | null;
  width: number | null;
}

/** A normalised totals row. */
export interface TotalsSpec {
  enabled: boolean;
  label: string;
  /** Resolved column INDICES, so writer and preview agree without re-resolving. */
  sumColumns: number[];
}

/** A normalised sheet. */
export interface SheetSpec {
  name: string;
  columns: ColumnSpec[];
  rows: CellValue[][];
  totals: TotalsSpec;
  dropped: number;
  sheetIndex: number;
}

/** A normalised workbook spec. */
export interface WorkbookSpec {
  title: string;
  sheets: SheetSpec[];
}

/** One note produced during normalisation. */
export interface SpecNote {
  level: string;
  message: string;
}

/** The raw, un-normalised spec as it arrives from a model. */
export interface RawSpec {
  title?: unknown;
  name?: unknown;
  sheets?: unknown;
  rows?: unknown;
  columns?: unknown;
  totals?: unknown;
}

export interface NormalizeResult {
  spec: WorkbookSpec;
  notes: SpecNote[];
}

export interface ValidateResult {
  ok: boolean;
  blocking: string[];
  warnings: string[];
}

export interface SpecStats {
  sheets: number;
  rows: number;
  columns: number;
}

/** A cell as `writeWorkbook` consumes it. */
export interface WriteCell {
  ref: string;
  col: number;
  row: number;
  value: CellValue | number;
  formula?: string;
  /** hyperlink target, for a url cell whose text is a link worth following */
  link?: string;
  styleIndex: StyleIndex;
}

export interface SheetForWriter {
  name: string;
  cells: WriteCell[];
  cols: Array<{ min: number; max: number; width: number }>;
  freeze: number;
  dimensions: string;
  headerRow: number;
  totalRow: number | null;
}

/** Recognised spellings of the type names themselves, in Chinese. */
export const TYPE_LABELS: Record<ColumnType, string> = {
  text: '文本',
  number: '数字',
  integer: '整数',
  currency: '金额',
  percent: '百分比',
  date: '日期',
  boolean: '是否',
  url: '链接',
};

export const MAX_SHEETS = 12;
export const MAX_COLUMNS = 60;
export const MAX_ROWS = 5000;
export const MAX_CELL_CHARS = 20000;
export const MAX_NAME_CHARS = 80;
