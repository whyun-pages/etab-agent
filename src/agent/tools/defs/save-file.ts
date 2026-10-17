'use strict';
/**
 * `save_file`: asks for the table to be saved. Recorded, not written: the
 * server writes it after the turn, once the edits have landed on the stored
 * spec, so the file shows what was actually kept.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { EXPORT_FORMATS, isExportFormat, cleanBaseName } from '../../../workbook/export.ts';
import { checkPath } from '../../../access/file-access.ts';
import { textResult } from '../tool-context.ts';
import type { ToolContext } from '../tool-context.ts';

export function saveFileTool({ state, caps, schemas: { Type, StringEnum } }: ToolContext): AgentTool<any> {
  return {
    name: 'save_file',
    label: '保存文件',
    description: '把当前表格保存到用户的导出目录。本轮结束、修改落定之后才真正写入；同名文件不会被覆盖，会自动加编号。',
    parameters: Type.Object({
      format: StringEnum(EXPORT_FORMATS),
      sheet: Type.Optional(Type.String({ description: '只保存这一个工作表；省略则保存全部（CSV 每表一个文件）' })),
      filename: Type.Optional(Type.String({ description: '文件名，不含目录和扩展名；省略则用工作簿标题' })),
      ...(caps.fileAccess === 'readwrite'
        ? { dir: Type.Optional(Type.String({ description: '保存到这个文件夹（完整路径）；省略则存到导出目录' })) }
        : {}),
    }),
    execute: async (_id, args) => {
      const a = args as { format?: unknown; sheet?: unknown; filename?: unknown; dir?: unknown };
      if (!isExportFormat(a.format)) throw new Error(`format 只能是 ${EXPORT_FORMATS.join('、')}。`);
      if (!state.draft || !state.draft.sheets.length) throw new Error('还没有表格，没有可保存的内容。');
      const sheet = a.sheet == null || a.sheet === '' ? null : String(a.sheet);
      if (sheet && !state.draft.sheets.some((s) => s.name.toLowerCase() === sheet.toLowerCase())) {
        throw new Error(`没有名为「${sheet}」的工作表。现有：${state.draft.sheets.map((s) => s.name).join('、')}`);
      }
      const filename = a.filename == null || a.filename === '' ? null : cleanBaseName(a.filename);
      let dir: string | null = null;
      if (a.dir != null && a.dir !== '') {
        if (caps.fileAccess !== 'readwrite') throw new Error('没有写文件的权限，只能保存到导出目录；请省略 dir。');
        // Checked now so the model hears about a refused folder this turn;
        // the server checks again when it writes.
        dir = await checkPath(a.dir, caps.fileOptions, { forWrite: true, folder: true });
      }
      state.exports.push({ format: a.format, sheet, filename, ...(dir ? { dir } : {}) });
      const name = `${filename || cleanBaseName(state.draft.title)}.${a.format}`;
      // Worded for the model's reply: the server writes the file after the turn
      // and appends the real path (or the failure) itself, so the model
      // should neither promise a path nor claim success it cannot see.
      return textResult(
        `好的，会保存为 ${name}（${sheet ? `工作表「${sheet}」` : '全部工作表'}）。文件在本轮结束时写入，保存位置会自动附在你的回复后面，回复里不必再写路径。`,
      );
    },
  };
}
