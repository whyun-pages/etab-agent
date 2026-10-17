'use strict';
/**
 * What the server holds between requests: the session store, settings, the
 * per-process uploads and held proposals, and the preview cache.
 *
 * Sessions are the durable thing: they live on disk (see src/store/session-store.ts)
 * and this class only holds the handle. Everything else here is per-process
 * and deliberately cheap to lose.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import type { Attachment, Extractor } from '../ingest/types.ts';
import type { FileWrite } from '../agent/tools/file-access.ts';
import { openWithSystem } from '../platform/open-file.ts';
import { Settings } from '../store/settings.ts';
import { SessionStore, safeId as safeSessionId } from '../store/session-store.ts';
import { writeSpec } from '../workbook/workbook.ts';
import { sheetWindow, MAX_PREVIEW_ROWS } from '../workbook/preview.ts';
import { readWorkbook } from '../formats/xlsx.ts';

type WorkbookSpec = import('../workbook/workbook.ts').WorkbookSpec;
type SpecOp = import('../workbook/spec-ops.ts').SpecOp;
type ExportRequest = import('../agent/agent.ts').ExportRequest;
type FetchOptions = import('../agent/tools/fetch-url.ts').FetchOptions;
type ParsedWorkbook = import('../formats/xlsx.ts').Workbook;
type SettingsLike = import('../store/settings.ts').Settings;
/** A pi-ai model, for the test seam that replaces the configured one. */
export type PiModel = import('@earendil-works/pi-ai').Model<any>;

// Re-exported for the routes, which take them from here with the rest of
// the state's shapes.
export type { Attachment, Extractor };

/**
 * An uploaded attachment as this process keeps it: the reader's result plus the
 * two things the reader does not need — the sanitised filename and the bytes,
 * which are held so a later request can re-read the same upload.
 */
export interface UploadedAttachment extends Attachment {
  /** Names the upload in URLs; an index would shift under a concurrent clear. */
  id: string;
  filename: string;
  data: Buffer;
  /** Where the copy for "open on this computer" was written, once it was. */
  openedPath?: string;
}

/** A change held for confirmation, per session. */
export interface PendingChange {
  /** what the preview showed, computed from the turn's snapshot */
  spec: WorkbookSpec | null;
  /** how to get there; replayed against the stored spec on apply */
  ops: SpecOp[];
  /** saves the turn asked for, performed once the change is applied */
  exports: ExportRequest[];
  /** text writes the turn asked for, performed once the change is applied */
  writes: FileWrite[];
  message: string;
  at: number;
}

export class AppState {
  dataDir: string;
  sessions: SessionStore;
  /**
   * Uploaded attachments, per session, kept for the life of the process.
   *
   * Keyed by session because a file is context for one conversation: with a
   * single process-wide list, a file attached in one session showed up in
   * every other one and was sent to the model with their turns too. Deleting
   * a session drops its entry.
   *
   * In memory, as before: the bytes are not written into the session file.
   * A restart losing them asks the user to attach again, which is visible;
   * a session file that grows by every upload is not.
   */
  uploads: Map<string, UploadedAttachment[]>;
  /**
   * Changes held for confirmation, per session.
   *
   * In memory on purpose. An unconfirmed proposal is not part of the document:
   * losing it to a restart means the user is asked again, which is the safe
   * direction. Writing it to disk would make "we suggested this once" look
   * like "this is pending", and a stale pending change is worse than none.
   */
  pending: Map<string, PendingChange>;
  /** Model credentials, read from settings.json in the data directory. */
  settings: SettingsLike;
  /**
   * The model a session turn drives. Absent means the one built from settings;
   * `createServer` sets it from the `model` seam.
   */
  agentModel?: PiModel;
  /**
   * Extra options for the agent's `fetch_url`. Test seam: a test sets
   * `{ allowPrivate: true }` here to fetch from its own 127.0.0.1 server.
   * Production never sets it, so the SSRF rules in src/agent/tools/fetch-url.ts hold.
   */
  fetchOptions?: FetchOptions;
  /**
   * Workbooks already written and read back for a preview, by `previewKey`.
   * Scrolling the preview asks for one page at a time; without this every
   * page would serialise and re-parse the whole sheet. A few entries is
   * enough — the open session, and its held proposal — and losing them only
   * costs one rebuild.
   */
  previews: Map<string, ParsedWorkbook>;
  /** A spec's serialisation to its preview key; see `previewSource`. */
  previewKeys: Map<string, string>;
  /**
   * Where attachment copies are written to be opened with the system's
   * default program, one folder per session. Under the OS temp directory: a
   * copy is disposable, and one left behind by a crash is the OS's to clean.
   */
  openDir: string;
  /** Hands a file to the OS. Test seam: a test records the path instead. */
  openFile: (file: string) => Promise<void>;

  constructor({ dataDir }: { dataDir: string }) {
    this.dataDir = dataDir;
    this.sessions = new SessionStore(dataDir);
    this.uploads = new Map();
    this.pending = new Map();
    this.settings = new Settings(dataDir);
    this.previews = new Map();
    this.previewKeys = new Map();
    this.openDir = path.join(os.tmpdir(), 'etab-agent', 'opened');
    this.openFile = openWithSystem;
  }

  /**
   * Forget a session's attachments, and the copies opened from them.
   *
   * The copies are removed best-effort: a program can still hold one open
   * (Excel locks the file on Windows), and failing a clear over that would
   * be worse than a stray file in the temp directory.
   */
  dropUploads(sid: string): void {
    this.uploads.delete(sid);
    const key = safeSessionId(sid);
    if (key) fs.promises.rm(path.join(this.openDir, key), { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- preview

const PREVIEW_CACHE_SIZE = 8;

/** Keep `map` to `size` entries, dropping the least recently set. */
function remember<V>(map: Map<string, V>, key: string, value: V, size: number): void {
  // Re-inserted to mark it recent: a Map iterates in insertion order, so the
  // first key is always the least recently used.
  map.delete(key);
  map.set(key, value);
  while (map.size > size) map.delete(map.keys().next().value as string);
}

/**
 * The parsed workbook a preview is cut from, and its `key`.
 *
 * The key names the version of the table, and the client sends it back with
 * every page request, so rows from two versions are never stitched into one
 * grid. It is a hash of the written xlsx bytes, not of the spec: the spec a
 * turn just produced and the same spec read back from disk differ in shape
 * (the store re-normalises on load), and hashing the spec gave one table two
 * keys — the very first page came back stale. `writeSpec` is deterministic,
 * so equal tables write equal bytes whatever the spec looked like in memory.
 *
 * Writing the bytes is the cost a page request should not pay each time, so
 * the spec's own serialisation maps to its key as well: each shape of a spec
 * is written once.
 */
export function previewSource(state: AppState, spec: WorkbookSpec): { key: string; wb: ParsedWorkbook } {
  const shape = crypto.createHash('sha1').update(JSON.stringify(spec)).digest('hex');
  const known = state.previewKeys.get(shape);
  const cached = known ? state.previews.get(known) : undefined;
  if (known && cached) {
    remember(state.previews, known, cached, PREVIEW_CACHE_SIZE);
    return { key: known, wb: cached };
  }
  const bytes = writeSpec(spec);
  const key = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16);
  const wb = state.previews.get(key) || readWorkbook(bytes);
  remember(state.previewKeys, shape, key, PREVIEW_CACHE_SIZE * 4);
  remember(state.previews, key, wb, PREVIEW_CACHE_SIZE);
  return { key, wb };
}

export interface PreviewWindow {
  startRow?: number;
  maxRows?: number;
}

/**
 * A window of a spec's first sheet, as the grid draws it, plus its `key`.
 *
 * Through the written bytes, not straight from the spec: what the preview
 * shows is what the file holds (see src/workbook/preview.ts).
 */
export function previewOf(state: AppState, spec: WorkbookSpec, win: PreviewWindow = {}) {
  const { key, wb } = previewSource(state, spec);
  return { ...sheetWindow(wb, undefined, { startRow: win.startRow, maxRows: win.maxRows || MAX_PREVIEW_ROWS }), key };
}
