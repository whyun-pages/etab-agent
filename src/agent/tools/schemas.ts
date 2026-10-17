'use strict';
/**
 * Schema pieces several tools share: a cell, a row, a sheet name, a column
 * definition, a where-list.
 *
 * Built per turn, not at module load, because `Type` and `StringEnum` come
 * from pi-ai and pi-ai is only reachable through `loadPi()` (see
 * src/agent/pi.ts). Enums use pi-ai's `StringEnum` rather than a union of
 * literals: Gemini rejects the `anyOf`/`const` shape a literal union compiles
 * to.
 */

import { CONDITION_OPS } from '../../workbook/table-query.ts';
import { TYPES } from '../../workbook/workbook.ts';
import type { Pi } from '../pi.ts';

export type Schemas = ReturnType<typeof buildSchemas>;

export function buildSchemas(ai: Pi['ai']) {
  const { Type, StringEnum } = ai;
  const Cell = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
  const Row = Type.Array(Cell);
  const Sheet = Type.Optional(Type.String({ description: '工作表名；只有一个工作表时可省略' }));
  const ColType = StringEnum(TYPES);
  const ColumnDef = Type.Object({ header: Type.String({ description: '列名' }), type: ColType });
  const Where = Type.Array(
    Type.Object({
      column: Type.String({ description: '列名' }),
      op: StringEnum([...CONDITION_OPS]),
      value: Type.Optional(
        Type.Union([Cell, Type.Array(Cell)], { description: 'in/not_in 时是数组；empty/not_empty 不需要' }),
      ),
    }),
    { description: '筛选条件' },
  );
  const Match = Type.Optional(
    StringEnum(['all', 'any'], { description: '多个条件：all 全部满足（默认），any 满足任一' }),
  );
  return { Type, StringEnum, Cell, Row, Sheet, ColType, ColumnDef, Where, Match };
}
