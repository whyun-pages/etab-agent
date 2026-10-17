'use strict';
/**
 * Rows into a table: which row is the header, what each column holds, and
 * the light coercion that lets "1,200" and "13%" count as numbers.
 */

import type { CellValue, Table } from './types.ts';

// ------------------------------------------------------------------- tables

/** Options for text → rows scoring: numbers and dates are strong data signals. */
const NUMERIC_RE = /^-?[\d,]+(\.\d+)?%?$/;

/**
 * Convert a matrix (CSV rows or sheet rows) into a table with a header row and
 * typed columns, reusing the same inference rules as template schemas.
 */
export function matrixToTable(rows: unknown[][], { sheetName = null }: { sheetName?: string | null } = {}): Table {
  const clean = rows.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''));
  if (!clean.length) return { header: [], rows: [], columns: [] };

  const headerIdx = detectHeaderRow(clean);
  const header = (clean[headerIdx] || []).map((h, i) => {
    const t = h === null || h === undefined ? '' : String(h).trim();
    return t || '列' + (i + 1);
  });
  const data = clean.slice(headerIdx + 1).map((r) => {
    const out: unknown[] = [];
    for (let i = 0; i < header.length; i++) {
      const v = r[i];
      // Normalise "absent" to null so callers never branch on undefined vs ''.
      out.push(v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : v);
    }
    return out;
  });

  const columns = header.map((label, i) => {
    const values = data.map((r) => coerce(r[i])).filter((v): v is CellValue => v !== null && v !== '');
    return {
      index: i,
      label,
      values,
      type: columnType(values, label),
    };
  });

  // `rows` keeps the RAW cell values (only absent normalised to null); `columns`
  // carries the coerced copies. Callers read the two differently — a sheet
  // round-trip wants the text Excel holds, the inference wants the number.
  return { sheet: sheetName, header, rows: data as CellValue[][], columns, headerIndex: headerIdx };
}

/** Pick the first row that looks like labels rather than data. */
export function detectHeaderRow(rows: unknown[][]): number {
  const limit = Math.min(rows.length, 8);
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let r = 0; r < limit; r++) {
    const row = rows[r];
    let score = 0;
    for (const cell of row) {
      const s = cell === null || cell === undefined ? '' : String(cell).trim();
      if (!s) continue;
      // Text that is not a bare number reads as a label.
      if (!NUMERIC_RE.test(s) && !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(s)) score += 2;
      else score -= 1;
    }
    // Prefer earlier rows when scores tie, and reward filling the row.
    score -= r * 0.1;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = r;
    }
  }
  return bestIdx;
}

/** Turn a raw string cell into a number/date/string where obvious. */
export function coerce(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  const s = String(v).trim();
  if (s === '') return null;
  if (NUMERIC_RE.test(s)) {
    const cleaned = s.replace(/[,\s]/g, '').replace(/%$/, '');
    const n = Number(cleaned);
    if (Number.isFinite(n)) return /%$/.test(s) ? n / 100 : n;
  }
  return s;
}

export function columnType(values: CellValue[], label: string): string {
  if (!values.length) return 'text';
  const numeric = values.filter((v) => typeof v === 'number').length;
  const dates = values.filter(
    (v) => v instanceof Date || (typeof v === 'string' && /^\d{4}[-/年]\d{1,2}([-/月]\d{1,2})?/.test(v)),
  ).length;
  const bools = values.filter((v) => typeof v === 'boolean').length;
  const total = values.length;
  if (bools / total > 0.8) return 'boolean';
  if (dates / total > 0.7) return 'date';
  if (numeric / total > 0.8) {
    if (/金额|单价|价格|总额|合计|费用|成本|税率|价|amount|price|total|cost/i.test(label)) return 'currency';
    if (values.every((v) => typeof v !== 'number' || Number.isInteger(v))) return 'integer';
    return 'number';
  }
  return 'text';
}
