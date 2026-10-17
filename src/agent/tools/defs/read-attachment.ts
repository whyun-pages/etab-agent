'use strict';
/** `read_attachment`: an upload's full content, a page at a time, or its table imported as a sheet. */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { tableForImport } from '../fetched.ts';
import { findAttachment, attachmentTable, readAttachmentPart } from '../attachments.ts';
import { textResult } from '../tool-context.ts';
import type { ToolContext } from '../tool-context.ts';

export function readAttachmentTool({ caps, addTable, schemas: { Type } }: ToolContext): AgentTool<any> {
  return {
    name: 'read_attachment',
    label: '读取附件',
    description:
      '读取用户上传的附件的完整内容（消息里只有预览）。表格：from/to 读取一段行，importAs 整张导入为新工作表；统计请用 query_table。文本：from 是起始字符位置。',
    parameters: Type.Object({
      name: Type.String({ description: '附件名，与【附件：…】中的一致' }),
      sheet: Type.Optional(Type.String({ description: '附件里的工作表名；省略则用默认的那张' })),
      from: Type.Optional(Type.Integer({ description: '表格：起始行号，从 1 开始；文本：起始字符位置，从 0 开始' })),
      to: Type.Optional(Type.Integer({ description: '表格：结束行号（含）' })),
      importAs: Type.Optional(Type.String({ description: '把整张表导入为新工作表时的表名' })),
    }),
    execute: async (_id, args) => {
      const a = args as Record<string, unknown>;
      const att = findAttachment(caps.attachments, String(a.name ?? ''));
      const importAs = String(a.importAs ?? '').trim();
      if (!importAs) return textResult(readAttachmentPart(att, a));

      if (!caps.canEdit) throw new Error('当前为只读模式，不能导入。可以不带 importAs 只读取内容。');
      const table = tableForImport({ ...att, table: attachmentTable(att, a.sheet) });
      if (!table) throw new Error(`附件「${att.name}」不是表格，不能导入。`);
      return textResult(`${addTable(importAs, table.columns, table.rows)}（导入了 ${table.rows.length} 行）`);
    },
  };
}
