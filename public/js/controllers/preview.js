/* ════════════════════════════════════════════════════════════════════
   The preview grid's data: paging rows in as it scrolls, and column widths
   dragged in the grid.
   ════════════════════════════════════════════════════════════════════ */

import { api, ApiError } from '../api.js';
import { state, set } from '../state.js';
import { fail } from '../feedback.js';

// ── preview paging ───────────────────────────────────────────────────

/**
 * Fetch the next page of preview rows and append it.
 *
 * Driven by the grid's bottom edge coming into view. One page at a time; a
 * preview replaced while the request was out (a turn landed, another session
 * opened) drops the answer, and a table that changed under the key reloads
 * the preview from the top instead of appending rows of a different table.
 */
export async function loadMorePreview() {
  const p = state.preview;
  const id = state.activeId;
  if (!p || !id || !p.key || state.previewLoading) return;
  const loaded = (p.startRow || 1) - 1 + p.rows.length;
  if (loaded >= (p.totalRows || 0)) return;

  set({ previewLoading: true, previewError: null });
  try {
    const res = await api.previewRows(id, { key: p.key, from: loaded + 1, count: PREVIEW_PAGE, proposed: p.proposed });
    if (state.activeId !== id || state.preview !== p) return;
    if (res.stale) {
      const fresh = await api.getSession(id);
      if (state.activeId === id) set({ preview: fresh.preview || null });
      return;
    }
    set({
      preview: {
        ...p,
        rows: p.rows.concat(res.rows || []),
        formats: (p.formats || []).concat(res.formats || []),
        totalRows: res.totalRows,
      },
    });
  } catch (err) {
    if (state.activeId === id)
      set({ previewError: err instanceof ApiError ? err.message : String(err?.message || err) });
  } finally {
    set({ previewLoading: false });
  }
}

/** Rows per page request; the server caps it too. */
const PREVIEW_PAGE = 200;

/**
 * Save a column width dragged in the preview.
 *
 * Shown at the new width at once; the server's answer brings the table's new
 * `key` (the file's bytes changed) and its `cols`. `view` keeps the table's
 * identity across that key change, so the rows already loaded and the scroll
 * position stay — not a single row changed. A refusal (the table changed
 * under the drag) puts the old width back and says why.
 */
export async function setColumnWidth(index, width) {
  const p = state.preview;
  const id = state.activeId;
  // The first window always starts at row 1, which is the header row.
  const header = p && (p.startRow || 1) === 1 && p.rows[0] ? p.rows[0][index] : null;
  if (!p || !id || p.proposed || header === null || header === undefined) return;

  const view = p.view || p.key;
  const same = () => state.activeId === id && state.preview && (state.preview.view || state.preview.key) === view;
  set({ preview: { ...p, view, cols: withWidth(p.cols, index + 1, width) } });
  try {
    const res = await api.columnWidth(id, { sheet: p.name, index, header: String(header), width });
    if (same()) set({ preview: { ...state.preview, key: res.key, cols: res.cols || [] } });
  } catch (err) {
    if (same()) set({ preview: { ...state.preview, cols: p.cols } });
    fail('列宽没有保存', err);
  }
}

/** `cols` ranges with column `c` (1-based) set to `width`, splitting a range it sits in. */
function withWidth(cols, c, width) {
  const out = [];
  for (const r of cols || []) {
    if (c < r.min || c > r.max) {
      out.push(r);
      continue;
    }
    if (r.min < c) out.push({ ...r, max: c - 1 });
    if (r.max > c) out.push({ ...r, min: c + 1 });
  }
  out.push({ min: c, max: c, width });
  return out;
}
