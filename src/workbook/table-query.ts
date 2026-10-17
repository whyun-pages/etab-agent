'use strict';
/**
 * Queries over a table — filter, group, aggregate, compute — shared by the
 * workbook and the attachments.
 *
 * Why this exists
 * ---------------
 * A model shown five rows of a 910-row table cannot count the other 905, and a
 * model shown all 910 counts them badly: it is reading, not adding. Asked "统计
 * 订单状态", the honest answer comes from a loop over every row, not from the
 * model's attention. So the arithmetic lives here, and the model asks for it.
 *
 * The same reasoning covers editing. "删掉所有已签收的" used to mean reading
 * every row, listing the matching numbers and passing them to `delete_rows`;
 * "金额都乘 1.1" meant one `update_cells` entry per row. Both are now a
 * condition or an expression, evaluated here, row by row, the same way every
 * time.
 *
 * Pure and deterministic
 * ----------------------
 * Nothing here reads a clock, a file or a random source, and every ordering is
 * decided by the input (first appearance, then a stable sort). The edit
 * operations in src/workbook/spec-ops.ts call into this module and are REPLAYED on the
 * stored spec by the server; a function here that answered differently the
 * second time would make the replay land something the preview never showed.
 * That is also why there is no TODAY()/NOW() in the expression language.
 *
 * The expression language is deliberately small and is NOT JavaScript: it is
 * parsed by the code below and evaluated over values, so there is no `eval`,
 * no property access and nothing to escape from.
 */

import type { CellValue } from './workbook.ts';
import { isoDay } from './coerce.ts';

/** A refusal the model can act on: a bad column, operator or expression. */
export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

/** The shape every query runs over: a header and rows in header order. */
export interface QueryTable {
  header: string[];
  rows: unknown[][];
}

/** One condition of a `where`. */
export interface Condition {
  column: string;
  op: string;
  value?: unknown;
}

/** Row selection: conditions joined by AND (`all`, the default) or OR (`any`). */
export interface Selection {
  where?: Condition[];
  match?: 'all' | 'any';
}

/** One aggregate of `aggregate`. `column` may be an expression (contains `[`). */
export interface Metric {
  fn: string;
  column?: string;
  as?: string;
}

export interface AggregateArgs extends Selection {
  /** columns (or expressions) to group by; none means one group of everything */
  groupBy?: string[];
  metrics?: Metric[];
  /** a result column to sort by, and the direction; default: first metric, descending */
  sort?: { by: string; order?: 'asc' | 'desc' };
}

export interface AggregateResult {
  header: string[];
  rows: CellValue[][];
  /** rows that passed the selection */
  matched: number;
  /** rows in the table */
  total: number;
}

export const CONDITION_OPS = [
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'in',
  'not_in',
  'empty',
  'not_empty',
] as const;
export const METRIC_FNS = ['count', 'sum', 'avg', 'min', 'max', 'distinct'] as const;

/** Label shown for an empty group key; a blank line in a listing reads as missing data. */
export const EMPTY_LABEL = '（空）';

// ------------------------------------------------------------- values

/** A cell as text: dates as YYYY-MM-DD, the form the model reads and writes. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : isoDay(v);
  return String(v);
}

/**
 * A cell as one field of a tab-separated line, for the tables the model reads.
 * A tab or line break inside the value would shift every column after it, so
 * they become spaces here — and only here: `cellText` is what conditions
 * compare against, and a multi-line cell must still match as written.
 */
export function tsvCell(v: unknown): string {
  return cellText(v).replace(/[\t\r\n]+/g, ' ');
}

export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * A cell as a number, or null when it is not one.
 *
 * Text that a person would read as a number counts: `1,200`, `¥35.5`, `12%`.
 * Spreadsheets exported by other systems are full of those, and a sum that
 * skipped them would be silently wrong.
 */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return null;
  let s = v
    .trim()
    .replace(/[,，\s]/g, '')
    .replace(/^[¥￥$]/, '');
  const pct = s.endsWith('%');
  if (pct) s = s.slice(0, -1);
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

/** A date from a Date or a `YYYY-MM-DD`-like string; null otherwise. */
function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})[-/年.](\d{1,2})(?:[-/月.](\d{1,2}))?/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] || 1)));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * How text sorts here: Chinese order, numbers in text by value ("第2行" before
 * "第10行"). A fixed locale, so the same input sorts the same on every machine.
 * Shared by query results, sort_rows and folder listings.
 */
export const COLLATOR = new Intl.Collator('zh-CN', { numeric: true });

/**
 * Compare two values the way a person would: as numbers when both are, as
 * dates when both are, as text otherwise.
 */
function compare(a: unknown, b: unknown): number {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na - nb;
  const da = toDate(a);
  const db = toDate(b);
  if (da && db) return da.getTime() - db.getTime();
  return COLLATOR.compare(cellText(a), cellText(b));
}

/** Equality: numeric when both sides are numbers, otherwise trimmed text. */
function same(a: unknown, b: unknown): boolean {
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na === nb;
  const da = a instanceof Date ? toDate(a) : null;
  const db = b instanceof Date ? toDate(b) : null;
  if (da || db) {
    const x = toDate(a);
    const y = toDate(b);
    return Boolean(x && y && x.getTime() === y.getTime());
  }
  return cellText(a).trim() === cellText(b).trim();
}

/**
 * Past this, `n * 1e6` is beyond the integers a double holds exactly, and the
 * round trip moves `n` itself.
 */
const ROUND6_LIMIT = Number.MAX_SAFE_INTEGER / 1e6;

/**
 * Sums of decimals drift (0.1 + 0.2); nobody should be shown that.
 *
 * An integer is returned as it is, and so is anything too large to scale:
 * `Math.round(n * 1e6) / 1e6` turned the product ID 10147810868016 into
 * 10147810868016.002 — every ID or order number that went through an
 * expression came out changed, and still looked like itself at a glance.
 */
export function round6(n: number): number {
  if (Number.isInteger(n) || Math.abs(n) >= ROUND6_LIMIT) return n;
  return Math.round(n * 1e6) / 1e6;
}

// ------------------------------------------------------------ columns

/** A column's index by header: exact, then ignoring case and spaces. */
export function columnIndex(t: QueryTable, header: unknown): number {
  const want = String(header ?? '').trim();
  let i = t.header.findIndex((h) => h === want);
  if (i < 0) {
    const loose = (s: string) => s.replace(/\s+/g, '').toLowerCase();
    i = t.header.findIndex((h) => loose(h) === loose(want));
  }
  if (i < 0) throw new QueryError(`没有名为「${want}」的列。现有列：${t.header.join('、') || '(无)'}`);
  return i;
}

// ---------------------------------------------------------- selection

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Compile a `where` into a row predicate, resolving every column up front. */
export function compileSelection(t: QueryTable, sel: Selection): (row: unknown[]) => boolean {
  const conds = list(sel.where).map((raw) => {
    const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const i = columnIndex(t, c.column);
    const op = String(c.op ?? '=')
      .trim()
      .toLowerCase()
      .replace(/^==$/, '=')
      .replace(/^<>$/, '!=');
    if (!(CONDITION_OPS as readonly string[]).includes(op)) {
      throw new QueryError(`不认识的条件「${op}」。可用：${CONDITION_OPS.join(' ')}`);
    }
    const value = c.value;
    if ((op === 'in' || op === 'not_in') && !Array.isArray(value)) {
      throw new QueryError(`条件 ${op} 的 value 必须是数组。`);
    }
    if (op !== 'empty' && op !== 'not_empty' && value === undefined) {
      throw new QueryError(`条件「${t.header[i]} ${op}」缺少 value。`);
    }
    return (row: unknown[]) => test(row[i], op, value);
  });
  if (!conds.length) return () => true;
  const any = String(sel.match ?? 'all').toLowerCase() === 'any';
  return any ? (row) => conds.some((f) => f(row)) : (row) => conds.every((f) => f(row));
}

/**
 * Whether an ordering comparison means anything. A number compared with text
 * that is not a number ("abc" > 100) would fall back to comparing the text,
 * and "abc" sorts after "100" — so a filter for big amounts would keep every
 * row with junk in the column. Such a row matches no ordering condition.
 */
function orderable(cell: unknown, value: unknown): boolean {
  if (isBlank(cell)) return false;
  if (toNumber(value) !== null && toNumber(cell) === null && !toDate(cell)) return false;
  return true;
}

function test(cell: unknown, op: string, value: unknown): boolean {
  const text = cellText(cell).toLowerCase();
  const want = cellText(value).toLowerCase();
  switch (op) {
    case '=':
      return same(cell, value);
    case '!=':
      return !same(cell, value);
    case '>':
      return orderable(cell, value) && compare(cell, value) > 0;
    case '>=':
      return orderable(cell, value) && compare(cell, value) >= 0;
    case '<':
      return orderable(cell, value) && compare(cell, value) < 0;
    case '<=':
      return orderable(cell, value) && compare(cell, value) <= 0;
    case 'contains':
      return text.includes(want);
    case 'not_contains':
      return !text.includes(want);
    case 'starts_with':
      return text.startsWith(want);
    case 'ends_with':
      return text.endsWith(want);
    case 'in':
      return (value as unknown[]).some((v) => same(cell, v));
    case 'not_in':
      return !(value as unknown[]).some((v) => same(cell, v));
    case 'empty':
      return isBlank(cell);
    case 'not_empty':
      return !isBlank(cell);
    default:
      return false;
  }
}

/** Indices (0-based) of the rows a selection keeps, in table order. */
export function selectRows(t: QueryTable, sel: Selection): number[] {
  const keep = compileSelection(t, sel);
  const out: number[] = [];
  t.rows.forEach((r, i) => {
    if (keep(r)) out.push(i);
  });
  return out;
}

// ---------------------------------------------------------- aggregate

/** A groupBy entry or metric column: a header, or an expression when it has `[`. */
function compileValue(t: QueryTable, src: string): { label: string; get: (row: unknown[], n: number) => unknown } {
  if (src.includes('[')) {
    const fn = compileExpression(t, src);
    return { label: src, get: (row, n) => fn(row, n) };
  }
  const i = columnIndex(t, src);
  return { label: t.header[i], get: (row) => row[i] };
}

/**
 * Group and aggregate. With no groupBy the result is one row over everything
 * selected; with no metrics it is a count.
 *
 * Groups appear in order of first appearance, then sorted — stable, so equal
 * values keep that order and the same table always gives the same listing.
 */
export function aggregate(t: QueryTable, args: AggregateArgs): AggregateResult {
  const keep = compileSelection(t, args);
  const keys = list(args.groupBy).map((g) => compileValue(t, String(g)));
  const metricsIn = list(args.metrics).length ? list(args.metrics) : [{ fn: 'count' }];
  const metrics = metricsIn.map((raw) => {
    const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const fn = String(m.fn ?? 'count')
      .trim()
      .toLowerCase();
    if (!(METRIC_FNS as readonly string[]).includes(fn))
      throw new QueryError(`不认识的统计「${fn}」。可用：${METRIC_FNS.join(' ')}`);
    const col = m.column == null || m.column === '' ? null : compileValue(t, String(m.column));
    if (!col && fn !== 'count') throw new QueryError(`统计 ${fn} 需要 column。`);
    const label = String(m.as ?? '').trim() || (fn === 'count' && !col ? '行数' : `${col!.label}${METRIC_LABEL[fn]}`);
    return { fn, col, label };
  });

  interface Acc {
    n: number;
    sum: number;
    nums: number;
    min: unknown;
    max: unknown;
    seen: Set<string>;
  }
  const groups = new Map<string, { key: unknown[]; acc: Acc[] }>();
  let matched = 0;
  t.rows.forEach((row, idx) => {
    if (!keep(row)) return;
    matched++;
    const keyVals = keys.map((k) => k.get(row, idx + 1));
    const id = JSON.stringify(keyVals.map((v) => (isBlank(v) ? '' : cellText(v).trim())));
    let g = groups.get(id);
    if (!g) {
      g = {
        key: keyVals.map((v) => (isBlank(v) ? EMPTY_LABEL : v)),
        acc: metrics.map(() => ({ n: 0, sum: 0, nums: 0, min: null, max: null, seen: new Set() })),
      };
      groups.set(id, g);
    }
    metrics.forEach((m, k) => {
      const a = g!.acc[k];
      if (!m.col) {
        a.n++;
        return;
      }
      const v = m.col.get(row, idx + 1);
      if (isBlank(v)) return;
      a.n++;
      a.seen.add(cellText(v).trim());
      const num = toNumber(v);
      if (num !== null) {
        a.sum += num;
        a.nums++;
      }
      if (a.min === null || compare(v, a.min) < 0) a.min = v;
      if (a.max === null || compare(v, a.max) > 0) a.max = v;
    });
  });
  // No groupBy and nothing matched is still one row of zeros: "0 orders" is an answer.
  if (!keys.length && !groups.size) {
    groups.set('[]', {
      key: [],
      acc: metrics.map(() => ({ n: 0, sum: 0, nums: 0, min: null, max: null, seen: new Set() })),
    });
  }

  const header = [...keys.map((k) => k.label), ...metrics.map((m) => m.label)];
  const rows: CellValue[][] = [...groups.values()].map((g) => [
    ...(g.key as CellValue[]),
    ...metrics.map((m, k): CellValue => {
      const a = g.acc[k];
      switch (m.fn) {
        case 'count':
          return a.n;
        case 'sum':
          return round6(a.sum);
        case 'avg':
          return a.nums ? round6(a.sum / a.nums) : null;
        case 'min':
          return (a.min ?? null) as CellValue;
        case 'max':
          return (a.max ?? null) as CellValue;
        case 'distinct':
          return a.seen.size;
        default:
          return null;
      }
    }),
  ]);

  if (rows.length > 1) {
    const by = args.sort && args.sort.by ? String(args.sort.by) : keys.length ? header[keys.length] : '';
    if (by) {
      const i = header.findIndex((h) => h === by);
      if (i < 0) throw new QueryError(`sort.by 必须是结果里的列：${header.join('、')}`);
      const desc = args.sort ? String(args.sort.order ?? 'desc').toLowerCase() !== 'asc' : true;
      const keyed = rows.map((r, n) => ({ r, n }));
      keyed.sort((x, y) => (desc ? -1 : 1) * compare(x.r[i], y.r[i]) || x.n - y.n);
      rows.splice(0, rows.length, ...keyed.map((x) => x.r));
    }
  }
  return { header, rows, matched, total: t.rows.length };
}

const METRIC_LABEL: Record<string, string> = {
  sum: '合计',
  avg: '平均',
  min: '最小',
  max: '最大',
  distinct: '去重数',
  count: '个数',
};

// --------------------------------------------------------- expressions

/**
 * The expression language, in one place so the tool descriptions and the
 * errors can quote it.
 */
export const EXPRESSION_HELP =
  '表达式：用 [列名] 引用本行的值；运算 + - * / %，比较 = != > >= < <=，逻辑 and or not，& 连接文本；' +
  '函数 IF ROUND ABS MIN MAX SUM AVG LEN LEFT RIGHT MID UPPER LOWER TRIM CONCAT CONTAINS REPLACE YEAR MONTH DAY DATE DATEDIFF ADDDAYS TEXT NUMBER ISBLANK COALESCE ROW。' +
  '文本用引号 "…"；日期常量用 DATE(2025,5,3) 或带引号的 "2025/5/3"；ROW() 是本行的行号，从 1 开始；' +
  'TEXT(值, 格式) 按格式写成文本，格式可用 0、0.00、#,##0.00、0.00%、yyyy/m/d、yyyy-mm-dd hh:mm:ss。' +
  '例：[单价]*[数量]、IF([金额]>1000,"大单","普通")、YEAR([下单日期])&"-"&MONTH([下单日期])、"编号-"&ROW()';

type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'col'; i: number }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; name: string; args: Node[] };

interface Tok {
  k: 'num' | 'str' | 'col' | 'id' | 'op' | 'end';
  v: string;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
      if (!m) throw new QueryError(`表达式在第 ${i + 1} 个字符处有不认识的数字。`);
      out.push({ k: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'" || c === '“' || c === '‘') {
      const close = c === '“' ? '”' : c === '‘' ? '’' : c;
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== close) {
        // A backslash escapes the next character, so a quote can appear inside.
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
          continue;
        }
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new QueryError('表达式里的引号没有闭合。');
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const j = src.indexOf(']', i);
      if (j < 0) throw new QueryError('表达式里的 [ 没有闭合。');
      out.push({ k: 'col', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['>=', '<=', '!=', '<>', '==', '&&', '||'].includes(two)) {
      out.push({ k: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/%=<>&(),!'.includes(c)) {
      out.push({ k: 'op', v: c });
      i++;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (m) {
      out.push({ k: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    throw new QueryError(`表达式在第 ${i + 1} 个字符「${c}」处无法识别。列名要写在 [ ] 里，文本要加引号。`);
  }
  out.push({ k: 'end', v: '' });
  return out;
}

const FUNCTIONS: Record<string, { min: number; max: number }> = {
  IF: { min: 2, max: 3 },
  ROUND: { min: 1, max: 2 },
  ABS: { min: 1, max: 1 },
  MIN: { min: 1, max: 64 },
  MAX: { min: 1, max: 64 },
  SUM: { min: 1, max: 64 },
  AVG: { min: 1, max: 64 },
  LEN: { min: 1, max: 1 },
  LEFT: { min: 1, max: 2 },
  RIGHT: { min: 1, max: 2 },
  MID: { min: 2, max: 3 },
  UPPER: { min: 1, max: 1 },
  LOWER: { min: 1, max: 1 },
  TRIM: { min: 1, max: 1 },
  CONCAT: { min: 1, max: 64 },
  CONTAINS: { min: 2, max: 2 },
  REPLACE: { min: 3, max: 3 },
  YEAR: { min: 1, max: 1 },
  MONTH: { min: 1, max: 1 },
  DAY: { min: 1, max: 1 },
  DATE: { min: 3, max: 3 },
  DATEDIFF: { min: 2, max: 2 },
  ADDDAYS: { min: 2, max: 2 },
  TEXT: { min: 1, max: 2 },
  NUMBER: { min: 1, max: 1 },
  ISBLANK: { min: 1, max: 1 },
  COALESCE: { min: 1, max: 64 },
  ROW: { min: 0, max: 0 },
};

/** Expressions longer than this are refused; nothing a person asks for needs more. */
const MAX_EXPRESSION = 2000;
/**
 * How deep brackets, function calls and repeated `not` / `-` may nest. Each
 * level of brackets is nine frames of the descent below; 2000 characters of
 * "(" overflowed the stack, and the RangeError escaped as an internal error
 * rather than a QueryError the model could read and fix. No real expression
 * comes near this.
 */
const MAX_NESTING = 100;

function parse(t: QueryTable, src: string): Node {
  if (src.length > MAX_EXPRESSION) throw new QueryError(`表达式太长（超过 ${MAX_EXPRESSION} 字）。`);
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (...v: string[]) => peek().k === 'op' && v.includes(peek().v);
  const isWord = (...v: string[]) => peek().k === 'id' && v.includes(peek().v.toLowerCase());
  const expect = (v: string) => {
    if (!isOp(v)) throw new QueryError(`表达式缺少「${v}」。`);
    p++;
  };
  let depth = 0;
  const nested = <T>(f: () => T): T => {
    if (++depth > MAX_NESTING) throw new QueryError(`表达式嵌套太深（超过 ${MAX_NESTING} 层）。`);
    try {
      return f();
    } finally {
      depth--;
    }
  };

  const orExpr = (): Node => {
    let a = andExpr();
    while (isOp('||') || isWord('or')) {
      p++;
      a = { t: 'bin', op: 'or', a, b: andExpr() };
    }
    return a;
  };
  const andExpr = (): Node => {
    let a = notExpr();
    while (isOp('&&') || isWord('and')) {
      p++;
      a = { t: 'bin', op: 'and', a, b: notExpr() };
    }
    return a;
  };
  const notExpr = (): Node => {
    if (isOp('!') || isWord('not')) {
      p++;
      return { t: 'un', op: 'not', a: nested(notExpr) };
    }
    return cmpExpr();
  };
  const cmpExpr = (): Node => {
    const a = catExpr();
    if (isOp('=', '==', '!=', '<>', '>', '>=', '<', '<=')) {
      const op = { '==': '=', '<>': '!=' }[peek().v] || peek().v;
      p++;
      return { t: 'bin', op, a, b: catExpr() };
    }
    return a;
  };
  const catExpr = (): Node => {
    let a = addExpr();
    while (isOp('&')) {
      p++;
      a = { t: 'bin', op: '&', a, b: addExpr() };
    }
    return a;
  };
  const addExpr = (): Node => {
    let a = mulExpr();
    while (isOp('+', '-')) {
      const op = toks[p++].v;
      a = { t: 'bin', op, a, b: mulExpr() };
    }
    return a;
  };
  const mulExpr = (): Node => {
    let a = unary();
    while (isOp('*', '/', '%')) {
      const op = toks[p++].v;
      a = { t: 'bin', op, a, b: unary() };
    }
    return a;
  };
  const unary = (): Node => {
    if (isOp('-')) {
      p++;
      return { t: 'un', op: 'neg', a: nested(unary) };
    }
    if (isOp('+')) {
      p++;
      return nested(unary);
    }
    return primary();
  };
  const primary = (): Node => {
    const tok = peek();
    if (tok.k === 'num') {
      p++;
      return { t: 'lit', v: Number(tok.v) };
    }
    if (tok.k === 'str') {
      p++;
      return { t: 'lit', v: tok.v };
    }
    if (tok.k === 'col') {
      p++;
      return { t: 'col', i: columnIndex(t, tok.v) };
    }
    if (isOp('(')) {
      p++;
      const e = nested(orExpr);
      expect(')');
      return e;
    }
    if (tok.k === 'id') {
      p++;
      const word = tok.v.toLowerCase();
      if (word === 'true' || word === 'false') return { t: 'lit', v: word === 'true' };
      if (word === 'null') return { t: 'lit', v: null };
      const name = tok.v.toUpperCase();
      const spec = FUNCTIONS[name];
      if (!spec) throw new QueryError(`不认识的函数或名字「${tok.v}」。列名要写在 [ ] 里，例如 [${tok.v}]。`);
      expect('(');
      const args: Node[] = [];
      if (!isOp(')')) {
        args.push(nested(orExpr));
        while (isOp(',')) {
          p++;
          args.push(nested(orExpr));
        }
      }
      expect(')');
      if (args.length < spec.min || args.length > spec.max) {
        throw new QueryError(
          `函数 ${name} 需要 ${spec.min === spec.max ? spec.min : `${spec.min}–${spec.max}`} 个参数，给了 ${args.length} 个。`,
        );
      }
      return { t: 'call', name, args };
    }
    throw new QueryError(tok.k === 'end' ? '表达式不完整。' : `表达式里「${tok.v}」的位置不对。`);
  };

  const node = orExpr();
  if (peek().k !== 'end') throw new QueryError(`表达式在「${peek().v}」处多出了内容。`);
  return node;
}

/** Thrown inside evaluation for a row that cannot be computed; the row gets null. */
class RowError extends Error {}

function num(v: unknown): number {
  if (isBlank(v)) return 0;
  const n = toNumber(v);
  if (n === null) throw new RowError(`「${cellText(v)}」不是数字`);
  return n;
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (isBlank(v)) return false;
  if (typeof v === 'number') return v !== 0;
  const s = cellText(v).trim().toLowerCase();
  return !['0', 'false', '否', 'no', 'n'].includes(s);
}

function dateOf(v: unknown): Date {
  const d = toDate(v);
  if (!d) throw new RowError(`「${cellText(v)}」不是日期`);
  return d;
}

const DAY_MS = 86_400_000;

/** A number format TEXT understands: digits, an optional thousands comma, decimals, percent. */
const NUMBER_FORMAT_RE = /^(#,##)?0(\.(0+))?(%)?$/;
/** The date/time pieces TEXT understands; `mm` after `h` (or before `ss`) is minutes, as in Excel. */
const DATE_TOKEN_RE = /yyyy|yy|mm|m|dd|d|hh|h|ss|s/g;

/**
 * TEXT(value, format) — the part of Excel's format language a table needs.
 *
 * Numbers: `0`, `0.00`, `#,##0.00`, `0%`, `0.00%`. Dates: `yyyy/m/d`,
 * `yyyy-mm-dd hh:mm:ss` and the like. Without it there was no way to write
 * "two decimals as text" at all: `ROUND(8, 2)` is 8, and two models asked
 * for 8.00 tried `TEXT(x, "0.00")`, were refused, and one built the digits
 * by hand out of LEFT and MID — 7.96 came out "8.-4". Anything else is
 * refused, naming what works, rather than guessed at.
 */
function formatText(value: unknown, format: string): string | null {
  if (isBlank(value)) return null;
  const f = format.trim();
  const n = NUMBER_FORMAT_RE.exec(f);
  if (n) {
    const decimals = n[3] ? n[3].length : 0;
    const scaled = num(value) * (n[4] ? 100 : 1);
    // EPSILON nudges a half that binary cannot hold (7.955 is 7.95499…) up, as Excel rounds it.
    const fixed = (
      Math.round((scaled + Math.sign(scaled) * Number.EPSILON * Math.abs(scaled)) * 10 ** decimals) /
      10 ** decimals
    ).toFixed(decimals);
    const [int, frac] = fixed.split('.');
    const grouped = n[1] ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : int;
    return `${grouped}${frac ? `.${frac}` : ''}${n[4] ? '%' : ''}`;
  }
  if (/[yd]/i.test(f) || /h/i.test(f)) {
    const d = dateTimeOf(value);
    const tokens = [...f.matchAll(DATE_TOKEN_RE)].map((m) => m[0]);
    let i = -1;
    return f.replace(DATE_TOKEN_RE, (tok) => {
      i++;
      const pad = (x: number) => String(x).padStart(2, '0');
      const minutes = tok[0] === 'm' && (tokens[i - 1]?.[0] === 'h' || tokens[i + 1]?.[0] === 's');
      switch (tok) {
        case 'yyyy':
          return String(d.getUTCFullYear());
        case 'yy':
          return pad(d.getUTCFullYear() % 100);
        case 'mm':
          return pad(minutes ? d.getUTCMinutes() : d.getUTCMonth() + 1);
        case 'm':
          return String(minutes ? d.getUTCMinutes() : d.getUTCMonth() + 1);
        case 'dd':
          return pad(d.getUTCDate());
        case 'd':
          return String(d.getUTCDate());
        case 'hh':
          return pad(d.getUTCHours());
        case 'h':
          return String(d.getUTCHours());
        case 'ss':
          return pad(d.getUTCSeconds());
        default:
          return String(d.getUTCSeconds());
      }
    });
  }
  throw new RowError(
    `TEXT 不认识格式「${f}」。可用：0、0.00、#,##0.00、0%、0.00%，或日期 yyyy/m/d、yyyy-mm-dd hh:mm:ss`,
  );
}

/** A date, keeping the time of day when the text carries one (toDate keeps only the day). */
function dateTimeOf(v: unknown): Date {
  if (typeof v === 'string') {
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(v.trim());
    if (m) {
      const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x || 0));
      return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    }
  }
  return dateOf(v);
}

function evaluate(n: Node, row: unknown[], rowNo: number): unknown {
  switch (n.t) {
    case 'lit':
      return n.v;
    case 'col':
      return row[n.i] ?? null;
    case 'un': {
      const a = evaluate(n.a, row, rowNo);
      return n.op === 'not' ? !truthy(a) : isBlank(a) ? null : -num(a);
    }
    case 'bin': {
      if (n.op === 'and') return truthy(evaluate(n.a, row, rowNo)) && truthy(evaluate(n.b, row, rowNo));
      if (n.op === 'or') return truthy(evaluate(n.a, row, rowNo)) || truthy(evaluate(n.b, row, rowNo));
      const a = evaluate(n.a, row, rowNo);
      const b = evaluate(n.b, row, rowNo);
      switch (n.op) {
        case '&':
          return cellText(a) + cellText(b);
        case '+':
          return num(a) + num(b);
        case '-':
          return num(a) - num(b);
        case '*':
          return num(a) * num(b);
        case '/': {
          const d = num(b);
          if (d === 0) throw new RowError('除数为 0');
          return num(a) / d;
        }
        case '%': {
          const d = num(b);
          if (d === 0) throw new RowError('除数为 0');
          return num(a) % d;
        }
        case '=':
          return same(a, b);
        case '!=':
          return !same(a, b);
        case '>':
          return compare(a, b) > 0;
        case '>=':
          return compare(a, b) >= 0;
        case '<':
          return compare(a, b) < 0;
        case '<=':
          return compare(a, b) <= 0;
        default:
          return null;
      }
    }
    case 'call':
      return call(n, row, rowNo);
    default:
      return null;
  }
}

function call(n: Extract<Node, { t: 'call' }>, row: unknown[], rowNo: number): unknown {
  // IF and COALESCE evaluate lazily: the branch not taken may not compute
  // (a division by a zero that the condition was guarding against).
  if (n.name === 'IF') {
    return truthy(evaluate(n.args[0], row, rowNo))
      ? evaluate(n.args[1], row, rowNo)
      : n.args[2]
        ? evaluate(n.args[2], row, rowNo)
        : null;
  }
  if (n.name === 'COALESCE') {
    for (const a of n.args) {
      const v = evaluate(a, row, rowNo);
      if (!isBlank(v)) return v;
    }
    return null;
  }
  const v = n.args.map((a) => evaluate(a, row, rowNo));
  const s = (i: number) => cellText(v[i]);
  const nums = () => v.filter((x) => !isBlank(x)).map(num);
  switch (n.name) {
    case 'ROUND': {
      const d = v.length > 1 ? Math.trunc(num(v[1])) : 0;
      const f = 10 ** d;
      return isBlank(v[0]) ? null : Math.round(num(v[0]) * f) / f;
    }
    case 'ABS':
      return isBlank(v[0]) ? null : Math.abs(num(v[0]));
    case 'MIN': {
      const xs = nums();
      return xs.length ? Math.min(...xs) : null;
    }
    case 'MAX': {
      const xs = nums();
      return xs.length ? Math.max(...xs) : null;
    }
    case 'SUM':
      return nums().reduce((a, b) => a + b, 0);
    case 'AVG': {
      const xs = nums();
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    }
    case 'LEN':
      return [...s(0)].length;
    case 'LEFT':
      return [...s(0)].slice(0, v.length > 1 ? Math.max(0, Math.trunc(num(v[1]))) : 1).join('');
    case 'RIGHT': {
      const k = v.length > 1 ? Math.max(0, Math.trunc(num(v[1]))) : 1;
      const cs = [...s(0)];
      return k ? cs.slice(-k).join('') : '';
    }
    case 'MID': {
      const cs = [...s(0)];
      const from = Math.max(1, Math.trunc(num(v[1]))) - 1;
      return cs.slice(from, v.length > 2 ? from + Math.max(0, Math.trunc(num(v[2]))) : undefined).join('');
    }
    case 'UPPER':
      return s(0).toUpperCase();
    case 'LOWER':
      return s(0).toLowerCase();
    case 'TRIM':
      return s(0).trim();
    case 'CONCAT':
      return v.map(cellText).join('');
    case 'CONTAINS':
      return s(0).toLowerCase().includes(s(1).toLowerCase());
    case 'REPLACE':
      return s(1) ? s(0).split(s(1)).join(s(2)) : s(0);
    case 'YEAR':
      return isBlank(v[0]) ? null : dateOf(v[0]).getUTCFullYear();
    case 'MONTH':
      return isBlank(v[0]) ? null : dateOf(v[0]).getUTCMonth() + 1;
    case 'DAY':
      return isBlank(v[0]) ? null : dateOf(v[0]).getUTCDate();
    case 'DATE':
      return new Date(Date.UTC(num(v[0]), num(v[1]) - 1, num(v[2])));
    case 'DATEDIFF':
      return isBlank(v[0]) || isBlank(v[1])
        ? null
        : Math.round((dateOf(v[0]).getTime() - dateOf(v[1]).getTime()) / DAY_MS);
    case 'ADDDAYS':
      return isBlank(v[0]) ? null : new Date(dateOf(v[0]).getTime() + Math.round(num(v[1])) * DAY_MS);
    case 'TEXT':
      return v.length > 1 ? formatText(v[0], s(1)) : s(0);
    case 'NUMBER':
      return isBlank(v[0]) ? null : num(v[0]);
    case 'ISBLANK':
      return isBlank(v[0]);
    case 'ROW':
      return rowNo;
    default:
      return null;
  }
}

/** A compiled expression: `(row, rowNo)` → value. A row that cannot compute throws `RowError`. */
export type Compiled = (row: unknown[], rowNo: number) => unknown;

/**
 * A date written without quotes — `2025/5/3`, `2025-05-03` — anywhere in the
 * expression, or null.
 *
 * It parses, as two divisions or two subtractions, and evaluates to 135 or
 * 2017. Seen in a real run: a column meant to read 2025/5/3 came out 135 in
 * every row, and nothing said so. No one means year/month/day as arithmetic,
 * so it is refused with the two spellings that work. Recognised only as
 * three literals, a plausible year first, under one repeated operator.
 */
function bareDate(n: Node): { text: string; value: number; parts: number[] } | null {
  if (n.t === 'bin' && (n.op === '/' || n.op === '-') && n.a.t === 'bin' && n.a.op === n.op) {
    const parts = [n.a.a, n.a.b, n.b].map((x) => (x.t === 'lit' && typeof x.v === 'number' ? x.v : NaN));
    const [y, m, d] = parts;
    if (Number.isInteger(y) && y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      if (Number.isInteger(m) && Number.isInteger(d)) {
        const value = n.op === '/' ? y / m / d : y - m - d;
        return { text: parts.join(n.op), value, parts };
      }
    }
  }
  const kids = n.t === 'un' ? [n.a] : n.t === 'bin' ? [n.a, n.b] : n.t === 'call' ? n.args : [];
  for (const k of kids) {
    const hit = bareDate(k);
    if (hit) return hit;
  }
  return null;
}

/**
 * Compile an expression against a table's header.
 *
 * Column references are resolved now, so a typo in a column name is one
 * error for the whole call, not a null in every row.
 */
export function compileExpression(t: QueryTable, src: string): Compiled {
  const node = parse(t, String(src ?? ''));
  const date = bareDate(node);
  if (date) {
    throw new QueryError(
      `表达式里的 ${date.text} 没有引号，会被当成算式（结果是 ${round6(date.value)}）。` +
        `要写日期，请用 DATE(${date.parts.join(',')})，或写成带引号的文本 "${date.text}"。`,
    );
  }
  return (row, rowNo) => {
    const v = evaluate(node, row, rowNo);
    if (typeof v === 'number') return Number.isFinite(v) ? round6(v) : null;
    return v;
  };
}

/**
 * Evaluate an expression over chosen rows.
 *
 * A row whose value cannot be computed (text where a number was needed, a
 * division by zero) gets null and is counted: one bad cell in 900 should not
 * refuse the other 899, and it should not pass silently either.
 */
export function computeRows(
  t: QueryTable,
  src: string,
  indices: number[],
): { values: Map<number, unknown>; failed: Array<{ row: number; reason: string }> } {
  const fn = compileExpression(t, src);
  const values = new Map<number, unknown>();
  const failed: Array<{ row: number; reason: string }> = [];
  for (const i of indices) {
    try {
      values.set(i, fn(t.rows[i], i + 1));
    } catch (err) {
      if (!(err instanceof RowError)) throw err;
      values.set(i, null);
      failed.push({ row: i + 1, reason: err.message });
    }
  }
  return { values, failed };
}

/** A short, model-readable account of rows that could not be computed. */
export function describeFailures(failed: Array<{ row: number; reason: string }>): string {
  if (!failed.length) return '';
  const shown = failed
    .slice(0, 5)
    .map((f) => `第 ${f.row} 行（${f.reason}）`)
    .join('、');
  return `；${failed.length} 行无法计算，已留空：${shown}${failed.length > 5 ? ' 等' : ''}`;
}

/** An aggregate result as tab-separated lines, for a tool result. */
export function formatAggregate(r: AggregateResult, maxRows = 200): string {
  const shown = r.rows.slice(0, maxRows);
  const lines = [r.header.join('\t'), ...shown.map((row) => row.map(cellText).join('\t'))];
  const more = r.rows.length > shown.length ? `\n（共 ${r.rows.length} 组，只列出前 ${shown.length} 组）` : '';
  return lines.join('\n') + more;
}
