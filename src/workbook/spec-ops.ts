'use strict';
/**
 * Edit operations on a workbook spec — what the agent's tools actually do.
 *
 * Every operation is a pure function `(spec, args) -> spec`. Nothing here
 * talks to a model, a file, or a session; src/agent/agent.ts wraps each one in a
 * tool, and src/http/server.ts replays the same list against the stored spec. Same
 * spec and same operations, same result — the replay depends on that.
 *
 * Addressed by position, not matched by content
 * ---------------------------------------------
 * The old design had the model return a whole new spec every turn, because a
 * patch "needs a matching algorithm, and a matching algorithm on a spreadsheet
 * means deciding that 'the row with 125万' is the same row as before —
 * silently, and possibly wrongly." That objection is about matching, and these
 * operations do not match. A row is named by its number, a column by its
 * header, a sheet by its name — exactly as the model was shown them in the
 * state summary, which numbers every row. The model points; nothing guesses.
 * An address that does not exist is an error the model sees and can correct,
 * never a best-effort hit on a neighbour.
 *
 * One path through normalisation
 * ------------------------------
 * An operation does not poke at a normalised spec in place. It converts the
 * spec back to the raw shape `normalizeSpec` accepts (`toRaw`), edits that,
 * and normalises the result. So a value written by `update_cells` is coerced
 * by exactly the rules a value in `create_workbook` is, a type change
 * re-coerces the column, and the limits (rows, columns, name length) hold no
 * matter which operation got there. The cost is re-normalising a whole spec
 * per edit — a few thousand cells at most, well under a millisecond's worth
 * of work next to a model call.
 */

import { normalizeSpec, validateSpec, TYPES } from './workbook.ts';
import type { CellValue, ColumnType, SpecNote, WorkbookSpec } from './workbook.ts';
import { QueryError, selectRows, computeRows, describeFailures, cellText, isBlank } from './table-query.ts';
import type { QueryTable, Selection } from './table-query.ts';

/** An operation as the agent records it: the tool's name and its arguments. */
export interface SpecOp {
  op: string;
  args: Record<string, unknown>;
  /**
   * The calendar day the operation was made on (YYYY-MM-DD), against which a
   * relative date in its values — 今天, 明天, 三月五日 — is resolved. Recorded
   * with the op, not read from the clock when it is applied: a replay on a
   * newer table, or a held change applied hours later, must land the same
   * dates the turn showed. Absent, such a value is not a date.
   */
  today?: string;
}

/** What an operation may consult besides the spec and its arguments. */
export interface OpContext {
  today?: string;
}

/** What one operation produced. */
export interface OpResult {
  spec: WorkbookSpec;
  notes: SpecNote[];
  /** one line for the model, saying what happened */
  summary: string;
}

/** A refusal the model can act on: the address was wrong, or the result unusable. */
export class SpecOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecOpError';
  }
}

// ------------------------------------------------------------- raw form

interface RawColumnOut {
  key: string;
  header: string;
  type: ColumnType;
  format: string | null;
  width?: number;
}

interface RawTotalsOut {
  enabled: boolean;
  label: string;
  /** column KEYS, which survive a rename where a header would not */
  sumColumns: string[];
}

interface RawSheetOut {
  name: string;
  columns: RawColumnOut[];
  rows: unknown[][];
  totals: RawTotalsOut | false;
}

interface RawSpecOut {
  title: string;
  sheets: RawSheetOut[];
}

/** A normalised spec back to the shape `normalizeSpec` takes, fresh arrays throughout. */
function toRaw(spec: WorkbookSpec): RawSpecOut {
  return {
    title: spec.title,
    sheets: spec.sheets.map((s) => ({
      name: s.name,
      // `width: null` is left out rather than passed through: normalizeSpec reads
      // it with `Number(...)`, and `Number(null)` is 0, which clamps to a width
      // of 4 — every edit would have narrowed every column.
      columns: s.columns.map((c) => ({
        key: c.key,
        header: c.header,
        type: c.type,
        format: c.format,
        ...(c.width === null ? {} : { width: c.width }),
      })),
      rows: s.rows.map((r) => r.slice()),
      totals:
        s.totals && s.totals.enabled
          ? {
              enabled: true,
              label: s.totals.label,
              sumColumns: s.totals.sumColumns.map((i) => s.columns[i]?.key).filter(Boolean),
            }
          : false,
    })),
  };
}

/** Normalise an edited raw spec, refusing one that would not be writable. */
function finish(ctx: OpContext, raw: unknown, summary: string): OpResult {
  const { spec, notes } = normalizeSpec(raw, { today: ctx.today });
  const verdict = validateSpec(spec);
  if (!verdict.ok) throw new SpecOpError(verdict.blocking.join('；') || '修改后的工作簿不可用');
  return { spec, notes, summary };
}

// ------------------------------------------------------------ addressing

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function requireSpec(spec: WorkbookSpec | null): WorkbookSpec {
  if (!spec || !spec.sheets.length) throw new SpecOpError('还没有表格。请先用 create_workbook 建表。');
  return spec;
}

/**
 * The sheet an operation targets. The name may be left out when there is only
 * one sheet — the common case, and the one where naming it is pure ceremony.
 */
function findSheet(raw: RawSpecOut, name: unknown): RawSheetOut {
  const wanted = str(name);
  if (!wanted) {
    if (raw.sheets.length === 1) return raw.sheets[0];
    throw new SpecOpError(
      `工作簿有 ${raw.sheets.length} 个工作表，请指明 sheet：${raw.sheets.map((s) => `「${s.name}」`).join('、')}`,
    );
  }
  const hit =
    raw.sheets.find((s) => s.name === wanted) || raw.sheets.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
  if (!hit)
    throw new SpecOpError(`没有名为「${wanted}」的工作表。现有：${raw.sheets.map((s) => `「${s.name}」`).join('、')}`);
  return hit;
}

/** A column's index by header. Exact match only: a near miss is the model's to fix. */
function findColumn(sheet: RawSheetOut, header: unknown): number {
  const wanted = str(header);
  const idx = sheet.columns.findIndex((c) => c.header === wanted);
  if (idx === -1) {
    throw new SpecOpError(
      `工作表「${sheet.name}」没有列「${wanted}」。现有列：${sheet.columns.map((c) => `「${c.header}」`).join('、') || '(无)'}`,
    );
  }
  return idx;
}

/** A 1-based data row number to an index, refusing anything out of range. */
function rowIndex(sheet: RawSheetOut, n: unknown): number {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1 || num > sheet.rows.length) {
    throw new SpecOpError(
      `行号 ${str(n) || '(空)'} 超出范围：工作表「${sheet.name}」共 ${sheet.rows.length} 行，行号从 1 开始，不含表头。`,
    );
  }
  return num - 1;
}

function columnType(raw: unknown): ColumnType {
  const t = str(raw);
  if (!t) return 'text';
  if ((TYPES as readonly string[]).includes(t)) return t as ColumnType;
  throw new SpecOpError(`未知的列类型「${t}」。可用：${TYPES.join('、')}`);
}

/**
 * A row as the model sent it — an array in column order, or an object keyed by
 * header — as an array in column order. An object key that names no column is
 * refused rather than dropped: it is almost always a typo for a real header,
 * and dropping it would lose the value the user asked for.
 */
function rowCells(sheet: RawSheetOut, row: unknown): unknown[] {
  if (Array.isArray(row)) return row.slice();
  if (row && typeof row === 'object') {
    const out: unknown[] = sheet.columns.map(() => null);
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      out[findColumn(sheet, k)] = v;
    }
    return out;
  }
  throw new SpecOpError('每一行必须是按列顺序的数组，或以列名为键的对象。');
}

// ------------------------------------------------------------ operations

/** Create or wholesale rebuild. The only operation that may discard everything. */
function createWorkbook(_spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const sheets = list(args.sheets);
  if (!sheets.length) throw new SpecOpError('create_workbook 至少要有一个工作表。');
  const result = finish(ctx, { title: args.title, sheets }, '');
  const rows = result.spec.sheets.reduce((n, s) => n + s.rows.length, 0);
  result.summary = `已建立工作簿「${result.spec.title}」：${result.spec.sheets.length} 个工作表，共 ${rows} 行`;
  return result;
}

function addColumns(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  const cols = list(args.columns);
  if (!cols.length) throw new SpecOpError('add_columns 没有给出任何列。');
  const added: string[] = [];
  for (const c of cols) {
    const src = (c && typeof c === 'object' ? c : { header: c }) as Record<string, unknown>;
    const header = str(src.header);
    if (!header) throw new SpecOpError('新列必须有列名 header。');
    if (sheet.columns.some((x) => x.header === header)) throw new SpecOpError(`列「${header}」已经存在。`);
    const at = str(src.before) ? findColumn(sheet, src.before) : sheet.columns.length;
    const values = list(src.values);
    if (values.length > sheet.rows.length) {
      throw new SpecOpError(`列「${header}」给了 ${values.length} 个值，但只有 ${sheet.rows.length} 行。`);
    }
    sheet.columns.splice(at, 0, { key: header, header, type: columnType(src.type), format: null });
    sheet.rows.forEach((r, i) => {
      while (r.length < at) r.push(null);
      r.splice(at, 0, i < values.length ? values[i] : null);
    });
    added.push(header);
  }
  return finish(ctx, raw, `已在「${sheet.name}」新增列：${added.join('、')}`);
}

function removeColumns(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  const headers = list(args.headers).map(str);
  if (!headers.length) throw new SpecOpError('remove_columns 没有给出列名。');
  // Resolve every header before removing any, so one typo removes nothing.
  const indices = headers.map((h) => findColumn(sheet, h)).sort((a, b) => b - a);
  const keys = new Set(indices.map((i) => sheet.columns[i].key));
  for (const i of indices) {
    sheet.columns.splice(i, 1);
    for (const r of sheet.rows) if (r.length > i) r.splice(i, 1);
  }
  let note = '';
  if (sheet.totals) {
    sheet.totals.sumColumns = sheet.totals.sumColumns.filter((k) => !keys.has(k));
    // An empty list would mean "total every numeric column" to normalizeSpec —
    // a totals row over columns nobody picked. Removing the summed columns
    // removes the totals instead, and says so.
    if (!sheet.totals.sumColumns.length) {
      sheet.totals = false;
      note = '（被合计的列都已删除，合计行一并去掉）';
    }
  }
  return finish(ctx, raw, `已从「${sheet.name}」删除列：${headers.join('、')}${note}`);
}

function updateColumns(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  const changes = list(args.changes);
  const order = list(args.order).map(str);
  if (!changes.length && !order.length) throw new SpecOpError('update_columns 既没有 changes 也没有 order。');
  const done: string[] = [];
  for (const ch of changes) {
    const src = (ch && typeof ch === 'object' ? ch : {}) as Record<string, unknown>;
    const col = sheet.columns[findColumn(sheet, src.header)];
    const newHeader = str(src.newHeader);
    if (newHeader && newHeader !== col.header) {
      if (sheet.columns.some((x) => x.header === newHeader)) throw new SpecOpError(`列「${newHeader}」已经存在。`);
      done.push(`「${col.header}」改名为「${newHeader}」`);
      col.header = newHeader;
    }
    if (str(src.type)) {
      const t = columnType(src.type);
      if (t !== col.type) done.push(`「${col.header}」类型 ${col.type}→${t}`);
      col.type = t;
    }
  }
  if (order.length) {
    // A full permutation, or nothing: a partial list leaves the rest's place
    // undefined, and guessing it is the kind of quiet decision this module avoids.
    const indices = order.map((h) => findColumn(sheet, h));
    if (new Set(indices).size !== sheet.columns.length || indices.length !== sheet.columns.length) {
      throw new SpecOpError(`order 必须恰好列出全部 ${sheet.columns.length} 列，每列一次。`);
    }
    sheet.columns = indices.map((i) => sheet.columns[i]);
    sheet.rows = sheet.rows.map((r) => [
      ...indices.map((i) => (i < r.length ? r[i] : null)),
      ...r.slice(indices.length),
    ]);
    done.push('调整了列顺序');
  }
  return finish(ctx, raw, done.length ? `「${sheet.name}」：${done.join('；')}` : `「${sheet.name}」的列没有变化`);
}

/**
 * Column widths, in Excel's units (characters of the default font).
 *
 * Not a model tool: this is what dragging a column edge in the preview sends.
 * It is an operation all the same, so it lands through the same pure path and
 * survives a turn replayed on top of it — `toRaw` carries widths through.
 * Clamped by normalisation like any declared width (4..80).
 */
function setColumnWidths(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  const widths = list(args.widths);
  if (!widths.length) throw new SpecOpError('set_column_widths 没有给出任何列宽。');
  const done: string[] = [];
  for (const w of widths) {
    const src = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
    const col = sheet.columns[findColumn(sheet, src.header)];
    const n = Number(src.width);
    if (src.width === null || src.width === undefined || src.width === '' || !Number.isFinite(n) || n <= 0) {
      throw new SpecOpError(`列「${col.header}」的宽度「${str(src.width)}」不是正数。`);
    }
    col.width = n;
    done.push(col.header);
  }
  return finish(ctx, raw, `已调整「${sheet.name}」的列宽：${done.join('、')}`);
}

function addRows(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  const rows = list(args.rows).map((r) => rowCells(sheet, r));
  if (!rows.length) throw new SpecOpError('add_rows 没有给出任何行。');
  const at = args.before === undefined || args.before === null ? sheet.rows.length : rowIndex(sheet, args.before);
  sheet.rows.splice(at, 0, ...rows);
  const where = at === sheet.rows.length - rows.length ? '末尾' : `第 ${at + 1} 行处`;
  return finish(ctx, raw, `已在「${sheet.name}」${where}新增 ${rows.length} 行，现共 ${sheet.rows.length} 行`);
}

function updateCells(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  const cells = list(args.cells);
  if (!cells.length) throw new SpecOpError('update_cells 没有给出任何单元格。');
  for (const cell of cells) {
    const src = (cell && typeof cell === 'object' ? cell : {}) as Record<string, unknown>;
    const r = rowIndex(sheet, src.row);
    const c = findColumn(sheet, src.column);
    const row = sheet.rows[r];
    while (row.length <= c) row.push(null);
    row[c] = src.value === undefined ? null : src.value;
  }
  return finish(ctx, raw, `已修改「${sheet.name}」${cells.length} 个单元格`);
}

// ------------------------------------------------------- by condition
//
// The operations below choose rows by a condition (`where`) instead of by
// number, and compute values by an expression instead of listing them. Both
// are evaluated by src/workbook/table-query.ts against the table the operation is
// applied to — which, on the server's replay, is the STORED table. So "delete
// the rows marked 已签收" deletes the rows marked 已签收 in the newer table, not
// the row numbers that were marked so in the snapshot the turn saw. That is
// the meaning the user asked for, and it is why these record the condition
// rather than the row numbers it produced.

/** A sheet as src/workbook/table-query.ts reads it: header and rows, sharing the arrays. */
function view(sheet: RawSheetOut): QueryTable {
  return { header: sheet.columns.map((c) => c.header), rows: sheet.rows };
}

/** Run a table-query call, turning its refusal into this module's. */
function query<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof QueryError) throw new SpecOpError(err.message);
    throw err;
  }
}

function selection(args: Record<string, unknown>): Selection {
  return {
    where: list(args.where) as Selection['where'],
    match: str(args.match).toLowerCase() === 'any' ? 'any' : 'all',
  };
}

/** A selection in words, for summaries: 「状态 = 已签收」且「金额 > 100」. */
function describeWhere(args: Record<string, unknown>): string {
  const conds = list(args.where).map((c) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const v = Array.isArray(o.value)
      ? o.value.map(cellText).join('/')
      : o.value === undefined
        ? ''
        : ` ${cellText(o.value)}`;
    return `「${str(o.column)} ${str(o.op) || '='}${Array.isArray(o.value) ? ` ${v}` : v}」`;
  });
  return conds.join(str(args.match).toLowerCase() === 'any' ? '或' : '且');
}

function deleteRows(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  const nums = list(args.rows);
  const where = list(args.where);
  if (!nums.length && !where.length) throw new SpecOpError('delete_rows 需要 rows（行号）或 where（条件）。');
  if (nums.length && where.length) throw new SpecOpError('delete_rows 的 rows 和 where 只能给一个。');
  // Resolve all first, then delete from the bottom, so the numbers the model
  // gave all refer to the table it saw rather than to a table half-deleted.
  const indices = where.length
    ? query(() => selectRows(view(sheet), selection(args))).sort((a, b) => b - a)
    : [...new Set(nums.map((n) => rowIndex(sheet, n)))].sort((a, b) => b - a);
  for (const i of indices) sheet.rows.splice(i, 1);
  const why = where.length ? `符合${describeWhere(args)}的 ` : '';
  return finish(ctx, raw, `已从「${sheet.name}」删除${why}${indices.length} 行，剩 ${sheet.rows.length} 行`);
}

/**
 * Set columns to fixed values on every row a condition selects — or on every
 * row, when there is no condition. "把所有派送中的改成已签收" is one call, not
 * one `update_cells` entry per row.
 */
function updateRows(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  const set = (args.set && typeof args.set === 'object' && !Array.isArray(args.set) ? args.set : {}) as Record<
    string,
    unknown
  >;
  const cols = Object.entries(set).map(([h, v]) => ({ c: findColumn(sheet, h), v }));
  if (!cols.length) throw new SpecOpError('update_rows 的 set 没有给出任何列。');
  const indices = query(() => selectRows(view(sheet), selection(args)));
  for (const i of indices) {
    const row = sheet.rows[i];
    for (const { c, v } of cols) {
      while (row.length <= c) row.push(null);
      row[c] = v === undefined ? null : v;
    }
  }
  const where = list(args.where).length ? `符合${describeWhere(args)}的` : '全部';
  return finish(
    ctx,
    raw,
    `已把「${sheet.name}」${where} ${indices.length} 行的 ${cols.map(({ c }) => `「${sheet.columns[c].header}」`).join('、')} 改为指定值`,
  );
}

/** The column type a set of computed values suggests, for a new column. */
function inferType(values: unknown[]): ColumnType {
  const present = values.filter((v) => !isBlank(v));
  if (!present.length) return 'text';
  if (present.every((v) => v instanceof Date)) return 'date';
  if (present.every((v) => typeof v === 'boolean')) return 'boolean';
  if (present.every((v) => typeof v === 'number'))
    return present.every((v) => Number.isInteger(v)) ? 'integer' : 'number';
  return 'text';
}

/**
 * Fill a column from an expression over each row: an existing column is
 * overwritten (on the selected rows), a new one is added. The expression is
 * what is recorded, so the replay recomputes from the stored values.
 */
function computeColumn(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  const header = str(args.column);
  if (!header) throw new SpecOpError('compute_column 必须给出 column（列名）。');
  const expression = str(args.expression);
  if (!expression) throw new SpecOpError('compute_column 必须给出 expression。');
  const t = view(sheet);
  const indices = query(() => selectRows(t, selection(args)));
  const { values, failed } = query(() => computeRows(t, expression, indices));

  let c = sheet.columns.findIndex((x) => x.header === header);
  const created = c < 0;
  if (created) {
    c = str(args.before) ? findColumn(sheet, args.before) : sheet.columns.length;
    const type = str(args.type) ? columnType(args.type) : inferType([...values.values()]);
    sheet.columns.splice(c, 0, { key: header, header, type, format: null });
    for (const r of sheet.rows) {
      while (r.length < c) r.push(null);
      r.splice(c, 0, null);
    }
  } else if (str(args.type)) {
    sheet.columns[c].type = columnType(args.type);
  }
  for (const [i, v] of values) {
    const row = sheet.rows[i];
    while (row.length <= c) row.push(null);
    row[c] = v as CellValue;
  }
  const where = list(args.where).length ? `符合${describeWhere(args)}的 ${indices.length} 行` : `${indices.length} 行`;
  return finish(
    ctx,
    raw,
    `已${created ? '新增' : '重新计算'}「${sheet.name}」的列「${header}」 = ${expression}（${where}）${describeFailures(failed)}`,
  );
}

/**
 * Bring columns over from another sheet by a matching key, as VLOOKUP does:
 * for each row, the first row of `fromSheet` whose `fromKey` equals this row's
 * `key`. A row with no match gets blanks, and the summary counts them — a
 * lookup that silently misses half the keys is the classic spreadsheet bug.
 */
function lookupColumns(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  const src = findSheet(raw, args.fromSheet);
  if (src === sheet) throw new SpecOpError('lookup_columns 的 fromSheet 不能是同一个工作表。');
  const key = findColumn(sheet, args.key);
  const srcKey = findColumn(src, str(args.fromKey) || args.key);
  const wanted = list(args.columns).map(str).filter(Boolean);
  if (!wanted.length) throw new SpecOpError('lookup_columns 必须给出 columns（要带过来的列）。');
  const names = list(args.names).map(str);
  const cols = wanted.map((h, k) => ({ from: findColumn(src, h), header: names[k] || h }));

  // Keys compared as trimmed text: "1001" in one sheet and 1001 in the other
  // are the same order number to anyone reading them.
  const norm = (v: unknown) => cellText(v).trim();
  const index = new Map<string, unknown[]>();
  for (const r of src.rows) {
    const k = norm(r[srcKey]);
    if (k && !index.has(k)) index.set(k, r);
  }

  const targets = cols.map(({ from, header }) => {
    let c = sheet.columns.findIndex((x) => x.header === header);
    if (c < 0) {
      c = sheet.columns.length;
      const s = src.columns[from];
      sheet.columns.push({ key: header, header, type: s.type, format: s.format });
      for (const r of sheet.rows) {
        while (r.length < c) r.push(null);
        r.push(null);
      }
    }
    return { from, c };
  });
  let missed = 0;
  for (const r of sheet.rows) {
    const hit = index.get(norm(r[key]));
    if (!hit) {
      if (norm(r[key])) missed++;
    }
    for (const { from, c } of targets) {
      while (r.length <= c) r.push(null);
      r[c] = hit ? (hit[from] ?? null) : null;
    }
  }
  const miss = missed ? `；${missed} 行在「${src.name}」里找不到对应的「${src.columns[srcKey].header}」，已留空` : '';
  return finish(
    ctx,
    raw,
    `已按「${sheet.columns[key].header}」从「${src.name}」带入列：${cols.map((x) => x.header).join('、')}${miss}`,
  );
}

/** Collation for sorting text the way a Chinese reader expects. Fixed locale: same input, same order. */
const COLLATOR = new Intl.Collator('zh-CN', { numeric: true });

function sortKey(v: CellValue | unknown): number | string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  return String(v);
}

function sortRows(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  const c = findColumn(sheet, args.by);
  const desc = str(args.order).toLowerCase() === 'desc';
  // Blanks last in either direction: a sort that floats empty cells to the
  // top reads as "the data disappeared".
  const keyed = sheet.rows.map((row, i) => ({ row, i, k: sortKey(row[c]) }));
  keyed.sort((a, b) => {
    if (a.k === null || b.k === null) return a.k === b.k ? a.i - b.i : a.k === null ? 1 : -1;
    let d: number;
    if (typeof a.k === 'number' && typeof b.k === 'number') d = a.k - b.k;
    else d = COLLATOR.compare(String(a.k), String(b.k));
    if (desc) d = -d;
    return d || a.i - b.i;
  });
  sheet.rows = keyed.map((x) => x.row);
  return finish(ctx, raw, `已按「${sheet.columns[c].header}」${desc ? '降序' : '升序'}排列「${sheet.name}」`);
}

function setTotals(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  if (args.enabled === false) {
    sheet.totals = false;
    return finish(ctx, raw, `已去掉「${sheet.name}」的合计行`);
  }
  const headers = list(args.sumColumns).map(str).filter(Boolean);
  const keys = headers.map((h) => sheet.columns[findColumn(sheet, h)].key);
  sheet.totals = { enabled: true, label: str(args.label) || '合计', sumColumns: keys };
  const result = finish(ctx, raw, '');
  const t = result.spec.sheets.find((s) => s.name === sheet.name)!.totals;
  const summed = t.sumColumns.map((i) => result.spec.sheets.find((s) => s.name === sheet.name)!.columns[i].header);
  result.summary = t.enabled
    ? `已为「${sheet.name}」加上合计行，合计列：${summed.join('、')}`
    : `「${sheet.name}」没有可合计的数值列，未加合计行`;
  return result;
}

function addSheet(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw: RawSpecOut = spec && spec.sheets.length ? toRaw(spec) : { title: str(args.title) || '工作簿', sheets: [] };
  const name = str(args.name);
  if (!name) throw new SpecOpError('add_sheet 必须给出工作表名 name。');
  if (raw.sheets.some((s) => s.name.toLowerCase() === name.toLowerCase()))
    throw new SpecOpError(`工作表「${name}」已经存在。`);
  const sheet = { name, columns: list(args.columns), rows: list(args.rows), totals: args.totals ?? false };
  return finish(ctx, { ...raw, sheets: [...raw.sheets, sheet] }, `已新增工作表「${name}」`);
}

function removeSheet(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  if (raw.sheets.length === 1) throw new SpecOpError('这是唯一的工作表，不能删除。要重做整个表请用 create_workbook。');
  raw.sheets = raw.sheets.filter((s) => s !== sheet);
  return finish(ctx, raw, `已删除工作表「${sheet.name}」（${sheet.rows.length} 行）`);
}

function rename(spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext): OpResult {
  const raw = toRaw(requireSpec(spec));
  const done: string[] = [];
  if (str(args.title)) {
    raw.title = str(args.title);
    done.push(`标题改为「${raw.title}」`);
  }
  if (str(args.newName)) {
    const sheet = findSheet(raw, args.sheet);
    const newName = str(args.newName);
    if (raw.sheets.some((s) => s !== sheet && s.name.toLowerCase() === newName.toLowerCase())) {
      throw new SpecOpError(`工作表「${newName}」已经存在。`);
    }
    done.push(`工作表「${sheet.name}」改名为「${newName}」`);
    sheet.name = newName;
  }
  if (!done.length) throw new SpecOpError('rename 需要 title，或 sheet 加 newName。');
  return finish(ctx, raw, done.join('；'));
}

/** Every operation, by the tool name the model calls it with. */
export const OPS: Record<
  string,
  (spec: WorkbookSpec | null, args: Record<string, unknown>, ctx: OpContext) => OpResult
> = {
  create_workbook: createWorkbook,
  add_columns: addColumns,
  remove_columns: removeColumns,
  update_columns: updateColumns,
  add_rows: addRows,
  update_cells: updateCells,
  delete_rows: deleteRows,
  update_rows: updateRows,
  compute_column: computeColumn,
  lookup_columns: lookupColumns,
  sort_rows: sortRows,
  set_totals: setTotals,
  add_sheet: addSheet,
  remove_sheet: removeSheet,
  rename,
  set_column_widths: setColumnWidths,
};

/** Apply one recorded operation. */
export function applyOp(spec: WorkbookSpec | null, op: SpecOp): OpResult {
  const fn = Object.hasOwn(OPS, op.op) ? OPS[op.op] : undefined;
  if (!fn) throw new SpecOpError(`未知的操作「${op.op}」`);
  return fn(spec, op.args || {}, { today: op.today });
}

/**
 * Apply a list of operations in order. Throws on the first one that fails —
 * a replay that half-applies is a document nobody asked for.
 */
export function applyOps(spec: WorkbookSpec | null, ops: SpecOp[]): { spec: WorkbookSpec | null; notes: SpecNote[] } {
  let current = spec;
  const notes: SpecNote[] = [];
  for (const op of ops) {
    const r = applyOp(current, op);
    current = r.spec;
    notes.push(...r.notes);
  }
  return { spec: current, notes };
}

/**
 * Rows of one sheet, numbered, for the `read_rows` tool. Numbers match what
 * the edit operations accept. Dates are shown as `YYYY-MM-DD`, the form the
 * model is told to write them in.
 */
export function readRows(spec: WorkbookSpec | null, args: Record<string, unknown>): string {
  const raw = toRaw(requireSpec(spec));
  const sheet = findSheet(raw, args.sheet);
  const total = sheet.rows.length;
  if (!total) return `工作表「${sheet.name}」没有数据行。`;
  const from = Math.max(1, Math.min(total, Number(args.from) || 1));
  const to = Math.max(from, Math.min(total, Number(args.to) || from + 99, from + 199));
  const lines = [
    `工作表「${sheet.name}」第 ${from}–${to} 行（共 ${total} 行）。列：${sheet.columns.map((c) => c.header).join('、')}`,
  ];
  for (let i = from - 1; i < to; i++) {
    lines.push(
      `${i + 1}. ${JSON.stringify(sheet.rows[i].map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)))}`,
    );
  }
  return lines.join('\n');
}
