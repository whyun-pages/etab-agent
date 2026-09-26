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

  const dl = el('button', { class: 'btn btn--sm', type: 'button', title: '下载 .xlsx' });
  dl.innerHTML = `${icon('download')}<span>下载</span>`;
  dl.disabled = !sheet || !sheet.rows.length;
  dl.addEventListener('click', () => handlers.onDownload());
  tools.append(dl);

  head.append(tools);
  root.append(head);

  // ── body ───────────────────────────────────────────────────────────
  const body = el('div', { class: 'preview__body' });

  if (!sheet || !sheet.rows.length) {
    body.append(emptyPreview(state));
  } else {
    body.append(sheetView(sheet));
  }
  root.append(body);

  return root;
}

/** A sentence for the header: how big the thing is, in the units a person uses. */
function sheetStats(sheet) {
  const rows = sheet.rows.length;
  const cols = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0);
  // The first row is headers, not data.
  const data = Math.max(0, rows - 1);
  const bits = [`${data} 行`, `${cols} 列`];
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
