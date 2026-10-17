'use strict';
/** `ask_user`: one question back to the user when an edit lacks what it needs. Ends the turn. */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { textResult } from '../tool-context.ts';
import type { ToolContext } from '../tool-context.ts';

export function askUserTool({ state, schemas: { Type } }: ToolContext): AgentTool<any> {
  return {
    name: 'ask_user',
    label: '反问用户',
    description: '用户要求改表但缺少必要信息时，向用户提一个问题。调用后本轮结束。',
    parameters: Type.Object({ question: Type.String() }),
    execute: async (_id, args) => {
      state.question = String((args as { question?: unknown }).question || '').trim();
      return { ...textResult('已向用户提问，等待回答。'), terminate: true };
    },
  };
}
