'use strict';
/** `read_attachment`: an upload's full content, a page at a time, or its table imported as a sheet. */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { tableForImport, VERBATIM_HELP } from '../fetched.ts';
import { findAttachment, attachmentTable, headerOnlyNote } from '../../../ingest/select.ts';
import { readAttachmentPart } from '../attachments.ts';
import { textResult } from '../tool-context.ts';
import type { ToolContext } from '../tool-context.ts';
import type { Attachment } from '../../types.ts';
import type { WorkbookSpec } from '../../../workbook/workbook.ts';

export function readAttachmentTool({ state, caps, addTable, schemas: { Type } }: ToolContext): AgentTool<any> {
  return {
    name: 'read_attachment',
    label: '读取附件',
    description:
      '读取用户上传的附件的完整内容（消息里只有预览）。表格：from/to 读取一段行，importAs 整张导入为新工作表；统计请用 query_table。文本：from 是起始字符位置。',
    parameters: Type.Object({
      name: Type.String({ description: '附件名，与【附件：…】中的一致' }),
      sheet: Type.Optional(
        Type.String({
          description:
            '附件文件里的工作表名（不是导入时起的名字）；省略则用默认的那张。读取已经导入工作簿的表用 read_rows，不用 read_attachment',
        }),
      ),
      from: Type.Optional(Type.Integer({ description: '表格：起始行号，从 1 开始；文本：起始字符位置，从 0 开始' })),
      to: Type.Optional(Type.Integer({ description: '表格：结束行号（含）' })),
      importAs: Type.Optional(Type.String({ description: '把整张表导入为新工作表时的表名' })),
      verbatim: Type.Optional(Type.Boolean({ description: VERBATIM_HELP })),
    }),
    execute: async (_id, args) => {
      const a = args as Record<string, unknown>;
      const att = findAttachment(caps.attachments, String(a.name ?? ''));
      refuseWorkbookSheet(att, a.sheet, state.draft);
      const importAs = String(a.importAs ?? '').trim();
      if (!importAs) return textResult(readAttachmentPart(att, a));

      if (!caps.canEdit) throw new Error('当前为只读模式，不能导入。可以不带 importAs 只读取内容。');
      const table = tableForImport({ ...att, table: attachmentTable(att, a.sheet) }, { verbatim: a.verbatim === true });
      if (!table) throw new Error(`附件「${att.name}」不是表格，不能导入。`);
      const empty = table.rows.length ? '' : `\n${headerOnlyNote(table.columns.length)}`;
      return textResult(`${addTable(importAs, table.columns, table.rows)}（导入了 ${table.rows.length} 行）${empty}`);
    },
  };
}

/**
 * A `sheet` that names one of the WORKBOOK's sheets, not the file's.
 *
 * Both models compared did this about ten times a run: import the file as
 * 「日报」, then call read_attachment with sheet: '日报' to look at it. The
 * plain "no such sheet, there is X" answer sent them guessing other names;
 * this says which tool reads what they meant.
 */
function refuseWorkbookSheet(att: Attachment, sheet: unknown, draft: WorkbookSpec | null): void {
  const want = String(sheet ?? '').trim();
  if (!want || (att.sheets || []).some((t) => String(t.sheet || '').toLowerCase() === want.toLowerCase())) return;
  if (draft?.sheets.some((s) => s.name === want)) {
    throw new Error(
      `「${want}」是工作簿里的工作表，不是附件「${att.name}」里的。读它请用 read_rows（sheet: 「${want}」）；读附件本身时不传 sheet，或传附件里的工作表名。`,
    );
  }
}
