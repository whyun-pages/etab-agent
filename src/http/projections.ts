'use strict';
/**
 * What the client is shown of the server's objects. Each projection leaves
 * something out on purpose; the comments say what and why.
 */

import { specStats } from '../workbook/workbook.ts';
import { isOpenable } from '../platform/open-file.ts';
import { headerOnlyNote } from '../ingest/select.ts';
import type { Attachment, UploadedAttachment } from './app-state.ts';
import type { Session, StoredMessage } from '../store/session-store.ts';

/**
 * A session as the client sees it.
 *
 * Note what is NOT here: the spec's raw form is sent, but no credentials and no
 * internal bookkeeping. The spec has to travel — the client draws the grid from
 * it and hands it back for a chat turn against what the user is looking at.
 */
export function publicSession(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title,
    messages: publicMessages(session.messages),
    spec: session.spec || null,
    stats: session.spec ? specStats(session.spec) : null,
    updatedAt: session.updatedAt,
  };
}

/** Messages as the client sees them: no internal fields, order is the information. */
export function publicMessages(messages: StoredMessage[] | null | undefined): Array<Record<string, unknown>> {
  return (messages || []).map((m) => ({
    role: m.role,
    content: m.content,
    intent: m.intent,
    guarded: m.guarded === true ? true : undefined,
    attachments: m.attachments,
    at: m.at,
  }));
}

/** An attachment as the client — and the model — sees it. The raw bytes never go back. */
export function publicAttachment(att: Attachment): Record<string, unknown> {
  return {
    name: att.name,
    kind: att.kind,
    note: att.note,
    error: att.error,
    extractError: att.extractError,
    meta: att.meta,
    sheets: att.sheets
      ? att.sheets.map((s) => ({ sheet: s.sheet, header: s.header, rowCount: s.rows.length }))
      : undefined,
    header: att.header,
    rowCount: att.table ? att.table.rows.length : undefined,
    columns: att.table ? att.table.columns.map((c) => ({ label: c.label, type: c.type })) : undefined,
    textPreview: att.text ? String(att.text).slice(0, 800) : undefined,
    preview: att.table ? att.table.rows.slice(0, 5) : undefined,
  };
}

/**
 * The sheet a workbook upload was read from, by name — one sheet as much as
 * several. Asked to "keep the source's sheet name", two models out of two
 * said the name was nowhere in what they were shown, and it was not: only a
 * file with more than one sheet listed them.
 */
function sheetLine(u: Attachment): string {
  const names = (u.sheets || []).map((s) => s.sheet).filter(Boolean);
  if (names.length > 1) return `\n工作表：${names.map((n) => `「${n}」`).join('、')}；下面是「${u.table?.sheet}」`;
  return u.table?.sheet ? `\n工作表：「${u.table.sheet}」` : '';
}

/**
 * The current attachments, as the text the model reads this turn.
 *
 * Composed per turn by the turn route, and never stored. It used to be composed
 * in the client (NOTES.md #59) and sent as part of the user's message, which
 * meant the server saved it as what the user said: the block showed up in the
 * chat bubble, was saved again on every turn while the file stayed attached,
 * and then ate the history budget on every turn after that. The user's message
 * is what they typed; the attachment is context for the turn, the same way the
 * spec is.
 *
 * Built from `publicAttachment` so the model sees exactly what the chips
 * describe — the same five preview rows, the same text cap — not a richer view
 * the user has no way to check.
 *
 * Lives here, next to `publicAttachment`, rather than in the route: evals/run.js
 * drives `runTurn` without the HTTP layer and has to show the model the same
 * block, and a private copy there had already drifted once.
 */
export function attachmentContext(uploads: Attachment[]): string {
  const blocks = uploads.map((u) => {
    const a = publicAttachment(u);
    const head = `【附件：${a.name}】`;
    if (a.kind === 'table' || a.kind === 'sheet') {
      const cols = ((a.columns as Array<{ label: string }> | undefined) || []).map((c) => c.label).join('、');
      const rows = ((a.preview as unknown[][] | undefined) || []).map((r) => r.join('\t')).join('\n');
      const header = ((a.columns as unknown[] | undefined) || []).length;
      const more = a.rowCount
        ? `（共 ${a.rowCount} 行，下面只给前几行；全部内容用 read_attachment 读取）`
        : header
          ? `（${headerOnlyNote(header)}）`
          : '';
      // A table's note says what was NOT read (rows past the grid limit).
      const note = a.note ? `\n（${a.note}）` : '';
      return `${head}${more}${note}${sheetLine(u)}\n列：${cols}\n${rows}`;
    }
    if (a.textPreview) {
      const full = String(u.text || '').length;
      const cut =
        full > String(a.textPreview).length ? `\n（共 ${full} 字，上面只是开头；全部内容用 read_attachment 读取）` : '';
      return `${head}\n${String(a.textPreview)}${cut}`;
    }
    return `${head}（${a.note || '无法预览内容'}）`;
  });
  return blocks.length ? `--- 附件资料 ---\n${blocks.join('\n\n')}` : '';
}

/** An upload as the client sees it: the attachment, plus how to address and open it. */
export function publicUpload(u: UploadedAttachment): Record<string, unknown> {
  return { id: u.id, ...publicAttachment(u), openable: isOpenable(u.filename) };
}
