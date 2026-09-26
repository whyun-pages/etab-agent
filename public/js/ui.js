/* ════════════════════════════════════════════════════════════════════
   Shell chrome: toasts, modal, command palette, drag overlay.
   ════════════════════════════════════════════════════════════════════ */

import { el, esc, iconBox } from './dom.js';
import { icon } from './icons.js';

// ── toasts ──────────────────────────────────────────────────────────

const toasts = () => document.getElementById('toasts');

/**
 * Show a transient message.
 * @param {object} opts
 * @param {'ok'|'err'|'warn'|'info'} [opts.tone]
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {{label: string, onClick: Function}} [opts.action]
 * @param {number} [opts.ms] 0 keeps it until dismissed
 */
export function toast({ tone = 'info', title, body = '', action = null, ms = 4200 }) {
  const node = el('div', { class: `toast toast--${tone}` });
  const iconName = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' }[tone] || 'info';
  node.innerHTML =
    `<span class="row__icon" style="margin-top:1px">${icon(iconName)}</span>`
    + `<div class="toast__body"><span class="toast__title">${esc(title)}</span>${body ? esc(body) : ''}</div>`;

  const box = toasts();
  box.append(node);

  let once = false;
  const close = () => {
    if (once) return;
    once = true;
    node.style.opacity = '0';
    node.style.transition = 'opacity 120ms';
    setTimeout(() => node.remove(), 130);
  };

  if (action) {
    const btn = el('button', { class: 'toast__act', text: action.label, type: 'button' });
    btn.addEventListener('click', () => { action.onClick(); close(); });
    node.querySelector('.toast__body').append(' ', btn);
  }

  node.addEventListener('click', (e) => { if (e.target === node) close(); });
  if (ms > 0) setTimeout(close, ms);
  return close;
}

// ── modal ───────────────────────────────────────────────────────────

let modalCloser = null;

/**
 * Open a modal. Returns a close() function.
 * @param {{title: string, body: Node|string, footer?: Node[], onClose?: Function}} opts
 */
export function openModal({ title, body, footer = [], onClose }) {
  const root = document.getElementById('modal');
  document.getElementById('modal-title').textContent = title;

  const bodyEl = document.getElementById('modal-body');
  bodyEl.replaceChildren(typeof body === 'string' ? el('div', { html: body }) : body);

  const footEl = document.getElementById('modal-foot');
  footEl.replaceChildren(...footer);
  footEl.hidden = footer.length === 0;

  root.hidden = false;

  const close = () => {
    if (root.hidden) return;
    root.hidden = true;
    modalCloser = null;
    if (onClose) onClose();
  };
  modalCloser = close;
  return close;
}

export function closeModal() {
  if (modalCloser) modalCloser();
}

/** Wire the modal's [data-close] handles and Esc once at startup. */
export function initModal() {
  const root = document.getElementById('modal');
  for (const node of root.querySelectorAll('[data-close]')) {
    node.addEventListener('click', closeModal);
  }
}

// ── command palette ─────────────────────────────────────────────────

/**
 * A filterable list of actions, in the style of an editor's quick-open.
 * @param {{items: Array<{id,label,sub,icon,run}>, placeholder?: string, emptyText?: string}} opts
 */
export function openPalette({ items, placeholder = '输入以筛选…', emptyText = '没有匹配项' }) {
  const list = el('ul', { class: 'palette__list' });
  const input = el('input', { class: 'palette__input', placeholder, type: 'text', spellcheck: 'false' });

  const wrap = el('div', {}, [input, list]);
  const close = openModal({ title: '快速打开', body: wrap });
  wrap.closest('.modal__box').classList.add('modal__box--palette');

  let filtered = items;
  let cursor = 0;

  const paint = () => {
    if (!filtered.length) {
      list.replaceChildren(el('li', { class: 'empty', text: emptyText }));
      return;
    }
    list.replaceChildren(...filtered.map((it, i) => {
      const btn = el('button', {
        class: `palette__item${i === cursor ? ' is-cursor' : ''}`,
        type: 'button',
        html: `${iconBox(it.icon || 'file')}<span class="row__text"><span class="row__title">${esc(it.label)}</span>`
          + `${it.sub ? `<span class="row__sub">${esc(it.sub)}</span>` : ''}</span>`,
      });
      btn.addEventListener('click', () => { close(); it.run(); });
      btn.addEventListener('mousemove', () => {
        if (cursor === i) return;
        cursor = i;
        paint();
      });
      return el('li', {}, [btn]);
    }));
  };

  const filter = () => {
    const q = input.value.trim().toLowerCase();
    filtered = !q ? items : items.filter((it) => `${it.label} ${it.sub || ''}`.toLowerCase().includes(q));
    cursor = 0;
    paint();
  };

  input.addEventListener('input', filter);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, filtered.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(cursor - 1, 0); paint(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = filtered[cursor];
      if (it) { close(); it.run(); }
    }
  });

  paint();
  setTimeout(() => input.focus(), 0);
  return close;
}

// ── drag overlay ────────────────────────────────────────────────────

let dragDepth = 0;

/**
 * Turn the whole window into a drop target.
 * @param {(files: FileList) => void} onDrop  receives every dropped file
 * @param {() => boolean} [isBusy]
 */
export function initDragDrop(onDrop) {
  const overlay = document.getElementById('drag-overlay');

  const show = (on) => overlay.classList.toggle('is-on', on);

  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth += 1;
    show(true);
  });
  window.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) show(false);
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    show(false);
    onDrop(e.dataTransfer.files);
  });
}
