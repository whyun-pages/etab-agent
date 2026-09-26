'use strict';
/**
 * Workbook spec — the single source of truth for what the agent is building.
 *
 * Why a spec and not an .xlsx
 * ---------------------------
 * The model proposes; this module decides. A model that is asked to "produce a
 * spreadsheet" will happily emit a malformed one, and a malformed file is the
 * one failure a user cannot work around: Excel refuses to open it, and there is
 * nothing to look at. So the model never touches XML. It emits a plain JSON
 * description (this spec), which is normalised and validated here, and only a
 * spec that passes is turned into a workbook by `toSheet`/`writeSpec`.
 *
 * That is the same boundary the template engine drew — the model decides what
 * the TEXT means, code decides what lands in a cell — moved to a new setting.
 *
 * Shape
 * -----
 *   {
 *     title: '销售汇总',
 *     sheets: [
 *       {
 *         name: '一月',
 *         columns: [{ key, header, type, format?, width? }],
 *         rows: [[v, v, ...], ...],
 *         totals: { enabled, label, sumColumns }
 *       }
 *     ]
 *   }
 *
 * Everything else is optional. Normalisation fills in what is missing, and it
 * is the reason a half-specified spec from a model is usable rather than
 * rejected.
 *
 * Types
 * -----
 *   text | number | integer | currency | percent | date | boolean
 *
 * A `date` is stored as a real Date (or an ISO string, coerced) and rendered to
 * an Excel serial number at write time. `dateToSerial` is shared with
 * render.js and pinned to the 1899-12-30 epoch that Excel actually uses.
 *
 * These exported types are the contract the rest of the tree types against —
 * the agent, the session store, the server and the preview all speak in
 * `WorkbookSpec`, not in `any`. They carry `export` and nothing else, and the
 * runtime exports below do the same: the file is ESM source emitted to
 * CommonJS by `tsc`, so `export` here IS the `module.exports` the consumers
 * require — there is no second, hand-written export block to keep in sync.
 */

import { parseNumber, parseChineseNumber, parseDate, parseBoolean } from './extract.ts';
import { cellRef, colName } from './xlsx.ts';
import { writeFreshWorkbook } from './xlsx-writer.ts';

// Style indices are a contract with lib/xlsx-writer.js's buildStylesXml().
// Set by number here only because importing the writer from the spec layer
// would make a pure data module depend on the XML layer.
export const STYLE = {
  DEFAULT: 0, HEADER: 1, NUMBER: 2, DATE: 3, CURRENCY: 4, PERCENT: 5, INTEGER: 6, TOTAL: 7,
  CURRENCY_TOTAL: 8, PERCENT_TOTAL: 9,
} as const;

/** A style index understood by lib/xlsx-writer.js. */
export type StyleIndex = (typeof STYLE)[keyof typeof STYLE];

/** Column types this module understands. */
export const TYPES = ['text', 'number', 'integer', 'currency', 'percent', 'date', 'boolean'] as const;

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

/** Spellings a model might use for a type, mapped onto the canonical name. */
const TYPE_ALIASES: Record<string, ColumnType> = {
  string: 'text', str: 'text', strng: 'text', label: 'text',
  num: 'number', float: 'number', decimal: 'number', double: 'number',
  int: 'integer', whole: 'integer',
  money: 'currency', amount: 'currency', 金额: 'currency',
  pct: 'percent', percentage: 'percent', 百分比: 'percent',
  datetime: 'date', time: 'date', 日期: 'date',
  bool: 'boolean', yesno: 'boolean', 布尔: 'boolean',
};

/** Recognised spellings of the type names themselves, in Chinese. */
export const TYPE_LABELS: Record<ColumnType, string> = {
  text: '文本', number: '数字', integer: '整数', currency: '金额',
  percent: '百分比', date: '日期', boolean: '是否',
};

export const MAX_SHEETS = 12;
export const MAX_COLUMNS = 60;
export const MAX_ROWS = 5000;
const MAX_CELL_CHARS = 20000;
const MAX_NAME_CHARS = 80;

// --------------------------------------------------------------- utilities

const isBlank = (v: unknown): boolean => v === null || v === undefined || v === '';

/** Excel's day 0. 1899-12-30 because Excel believes 1900 was a leap year. */
const SERIAL_EPOCH = Date.UTC(1899, 11, 30);

/**
 * A Date to an Excel serial number.
 * @returns days since 1899-12-30, with the time as a fraction
 */
export function dateToSerial(date: Date): number {
  const ms = date.getTime() - SERIAL_EPOCH;
  return ms / 86400000;
}

/** Clamp a string to the cell limit, marking that it was cut. */
export function clampText(s: unknown): string {
  const t = String(s);
  if (t.length <= MAX_CELL_CHARS) return t;
  return t.slice(0, MAX_CELL_CHARS) + '…';
}

/** A heading that is present, printable, and not absurdly long. */
function cleanName(raw: unknown, fallback: string): string {
  let s = isBlank(raw) ? '' : String(raw).replace(/[\r\n\t]+/g, ' ').trim();
  // Excel forbids : \ / ? * [ ] in a sheet name.
  s = s.replace(/[:\\/?*[\]]/g, '_');
  if (!s) s = fallback;
  return s.slice(0, MAX_NAME_CHARS);
}

/**
 * Extract a number from either a bare number or a parser result object.
 *
 * `parseNumber` answers with `{value, raw, scale, percent}`; `parseChineseNumber`
 * answers with a bare number. Both mean "here is the number", so accept both
 * rather than making every caller remember which is which.
 */
function unwrapNumber(r: unknown): number | null {
  if (r === null || r === undefined) return null;
  if (typeof r === 'number') return Number.isFinite(r) ? r : null;
  if (typeof r === 'object' && typeof (r as { value?: unknown }).value === 'number'
    && Number.isFinite((r as { value: number }).value)) {
    return (r as { value: number }).value;
  }
  return null;
}

/** The result of coercing one raw value to a column's type. */
export interface CoerceResult {
  value: CellValue;
  note: string | null;
}

/**
 * Coerce one value to a column's type.
 *
 * Returns `{ value, note }` — `note` is non-null when the input could not be
 * represented, and the caller decides whether that is a failure or a blank.
 * Nothing is ever silently turned into a plausible-looking wrong number: a
 * currency cell holding "四十几万吧" is reported, not stored as 40.
 */
export function coerce(raw: unknown, type: ColumnType): CoerceResult {
  if (isBlank(raw)) return { value: null, note: null };

  switch (type) {
    case 'number':
    case 'integer':
    case 'currency':
    case 'percent': {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        return { value: type === 'integer' ? Math.round(raw) : raw, note: null };
      }
      const s = String(raw).trim();
      // Chinese numerals first: "125万" and "一百二十五万" are both numbers a
      // Chinese speaker would expect to work.
      //
      // Both helpers are quirky in the same way: `parseChineseNumber` returns a
      // number or null, but `parseNumber` returns a RESULT OBJECT
      // ({value, raw, scale, percent}) or null. Treating that object as a number
      // silently discarded every ordinary value — "1200" became a blank cell
      // with a note, which is the one outcome this whole layer exists to avoid.
      let n = parseChineseNumber(s);
      if (n === null || n === undefined) n = unwrapNumber(parseNumber(s));
      if (n === null || n === undefined || !Number.isFinite(n)) {
        return { value: null, note: `「${s.slice(0, 24)}」不是${TYPE_LABELS[type]}，已留空` };
      }
      return { value: type === 'integer' ? Math.round(n) : n, note: null };
    }

    case 'date': {
      if (raw instanceof Date) {
        return Number.isNaN(raw.getTime())
          ? { value: null, note: '日期无效，已留空' }
          : { value: raw, note: null };
      }
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        // Excel serial in, serial out.
        if (raw > 1 && raw < 200000) return { value: new Date(SERIAL_EPOCH + raw * 86400000), note: null };
      }
      // A date that has been through JSON is a string again, and a date-shaped
      // string is ambiguous with text that merely looks like a date. The column
      // type is what resolves it: this branch only runs because the column IS a
      // date, so an ISO/`YYYY-MM-DD` string here is a date that lost its type on
      // the way through `JSON.stringify` — which is exactly what happens every
      // time a session is reloaded from disk.
      const iso = isoToDate(raw);
      if (iso) return { value: iso, note: null };
      const d = parseDate(String(raw));
      if (!d) return { value: null, note: `「${String(raw).slice(0, 24)}」不是日期，已留空` };
      return { value: d, note: null };
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw, note: null };
      const b = parseBoolean(String(raw));
      if (b === null || b === undefined) {
        const s = String(raw).trim().toLowerCase();
        if (s === 'true' || s === 'yes' || s === '1') return { value: true, note: null };
        if (s === 'false' || s === 'no' || s === '0') return { value: false, note: null };
        return { value: null, note: `「${String(raw).slice(0, 24)}」不是是否值，已留空` };
      }
      return { value: Boolean(b), note: null };
    }

    default:
      return { value: clampText(raw), note: null };
  }
}

/**
 * A date that came back from JSON, or null.
 *
 * `new Date(string)` is deliberately not used on its own: it accepts almost
 * anything (`new Date('5')` is a valid date in 2001) and a text column that
 * happens to read "March" would silently become a date. Only the two shapes
 * this codebase itself writes are accepted — an ISO timestamp, and a bare
 * `YYYY-MM-DD`, which is what `parseDate` emits before `Date` takes over.
 */
function isoToDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null;
  const d = new Date(s.includes('T') || s.includes(' ') ? s.replace(' ', 'T') : `${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Map a free-form type name onto a known one. */
export function normalizeType(raw: unknown): ColumnType {
  if (isBlank(raw)) return 'text';
  const s = String(raw).trim().toLowerCase();
  if ((TYPES as readonly string[]).includes(s)) return s as ColumnType;
  if (TYPE_ALIASES[s]) return TYPE_ALIASES[s];
  // "currency (CNY)" / "金额 元" — take the first recognised word.
  for (const word of s.split(/[^a-z\u4e00-\u9fa5]+/)) {
    if (!word) continue;
    if ((TYPES as readonly string[]).includes(word)) return word as ColumnType;
    if (TYPE_ALIASES[word]) return TYPE_ALIASES[word];
  }
  for (const [zh, en] of Object.entries(TYPE_ALIASES)) {
    if (/[\u4e00-\u9fa5]/.test(zh) && s.includes(zh)) return en;
  }
  return 'text';
}

/** Make keys unique within a sheet, keeping the first occurrence stable. */
function uniqueKeys(columns: ColumnSpec[]): ColumnSpec[] {
  const seen = new Map<string, number>();
  for (const c of columns) {
    const n = (seen.get(c.key) || 0) + 1;
    seen.set(c.key, n);
    if (n > 1) c.key = `${c.key}_${n}`;
  }
  return columns;
}

// ------------------------------------------------------------ normalisation

/**
 * A column as it arrives from the model, before normalisation.
 *
 * Loose on purpose: this is untrusted JSON, and every field is optional
 * because a model reply that is missing half of them must still normalise.
 */
export interface RawColumn {
  key?: unknown;
  header?: unknown;
  label?: unknown;
  name?: unknown;
  title?: unknown;
  type?: unknown;
  format?: unknown;
  width?: unknown;
}

/** A sheet as it arrives from the model. */
export interface RawSheet {
  name?: unknown;
  columns?: unknown;
  rows?: unknown;
  totals?: unknown;
}

/** A totals block as it arrives from the model. */
export interface RawTotals {
  enabled?: unknown;
  label?: unknown;
  sumColumns?: unknown;
  columns?: unknown;
}

/**
 * Coerce anything into a valid spec.
 *
 * Never throws on bad input: a model reply that is missing half its fields
 * should produce a usable small workbook, not an exception the UI has to
 * explain. Problems are returned in `notes` so they can be shown.
 */
export function normalizeSpec(raw: unknown): NormalizeResult {
  const notes: SpecNote[] = [];
  const src = (raw && typeof raw === 'object' ? raw : {}) as RawSpec;

  if (!raw || typeof raw !== 'object') {
    notes.push({ level: 'warn', message: '模型没有返回可用的工作簿描述。' });
  }

  const spec: WorkbookSpec = {
    title: cleanName(src.title, '工作簿'),
    sheets: [],
  };

  let sheets = Array.isArray(src.sheets) ? (src.sheets as RawSheet[]) : null;
  if (!sheets && Array.isArray(src.rows)) {
    // A bare table, not wrapped in a sheet: accept it.
    sheets = [{ name: src.name || 'Sheet1', columns: src.columns, rows: src.rows }];
  }
  if (!sheets || !sheets.length) {
    sheets = [{ name: 'Sheet1', columns: [], rows: [] }];
    notes.push({ level: 'warn', message: '没有给出任何工作表，已建一个空的。' });
  }
  if (sheets.length > MAX_SHEETS) {
    notes.push({ level: 'warn', message: `工作表超过 ${MAX_SHEETS} 个，只保留前 ${MAX_SHEETS} 个。` });
    sheets = sheets.slice(0, MAX_SHEETS);
  }

  const sheetNames = new Set<string>();
  for (let i = 0; i < sheets.length; i++) {
    const s: RawSheet = (sheets[i] && typeof sheets[i] === 'object') ? sheets[i] : {};
    let name = cleanName(s.name, `Sheet${i + 1}`);
    let n = 2;
    while (sheetNames.has(name.toLowerCase())) {
      name = `${cleanName(s.name, `Sheet${i + 1}`)}_${n++}`;
    }
    sheetNames.add(name.toLowerCase());

    const sheet = normalizeSheet(s, name, notes, i);
    spec.sheets.push(sheet);
  }

  return { spec, notes };
}

/** One sheet: columns first (rows are keyed off them), then the data. */
function normalizeSheet(s: RawSheet, name: string, notes: SpecNote[], sheetIndex: number): SheetSpec {
  const where = `工作表「${name}」`;

  // ── columns ───────────────────────────────────────────────────────
  const columns: ColumnSpec[] = [];
  const rawCols: unknown[] = Array.isArray(s.columns) ? s.columns : [];
  if (rawCols.length > MAX_COLUMNS) {
    notes.push({ level: 'warn', message: `${where}的列超过 ${MAX_COLUMNS} 个，只保留前 ${MAX_COLUMNS} 个。` });
  }
  for (const raw of rawCols.slice(0, MAX_COLUMNS)) {
    if (typeof raw === 'string') {
      columns.push({ key: raw, header: raw, type: 'text', format: null, width: null });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const rc = raw as RawColumn;
    const header = cleanName(rc.header || rc.label || rc.name || rc.title, '');
    const key = cleanName(rc.key || header, `col${columns.length + 1}`);
    if (!header && !key) continue;
    columns.push({
      key,
      header: header || key,
      type: normalizeType(rc.type),
      format: isBlank(rc.format) ? null : String(rc.format),
      width: Number.isFinite(Number(rc.width)) ? Math.max(4, Math.min(80, Number(rc.width))) : null,
    });
  }
  uniqueKeys(columns);

  // ── rows ──────────────────────────────────────────────────────────
  let rawRows: unknown[] = Array.isArray(s.rows) ? s.rows : [];
  let dropped = 0;
  if (rawRows.length > MAX_ROWS) {
    dropped = rawRows.length - MAX_ROWS;
    notes.push({ level: 'warn', message: `${where}有 ${rawRows.length} 行，只保留前 ${MAX_ROWS} 行。` });
    rawRows = rawRows.slice(0, MAX_ROWS);
  }

  const headerIndex = new Map(columns.map((c, i) => [c.header, i]));
  const keyIndex = new Map(columns.map((c, i) => [c.key, i]));
  const ragged: number[] = [];
  const failed = new Map<string, { header: string; reason: string; count: number }>();

  const rows: CellValue[][] = rawRows.map((rawRow, r) => {
    let row: unknown = rawRow;
    // An object row ({客户: 'A'}) is mapped onto columns by header or key.
    if (row && !Array.isArray(row) && typeof row === 'object') {
      const srcRow = row as Record<string, unknown>;
      const out: unknown[] = columns.map(() => null);
      for (const [k, v] of Object.entries(srcRow)) {
        const idx = headerIndex.has(k) ? headerIndex.get(k) : keyIndex.get(k);
        if (idx === undefined) continue;
        out[idx] = v;
      }
      row = out;
    }
    if (!Array.isArray(row)) return columns.map(() => null);

    if (columns.length && row.length !== columns.length) ragged.push(r + 1);

    const out: CellValue[] = [];
    for (let c = 0; c < columns.length; c++) {
      const { value, note } = coerce(row[c], columns[c].type);
      if (note) {
        const k = `${columns[c].header}`;
        if (!failed.has(k)) failed.set(k, { header: k, reason: note, count: 0 });
        failed.get(k)!.count++;
      }
      out.push(value);
    }
    // Extra cells beyond the declared columns are kept as text so data is not
    // lost, but reported, because it usually means the header row was misread.
    for (let c = columns.length; c < row.length; c++) {
      if (!isBlank(row[c])) out.push(clampText(row[c]));
    }
    return out;
  });

  if (ragged.length) {
    notes.push({
      level: 'warn',
      message: `${where}有 ${ragged.length} 行的单元格数与列数不一致（第 ${ragged.slice(0, 5).join('、')} 行），已按列补齐。`,
    });
  }
  for (const f of failed.values()) {
    notes.push({ level: 'warn', message: `${where}「${f.header}」有 ${f.count} 格不是${f.reason.replace(/^.*不是/, '').replace(/，已留空$/, '')}，已留空。` });
  }

  // A sheet with data but no declared columns is common from a model that only
  // emitted rows. Infer columns so the grid still shows something sensible.
  if (!columns.length && rows.length) {
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    for (let c = 0; c < Math.min(width, MAX_COLUMNS); c++) {
      columns.push({ key: `col${c + 1}`, header: `列${c + 1}`, type: 'text', format: null, width: null });
    }
    notes.push({ level: 'info', message: `${where}没有列定义，已按数据推断 ${columns.length} 列。` });
  }

  // ── totals ────────────────────────────────────────────────────────
  const totals = normalizeTotals(s.totals, columns, notes, where);

  return {
    name,
    columns,
    rows,
    totals,
    dropped,
    sheetIndex,
  };
}

/**
 * A totals row, if the caller asked for one.
 *
 * Totals are OPT-IN: an absent `totals` produces none. A 合计 row appearing under
 * a table the user merely asked to create would be an unrequested edit to their
 * data, and the preview would have to explain a row nobody asked for.
 *
 * Given `totals: {enabled: true}` with no column list, the numeric columns are
 * summed — that is what 合计 means in practice. `sumColumns` holds column KEYS,
 * headers, OR zero-based indices; all three are resolved to indices here so the
 * writer and the preview agree without re-resolving, which is the kind of
 * duplication that drifts.
 *
 * Accepting an index matters because the model is told to name columns and still
 * emits `sumColumns: [1]` often enough to have caused a real bug: an index used
 * to match nothing, the whole list resolved empty, and `enabled` was computed as
 * `indices.length > 0` — so a request to total a column silently produced NO
 * totals row at all. The user saw 435000 in the reply and a three-row table in
 * the preview.
 */
function normalizeTotals(raw: unknown, columns: ColumnSpec[], notes: SpecNote[], where: string): TotalsSpec {
  if (!raw || raw === false) return { enabled: false, label: '', sumColumns: [] };
  if (typeof raw === 'object' && (raw as RawTotals).enabled === false) return { enabled: false, label: '', sumColumns: [] };
  const src: RawTotals = (typeof raw === 'object') ? raw : {};

  const wanted: unknown[] = Array.isArray(src.sumColumns) ? src.sumColumns
    : Array.isArray(src.columns) ? src.columns
      : [];

  const SUMABLE: ColumnType[] = ['number', 'currency', 'integer'];
  // number/currency/integer qualify; percent does NOT — the sum of a column of
  // tax rates is a meaningless number, and it appeared in the preview as a
  // confident-looking 0.5 that no user asked for.
  const indices: number[] = [];
  const byKey = new Map(columns.map((c, i) => [c.key, i]));
  const byHeader = new Map(columns.map((c, i) => [c.header, i]));

  if (wanted.length) {
    for (const w of wanted) {
      // A bare number is a column INDEX, not a name. It is 0-based to match how
      // this module refers to columns everywhere else, and it is only honoured
      // where a sum means something, so a one-based slip that lands on a text
      // or date column is dropped instead of producing a meaningless total.
      if (typeof w === 'number' && Number.isInteger(w)) {
        if (w >= 0 && w < columns.length && SUMABLE.includes(columns[w].type)) {
          if (!indices.includes(w)) indices.push(w);
        } else {
          notes.push({ level: 'warn', message: `${where}的合计列索引 ${w} 不可加，已忽略。` });
        }
        continue;
      }
      const key = String(w);
      const idx = byKey.has(key) ? byKey.get(key) : byHeader.get(key);
      if (idx === undefined) {
        notes.push({ level: 'warn', message: `${where}的合计列「${key.slice(0, 20)}」不存在，已忽略。` });
        continue;
      }
      if (!indices.includes(idx)) indices.push(idx);
    }
  }

  // An EXPLICIT but unusable list must not be worse than no list at all. Before,
  // `sumColumns: ['金额']` on a spec whose columns all carry a different key fell
  // through to `enabled: false`, while `sumColumns: []` summed every numeric
  // column — so naming a column the wrong way silently deleted the totals row.
  // The user asked for a 合计; the honest failure mode is to total the summable
  // columns, not to pretend they asked for nothing.
  if (!indices.length) {
    columns.forEach((c, i) => {
      if (SUMABLE.includes(c.type)) indices.push(i);
    });
  }

  return {
    enabled: indices.length > 0,
    label: cleanName(src.label, '合计'),
    sumColumns: indices,
  };
}

// -------------------------------------------------------------- validation

/**
 * Decide whether a spec may be written.
 *
 * `normalizeSpec` makes a spec WORKABLE; this decides whether it is worth
 * showing. Only two things block: nothing at all to write, and a sheet whose
 * columns are all unnamed (which produces a file with no headings and is never
 * what was wanted). Everything else is a note, because a workbook with one odd
 * cell is still a workbook.
 */
export function validateSpec(spec: WorkbookSpec): ValidateResult {
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.sheets) || !spec.sheets.length) {
    blocking.push('没有工作表可以写入。');
    return { ok: false, blocking, warnings };
  }

  const cellCount = spec.sheets.reduce(
    (n, s) => n + (s.rows || []).reduce((m, r) => m + (r ? r.length : 0), 0), 0);

  for (const s of spec.sheets) {
    const cols = s.columns || [];
    if (!cols.length && (s.rows || []).length) {
      blocking.push(`工作表「${s.name}」有数据但没有列定义。`);
    }
    if (cols.length && cols.every((c) => !c.header)) {
      blocking.push(`工作表「${s.name}」的列都没有名称。`);
    }
    const unnamed = cols.filter((c) => !c.header).length;
    if (unnamed) warnings.push(`工作表「${s.name}」有 ${unnamed} 列没有名称。`);
  }

  if (!cellCount) warnings.push('工作簿是空的，还没有任何数据。');

  // A totals row is the one thing a user can see that this layer added on its
  // own, so it is worth confirming the cached values agree with the formulas.
  for (const s of spec.sheets) {
    if (!(s.totals && s.totals.enabled)) continue;
    if (!(s.rows || []).length) warnings.push(`工作表「${s.name}」要了合计行，但没有数据，合计未生成。`);
  }

  return { ok: blocking.length === 0, blocking, warnings };
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
      col: i + 1, row: 1,
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
      const style = styleFor(columns[i], v);
      cells.push({ ref: cellRef(i + 1, rowNum), col: i + 1, row: rowNum, value, styleIndex: style });
    }
  });

  let totalRow: number | null = null;
  const totals = sheet.totals || { enabled: false, label: '', sumColumns: [] };
  if (totals.enabled && rows.length) {
    totalRow = rows.length + 2;
    const labelCol = totals.sumColumns.includes(0) ? (totals.sumColumns.find((i) => i > 0) ?? 0) : 0;
    // Label sits in the first column that is not itself summed, or column A.
    const putLabel = totals.sumColumns.includes(0) ? labelCol : 0;
    cells.push({
      ref: cellRef(putLabel + 1, totalRow),
      col: putLabel + 1, row: totalRow,
      value: totals.label || '合计',
      styleIndex: STYLE.HEADER,
    });

    for (const i of totals.sumColumns) {
      if (i === putLabel) continue;
      const letter = colName(i + 1);
      const first = 2;
      const last = rows.length + 1;
      const formula = `SUM(${letter}${first}:${letter}${last})`;
      const total = rows.reduce((sum, r) => {
        const v = r[i];
        return sum + (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      }, 0);
      cells.push({
        ref: cellRef(i + 1, totalRow),
        col: i + 1, row: totalRow,
        value: total,
        formula,
        styleIndex: totalStyleFor(columns[i]),
      });
    }
  }

  const height = Math.max(1, totalRow || rows.length + 1);
  return {
    name: sheet.name,
    cells,
    cols: columnWidths(columns, width),
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

/** Column widths: declared, or sized from the widest plausible content. */
function columnWidths(columns: ColumnSpec[], width: number): Array<{ min: number; max: number; width: number }> {
  const out: Array<{ min: number; max: number; width: number }> = [];
  for (let i = 0; i < width; i++) {
    const c = columns[i];
    if (c && c.width) { out.push({ min: i + 1, max: i + 1, width: c.width }); continue; }
    const header = (c && c.header) || '';
    // CJK characters are about twice as wide, which is the only reason this is
    // not just a length count.
    const w = Math.max(10, Math.min(40, displayWidth(header) + 4));
    out.push({ min: i + 1, max: i + 1, width: w });
  }
  return out;
}

/** Approximate rendered width of a string, counting CJK as two columns. */
export function displayWidth(s: unknown): number {
  let n = 0;
  for (const ch of String(s)) n += /[\u1100-\u115f\u2e80-\ua4cf\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
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

// ------------------------------------------------------------------- stats

/** A short summary for the UI: what is in this workbook. */
export function specStats(spec: WorkbookSpec | null | undefined): SpecStats {
  const sheets = (spec && spec.sheets) || [];
  const rows = sheets.reduce((n, s) => n + ((s.rows || []).length), 0);
  const cols = sheets.reduce((n, s) => n + ((s.columns || []).length), 0);
  return { sheets: sheets.length, rows, columns: cols };
}
