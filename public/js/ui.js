/* ════════════════════════════════════════════════════════════════════
   Shell chrome: toasts, modal, drag overlay.
   ════════════════════════════════════════════════════════════════════ */

import { el, esc } from './dom.js';
import { icon } from './icons.js';

// ── toasts ──────────────────────────────────────────────────────────

const toasts = () => document.getElementById('toasts');

/**
 * Show a transient message.
 *
 * Also takes the short form `toast(title, tone)`. Callers wrote it that way
 * long before it was supported, and the object destructuring then found no
 * `title` in a string: the toast rendered, empty, in the wrong colour.
 *
 * @param {object|string} opts
 * @param {'ok'|'err'|'warn'|'info'} [opts.tone]
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {{label: string, onClick: Function}} [opts.action]
 * @param {number} [opts.ms] 0 keeps it until dismissed
 */
export function toast(opts, toneArg) {
  const {
    tone = 'info',
    title = '',
    body = '',
    action = null,
    ms = 4200,
  } = typeof opts === 'string' ? { title: opts, tone: toneArg } : opts;
  const node = el('div', { class: `toast toast--${tone}` });
  const iconName = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' }[tone] || 'info';
  node.innerHTML =
    `<span class="row__icon" style="margin-top:1px">${icon(iconName)}</span>` +
    `<div class="toast__body"><span class="toast__title">${esc(title)}</span>${body ? esc(body) : ''}</div>`;

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
    btn.addEventListener('click', () => {
      action.onClick();
      close();
    });
    node.querySelector('.toast__body').append(' ', btn);
  }

  node.addEventListener('click', (e) => {
    if (e.target === node) close();
  });
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
