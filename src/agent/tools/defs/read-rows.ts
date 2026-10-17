'use strict';
/** `read_rows`: a page of the draft's rows, for when the summary did not list them all. */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { readRows } from '../../../workbook/spec-ops.ts';
import { textResult } from '../tool-context.ts';
import type { ToolContext } from '../tool-context.ts';

export function readRowsTool({ state, schemas: { Type, Sheet } }: ToolContext): AgentTool<any> {
  return {
    name: 'read_rows',
    label: '读取行',
    description: '读取某个工作表的一段行（带行号）。当前状态没有列出全部行时使用。一次最多 200 行。',
    parameters: Type.Object({
      sheet: Sheet,
      from: Type.Integer({ description: '起始行号，从 1 开始' }),
      to: Type.Optional(Type.Integer()),
    }),
    execute: async (_id, args) => textResult(readRows(state.draft, args as Record<string, unknown>)),
  };
}
