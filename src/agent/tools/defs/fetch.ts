'use strict';
/**
 * `fetch_url`: reads a web resource, or with `importAs` brings its table in
 * as a sheet. The fetching, and the rules on what may be fetched, are
 * src/agent/fetch-url.ts.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { fetchUrl, readFetched, describeFetched, tableForImport } from '../../fetch-url.ts';
import { textResult } from '../tool-context.ts';
import type { ToolContext } from '../tool-context.ts';

export function fetchUrlTool({ caps, addTable, schemas: { Type } }: ToolContext): AgentTool<any> {
  const { canEdit } = caps;
  return {
    name: 'fetch_url',
    label: '抓取网址',
    description:
      '下载一个 http/https 网址并读取内容（网页正文、CSV、JSON、xlsx 等）。给出 importAs 时，把抓到的表格整张导入为新工作表。',
    parameters: Type.Object({
      url: Type.String({ description: '完整网址，以 http:// 或 https:// 开头' }),
      importAs: Type.Optional(Type.String({ description: '导入为新工作表时的表名；只读内容时省略' })),
    }),
    execute: async (_id, args) => {
      const a = args as { url?: unknown; importAs?: unknown };
      const importAs = String(a.importAs ?? '').trim();
      // Refused before the request, not after: a read-only turn has no use
      // for the bytes, and should not cause the traffic.
      if (importAs && !canEdit) throw new Error('当前为只读模式，不能导入。可以不带 importAs 只读取内容。');
      const fetched = await fetchUrl(String(a.url ?? ''), { ...caps.fetchOptions, signal: caps.signal });
      const att = await readFetched(fetched);
      const described = describeFetched(fetched, att);
      if (!importAs) {
        // A table read without importAs is where a model starts copying rows
        // into create_workbook by hand: thousands of output tokens, a minute
        // or more, and a copy that can drift from the source. Said here, in
        // our voice and ahead of the page text, because the prompt saying it
        // once was not enough. Read-only turns cannot import, so they are not
        // told to.
        const n = att.kind === 'table' ? att.table?.rows.length || 0 : 0;
        const hint =
          canEdit && n && tableForImport(att)
            ? `（提示：这是一张 ${n} 行的表格。要把它做成表格，请用同一网址再调用一次 fetch_url 并传 importAs，会直接导入全部 ${n} 行；不要把这些行抄进 create_workbook 或 add_rows。只回答问题时不必导入。）
`
            : '';
        return textResult(hint + described);
      }

      const table = tableForImport(att);
      if (!table) throw new Error(`抓到的内容不是表格，不能导入。内容摘要：\n${described.slice(0, 2000)}`);
      const done = addTable(importAs, table.columns, table.rows);
      // The model already has the rows in the table; only a taste is
      // repeated, to keep a big import from filling the context.
      return textResult(`${done}\n${described.slice(0, 3000)}`);
    },
  };
}
