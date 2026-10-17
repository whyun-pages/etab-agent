'use strict';
/**
 * Whether a normalised spec is worth writing, and a short count of what is in
 * it.
 */

import type { WorkbookSpec, ValidateResult, SpecStats } from './spec-types.ts';

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

  const cellCount = spec.sheets.reduce((n, s) => n + (s.rows || []).reduce((m, r) => m + (r ? r.length : 0), 0), 0);

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

// ------------------------------------------------------------------- stats

/** A short summary for the UI: what is in this workbook. */
export function specStats(spec: WorkbookSpec | null | undefined): SpecStats {
  const sheets = (spec && spec.sheets) || [];
  const rows = sheets.reduce((n, s) => n + (s.rows || []).length, 0);
  const cols = sheets.reduce((n, s) => n + (s.columns || []).length, 0);
  return { sheets: sheets.length, rows, columns: cols };
}
