/* ════════════════════════════════════════════════════════════════════
   Preview pane — the right-hand side, and the point of the app.

   The conversation says what happened; this says what the file IS. A model
   that describes a table convincingly and one that actually produced one look
   identical in a transcript, so the artifact has to be on screen continuously
   rather than behind a download.

   Three states, and the empty one is deliberate: with no workbook there is
   nothing to draw, and a blank grid would read as "your table is empty"
   rather than "there is no table yet".
   ════════════════════════════════════════════════════════════════════ */

import { el } from '../dom.js';
import { icon } from '../icons.js';
import { sheetView } from './sheet.js';

const FORMATS = [['xlsx', 'xlsx'], ['csv', 'CSV'], ['json', 'JSON']];

/** The picked format, kept across re-renders for the life of the page. */
let downloadFormat = 'xlsx';

/**
 * Watches the bottom of the grid; replaced on every render, because the pane
 * and the sentinel it watches are rebuilt each time.
 */
let pager = null;

/**
 * @param {object} state
 * @param {object} handlers { onDownload }
 * @returns {HTMLElement}
 */
export function previewView(state, handlers) {
  const root = el('section', { class: 'preview' });

  const head = el('header', { class: 'preview__head' });
  head.append(el('span', { class: 'preview__title', text: '表格预览' }));

  const sheet = state.preview;
  const tools = el('div', { class: 'preview__tools' });

  if (sheet && sheet.rows.length) {
    const stats = sheetStats(sheet);
    tools.append(el('span', { class: 'preview__stat', text: stats }));
  }

  // The format picker sits next to the button rather than in a menu: three
  // choices, and the one in effect should be visible before the click. CSV
  // holds a single table, so it exports the sheet on screen.
  const empty = !sheet || !sheet.rows.length;
  const fmt = el('select', { class: 'preview__format', title: '下载格式', 'aria-label': '下载格式' });
  for (const [value, label] of FORMATS) {
    const opt = el('option', { value, text: label });
    opt.selected = value === downloadFormat;
    fmt.append(opt);
  }
  fmt.disabled = empty;
  fmt.addEventListener('change', () => { downloadFormat = fmt.value; });
  tools.append(fmt);

  const dl = el('button', { class: 'btn btn--sm', type: 'button', title: '下载' });
  dl.innerHTML = `${icon('download')}<span>下载</span>`;
  dl.disabled = empty;
  dl.addEventListener('click', () => handlers.onDownload(downloadFormat, sheet && sheet.name));
  tools.append(dl);

  head.append(tools);
  root.append(head);

  // ── body ───────────────────────────────────────────────────────────
  const body = el('div', { class: 'preview__body' });

  if (pager) { pager.disconnect(); pager = null; }
  if (!sheet || !sheet.rows.length) {
    body.append(emptyPreview(state));
  } else {
    body.append(sheetView(sheet));
    const more = moreRows(state, handlers, body);
    if (more) body.append(more);
    const cut = columnsCut(sheet);
    if (cut) body.append(cut);
  }
  root.append(body);

  return root;
}

/**
 * The line under the grid while rows are still on the server.
 *
 * Loading is driven by this line coming into view — scrolling to the bottom is
 * the request — and it says how far along the user is. A button stays as the
 * fallback: a failed page is retried on purpose, not in a loop, and a click
 * works where an observer does not fire.
 */
function moreRows(state, handlers, body) {
  const sheet = state.preview;
  const loaded = (sheet.startRow || 1) - 1 + sheet.rows.length;
  const total = sheet.totalRows || loaded;
  if (loaded >= total) return null;

  const line = el('div', { class: 'preview__more' });
  line.append(el('span', { text: `已显示 ${dataRows(loaded)} / ${dataRows(total)} 行` }));
  if (state.previewLoading) {
    line.append(el('span', { class: 'spinner' }), el('span', { text: '正在加载…' }));
  } else if (state.previewError) {
    line.append(el('span', { class: 'preview__moreerr', text: `加载失败：${state.previewError}` }));
    line.append(el('button', { class: 'btn btn--sm', type: 'button', text: '重试', onclick: handlers.onMorePreview }));
  } else {
    line.append(el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: '加载更多', onclick: handlers.onMorePreview }));
    if (typeof IntersectionObserver === 'function') {
      // A margin below the edge, so the next page is on its way before the
      // user reaches the end of this one.
      pager = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) handlers.onMorePreview();
      }, { root: body, rootMargin: '0px 0px 400px 0px' });
      pager.observe(line);
    }
  }
  return line;
}

/** Columns are not paged; past the cap the grid says what it left out. */
function columnsCut(sheet) {
  const shown = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (!sheet.totalCols || sheet.totalCols <= shown) return null;
  return el('p', { class: 'hint preview__cut', text: `只显示前 ${shown} 列（共 ${sheet.totalCols} 列），下载可得到完整表格。` });
}

/** Sheet rows to data rows: the first row is the header. */
const dataRows = (n) => Math.max(0, n - 1);

/** A sentence for the header: how big the thing is, in the units a person uses. */
function sheetStats(sheet) {
  // The whole sheet, not the rows loaded so far: this is what the file holds.
  const rows = sheet.totalRows || sheet.rows.length;
  const cols = sheet.totalCols || sheet.rows.reduce((m, r) => Math.max(m, r.length), 0);
  const bits = [`${dataRows(rows)} 行`, `${cols} 列`];
  if (sheet.name) bits.unshift(sheet.name);
  return bits.join(' · ');
}

function emptyPreview(state) {
  const box = el('div', { class: 'preview__empty' });

  if (state.busy.turn) {
    box.append(el('span', { class: 'spinner' }));
    box.append(el('p', { class: 'preview__hint', text: '正在生成表格…' }));
    return box;
  }

  box.append(el('span', { class: 'preview__emptyicon', html: icon('sheet') }));

  if (!state.settings?.hasKey) {
    box.append(el('p', { class: 'preview__hint', text: '还没有配置模型。到设置里填一个 API key 就能开始。' }));
    return box;
  }

  box.append(el('p', {
    class: 'preview__hint',
    text: state.activeId
      ? '说一句要做什么表，比如「做一个销售台账，三个客户…」，表格会出现在这里。'
      : '左边新建一个会话，或者选一个过去的会话继续。',
  }));
  return box;
}
