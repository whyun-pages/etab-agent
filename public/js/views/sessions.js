/* ════════════════════════════════════════════════════════════════════
   Sessions rail — the list on the left.

   A session is a conversation AND the workbook it produced, so the row has to
   carry both: a sentence to recognise it by ("杭州云图那个销售台账") and a hint
   that something came out of it (3 行 · 4 列). A list of timestamps would be
   technically correct and useless.
   ════════════════════════════════════════════════════════════════════ */

import { el } from '../dom.js';
import { icon } from '../icons.js';

/**
 * @param {object} state
 * Folded, the rail keeps the two things that do not need the list: unfold it,
 * and start a new session. Everything else waits for the list to come back.
 *
 * @param {object} state
 * @param {object} handlers { onOpen, onRemove, onCreate, onToggle }
 * @returns {HTMLElement}
 */
export function sessionsView(state, handlers) {
  const root = el('aside', { class: 'rail' });

  if (state.railCollapsed) {
    const strip = el('div', { class: 'rail__strip' });
    strip.append(toggleButton(state, handlers));
    strip.append(createButton(state, handlers));
    root.append(strip);
    return root;
  }

  // ── header ─────────────────────────────────────────────────────────
  const head = el('header', { class: 'rail__head' });
  head.append(el('span', { class: 'rail__title', text: '会话' }));
  head.append(createButton(state, handlers));
  head.append(toggleButton(state, handlers));
  root.append(head);

  // ── body ───────────────────────────────────────────────────────────
  const body = el('div', { class: 'rail__body' });

  if (!state.sessions.length) {
    body.append(el('p', { class: 'rail__empty', text: '还没有会话。' }));
  } else {
    const list = el('ul', { class: 'rail__list' });
    for (const s of state.sessions) list.append(row(s, state.activeId, handlers));
    body.append(list);
  }
  root.append(body);

  return root;
}

/** Fold or unfold the list; the title says which, since the icon is the same. */
function toggleButton(state, handlers) {
  const label = state.railCollapsed ? '展开会话列表（Ctrl+B）' : '折叠会话列表（Ctrl+B）';
  const btn = el('button', {
    class: 'iconbtn rail__toggle', type: 'button', title: label, html: icon('panel'),
  });
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', String(!state.railCollapsed));
  btn.addEventListener('click', handlers.onToggle);
  return btn;
}

function createButton(state, handlers) {
  const add = el('button', { class: 'iconbtn rail__add', type: 'button', title: '新建会话' });
  add.innerHTML = icon('sparkle');
  add.disabled = state.busy.create;
  add.addEventListener('click', handlers.onCreate);
  return add;
}

/** One session row. */
function row(session, activeId, handlers) {
  const isActive = session.id === activeId;
  const li = el('li');

  const btn = el('button', {
    class: `rail__item${isActive ? ' is-active' : ''}`,
    type: 'button',
  });

  const main = el('div', { class: 'rail__main' });
  main.append(el('span', { class: 'rail__name', text: session.title || '未命名会话' }));

  const bits = [];
  if (session.rows) bits.push(`${session.rows} 行`);
  if (session.messages) bits.push(`${session.messages} 条`);
  main.append(el('span', { class: 'rail__sub', text: bits.join(' · ') || '空对话' }));

  btn.append(main);

  const del = el('span', { class: 'rail__del', title: '删除', html: icon('trash') });
  del.addEventListener('click', (e) => {
    // The delete sits inside the row's button; without this the click would
    // also open the session it is deleting.
    e.stopPropagation();
    e.preventDefault();
    handlers.onRemove(session);
  });
  btn.append(del);

  btn.addEventListener('click', () => { if (!isActive) handlers.onOpen(session.id); });

  li.append(btn);
  return li;
}
