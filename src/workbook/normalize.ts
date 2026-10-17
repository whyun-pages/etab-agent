'use strict';
/**
 * Anything into a valid spec. Never throws: a reply missing half its fields
 * still becomes a usable small workbook, and every problem is a note.
 */

import { MAX_SHEETS, MAX_COLUMNS, MAX_ROWS } from './spec-types.ts';
import type {
  ColumnType,
  CellValue,
  ColumnSpec,
  TotalsSpec,
  SheetSpec,
  WorkbookSpec,
  SpecNote,
  RawSpec,
  NormalizeResult,
} from './spec-types.ts';
import { isBlank, columnWidth, clampText, cleanName, coerce, normalizeType, uniqueKeys } from './coerce.ts';

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
 *
 * `today` (YYYY-MM-DD) is what a relative date in a date column — 今天,
 * 明天, a month and day with no year — is resolved against. Without it such a
 * value is not a date: nothing here reads the clock, so the same input always
 * normalises to the same spec.
 */
export function normalizeSpec(raw: unknown, { today }: { today?: string } = {}): NormalizeResult {
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
    const s: RawSheet = sheets[i] && typeof sheets[i] === 'object' ? sheets[i] : {};
    let name = cleanName(s.name, `Sheet${i + 1}`);
    let n = 2;
    while (sheetNames.has(name.toLowerCase())) {
      name = `${cleanName(s.name, `Sheet${i + 1}`)}_${n++}`;
    }
    sheetNames.add(name.toLowerCase());

    const sheet = normalizeSheet(s, name, notes, i, today);
    spec.sheets.push(sheet);
  }

  return { spec, notes };
}

/** One sheet: columns first (rows are keyed off them), then the data. */
function normalizeSheet(
  s: RawSheet,
  name: string,
  notes: SpecNote[],
  sheetIndex: number,
  today: string | undefined,
): SheetSpec {
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
      width: columnWidth(rc.width),
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
      const { value, note } = coerce(row[c], columns[c].type, today);
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
    notes.push({
      level: 'warn',
      message: `${where}「${f.header}」有 ${f.count} 格不是${f.reason.replace(/^.*不是/, '').replace(/，已留空$/, '')}，已留空。`,
    });
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
  if (typeof raw === 'object' && (raw as RawTotals).enabled === false)
    return { enabled: false, label: '', sumColumns: [] };
  const src: RawTotals = typeof raw === 'object' ? raw : {};

  const wanted: unknown[] = Array.isArray(src.sumColumns)
    ? src.sumColumns
    : Array.isArray(src.columns)
      ? src.columns
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
