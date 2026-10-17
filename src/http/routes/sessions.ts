'use strict';
/**
 * Sessions, the template-free API. A session IS the document: it holds the
 * conversation and the spec, and the workbook is derived from the spec on
 * demand. Nothing here needs an uploaded file.
 *
 *   GET    /api/sessions
 *   POST   /api/sessions
 *   GET    /api/sessions/:id
 *   GET    /api/sessions/:id/preview
 *   POST   /api/sessions/:id/column-width
 *   DELETE /api/sessions/:id
 *   GET    /api/sessions/:id/workbook.:format
 *
 * The turn itself, and applying a held change, are in ./turn.ts.
 */

import type { Router } from '@koa/router';
import { applyOps } from '../../workbook/spec-ops.ts';
import { exportSpec, isExportFormat, ExportError } from '../../workbook/export.ts';
import { PREVIEW_PAGE_ROWS, MAX_PAGE_ROWS } from '../../workbook/preview.ts';
import { previewOf, previewSource } from '../app-state.ts';
import { fail, jsonBody, bodyOf, contentDisposition, messageOf, sessionOr404, noSession } from './http.ts';
import { publicSession } from './views.ts';
import type { RouteDeps } from './index.ts';

type Session = import('../../store/session-store.ts').Session;
type ExportFile = import('../../workbook/export.ts').ExportFile;

export function sessionRoutes(router: Router, { state }: RouteDeps): void {
  router.get('/api/sessions', async (ctx) => {
    ctx.body = { ok: true, sessions: await state.sessions.list() };
  });

  router.post('/api/sessions', jsonBody('64kb'), async (ctx) => {
    const session = await state.sessions.create(String(bodyOf(ctx).title || '').slice(0, 200));
    await state.sessions.prune();
    ctx.body = { ok: true, session: publicSession(session) };
  });

  router.get('/api/sessions/:id', async (ctx) => {
    const session = await sessionOr404(ctx, state.sessions);
    if (!session) return;
    ctx.body = {
      ok: true,
      session: publicSession(session),
      preview: session.spec ? previewOf(state, session.spec) : null,
      canEdit: Boolean((await state.settings.load()).chatCanEdit),
    };
  });

  /**
   * More rows of the preview, as the user scrolls.
   *
   * `key` is the one the first window came with. If the table has changed
   * since — a turn landed, the proposal was answered — the answer is `stale`
   * and no rows, and the client reloads from the top rather than appending rows
   * of a different table under the ones it has. `proposed=1` pages the held
   * proposal instead of the stored table.
   */
  router.get('/api/sessions/:id/preview', async (ctx) => {
    const session = await sessionOr404(ctx, state.sessions);
    if (!session) return;
    const q = ctx.URL.searchParams;
    const spec = q.get('proposed') === '1' ? state.pending.get(session.id)?.spec : session.spec;
    if (!spec || previewSource(state, spec).key !== q.get('key')) {
      ctx.body = { ok: true, stale: true };
      return;
    }
    const from = Math.max(1, Number.parseInt(q.get('from') || '', 10) || 1);
    const asked = Number.parseInt(q.get('count') || '', 10) || PREVIEW_PAGE_ROWS;
    const count = Math.min(Math.max(1, asked), MAX_PAGE_ROWS);
    const page = previewOf(state, spec, { startRow: from, maxRows: count });
    ctx.body = {
      ok: true,
      stale: false,
      key: page.key,
      startRow: page.startRow,
      rows: page.rows,
      formats: page.formats,
      totalRows: page.totalRows,
    };
  });

  /**
   * A column's width, dragged in the preview.
   *
   * Applied inside `update`, like a turn's edits: a turn may be in flight, and
   * writing back a spec read before it would undo whatever it lands. The
   * column is named by `index` AND `header`, and both must still agree on the
   * stored table — the preview may predate a turn that renamed or moved
   * columns, and widening the wrong column is worse than refusing.
   *
   * The answer carries only the new `key` and `cols`: the rows did not change,
   * so the client keeps every page it has loaded.
   */
  router.post('/api/sessions/:id/column-width', jsonBody('16kb'), async (ctx) => {
    const body = bodyOf(ctx);
    const index = Number(body.index);
    const header = String(body.header ?? '');
    let conflict = '';
    let found = false;
    // A refusal returns null so nothing is written; `found` tells it apart
    // from a session that does not exist.
    const saved = await state.sessions.update(ctx.params.id, (current: Session) => {
      found = true;
      const sheet = current.spec?.sheets.find((s) => s.name === body.sheet);
      const first = sheet ? sheet.columns.findIndex((c) => c.header === header) : -1;
      if (!sheet || !Number.isInteger(index) || first !== index) {
        conflict = '表格在这期间被改动过，列宽没有保存';
        return null;
      }
      try {
        const next = applyOps(current.spec, [
          { op: 'set_column_widths', args: { sheet: sheet.name, widths: [{ header, width: body.width }] } },
        ]).spec;
        return next ? { ...current, spec: next } : null;
      } catch (err) {
        conflict = messageOf(err);
        return null;
      }
    });
    if (!found) return noSession(ctx);
    if (conflict || !saved) return fail(ctx, 409, conflict || '列宽没有保存');
    const preview = saved.spec ? previewOf(state, saved.spec) : null;
    ctx.body = { ok: true, key: preview?.key ?? null, cols: preview?.cols ?? [] };
  });

  router.delete('/api/sessions/:id', async (ctx) => {
    const sid = ctx.params.id;
    const ok = await state.sessions.remove(sid);
    state.dropUploads(sid);
    // A miss answers like every other failure, with an `error` to show.
    if (!ok) return noSession(ctx);
    ctx.body = { ok };
  });

  /**
   * The current workbook as bytes, in any export format. Derived from the
   * spec, never cached. CSV holds one table: `?sheet=` names it, and the first
   * sheet is the default.
   */
  router.get('/api/sessions/:id/workbook.:format', async (ctx) => {
    const session = await sessionOr404(ctx, state.sessions);
    if (!session) return;
    // Bound to a local so the narrowing survives into `exportSpec` below.
    const spec = session.spec;
    if (!spec) return fail(ctx, 404, '这个会话还没有生成表格');

    const format = ctx.params.format;
    if (!isExportFormat(format)) return fail(ctx, 404, '不支持的格式');
    const sheet = ctx.URL.searchParams.get('sheet') || (format === 'csv' ? spec.sheets[0].name : null);
    let file: ExportFile;
    try {
      [file] = exportSpec(spec, { format, sheet, filename: spec.title || session.title || '工作簿' });
    } catch (err) {
      if (err instanceof ExportError) return fail(ctx, 404, err.message);
      throw err;
    }
    ctx.type = file.mime;
    ctx.set('Content-Disposition', contentDisposition(file.name));
    ctx.body = file.bytes;
  });
}
