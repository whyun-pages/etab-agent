'use strict';
/**
 * `query_table`: exact filtering and statistics over a sheet or an
 * attachment, so the model never counts rows itself. With `saveAs` the result
 * becomes a new sheet. The query language is src/workbook/table-query.ts.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  aggregate,
  selectRows,
  formatAggregate,
  tsvCell,
  METRIC_FNS,
  QueryError,
} from '../../../workbook/table-query.ts';
import type { QueryTable } from '../../../workbook/table-query.ts';
import { isoDay } from '../../../workbook/workbook.ts';
import type { WorkbookSpec } from '../../../workbook/workbook.ts';
import type { Attachment } from '../../types.ts';
import { findAttachment, attachmentTable } from '../../../ingest/select.ts';
import { attachmentFrame } from '../attachments.ts';
import { textResult } from '../tool-context.ts';
import type { ToolContext } from '../tool-context.ts';

/** Groups listed by an aggregate; the rest are counted. */
const QUERY_MAX_GROUPS = 200;
/** Matching rows listed by a query without metrics. */
const QUERY_MAX_ROWS = 100;

export function queryTableTool({ state, caps, addTable, schemas }: ToolContext): AgentTool<any> {
  const { Type, StringEnum, Sheet, Where, Match } = schemas;
  const { canEdit } = caps;
  return {
    name: 'query_table',
    label: '查询统计',
    description: [
      '对工作表或附件的全部行做精确的筛选和统计（计数、求和、平均、最大最小、去重数），不用自己数。',
      '- 不给 groupBy/metrics：列出符合 where 的行（带行号，行号可直接用于修改工具）。',
      '- 给 groupBy 和/或 metrics：分组统计；groupBy 的一项可以是表达式，如 MONTH([下单日期])。',
      '- attachment：查询附件而不是工作表。saveAs：把结果做成新工作表（透视表、汇总表）。',
    ].join('\n'),
    parameters: Type.Object({
      attachment: Type.Optional(Type.String({ description: '附件名；省略则查询当前工作簿' })),
      sheet: Sheet,
      where: Type.Optional(Where),
      match: Match,
      groupBy: Type.Optional(Type.Array(Type.String(), { description: '分组的列名或表达式' })),
      metrics: Type.Optional(
        Type.Array(
          Type.Object({
            fn: StringEnum([...METRIC_FNS]),
            column: Type.Optional(Type.String({ description: '列名或表达式；count 可省略（数行数）' })),
            as: Type.Optional(Type.String({ description: '结果列名' })),
          }),
        ),
      ),
      sort: Type.Optional(
        Type.Object({
          by: Type.String({ description: '按结果里的哪一列排序' }),
          order: Type.Optional(StringEnum(['asc', 'desc'])),
        }),
      ),
      saveAs: Type.Optional(Type.String({ description: '把结果做成新工作表时的表名' })),
    }),
    execute: async (_id, args) => {
      const a = args as Record<string, unknown>;
      const source = querySource(state.draft, caps.attachments, a);
      const saveAs = String(a.saveAs ?? '').trim();
      if (saveAs && !canEdit) throw new Error('当前为只读模式，不能把结果做成工作表。可以不带 saveAs 只查询。');
      const grouped = (Array.isArray(a.groupBy) && a.groupBy.length) || (Array.isArray(a.metrics) && a.metrics.length);
      try {
        if (grouped) {
          const r = aggregate(source.table, a as Parameters<typeof aggregate>[1]);
          const head = `${source.label}：共 ${r.total} 行，${r.matched === r.total ? '全部参与统计' : `符合条件的 ${r.matched} 行参与统计`}（精确值）。`;
          const body = formatAggregate(r, QUERY_MAX_GROUPS);
          if (!saveAs) return textResult(`${source.frame}${head}\n${body}`);
          const columns = r.header.map((h, i) => ({ header: h, type: columnTypeOf(r.rows.map((row) => row[i])) }));
          return textResult(`${addTable(saveAs, columns, r.rows)}\n${head}\n${body}`);
        }
        const hits = selectRows(source.table, a as Parameters<typeof selectRows>[1]);
        if (saveAs) {
          const t = source.table;
          const columns = t.header.map((h, i) => ({
            header: h,
            type: source.types[i] || columnTypeOf(hits.map((n) => t.rows[n][i])),
          }));
          return textResult(
            `${addTable(
              saveAs,
              columns,
              hits.map((n) => t.rows[n].map(plainCell)),
            )}（${hits.length} 行）`,
          );
        }
        const shown = hits.slice(0, QUERY_MAX_ROWS);
        const more =
          hits.length > shown.length ? `，只列出前 ${shown.length} 行（要全部处理时用 where 条件，不要逐行操作）` : '';
        const lines = shown.map((n) => `${n + 1}\t${source.table.rows[n].map(tsvCell).join('\t')}`);
        return textResult(
          `${source.frame}${source.label}：共 ${source.table.rows.length} 行，符合条件的 ${hits.length} 行${more}。第一列是行号。\n行号\t${source.table.header.map(tsvCell).join('\t')}\n${lines.join('\n')}`,
        );
      } catch (err) {
        // Same wording either way; the class only matters for not hiding a bug.
        if (err instanceof QueryError) throw new Error(err.message);
        throw err;
      }
    },
  };
}

/** What `query_table` runs over: a workbook sheet or an attachment's table. */
interface QuerySource {
  table: QueryTable;
  /** column types when known (a workbook sheet), for saveAs */
  types: string[];
  /** names the source in the result: 工作表「明细」 / 附件「订单.xlsx」 */
  label: string;
  /** the not-instructions framing, for attachments; empty for the workbook */
  frame: string;
}

function querySource(draft: WorkbookSpec | null, attachments: Attachment[], a: Record<string, unknown>): QuerySource {
  const attName = String(a.attachment ?? '').trim();
  if (attName) {
    const att = findAttachment(attachments, attName);
    const t = attachmentTable(att, a.sheet);
    if (!t) throw new Error(`附件「${att.name}」不是表格，不能查询。可以用 read_attachment 读它的文本。`);
    const label = `附件「${att.name}」${t.sheet && (att.sheets || []).length > 1 ? `的工作表「${t.sheet}」` : ''}`;
    return { table: { header: t.header, rows: t.rows }, types: [], label, frame: `${attachmentFrame(att)}\n` };
  }
  if (!draft || !draft.sheets.length) {
    throw new Error(
      attachments.length
        ? '还没有表格。要查询附件请传 attachment（附件名）。'
        : '还没有表格，也没有附件，没有可查询的内容。',
    );
  }
  const want = String(a.sheet ?? '').trim();
  let sheet = draft.sheets[0];
  if (want) {
    const hit =
      draft.sheets.find((s) => s.name === want) ||
      draft.sheets.find((s) => s.name.toLowerCase() === want.toLowerCase());
    if (!hit) throw new Error(`没有名为「${want}」的工作表。现有：${draft.sheets.map((s) => s.name).join('、')}`);
    sheet = hit;
  } else if (draft.sheets.length > 1) {
    throw new Error(
      `工作簿有 ${draft.sheets.length} 个工作表，请指明 sheet：${draft.sheets.map((s) => `「${s.name}」`).join('、')}`,
    );
  }
  return {
    table: { header: sheet.columns.map((c) => c.header), rows: sheet.rows },
    types: sheet.columns.map((c) => c.type),
    label: `工作表「${sheet.name}」`,
    frame: '',
  };
}

/** A column type for query output, from its values. */
function columnTypeOf(values: unknown[]): string {
  const present = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (!present.length) return 'text';
  if (present.every((v) => v instanceof Date)) return 'date';
  if (present.every((v) => typeof v === 'number'))
    return present.every((v) => Number.isInteger(v)) ? 'integer' : 'number';
  return 'text';
}

/** A cell for an op's arguments: dates as text, which is how the op log stores them. */
function plainCell(v: unknown): unknown {
  return v instanceof Date ? isoDay(v) : (v ?? null);
}
