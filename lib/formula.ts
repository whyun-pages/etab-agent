'use strict';
/**
 * Minimal formula evaluator, scoped to what a shifted totals row needs.
 *
 * Why this exists
 * ---------------
 * When rows are inserted above a totals footer, the footer's SUM is rewritten
 * to cover the new rows — but the cached `<v>` beside it still holds the old
 * total. Excel recalculates on open (`fullCalcOnLoad="1"` is already written),
 * yet anything reading the file *without* Excel — our own preview, a downstream
 * parser, pandas, a spreadsheet library — sees the stale number and believes it.
 *
 * So the generated file must be internally consistent on its own: cached value
 * equals the formula evaluated against the cells currently in the sheet.
 *
 * Scope, deliberately narrow
 * --------------------------
 * Aggregates over a rectangular range of same-sheet cells, with numeric
 * arguments. Anything outside that — nested functions, other sheets, named
 * ranges, IF/LOOKUP, array formulas — returns `null`, and the caller keeps the
 * original cached value rather than guessing. An unknown formula is not a
 * number, and inventing one would be worse than a stale value: a stale value at
 * least comes from the template's own data.
 */

/**
 * The part of a parsed cell this evaluator looks at.
 *
 * Structural on purpose: `lib/xlsx.js` owns the full cell shape, and importing
 * it here would make the evaluator depend on the XML layer for three fields.
 */
interface FormulaCell {
  ref: string;
  col: number;
  row: number;
  value: unknown;
  formula?: string | null;
}

/** "col,row" -> cell, as built by the caller. */
type Grid = Map<string, FormulaCell>;

interface Ref {
  col: number;
  row: number;
}

/** How each supported aggregate folds a list of numbers. */
interface Aggregates {
  SUM: (nums: number[]) => number;
  AVERAGE: (nums: number[]) => number | null;
  MIN: (nums: number[]) => number;
  MAX: (nums: number[]) => number;
  COUNT: (nums: number[]) => number;
}

/** Functions this evaluator understands, and how they fold a numeric list. */
export const AGGREGATES: Aggregates = {
  SUM: (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) : 0),
  AVERAGE: (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null),
  MIN: (nums) => (nums.length ? Math.min(...nums) : 0),
  MAX: (nums) => (nums.length ? Math.max(...nums) : 0),
  COUNT: (nums) => nums.length,
};

/** Split on top-level commas — commas inside nested parens do not split. */
export function splitArgs(text: string): string[] {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** `$COL$ROW` -> {col, row}; null when malformed. */
function parseRefStrict(text: string): Ref | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(text.trim());
  if (!m) return null;
  return { col: colToIndex(m[1]), row: Number(m[2]) };
}

/**
 * Expand one argument into the numeric values it contributes.
 *
 * `null` when the argument cannot be resolved.
 */
function argToNumbers(arg: string, grid: Grid): number[] | null {
  // Literal number, possibly signed or with a decimal point.
  if (/^[-+]?\d+(\.\d+)?$/.test(arg)) return [Number(arg)];

  // A range: expand every cell in the rectangle.
  const rangeMatch = /^(\$?[A-Z]{1,3}\$?\d+):(\$?[A-Z]{1,3}\$?\d+)$/i.exec(arg);
  if (rangeMatch) {
    const start = parseRefStrict(rangeMatch[1]);
    const end = parseRefStrict(rangeMatch[2]);
    if (!start || !end) return null;
    const r1 = Math.min(start.row, end.row);
    const r2 = Math.max(start.row, end.row);
    const c1 = Math.min(start.col, end.col);
    const c2 = Math.max(start.col, end.col);
    const nums: number[] = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const cell = grid.get(c + ',' + r);
        // Blank cells contribute nothing to SUM/AVERAGE/MIN/MAX, matching
        // Excel. A cell holding text is likewise skipped by these functions.
        if (!cell) continue;
        // A formula cell inside the range carries a cache we have no reason to
        // trust — this whole routine exists because formula caches go stale.
        // Adding it blindly would produce a total that is wrong in a way the
        // user cannot see; refuse the argument instead and let the caller keep
        // the template's own value.
        if (cell.formula) return null;
        if (typeof cell.value === 'number' && Number.isFinite(cell.value)) nums.push(cell.value);
      }
    }
    return nums;
  }

  // A single cell reference: numeric or nothing.
  const single = parseRefStrict(arg);
  if (single) {
    const cell = grid.get(single.col + ',' + single.row);
    if (!cell) return [];
    if (cell.formula) return null;
    if (typeof cell.value === 'number' && Number.isFinite(cell.value)) return [cell.value];
    return [];
  }

  // Anything else (another function, a name, a string) is out of scope.
  return null;
}

/**
 * Evaluate a formula against the cells of one sheet.
 *
 * @param formula e.g. `SUM(B4:B6)`
 * @param grid    "col,row" -> {value}
 * @returns null when out of scope
 */
export function evaluateFormula(formula: string, grid: Grid): number | null {
  if (typeof formula !== 'string') return null;
  const text = formula.trim();
  if (text.startsWith('=')) return null;

  const m = /^([A-Z]+)\s*\((.*)\)$/is.exec(text);
  if (!m) return null;

  const fn = m[1].toUpperCase();
  const fold = AGGREGATES[fn as keyof Aggregates];
  if (!fold) return null;

  const args = splitArgs(m[2]);
  if (!args.length) return null;

  let nums: number[] = [];
  for (const arg of args) {
    const part = argToNumbers(arg, grid);
    if (part === null) return null; // an unresolvable argument voids the whole result
    nums = nums.concat(part);
  }

  const result = fold(nums);
  return typeof result === 'number' && Number.isFinite(result) ? result : null;
}

interface RecomputedValue {
  ref: string;
  from: unknown;
  to: number;
}

interface RecomputeResult<T extends FormulaCell> {
  cells: T[];
  recomputed: RecomputedValue[];
  unresolved: string[];
}

/**
 * Recompute the cached value for every formula cell that can be evaluated in
 * place, and report which ones could not be.
 *
 * The sheet is treated as a whole so a formula may reference any cell, but only
 * cells present in the list are visible — that is exactly the post-render state.
 */
export function recomputeCachedValues<T extends FormulaCell>(cells: T[]): RecomputeResult<T> {
  // Every cell is visible to the evaluator, including formula cells — the
  // evaluator needs to *see* them so it can refuse a range that contains one.
  const grid: Grid = new Map();
  for (const c of cells) grid.set(c.col + ',' + c.row, c);

  const recomputed: RecomputedValue[] = [];
  const unresolved: string[] = [];

  const out = cells.map((c) => {
    if (!c.formula) return c;
    const value = evaluateFormula(c.formula, grid);
    if (value === null) {
      unresolved.push(c.ref);
      return c;
    }
    if (c.value !== value) {
      recomputed.push({ ref: c.ref, from: c.value, to: value });
    }
    return { ...c, value };
  });

  return { cells: out, recomputed, unresolved };
}
