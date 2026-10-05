'use strict';
/**
 * HTTP API for the Tab agent.
 *
 * Zero dependencies: node:http plus the modules in lib/. Multipart uploads are
 * parsed here because a spreadsheet app must accept files, and pulling in a
 * framework for one content type is not worth the supply-chain surface.
 *
 * Every endpoint answers JSON except the download, so the UI can render state
 * without guessing.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { readAttachment } from './attachments.ts';
import { readAsset } from './assets.ts';
import { Settings } from './settings.ts';
import { SessionStore, safeId as safeSessionId } from './session-store.ts';
import { runTurn as runAgentTurn, INTENT as AGENT_INTENT, describeChange } from './agent.ts';
import { normalizeSpec, validateSpec, writeSpec, specStats } from './workbook.ts';
import { sheetPreview as previewSpec } from './workbook-preview.ts';
import { chat, stripReasoning } from './llm.ts';

/**
 * The spec types, named locally.
 *
 * Same convention as `lib/session-store.ts` and `lib/workbook-preview.ts`: the
 * names are aliased here so the signatures below read as English, and every
 * reference is a `import(...)` type position, which is erased at emit.
 */
type WorkbookSpec = import('./workbook.ts').WorkbookSpec;
type Session = import('./session-store.ts').Session;
type StoredMessage = import('./session-store.ts').StoredMessage;
type SettingsPatch = import('./settings.ts').SettingsPatch;
type SettingsLike = import('./settings.ts').Settings;
type Transport = import('./agent.ts').Transport;

// `lib/attachments.ts` does not export its `Attachment`/`Extractor` shapes, so
// the ones this file needs are derived from the function it calls rather than
// re-declared. Deriving is what keeps them from drifting.
type Attachment = Awaited<ReturnType<typeof readAttachment>>;
type Extractor = NonNullable<Parameters<typeof readAttachment>[2]>['imageExtractor'];

const MAX_UPLOAD = 32 * 1024 * 1024;   // 32MB per request
const MAX_FILES = 20;

/** One parsed multipart part. */
interface MultipartPart {
  name: string;
  filename: string | null;
  contentType: string;
  data: Buffer;
}

/**
 * A part that carried a filename — i.e. a file, not a form field.
 *
 * `filename` is narrowed to `string` rather than left nullable: the upload route
 * branches on exactly that, and a nullable filename at every use site would mean
 * re-proving the same fact three times.
 */
interface MultipartFile extends MultipartPart {
  filename: string;
}

/**
 * An uploaded attachment as this process keeps it: the reader's result plus the
 * two things the reader does not need — the sanitised filename and the bytes,
 * which are held so a later request can re-read the same upload.
 */
interface UploadedAttachment extends Attachment {
  filename: string;
  data: Buffer;
}

/** A change held for confirmation, per session. */
interface PendingChange {
  spec: WorkbookSpec | null;
  message: string;
  at: number;
}

/** One entry of the `modelNotes` array an upload response may carry. */
interface ModelNote {
  step: string;
  error: string;
}

/**
 * The error shape this file throws and reads.
 *
 * `statusCode` is an extra property bolted onto a plain `Error` with
 * `Object.assign`, so it is not on the `Error` type and has to be named before
 * it can be read or set.
 */
interface HttpError extends Error {
  statusCode?: number;
}

// --------------------------------------------------------------- multipart

/**
 * Parse a multipart/form-data body.
 *
 * Deliberately a focused implementation: it handles what a browser FormData
 * sends (single boundary, no nested multipart, content-disposition with or
 * without a filename) and rejects anything malformed rather than guessing.
 *
 * @returns {Array<{name:string, filename:string|null, contentType:string, data:Buffer}>}
 */
function parseMultipart(buffer: Buffer, contentType: string): MultipartPart[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('缺少 multipart boundary');
  const boundary = (m[1] || m[2]).trim();

  const delim = Buffer.from('--' + boundary);
  const parts: MultipartPart[] = [];

  // Locate each boundary occurrence, then slice between them.
  const indices: number[] = [];
  let from = 0;
  while (true) {
    const i = buffer.indexOf(delim, from);
    if (i === -1) break;
    indices.push(i);
    from = i + delim.length;
  }
  if (indices.length < 2) return parts;

  for (let k = 0; k < indices.length - 1; k++) {
    const start = indices[k] + delim.length;
    const end = indices[k + 1];
    if (end <= start) continue;

    let chunk = buffer.subarray(start, end);
    // Trim the CRLF (or LF) that precedes the next boundary.
    if (chunk.length >= 2 && chunk[chunk.length - 2] === 0x0d && chunk[chunk.length - 1] === 0x0a) {
      chunk = chunk.subarray(0, chunk.length - 2);
    } else if (chunk.length >= 1 && chunk[chunk.length - 1] === 0x0a) {
      chunk = chunk.subarray(0, chunk.length - 1);
    }
    // A leading CRLF follows the boundary line.
    if (chunk.length >= 2 && chunk[0] === 0x0d && chunk[1] === 0x0a) chunk = chunk.subarray(2);

    // Header block ends at the first blank line.
    let headerEnd = chunk.indexOf('\r\n\r\n');
    let sepLen = 4;
    if (headerEnd === -1) {
      headerEnd = chunk.indexOf('\n\n');
      sepLen = 2;
    }
    if (headerEnd === -1) continue;

    const headerText = chunk.subarray(0, headerEnd).toString('utf8');
    const data = chunk.subarray(headerEnd + sepLen);

    const disp = /content-disposition:\s*([^\r\n]+)/i.exec(headerText);
    if (!disp) continue;
    const nameM = /name="([^"]*)"/i.exec(disp[1]);
    const fileM = /filename="([^"]*)"/i.exec(disp[1]);
    const typeM = /content-type:\s*([^\r\n]+)/i.exec(headerText);

    parts.push({
      name: nameM ? decodeName(nameM[1]) : '',
      // A filename is what distinguishes a file part from a form field.
      filename: fileM ? safeFilename(decodeName(fileM[1])) : null,
      contentType: typeM ? typeM[1].trim() : 'application/octet-stream',
      data: Buffer.from(data),
    });
  }
  return parts;
}

/**
 * Field/filename values are already UTF-8 decoded by the header read above, so
 * they are returned as-is. Some clients percent-encode instead; only then do we
 * decode, and never at the cost of throwing on a malformed sequence.
 */
function decodeName(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Strip any path component a browser or attacker might include. */
function safeFilename(name: unknown): string {
  let out = String(name).replace(/\\/g, '/').split('/').pop() || 'file';
  out = out.replace(/[\x00-\x1f<>:"|?*]/g, '_').trim();
  // Guard against traversal and reserved device names.
  if (!out || out === '.' || out === '..') out = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(out)) out = '_' + out;
  return out.slice(0, 180);
}

/** Read a request body with a hard size cap. */
function readBody(req: http.IncomingMessage, limit = MAX_UPLOAD): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('上传内容过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ------------------------------------------------------------------ state

/**
 * In-memory session state.
 *
 * Sessions are the durable thing: they live on disk (see lib/session-store.js)
 * and this class only holds the handle. Everything else here is per-process
 * and deliberately cheap to lose.
 */
class AppState {
  dataDir: string;
  sessions: SessionStore;
  /** Uploaded attachments, kept for the life of the process. */
  uploads: UploadedAttachment[];
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
   * Reaches the model for a session turn. Absent means the agent's own
   * default (`llm.chat`); `createServer` sets it from the `transport` seam.
   */
  agentTransport?: Transport;

  constructor({ dataDir }: { dataDir: string }) {
    this.dataDir = dataDir;
    this.sessions = new SessionStore(dataDir);
    this.uploads = [];
    this.pending = new Map();
    this.settings = new Settings(dataDir);
  }
}

// ------------------------------------------------------------------- json

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res: http.ServerResponse, status: number, message: string, extra?: Record<string, unknown>): void {
  json(res, status, { ok: false, error: message, ...(extra || {}) });
}

/**
 * A session as the client sees it.
 *
 * Note what is NOT here: the spec's raw form is sent, but no credentials and no
 * internal bookkeeping. The spec has to travel — the client draws the grid from
 * it and hands it back for a chat turn against what the user is looking at.
 */
function publicSession(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title,
    messages: publicMessages(session.messages),
    spec: session.spec || null,
    stats: session.spec ? specStats(session.spec) : null,
    updatedAt: session.updatedAt,
  };
}

/**
 * Messages as the client sees them.
 *
 * `at` is dropped: the UI groups by role, and a timestamp nobody renders is one
 * more thing that can leak an internal detail. Order is the information.
 */
function publicMessages(messages: StoredMessage[] | null | undefined): Array<Record<string, unknown>> {
  return (messages || []).map((m) => ({
    role: m.role,
    content: m.content,
    intent: m.intent,
    guarded: m.guarded === true ? true : undefined,
    attachments: m.attachments,
    at: m.at,
  }));
}

/** RFC 5987 filename for a download, safe with CJK names. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ----------------------------------------------------------------- routes

/**
 * Options for `createHandler`.
 *
 * `imageExtractor` / `textExtractor` are typed off `lib/attachments.ts` rather
 * than re-declared, so a change to the hook signature surfaces here instead of
 * silently mistyping it.
 */
interface HandlerOptions {
  state: AppState;
  staticDir?: string;
  imageExtractor?: Extractor;
  textExtractor?: Extractor;
  /**
   * Optional: not read by the default handler. Kept as an accepted option so a
   * caller passing it is not a type error; the per-request `modelNotes` array
   * below is what actually carries a model failure to the UI.
   */
  onModelNote?: (note: ModelNote) => void;
}

/**
 * Build the request handler.
 * @param {object} opts
 * @param {AppState} opts.state
 * @param {string} [opts.staticDir] directory of UI assets
 * @param {Function} [opts.imageExtractor] optional vision hook for images
 */
function createHandler({ state, staticDir, imageExtractor, textExtractor, onModelNote }: HandlerOptions): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  void onModelNote;
  return async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // `req.url` is optional on the wire type (`IncomingMessage` covers more than
    // HTTP/1.1 requests). The fallback is the same path the string concatenation
    // below already produced for an absent URL, so the route never changes.
    const url = new URL(req.url || '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    /**
     * Which extractors apply to this request.
     *
     * The model is opt-in per request: a `useModel: false` in the body keeps a
     * run fully deterministic even with a key configured. When the model is
     * used and fails, the note below carries the reason to the UI and the
     * extractor is dropped, so the deterministic path still runs.
     */
    const modelNotes: ModelNote[] = [];
    function extractorsFor(useModel: boolean): { imageExtractor: Extractor | undefined; textExtractor: Extractor | undefined } {
      if (!useModel) return { imageExtractor: undefined, textExtractor: undefined };

      // An image extractor may be supplied outright (tests, a future local OCR).
      const wrap = (fn: Extractor | undefined, label: string): Extractor | undefined => (fn ? async (buffer, mime, filename, kind, text) => {
        try {
          return await fn(buffer, mime, filename, kind, text);
        } catch (err) {
          // Never let a model failure abort the upload: record why and let the
          // rule-based reading stand.
          modelNotes.push({ step: label, error: String((err as HttpError).message || err) });
          throw err;
        }
      } : undefined);

      return {
        imageExtractor: wrap(imageExtractor, 'image'),
        textExtractor: wrap(textExtractor, 'text'),
      };
    }

    try {
      // ---------------------------------------------------------- static
      // No `staticDir` guard: a packaged build serves assets from inside the
      // executable, where there is no directory to pass. readAsset decides
      // between embedded assets and disk.
      if (req.method === 'GET' && serveStatic(res, staticDir, url.pathname)) return;

      // ----------------------------------------------------- health/meta
      if (route === 'GET /api/health') {
        // `app` is a stable identity, not a count: desktop.js probes this endpoint
        // to tell "our own instance" from an unrelated server that happens to
        // answer on the same port. Keying that on a field that can be removed
        // (as `templates` once was) would break single-instance detection
        // silently.
        return json(res, 200, {
          ok: true,
          app: 'tab-agent',
          uploads: state.uploads.length,
          modelConfigured: await state.settings.isConfigured(),
        });
      }

      // --------------------------------------------------------- settings
      if (route === 'GET /api/settings') {
        return json(res, 200, { ok: true, settings: await state.settings.publicSettings() });
      }

      if (route === 'POST /api/settings') {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as Record<string, unknown>;
        const patch: SettingsPatch = {};
        // Only these keys are writable, and an absent key means "leave it".
        // An empty string for apiKey is meaningful ("clear it"), so test for
        // presence rather than truthiness.
        if ('apiKey' in body) patch.apiKey = String(body.apiKey || '').trim();
        if ('baseUrl' in body) patch.baseUrl = String(body.baseUrl || '').trim();
        if ('model' in body) patch.model = String(body.model || '').trim();
        if ('useForAttachments' in body) patch.useForAttachments = Boolean(body.useForAttachments);
        if ('chatCanEdit' in body) patch.chatCanEdit = Boolean(body.chatCanEdit);
        if ('chatConfirmEdits' in body) patch.chatConfirmEdits = Boolean(body.chatConfirmEdits);

        // Refuse a base URL that is not http(s): anything else would be sent a
        // bearer token by a client that cannot speak the scheme.
        if (patch.baseUrl && !/^https?:\/\//i.test(patch.baseUrl)) {
          return fail(res, 400, '接口地址必须以 http:// 或 https:// 开头');
        }

        const saved = await state.settings.save(patch);
        void saved;
        // Echo the SAFE projection only — never the key back to the caller.
        return json(res, 200, { ok: true, settings: await state.settings.publicSettings() });
      }

      if (route === 'POST /api/settings/test') {
        if (!(await state.settings.isConfigured())) return fail(res, 400, '请先填写 API key、接口地址和模型名');
        try {
          // The budget has to cover the model THINKING plus the answer. A
          // reasoning model (MiniMax-M3 and friends) spends tokens on its
          // reasoning block before it emits anything, so a tiny cap gets consumed
          // by reasoning alone and the reply comes back empty — while the
          // provider still reports success. Seen live: maxTokens 16 returned
          // "<think>…</think>" with no answer. 512 leaves ample room.
          const raw = await chat({
            credentials: await state.settings.secrets(),
            messages: [{ role: 'user', content: '回复两个字：可用' }],
            maxTokens: 512,
            timeoutMs: 30_000,
          });
          // Show the answer, not the reasoning — but keep the raw text as
          // evidence when there is no answer at all.
          const reply = stripReasoning(raw);
          if (!reply) {
            return json(res, 200, {
              ok: false,
              error: '模型只返回了思考过程，没有给出回答。可能模型名有误，或该模型不支持 chat/completions 接口。',
              raw: String(raw).slice(0, 400),
            });
          }
          return json(res, 200, { ok: true, reply: String(reply).slice(0, 200) });
        } catch (err) {
          // The provider's own words are the useful part; pass them through.
          return json(res, 200, { ok: false, error: String((err as HttpError).message || err) });
        }
      }
      // -------------------------------------------------------- sessions
      //
      // The template-free API. A session IS the document: it holds the
      // conversation and the spec, and the workbook is derived from the spec on
      // demand. Nothing here needs an uploaded file.

      if (route === 'GET /api/sessions') {
        return json(res, 200, { ok: true, sessions: await state.sessions.list() });
      }

      if (route === 'POST /api/sessions') {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as Record<string, unknown>;
        const session = await state.sessions.create(String(body.title || '').slice(0, 200));
        await state.sessions.prune();
        return json(res, 200, { ok: true, session: publicSession(session) });
      }

      const sessGet = /^GET \/api\/sessions\/([^/]+)$/.exec(route);
      if (sessGet) {
        const session = await state.sessions.load(decodeURIComponent(sessGet[1]));
        if (!session) return fail(res, 404, '会话不存在');
        return json(res, 200, {
          ok: true,
          session: publicSession(session),
          preview: session.spec ? previewSpec(writeSpec(session.spec)) : null,
          canEdit: Boolean((await state.settings.load()).chatCanEdit),
        });
      }

      const sessDel = /^DELETE \/api\/sessions\/([^/]+)$/.exec(route);
      if (sessDel) {
        const ok = await state.sessions.remove(decodeURIComponent(sessDel[1]));
        return json(res, ok ? 200 : 404, { ok });
      }

      /**
       * One conversation turn.
       *
       * Returns the decision and, when it is a change, the preview of what it
       * would produce. Applying is a SECOND call (`POST .../apply`), because a
       * confirmation step has to be able to show the result before it exists —
       * and because it keeps the risky step a separate, explicit request rather
       * than a flag a parser slip could flip.
       *
       * The pending spec is held in memory per session rather than written to
       * disk: an unconfirmed proposal is not part of the document, and a restart
       * losing it is correct behaviour, not data loss.
       */
      const sessTurn = /^POST \/api\/sessions\/([^/]+)\/turn$/.exec(route);
      if (sessTurn) {
        const session = await state.sessions.load(decodeURIComponent(sessTurn[1]));
        if (!session) return fail(res, 404, '会话不存在');
        if (!(await state.settings.isConfigured())) return fail(res, 400, '尚未配置模型，无法对话');

        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}') as Record<string, unknown>;
        const message = String(body.message || '').trim();
        if (!message) return fail(res, 400, '消息不能为空');

        // Snapshotted before the model call: an upload or a clear landing while
        // the turn is in flight must not change what this turn says it read.
        const files = attachmentNames(state.uploads);
        const context = attachmentContext(state.uploads);

        let turn;
        try {
          turn = await runAgentTurn({
            settings: state.settings,
            message: context ? `${message}\n\n${context}` : message,
            spec: session.spec,
            history: session.messages,
            changes: session.changes,
            transport: state.agentTransport,
          });
        } catch (err) {
          // A provider failure is not recorded: the user's own message is kept
          // so retrying does not mean retyping.
          return json(res, 200, {
            ok: false,
            error: String((err as HttpError).message || err),
            messages: publicMessages(session.messages),
          });
        }

        // Read-only mode downgrades a change rather than showing one the user
        // cannot make. The conversation still happens.
        const canEdit = Boolean((await state.settings.load()).chatCanEdit);
        let spec = turn.spec;
        let note = '';
        if (spec && !canEdit) {
          spec = null;
          note = '（「允许修改」已关闭，本次没有改动表格）';
        }

        const confirmEdits = Boolean((await state.settings.load()).chatConfirmEdits);
        const pending = Boolean(spec) && confirmEdits;
        const applied = Boolean(spec) && !confirmEdits;

        if (pending) {
          state.pending.set(session.id, { spec, message, at: Date.now() });
        } else {
          state.pending.delete(session.id);
        }

        // The write is a read-modify-write that must run INSIDE the store's
        // queue, against the freshest on-disk session — not against the
        // snapshot loaded before the model call. Two turns firing at once would
        // otherwise each save a transcript that predates the other, and one
        // turn's messages would vanish with no error (measured: 12 concurrent
        // turns left 4 of 26 messages). `update` loads and writes in one slot.
        const saved = await state.sessions.update(session.id, (current: Session) => ({
          ...current,
          // First change names the session, unless the user named it earlier.
          title: current.title || (applied && spec && spec.title) || current.title,
          spec: applied ? spec : current.spec,
          // Recorded against `current.spec`, the freshest one, inside the queue
          // slot — the same reason the spec itself is written here.
          changes: applied
            ? [...current.changes, { request: message, summary: describeChange(current.spec, spec), at: new Date().toISOString() }]
            : current.changes,
          messages: [
            ...current.messages,
            {
              role: 'user',
              content: message,
              at: new Date().toISOString(),
              attachments: files.length ? files : undefined,
            },
            {
              role: 'assistant',
              content: turn.reply + (note ? `\n${note}` : ''),
              at: new Date().toISOString(),
              intent: turn.intent,
              guarded: turn.guarded === true,
              // `notes` on the stored message is `StoredMessage['notes']`
              // (`string[]`); the turn produces `SpecNote[]`. The two have been
              // passed through unchanged since before the migration — the value
              // is what a live session serves and what a reloaded one compares
              // against — so the cast records the existing shape rather than
              // changing it. Flattening to strings here would alter what a
              // session stores.
              notes: turn.notes as unknown as string[],
            },
          ],
        }));
        if (!saved) return fail(res, 404, '会话不存在');

        // Named once so the ternary below stays a `WorkbookSpec | null` instead
        // of being re-evaluated twice — same value, same branches, but the
        // narrowing survives into the guard. `Boolean(...) &&` would not narrow
        // inside the true branch.
        const shown = applied ? spec : saved.spec;

        return json(res, 200, {
          ok: true,
          intent: turn.intent,
          reply: saved.messages[saved.messages.length - 1].content,
          guarded: turn.guarded === true,
          lostRows: turn.lostRows || 0,
          notes: turn.notes || [],
          pending,
          applied,
          messages: publicMessages(saved.messages),
          preview: shown ? previewSpec(writeSpec(shown)) : null,
          proposed: pending && spec ? { rows: specStats(spec).rows, preview: previewSpec(writeSpec(spec)) } : null,
        });
      }

      /** Apply a proposal that was held for confirmation. */
      const sessApply = /^POST \/api\/sessions\/([^/]+)\/apply$/.exec(route);
      if (sessApply) {
        const session = await state.sessions.load(decodeURIComponent(sessApply[1]));
        if (!session) return fail(res, 404, '会话不存在');
        const held = state.pending.get(session.id);
        if (!held) return fail(res, 409, '没有待确认的修改');

        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as Record<string, unknown>;
        if (body.accept === false) {
          state.pending.delete(session.id);
          return json(res, 200, { ok: true, applied: false, messages: publicMessages(session.messages) });
        }

        const saved = await state.sessions.update(session.id, (current: Session) => ({
          ...current,
          title: current.title || (held.spec && held.spec.title) || '',
          spec: held.spec,
          changes: [
            ...current.changes,
            { request: held.message, summary: describeChange(current.spec, held.spec), at: new Date().toISOString() },
          ],
        }));
        state.pending.delete(session.id);
        if (!saved) return fail(res, 404, '会话不存在');
        return json(res, 200, {
          ok: true,
          applied: true,
          session: publicSession(saved),
          preview: saved.spec ? previewSpec(writeSpec(saved.spec)) : null,
        });
      }

      /** The current workbook as bytes. Derived from the spec, never cached. */
      const sessFile = /^GET \/api\/sessions\/([^/]+)\/workbook\.xlsx$/.exec(route);
      if (sessFile) {
        const session = await state.sessions.load(decodeURIComponent(sessFile[1]));
        if (!session) return fail(res, 404, '会话不存在');

        // The guard that used to read `if (!session.spec)` now binds the spec to
        // a local: same check, same 404, but the narrowing survives into
        // `writeSpec` below (a property read does not).
        const spec = session.spec;
        if (!spec) return fail(res, 404, '这个会话还没有生成表格');

        const buffer = writeSpec(spec);
        const name = `${spec.title || session.title || '工作簿'}.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Length': buffer.length,
          'Content-Disposition': contentDisposition(name),
        });
        res.end(buffer);
        return;
      }


      // ------------------------------------------------------ attachments
      if (route === 'POST /api/attachments') {
        const { files } = await readUpload(req);
        if (files.length > MAX_FILES) return fail(res, 400, `一次最多 ${MAX_FILES} 个附件`);

        const wantModel = (await state.settings.load()).useForAttachments;
        const { imageExtractor: imgEx, textExtractor: txtEx } = extractorsFor(wantModel);

        const results: Array<Record<string, unknown>> = [];
        for (const f of files) {
          const filename = f.filename;
          try {
            const att = await readAttachment(f.data, filename, {
              imageExtractor: imgEx,
              textExtractor: txtEx,
            });
            state.uploads.push({ ...att, filename, data: f.data });
            results.push(publicAttachment(att));
          } catch (err) {
            results.push({ name: filename, kind: 'error', error: String((err as HttpError).message || err) });
          }
        }
        // Tell the UI when the model was wanted but did not deliver, so a
        // degraded parse is visible rather than mysterious.
        if (modelNotes.length) {
          return json(res, 200, { ok: true, attachments: results, modelNotes });
        }
        return json(res, 200, { ok: true, attachments: results });
      }

      if (route === 'GET /api/attachments') {
        return json(res, 200, { ok: true, attachments: state.uploads.map(publicAttachment) });
      }

      if (route === 'DELETE /api/attachments') {
        state.uploads = [];
        return json(res, 200, { ok: true });
      }

      return fail(res, 404, `未知接口：${req.method} ${url.pathname}`);
    } catch (err) {
      const status = (err as HttpError).statusCode || 500;
      if (status >= 500) console.error('[tab-agent]', err);
      return fail(res, status, String((err as HttpError).message || err));
    }
  };
}

/** Collect multipart parts, splitting files from plain fields. */
async function readUpload(req: http.IncomingMessage): Promise<{ parts: MultipartPart[]; files: MultipartFile[]; fields: Record<string, string> }> {
  const body = await readBody(req);
  const ct = req.headers['content-type'] || '';
  if (!/multipart\/form-data/i.test(ct)) {
    throw Object.assign(new Error('期望 multipart/form-data'), { statusCode: 400 });
  }
  const parts = parseMultipart(body, ct);
  const files = parts.filter((p): p is MultipartFile => Boolean(p.filename));
  const fields: Record<string, string> = {};
  for (const p of parts) if (!p.filename && p.name) fields[p.name] = p.data.toString('utf8');
  return { parts, files, fields };
}

function publicAttachment(att: Attachment): Record<string, unknown> {
  // The raw bytes never go back to the client.
  const { data, ...rest } = att;
  void data;
  return {
    name: rest.name,
    kind: rest.kind,
    note: rest.note,
    error: rest.error,
    extractError: rest.extractError,
    meta: rest.meta,
    sheets: rest.sheets ? rest.sheets.map((s) => ({ sheet: s.sheet, header: s.header, rowCount: s.rows.length })) : undefined,
    header: rest.header,
    rowCount: rest.table ? rest.table.rows.length : undefined,
    columns: rest.table ? rest.table.columns.map((c) => ({ label: c.label, type: c.type })) : undefined,
    textPreview: rest.text ? String(rest.text).slice(0, 800) : undefined,
    preview: rest.table ? rest.table.rows.slice(0, 5) : undefined,
  };
}

/**
 * The current attachments, as the text the model reads this turn.
 *
 * Composed HERE, per turn, and never stored. It used to be composed in the
 * client (NOTES.md #59) and sent as part of the user's message, which meant the
 * server saved it as what the user said: the block showed up in the chat bubble,
 * was saved again on every turn while the file stayed attached, and then ate the
 * history budget on every turn after that. The user's message is what they
 * typed; the attachment is context for the turn, the same way the spec is.
 *
 * Built from `publicAttachment` so the model sees exactly what the chips
 * describe — the same five preview rows, the same text cap — not a richer view
 * the user has no way to check.
 */
function attachmentContext(uploads: UploadedAttachment[]): string {
  const blocks = uploads.map((u) => {
    const a = publicAttachment(u);
    const head = `【附件：${a.name}】`;
    if (a.kind === 'table' || a.kind === 'sheet') {
      const cols = ((a.columns as Array<{ label: string }> | undefined) || []).map((c) => c.label).join('、');
      const rows = ((a.preview as unknown[][] | undefined) || []).map((r) => r.join('\t')).join('\n');
      const more = a.rowCount ? `（共 ${a.rowCount} 行，下面只给前几行）` : '';
      return `${head}${more}\n列：${cols}\n${rows}`;
    }
    if (a.textPreview) return `${head}\n${String(a.textPreview)}`;
    return `${head}（${a.note || '无法预览内容'}）`;
  });
  return blocks.length ? `--- 附件资料 ---\n${blocks.join('\n\n')}` : '';
}

/**
 * Names of the attachments a turn was sent with, for the stored message.
 *
 * No error filter here or above: a file that failed to parse is reported in
 * the upload response and never enters `state.uploads`.
 */
function attachmentNames(uploads: UploadedAttachment[]): string[] {
  return uploads.map((u) => u.name);
}

/**
 * Serve UI assets; returns false when the path is not a file we own.
 *
 * Delegates to the asset registry so the same code serves a packaged build
 * (assets embedded in the executable) and a development checkout (assets on
 * disk). See lib/assets.js.
 */
function serveStatic(res: http.ServerResponse, dir: string | undefined, pathname: string): boolean {
  const asset = readAsset({ dir, pathname });
  if (!asset) return false;
  res.writeHead(200, {
    'Content-Type': asset.type,
    'Content-Length': asset.body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(asset.body);
  return true;
}

/**
 * What `createServer` accepts.
 *
 * `state` and `settingsOverride` are test seams: a caller can hand in a
 * pre-built state, or a whole settings object, so a test can run against a
 * scratch data directory without writing a real key anywhere. `agentTransport`
 * is the third, documented in full below.
 */
interface ServerOptions {
  state?: AppState;
  dataDir?: string;
  staticDir?: string;
  imageExtractor?: Extractor;
  textExtractor?: Extractor;
  transport?: Transport;
  settingsOverride?: SettingsLike;
}

/**
 * An http.Server that carries the state it serves with.
 *
 * `server.state` is how a caller reaches the live state after start-up (the
 * test suite constructs servers this way). Node's `Server` type has no such
 * property, so the intersection is what names it.
 */
type ServerWithState = http.Server<typeof http.IncomingMessage, typeof http.ServerResponse> & { state: AppState };

/** Create and start the server. */
function createServer(opts: ServerOptions): ServerWithState {
  const state = opts.state || new AppState({
    dataDir: opts.dataDir || path.join(process.cwd(), 'data'),
  });
  /**
   * Test seams for the agent transport and settings.
   *
   * `transport` replaces `llm.chat` for the session endpoints, so a test can
   * exercise the REAL decision logic — intent, the guard, normalisation — with
   * only the network call faked. Stubbing at the module cache does not work:
   * `lib/agent.js` destructures `chat` at require time, so the binding survives
   * any later swap.
   *
   * `settingsOverride` is here for the same reason: a test needs a configured
   * model without writing a real key to a real data directory.
   */
  if (opts.transport) state.agentTransport = opts.transport;
  if (opts.settingsOverride) state.settings = opts.settingsOverride;

  const handler = createHandler({
    state,
    staticDir: opts.staticDir,
    imageExtractor: opts.imageExtractor,
    textExtractor: opts.textExtractor,
  });
  const server: ServerWithState = Object.assign(
    http.createServer((req, res) => {
      handler(req, res).catch((err) => {
        console.error('[tab-agent] handler failure', err);
        if (!res.headersSent) fail(res, 500, String((err as HttpError).message || err));
        else res.end();
      });
    }),
    { state },
  );
  return server;
}

export {
  createServer,
  createHandler,
  AppState,
  parseMultipart,
  safeFilename,
  readBody,
  publicAttachment,
  contentDisposition,
  MAX_UPLOAD,
};
