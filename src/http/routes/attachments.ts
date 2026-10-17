'use strict';
/**
 * A session's attachments.
 *
 *   GET    /api/sessions/:id/attachments
 *   POST   /api/sessions/:id/attachments          multipart, field name free
 *   DELETE /api/sessions/:id/attachments
 *   POST   /api/sessions/:id/attachments/:aid/open
 *
 * Uploads are parsed by multer (busboy underneath), kept in memory: the bytes
 * live with the session's uploads for the life of the process anyway (see
 * AppState.uploads), so a temp file would only be a second copy to clean up.
 */

import fs from 'node:fs';
import path from 'node:path';
import multer from '@koa/multer';
import type { Router } from '@koa/router';
import type { Context } from 'koa';
import { ingestFile } from '../../ingest/ingest.ts';
import { isOpenable } from '../../platform/open-file.ts';
import { safeId as safeSessionId } from '../../store/session-store.ts';
import { toUpload } from '../app-state.ts';
import type { AppState, Extractor, UploadedAttachment } from '../app-state.ts';
import { fail, isLocalRequest, safeFilename, messageOf, sessionOr404 } from '../respond.ts';
import { publicUpload } from '../projections.ts';
import type { RouteDeps } from './index.ts';

/** Per request, and per file: an upload is at most this big. */
export const MAX_UPLOAD = 32 * 1024 * 1024;
export const MAX_FILES = 20;

/** One entry of the `modelNotes` array an upload response may carry. */
interface ModelNote {
  step: string;
  error: string;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: MAX_FILES },
  // busboy's default reads a filename without an explicit charset as latin1,
  // which turns every 订单.xlsx into mojibake. Browsers send UTF-8.
  defParamCharset: 'utf8',
} as multer.Options);

/**
 * Some clients percent-encode a filename instead of sending UTF-8; only then is
 * it decoded, and never at the cost of throwing on a malformed sequence.
 */
function decodeName(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The upload's files, parsed only after the route has decided it wants them.
 * multer's limits become the answers the client has always had: 413 for size,
 * 400 for count.
 */
async function readFiles(ctx: Context): Promise<{ filename: string; data: Buffer }[]> {
  if (!ctx.is('multipart/form-data')) {
    const err = Object.assign(new Error('期望 multipart/form-data'), { status: 400 });
    throw err;
  }
  // Refused before a byte is read when the client says up front it is too big.
  if (Number(ctx.get('content-length')) > MAX_UPLOAD) throw Object.assign(new Error('上传内容过大'), { status: 413 });
  try {
    await upload.any()(ctx, async () => {});
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'LIMIT_FILE_SIZE') throw Object.assign(new Error('上传内容过大'), { status: 413 });
    if (code === 'LIMIT_FILE_COUNT') throw Object.assign(new Error(`一次最多 ${MAX_FILES} 个附件`), { status: 400 });
    throw Object.assign(new Error(messageOf(err)), { status: 400 });
  }
  const files = Array.isArray(ctx.files) ? ctx.files : Object.values(ctx.files || {}).flat();
  return files.map((f) => ({ filename: safeFilename(decodeName(f.originalname)), data: f.buffer }));
}

export function attachmentRoutes(router: Router, { state, imageExtractor, textExtractor }: RouteDeps): void {
  router.get('/api/sessions/:id/attachments', async (ctx) => {
    const sid = ctx.params.id;
    if (!(await sessionOr404(ctx, state.sessions))) return;
    ctx.body = { ok: true, attachments: (state.uploads.get(sid) || []).map(publicUpload) };
  });

  router.delete('/api/sessions/:id/attachments', async (ctx) => {
    const sid = ctx.params.id;
    if (!(await sessionOr404(ctx, state.sessions))) return;
    state.dropUploads(sid);
    ctx.body = { ok: true };
  });

  router.post('/api/sessions/:id/attachments', async (ctx) => {
    const sid = ctx.params.id;
    if (!(await sessionOr404(ctx, state.sessions))) return;
    const files = await readFiles(ctx);

    // The model is opt-in: with it off, reading is fully deterministic. When it
    // is used and fails, the note carries the reason to the UI and the
    // rule-based reading still stands.
    const modelNotes: ModelNote[] = [];
    const wantModel = (await state.settings.load()).useForAttachments;
    const wrap = (fn: Extractor | undefined, label: string): Extractor | undefined =>
      wantModel && fn
        ? async (buffer, mime, filename, kind, text) => {
            try {
              return await fn(buffer, mime, filename, kind, text);
            } catch (err) {
              modelNotes.push({ step: label, error: messageOf(err) });
              throw err;
            }
          }
        : undefined;
    const extractors = { imageExtractor: wrap(imageExtractor, 'image'), textExtractor: wrap(textExtractor, 'text') };

    const results: Array<Record<string, unknown>> = [];
    const parsed: UploadedAttachment[] = [];
    // A .zip becomes one attachment per readable member (src/formats/attachments.ts
    // `ingestFile`); what it skipped is reported, not dropped silently.
    const archiveNotes: Array<{ name: string; skipped: number }> = [];
    for (const f of files) {
      const { items, skipped } = await ingestFile(f.data, f.filename, extractors);
      if (skipped.length) archiveNotes.push({ name: f.filename, skipped: skipped.length });
      for (const it of items) {
        if (!it.att) {
          results.push({ name: it.name, kind: 'error', error: it.error });
          continue;
        }
        const u = toUpload({ ...it, att: it.att });
        parsed.push(u);
        results.push(publicUpload(u));
      }
    }
    // Added after the reads, not one by one inside them: the session can be
    // deleted while a model-backed parse is in flight, and re-checking here
    // keeps a late upload from bringing back an entry the delete removed.
    if (parsed.length && (await state.sessions.load(sid))) {
      state.uploads.set(sid, [...(state.uploads.get(sid) || []), ...parsed]);
    }
    // Tell the UI when the model was wanted but did not deliver, so a degraded
    // parse is visible rather than mysterious.
    ctx.body = {
      ok: true,
      attachments: results,
      ...(modelNotes.length ? { modelNotes } : {}),
      ...(archiveNotes.length ? { archiveNotes } : {}),
    };
  });

  /**
   * Open an attachment with the computer's default program.
   *
   * This is the one route that makes the server START a program, so it is
   * local-only (see `isLocalRequest`), and only allowlisted extensions open
   * (see src/platform/open-file.ts).
   */
  router.post('/api/sessions/:id/attachments/:aid/open', async (ctx) => {
    if (!isLocalRequest(ctx)) return fail(ctx, 403, '只能在本机打开附件');
    const sid = ctx.params.id;
    if (!(await sessionOr404(ctx, state.sessions))) return;
    const u = (state.uploads.get(sid) || []).find((x) => x.id === ctx.params.aid);
    if (!u) return fail(ctx, 404, '附件不存在，可能已被清空');
    if (!isOpenable(u.filename)) return fail(ctx, 400, `出于安全考虑，不直接打开这类文件：${u.filename}`);
    const file = await openCopy(state, sid, u);
    try {
      await state.openFile(file);
    } catch (err) {
      // Not a server fault: no program for the type, or no opener at all.
      return fail(ctx, 502, messageOf(err));
    }
    ctx.body = { ok: true };
  });
}

/**
 * Write an upload to a file the OS can open, reusing the copy from an earlier
 * click while it still exists.
 *
 * Each copy gets its own folder so the file keeps its real name — that is the
 * name the opened program shows in its title bar — without two uploads that
 * share a name overwriting each other.
 */
async function openCopy(state: AppState, sid: string, u: UploadedAttachment): Promise<string> {
  if (u.openedPath) {
    try {
      await fs.promises.access(u.openedPath);
      return u.openedPath;
    } catch {
      /* removed since; write it again */
    }
  }
  const dir = path.join(state.openDir, safeSessionId(sid) || 'session', u.id);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, safeFilename(u.filename));
  await fs.promises.writeFile(file, u.data);
  u.openedPath = file;
  return file;
}
