'use strict';
/**
 * Exporting a workbook spec: bytes for each format, and writing them to disk.
 *
 * `exportSpec` is pure — same spec and options, same bytes — because both the
 * download route and the agent's `save_file` tool go through it, and a file
 * that differs between two downloads of the same table is a bug report nobody
 * can reproduce. Only `writeExports` touches the filesystem.
 *
 * CSV and formula injection
 * -------------------------
 * A CSV cell is not inert: Excel evaluates a cell that starts with `=`, `+`,
 * `-` or `@` as a formula. Tables here can be filled from fetched web pages
 * (src/agent/tools/fetch-url.ts), so a text cell like `=HYPERLINK(...)` is a realistic
 * input, not a theoretical one. Text cells starting with one of those
 * characters (or a tab / carriage return, which some readers strip before
 * evaluating) get a leading `'`, the OWASP-recommended neutraliser. Numbers are
 * written as numbers, so a negative amount is not touched. The xlsx writer
 * needs no such guard: it writes text as strings, never as formulas.
 */

import fs from 'node:fs';
import path from 'node:path';
import { columnTotal, totalsLabelColumn, writeSpec } from './workbook.ts';
import type { CellValue, SheetSpec, WorkbookSpec } from './workbook.ts';

export const EXPORT_FORMATS = ['xlsx', 'csv', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const MIME: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/** One file to hand out. */
export interface ExportFile {
  name: string;
  bytes: Buffer;
  mime: string;
}

export interface ExportOptions {
  format: ExportFormat;
  /** one sheet by name; omitted means all of them (one CSV per sheet) */
  sheet?: string | null;
  /** base file name without extension; defaults to the workbook title */
  filename?: string | null;
}

/** A refusal the caller can show as-is: unknown sheet, unknown format. */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && (EXPORT_FORMATS as readonly string[]).includes(v);
}

/**
 * A file name that is safe on Windows and says what it is.
 *
 * Takes the basename first: a model-supplied `../../x` or `C:\x` must not
 * name a directory, only a file. Capped so a long title cannot push the path
 * past MAX_PATH.
 */
export function cleanBaseName(raw: unknown, fallback = '工作簿'): string {
  let s = String(raw ?? '').trim();
  s = s.split(/[\\/]/).pop() || '';
  // A name that already carries one of our extensions keeps only its stem;
  // the format decides the extension.
  s = s.replace(/\.(xlsx|csv|json)$/i, '');
  s = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || fallback;
}

/** A cell as text, the way it is shown to the model and written to CSV. */
function plain(v: CellValue | undefined): string | number | boolean | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v;
}

const INJECTION_RE = /^[=+\-@\t\r]/;

function csvField(v: CellValue | undefined): string {
  const p = plain(v);
  if (p === null) return '';
  if (typeof p === 'boolean') return p ? 'TRUE' : 'FALSE';
  if (typeof p === 'number') return Number.isFinite(p) ? String(p) : '';
  // Only text needs the guard; a date was already turned into `YYYY-MM-DD`.
  let s = v instanceof Date ? p : INJECTION_RE.test(p) ? `'${p}` : p;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * The totals row as values, computed the same way `toSheet` computes them for
 * the xlsx (label in the first column that is not summed, sums of finite
 * numbers only), so a CSV and an xlsx of one table agree.
 */
function totalsRow(sheet: SheetSpec): CellValue[] | null {
  const t = sheet.totals;
  if (!t || !t.enabled || !sheet.rows.length) return null;
  const width = Math.max(1, sheet.columns.length);
  const row: CellValue[] = new Array(width).fill(null);
  const labelAt = totalsLabelColumn(t, width);
  if (labelAt !== null) row[labelAt] = t.label || '合计';
  for (const i of t.sumColumns) row[i] = columnTotal(sheet.rows, i);
  return row;
}

export function sheetToCsv(sheet: SheetSpec): string {
  const width = Math.max(1, sheet.columns.length);
  const lines = [sheet.columns.map((c) => csvField(c.header)).join(',')];
  const body = [...sheet.rows];
  const total = totalsRow(sheet);
  if (total) body.push(total);
  for (const r of body) {
    const cells: string[] = [];
    for (let i = 0; i < width; i++) cells.push(csvField(r[i]));
    lines.push(cells.join(','));
  }
  // BOM: without it Excel reads a UTF-8 CSV as the system code page, and every
  // Chinese header turns to mojibake. CRLF is what RFC 4180 specifies.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function specToJson(spec: WorkbookSpec, sheets: SheetSpec[]): string {
  const out = {
    title: spec.title,
    sheets: sheets.map((s) => {
      const sheet: Record<string, unknown> = {
        name: s.name,
        columns: s.columns.map((c) => ({ header: c.header, type: c.type })),
        // One object per row, keyed in column order. Header names are unique
        // within a sheet (normalisation guarantees it), so no key collides.
        rows: s.rows.map((r) => {
          const o: Record<string, unknown> = {};
          s.columns.forEach((c, i) => {
            o[c.header] = plain(r[i]);
          });
          return o;
        }),
      };
      if (s.totals && s.totals.enabled) {
        sheet.totals = {
          label: s.totals.label || '合计',
          sumColumns: s.totals.sumColumns.map((i) => s.columns[i]?.header).filter(Boolean),
        };
      }
      return sheet;
    }),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

function pickSheets(spec: WorkbookSpec, sheet: string | null | undefined): SheetSpec[] {
  if (!sheet) return spec.sheets;
  const want = String(sheet).trim().toLowerCase();
  const hit = spec.sheets.find((s) => s.name.toLowerCase() === want);
  if (!hit) throw new ExportError(`没有名为「${sheet}」的工作表。现有：${spec.sheets.map((s) => s.name).join('、')}`);
  return [hit];
}

/** The files for one export. Pure: no clock, no randomness, no I/O. */
export function exportSpec(spec: WorkbookSpec, { format, sheet, filename }: ExportOptions): ExportFile[] {
  if (!isExportFormat(format)) throw new ExportError(`不支持的导出格式：${String(format)}`);
  if (!spec || !spec.sheets || !spec.sheets.length) throw new ExportError('还没有表格，无法导出。');
  const base = cleanBaseName(filename || spec.title);
  const sheets = pickSheets(spec, sheet);

  if (format === 'xlsx') {
    // The xlsx always carries the whole workbook when no sheet is named; a
    // named sheet exports just that one, as a workbook of one.
    const target = sheet ? { ...spec, sheets } : spec;
    return [{ name: `${base}.xlsx`, bytes: writeSpec(target), mime: MIME.xlsx }];
  }
  if (format === 'json') {
    return [{ name: `${base}.json`, bytes: Buffer.from(specToJson(spec, sheets), 'utf8'), mime: MIME.json }];
  }
  // CSV holds one table; several sheets become several files, named apart.
  return sheets.map((s) => ({
    name: sheets.length > 1 ? `${base}-${cleanBaseName(s.name, '表')}.csv` : `${base}.csv`,
    bytes: Buffer.from(sheetToCsv(s), 'utf8'),
    mime: MIME.csv,
  }));
}

/** Split `name.ext` so a collision can become `name (1).ext`. */
function splitExt(name: string): [string, string] {
  const ext = path.extname(name);
  return [name.slice(0, name.length - ext.length), ext];
}

/**
 * Write files into `dir`, never overwriting anything.
 *
 * `open(..., 'wx')` fails if the path exists, and the check and the create are
 * one system call — so two saves racing for `表.csv` cannot both win; the loser
 * moves on to `表 (1).csv`. Checking with `access` first and then writing would
 * leave exactly that window open.
 */
export async function writeExports(dir: string, files: ExportFile[]): Promise<string[]> {
  await fs.promises.mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const f of files) {
    const [stem, ext] = splitExt(f.name);
    for (let n = 0; ; n++) {
      if (n > 999) throw new Error(`导出目录里同名文件太多：${f.name}`);
      const target = path.join(dir, n ? `${stem} (${n})${ext}` : f.name);
      let handle: fs.promises.FileHandle;
      try {
        handle = await fs.promises.open(target, 'wx');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      try {
        await handle.writeFile(f.bytes);
      } finally {
        await handle.close();
      }
      written.push(target);
      break;
    }
  }
  return written;
}
