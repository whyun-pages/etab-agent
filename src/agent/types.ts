'use strict';
/**
 * The shapes a turn is described in: what goes in (RunTurnArgs, the history,
 * the change log) and what comes out (TurnResult, with the operations to
 * replay and the requests the server performs afterwards).
 */

import type { Model } from '@earendil-works/pi-ai';
import type { SpecOp } from '../workbook/spec-ops.ts';
import type { ExportFormat } from '../workbook/export.ts';
import type { FetchOptions } from '../access/fetch.ts';
import type { Ingested } from '../ingest/ingest.ts';
import type { Attachment } from '../ingest/types.ts';
import type { FileAccessMode, FileAccessOptions, FileWrite } from '../access/file-access.ts';
import type { WorkbookSpec, SpecNote } from '../workbook/workbook.ts';
import type { Credentials } from './llm.ts';

/** What the user's message asks for. */
export const INTENT = {
  /** A question or chat. Never carries a spec. */
  ANSWER: 'answer',
  /** A change, carried out by edit tools. */
  ACTION: 'action',
  /** A change that cannot be made yet — something is missing. */
  QUESTION: 'question',
} as const;

/** One of the three intents a turn may resolve to. */
export type Intent = (typeof INTENT)[keyof typeof INTENT];

/** A session message as this module reads it back. */
export interface HistoryMessage {
  role?: string;
  content?: string;
  intent?: string;
  /** Files attached when the message was sent; their content is not in history. */
  attachments?: string[];
}

/** An applied change as this module reads it back (`ChangeRecord` in the store). */
export interface ChangeLine {
  request?: string;
  summary?: string;
}

/** One entry in the message list the model receives. */
export interface AgentMessage {
  role: string;
  content: string;
}

/** Arguments to `agentMessages`. */
export interface AgentMessagesArgs {
  history?: HistoryMessage[];
  message: string;
  spec?: WorkbookSpec | null;
  rowBudget?: number;
  historyBudget?: number;
  changes?: ChangeLine[];
}

/** What `guardChange` decides. */
export interface GuardVerdict {
  ok: boolean;
  reason: string;
  lostRows: number;
}

/** A settings object, as far as this module is concerned. */
export interface AgentSettings {
  isConfigured(): Promise<boolean>;
  secrets(): Promise<Credentials>;
}

/** Arguments to `runTurn`. */
export interface RunTurnArgs {
  settings: AgentSettings;
  message: string;
  spec?: WorkbookSpec | null;
  history?: HistoryMessage[];
  changes?: ChangeLine[];
  signal?: AbortSignal;
  rowBudget?: number;
  /**
   * Whether the edit tools are offered at all. Off means a read-only turn: the
   * model can read rows and answer, and has no tool that changes anything.
   */
  canEdit?: boolean;
  /**
   * The model to drive, instead of the one built from settings. Tests pass a
   * pi-ai faux model here so the real loop, tools and gates run against a
   * scripted conversation with no network.
   */
  model?: Model<any>;
  /** Whether `save_file` is offered. */
  canSave?: boolean;
  /** Whether `fetch_url` is offered. */
  canFetch?: boolean;
  /** Blocklist and limits for `fetch_url`; see src/access/fetch.ts. */
  fetchOptions?: FetchOptions;
  /**
   * The session's parsed uploads. The message carries only a preview of each
   * (src/http/projections.ts `attachmentContext`); `read_attachment` reads the rest from
   * here. None means the tool is not offered.
   */
  attachments?: Attachment[];
  /**
   * The calendar day of the turn (YYYY-MM-DD), stamped on every edit it
   * records so a relative date (今天, 明天) lands the same day on replay. The
   * route reads the clock once and passes it in; without it, relative dates
   * are not dates.
   */
  today?: string;
  /**
   * Local file access: off; read (pi's read, ls, find, grep, plus
   * import_file); or readwrite (also write, edit, the shell tool, and
   * save_file into a chosen folder). See src/access/file-access.ts.
   */
  fileAccess?: FileAccessMode;
  /** The blocklist and data folder every path is checked against. */
  fileOptions?: FileAccessOptions;
  /**
   * The idle windows, in ms. Test seam, like `model`: a test cannot wait a
   * minute to see the clock fire. Production uses the constants above.
   */
  idleTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
}

/** A save the model asked for, performed by the server once the turn has landed. */
export interface ExportRequest {
  format: ExportFormat;
  sheet?: string | null;
  filename?: string | null;
  /** a folder of the user's choosing instead of the export folder; only with file write access */
  dir?: string | null;
}

/** What one turn resolves to. */
export interface TurnResult {
  intent: Intent;
  reply: string;
  /** what the tools reported doing, one line each; empty for an answer */
  reason: string;
  spec: WorkbookSpec | null;
  /**
   * The edits that produced `spec`, in order. The server replays these against
   * the freshest stored spec rather than writing `spec` back wholesale — `spec`
   * was computed from a snapshot taken before the model call.
   */
  ops: SpecOp[];
  /** saves to perform after `ops` land; empty when none was asked for */
  exports: ExportRequest[];
  notes: SpecNote[];
  prefiltered: boolean;
  /** a compact transcript of the loop, for debugging */
  raw: string;
  guarded?: boolean;
  lostRows?: number;
  /** text files to write after the turn; empty when none, or when the turn was guarded */
  writes?: FileWrite[];
  /** files read from disk this turn, to keep as the session's attachments */
  loaded?: Ingested[];
}

export type { Attachment };
export type AttachmentTable = NonNullable<Attachment['table']>;
