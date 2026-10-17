'use strict';
/**
 * Picking one thing out of what was ingested: the attachment a name refers
 * to, the table (or sheet) inside it, and the one note about a table that has
 * a header and nothing under it.
 *
 * Here rather than in agent/tools because none of it is a tool's wording: the
 * HTTP layer composes the attachment block the model reads from the same
 * pieces (src/http/projections.ts), and nothing below the agent should have
 * to reach into tools/ for them.
 */

import type { Attachment, Table } from './types.ts';

/**
 * The attachment a name refers to.
 *
 * Exact first, then ignoring case, then a unique prefix-less match — a model
 * that drops the folder of `订单/BTCP.xlsx` or the extension still means one
 * file. An ambiguous or missing name lists what there is, so the next call can
 * be right.
 */
export function findAttachment(list: Attachment[], name: string): Attachment {
  const want = name.trim();
  const lower = want.toLowerCase();
  const stem = (n: string) =>
    n
      .toLowerCase()
      .replace(/^.*[\\/]/, '')
      .replace(/\.[^.]+$/, '');
  for (const match of [
    (a: Attachment) => a.name === want,
    (a: Attachment) => a.name.toLowerCase() === lower,
    (a: Attachment) => stem(a.name) === stem(want),
  ]) {
    const hits = list.filter(match);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1)
      throw new Error(`有 ${hits.length} 个附件都叫「${want}」，请用完整的名字：${hits.map((a) => a.name).join('、')}`);
  }
  throw new Error(`没有名为「${want}」的附件。现有：${list.map((a) => a.name).join('、')}`);
}

/** The table of an attachment, or of one of its sheets; null for a text file. */
export function attachmentTable(att: Attachment, sheet: unknown): Table | null {
  const want = sheet == null ? '' : String(sheet).trim();
  if (want) {
    const hit = (att.sheets || []).find((t) => String(t.sheet || '').toLowerCase() === want.toLowerCase());
    if (!hit) {
      const names = (att.sheets || []).map((t) => t.sheet).filter(Boolean);
      throw new Error(
        names.length
          ? `附件「${att.name}」里没有工作表「${want}」。现有：${names.join('、')}（sheet 指附件文件里的表；导入后想叫什么名字请用 importAs）`
          : `附件「${att.name}」只有一张表，不用指定 sheet。`,
      );
    }
    return hit;
  }
  return att.kind === 'table' || att.table ? att.table || null : null;
}

/**
 * Said wherever a table with a header and no data rows is shown to the model.
 *
 * A report downloaded for a day with no sales is exactly that, and the model
 * shown "共 0 行" concluded the file could not be read: four turns asking the
 * user to re-save the .xls as .xlsx, the one thing that would not help. The
 * header was read; the rows are not there to read.
 */
export function headerOnlyNote(columns: number): string {
  return `这张表只有表头（${columns} 列），没有数据行。这是文件本身的内容，不是读取失败；照常处理，结果就是一张只有表头的表。`;
}
