'use strict';
/**
 * The editing tools: one per operation in src/workbook/spec-ops.ts, each
 * applying it to the turn's draft and logging it for the server's replay.
 *
 * One table, not one file per tool: every entry is a name, a label, a
 * description and a schema, and they all execute the same way. Keeping the
 * schema in the same entry as the description means a tool cannot be added
 * with one and not the other.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TSchema } from '@earendil-works/pi-ai';
import type { SpecOp } from '../../../workbook/spec-ops.ts';
import { EXPRESSION_HELP } from '../../../workbook/table-query.ts';
import type { Schemas } from '../schemas.ts';
import { textResult } from '../tool-context.ts';
import type { ToolContext } from '../tool-context.ts';

interface EditTool {
  label: string;
  /** what the model reads to choose the tool */
  description: string;
  params: (s: Schemas) => TSchema;
}

/** In the order they are offered. */
const EDIT_TOOLS: Record<string, EditTool> = {
  create_workbook: {
    label: '新建工作簿',
    description: '新建整个工作簿，或在用户明确要求时推倒重做。会替换现有的全部内容。',
    params: ({ Type, ColumnDef, Row }) =>
      Type.Object({
        title: Type.String({ description: '工作簿标题' }),
        sheets: Type.Array(
          Type.Object({
            name: Type.String(),
            columns: Type.Array(ColumnDef),
            rows: Type.Array(Row),
            totals: Type.Optional(
              Type.Object({ sumColumns: Type.Array(Type.String({ description: '要合计的列名' })) }),
            ),
          }),
        ),
      }),
  },
  add_columns: {
    label: '新增列',
    description:
      '在工作表中新增一列或多列。before 指定插在哪一列之前，省略则加在最后；values 按行顺序给出已有各行的值，可省略。',
    params: ({ Type, Sheet, ColType, Cell }) =>
      Type.Object({
        sheet: Sheet,
        columns: Type.Array(
          Type.Object({
            header: Type.String(),
            type: ColType,
            before: Type.Optional(Type.String({ description: '插在这一列之前' })),
            values: Type.Optional(Type.Array(Cell, { description: '已有各行在新列的值，按行顺序' })),
          }),
        ),
      }),
  },
  remove_columns: {
    label: '删除列',
    description: '按列名删除一列或多列。',
    params: ({ Type, Sheet }) => Type.Object({ sheet: Sheet, headers: Type.Array(Type.String()) }),
  },
  update_columns: {
    label: '修改列',
    description: '修改列名或列类型（changes），或用 order 给出全部列的新顺序。',
    params: ({ Type, Sheet, ColType }) =>
      Type.Object({
        sheet: Sheet,
        changes: Type.Optional(
          Type.Array(
            Type.Object({
              header: Type.String({ description: '现在的列名' }),
              newHeader: Type.Optional(Type.String()),
              type: Type.Optional(ColType),
            }),
          ),
        ),
        order: Type.Optional(Type.Array(Type.String(), { description: '全部列名的新顺序' })),
      }),
  },
  add_rows: {
    label: '新增行',
    description: '新增一行或多行，每行按列顺序给出值。before 是行号，插在该行之前；省略则加在末尾。',
    params: ({ Type, Sheet, Row }) =>
      Type.Object({
        sheet: Sheet,
        rows: Type.Array(Row),
        before: Type.Optional(Type.Integer({ description: '插在这一行之前（行号从 1 开始）' })),
      }),
  },
  update_cells: {
    label: '修改单元格',
    description: '按行号和列名修改单元格的值。行号从 1 开始，不含表头。',
    params: ({ Type, Sheet, Cell }) =>
      Type.Object({
        sheet: Sheet,
        cells: Type.Array(Type.Object({ row: Type.Integer(), column: Type.String(), value: Cell })),
      }),
  },
  delete_rows: {
    label: '删除行',
    description:
      '删除行：rows 按行号（都指删除之前的编号），或 where 按条件删除所有符合的行（二选一）。只有用户明确要求删除时才使用。',
    params: ({ Type, Sheet, Where, Match }) =>
      Type.Object({
        sheet: Sheet,
        rows: Type.Optional(Type.Array(Type.Integer())),
        where: Type.Optional(Where),
        match: Match,
      }),
  },
  update_rows: {
    label: '批量修改',
    description: '把符合 where 条件的所有行（省略 where 则是全部行）的若干列改为固定值，set 以列名为键。',
    params: ({ Type, Sheet, Where, Match, Cell }) =>
      Type.Object({
        sheet: Sheet,
        where: Type.Optional(Where),
        match: Match,
        set: Type.Record(Type.String(), Cell, { description: '列名 → 新值' }),
      }),
  },
  compute_column: {
    label: '计算列',
    description: `用表达式逐行计算一列：列已存在则覆盖（可用 where 只算部分行），不存在则新增。${EXPRESSION_HELP}`,
    params: ({ Type, Sheet, ColType, Where, Match }) =>
      Type.Object({
        sheet: Sheet,
        column: Type.String({ description: '要写入的列名；不存在则新增' }),
        expression: Type.String({ description: '逐行计算的表达式，用 [列名] 引用本行的值' }),
        type: Type.Optional(ColType),
        where: Type.Optional(Where),
        match: Match,
        before: Type.Optional(Type.String({ description: '新增列时插在这一列之前' })),
      }),
  },
  lookup_columns: {
    label: '跨表引用',
    description: '按关键列匹配，把另一个工作表（fromSheet）的若干列带到本表，类似 VLOOKUP；匹配不到的行留空。',
    params: ({ Type, Sheet }) =>
      Type.Object({
        sheet: Sheet,
        key: Type.String({ description: '本表用来匹配的列' }),
        fromSheet: Type.String({ description: '数据来源的工作表' }),
        fromKey: Type.Optional(Type.String({ description: '来源表里对应的列；与 key 同名时可省略' })),
        columns: Type.Array(Type.String(), { description: '要带过来的列' }),
        names: Type.Optional(Type.Array(Type.String(), { description: '带过来后的列名，按 columns 顺序；省略则同名' })),
      }),
  },
  sort_rows: {
    label: '排序',
    description: '按某一列排序，空值总在最后。',
    params: ({ Type, StringEnum, Sheet }) =>
      Type.Object({
        sheet: Sheet,
        by: Type.String({ description: '按哪一列' }),
        order: Type.Optional(StringEnum(['asc', 'desc'])),
      }),
  },
  set_totals: {
    label: '合计行',
    description: '加上或去掉合计行。sumColumns 是要合计的列名，只放可加的数值列。',
    params: ({ Type, Sheet }) =>
      Type.Object({
        sheet: Sheet,
        enabled: Type.Boolean(),
        sumColumns: Type.Optional(Type.Array(Type.String())),
        label: Type.Optional(Type.String()),
      }),
  },
  add_sheet: {
    label: '新增工作表',
    description: '新增一个工作表。',
    params: ({ Type, ColumnDef, Row }) =>
      Type.Object({
        name: Type.String(),
        columns: Type.Array(ColumnDef),
        rows: Type.Optional(Type.Array(Row)),
      }),
  },
  remove_sheet: {
    label: '删除工作表',
    description: '删除一个工作表。',
    params: ({ Type }) => Type.Object({ sheet: Type.String() }),
  },
  rename: {
    label: '改名',
    description: '修改工作簿标题（title），或给工作表改名（sheet + newName）。',
    params: ({ Type }) =>
      Type.Object({
        title: Type.Optional(Type.String()),
        sheet: Type.Optional(Type.String()),
        newName: Type.Optional(Type.String()),
      }),
  },
};

export function editTools(ctx: ToolContext): AgentTool<any>[] {
  return Object.entries(EDIT_TOOLS).map(([name, t]) => ({
    name,
    label: t.label,
    description: t.description,
    parameters: t.params(ctx.schemas),
    execute: async (_id, args) => {
      // A copy, recorded only on success: this list is replayed later against
      // the stored spec, and an arguments object the loop still holds must
      // not be able to change it afterwards.
      const op: SpecOp = { op: name, args: JSON.parse(JSON.stringify(args)) };
      return textResult(ctx.record(op));
    },
  }));
}
