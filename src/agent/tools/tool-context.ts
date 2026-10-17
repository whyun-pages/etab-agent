'use strict';
/**
 * What every tool of a turn is built from: the turn's state, what the turn
 * allows, the shared schema pieces, and the two ways an edit is recorded.
 * Each tool in defs/ is a function of a ToolContext; tools.ts makes one per
 * turn and decides which tools to build from it.
 */

import type { SpecOp } from '../../workbook/spec-ops.ts';
import { applyOp } from '../../workbook/spec-ops.ts';
import type { WorkbookSpec, SpecNote } from '../../workbook/workbook.ts';
import type { Ingested } from '../../ingest/ingest.ts';
import type { FetchOptions } from '../fetch-url.ts';
import type { FileAccessMode, FileAccessOptions, FileWrite } from '../file-access.ts';
import type { ExportRequest, Attachment } from '../types.ts';
import type { Pi } from '../pi.ts';
import { buildSchemas } from './schemas.ts';
import type { Schemas } from './schemas.ts';

/** What the tools of one turn share: the draft and what was done to it. */
export interface TurnState {
  draft: WorkbookSpec | null;
  ops: SpecOp[];
  notes: SpecNote[];
  summaries: string[];
  question: string | null;
  exports: ExportRequest[];
  /** text writes asked for, performed by the server after the turn */
  writes: FileWrite[];
  /** files read from disk, which become the session's attachments */
  loaded: Ingested[];
  today: string | undefined;
}

/** What a turn's tool set is allowed to do. */
export interface Capabilities {
  canEdit: boolean;
  canSave: boolean;
  canFetch: boolean;
  fetchOptions: FetchOptions;
  /** the turn's abort signal, so a fetch dies with the turn */
  signal: AbortSignal;
  /**
   * The session's uploads, for `read_attachment` and `query_table`. The
   * turn's own copy: `import_file` appends to it, so a file read this turn can
   * be queried in the next step.
   */
  attachments: Attachment[];
  fileAccess: FileAccessMode;
  fileOptions: FileAccessOptions;
}

/** A sheet's columns as an import or a query result gives them. */
export type TableColumns = Array<{ header: string; type: string }>;

export interface ToolContext {
  state: TurnState;
  caps: Capabilities;
  schemas: Schemas;
  /** Apply an edit to the draft and log it; returns what the model is told. */
  record(raw: SpecOp): string;
  /**
   * A table as a new sheet — or as the workbook, when there is none yet; for
   * fetch_url's importAs, query_table's saveAs and read_attachment's importAs
   * alike.
   */
  addTable(name: string, columns: TableColumns, rows: unknown[][]): string;
}

/** A tool result that is one piece of text, the shape nearly every tool returns. */
export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} };
}

export function toolContext(ai: Pi['ai'], state: TurnState, caps: Capabilities): ToolContext {
  const record = (raw: SpecOp): string => {
    const op: SpecOp = state.today ? { ...raw, today: state.today } : raw;
    // Throws SpecOpError on a bad address or an unusable result; pi-agent
    // turns that into an error tool result, which the model reads.
    const r = applyOp(state.draft, op);
    state.draft = r.spec;
    state.ops.push(op);
    state.notes.push(...r.notes);
    state.summaries.push(r.summary);
    return r.notes.length ? `${r.summary}\n注意：${r.notes.map((n) => n.message).join('；')}` : r.summary;
  };

  // The rows go into the op verbatim: the replay on the stored spec must not
  // depend on an upload still being in memory or a query being re-run against
  // a table that has since changed.
  const addTable = (name: string, columns: TableColumns, rows: unknown[][]): string => {
    const sheet = { name, columns, rows };
    const hasTable = Boolean(state.draft && state.draft.sheets.length);
    const op: SpecOp = hasTable
      ? { op: 'add_sheet', args: sheet }
      : { op: 'create_workbook', args: { title: name, sheets: [sheet] } };
    return record(op);
  };

  return { state, caps, schemas: buildSchemas(ai), record, addTable };
}
