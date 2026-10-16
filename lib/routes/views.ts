'use strict';
/**
 * What the client is shown of the server's objects. Each projection leaves
 * something out on purpose; the comments say what and why.
 */

import { specStats } from '../workbook.ts';
import { isOpenable } from '../open-file.ts';
import type { Attachment, UploadedAttachment } from '../app-state.ts';

type Session = import('../session-store.ts').Session;
type StoredMessage = import('../session-store.ts').StoredMessage;

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
    sheets: att.sheets ? att.sheets.map((s) => ({ sheet: s.sheet, header: s.header, rowCount: s.rows.length })) : undefined,
    header: att.header,
    rowCount: att.table ? att.table.rows.length : undefined,
    columns: att.table ? att.table.columns.map((c) => ({ label: c.label, type: c.type })) : undefined,
    textPreview: att.text ? String(att.text).slice(0, 800) : undefined,
    preview: att.table ? att.table.rows.slice(0, 5) : undefined,
  };
}

/** An upload as the client sees it: the attachment, plus how to address and open it. */
export function publicUpload(u: UploadedAttachment): Record<string, unknown> {
  return { id: u.id, ...publicAttachment(u), openable: isOpenable(u.filename) };
}
