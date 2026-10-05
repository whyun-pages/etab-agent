/* ════════════════════════════════════════════════════════════════════
   Chat view — the left half, and the only way to make anything.

   The UI mirrors the server's contract rather than inventing its own. Three
   things it has to get right:

     1. An answer and a proposed change must LOOK different. A reply that says
        "改好了" as prose, and a reply that actually changed the table, are
        dangerously similar on screen. A change is therefore shown as a card
        with a button, never as a sentence.

     2. A proposed change is inert until clicked. The confirm button is the only
        path from "the model said it would" to "the document changed".

     3. A guard firing is shown. When the change was refused for dropping rows,
        saying so is the whole point — a silent no-op would make the assistant
        look like it ignored the request.
   ════════════════════════════════════════════════════════════════════ */

import { el, esc } from '../dom.js';
import { icon } from '../icons.js';
import { composer, prepareComposer } from '../composer.js';

const PLACEHOLDER = '说一句要做什么表…（Enter 发送，Shift+Enter 换行）';

/**
 * @param {object} state
 * @param {object} handlers { onSend, onApply, onDismiss, onDownload }
 * @returns {HTMLElement}
 */
export function chatView(state, handlers) {
  const root = el('section', { class: 'chat' });

  root.append(head(state));
  root.append(stream(state, handlers));
  root.append(composerBox(state, handlers));
  return root;
}

// ── header ──────────────────────────────────────────────────────────

function head(state) {
  const bar = el('header', { class: 'chat__head' });
  const title = state.title || '新对话';
  bar.append(el('span', { class: 'chat__title', text: title }));

  const bits = [];
  if (state.messages.length) bits.push(`${state.messages.length} 条消息`);
  if (state.preview && state.preview.rows.length) {
    const data = Math.max(0, state.preview.rows.length - 1);
    bits.push(`${data} 行`);
  }
  if (bits.length) bar.append(el('span', { class: 'chat__meta', text: bits.join(' · ') }));

  return bar;
}

// ── transcript ──────────────────────────────────────────────────────

function stream(state, handlers) {
  const box = el('div', { class: 'chat__stream' });

  if (!state.settings?.hasKey) {
    box.append(notice('还没有配置模型。点右上角设置，填一个 API key 就能开始。'));
    return box;
  }

  if (!state.messages.length) {
    box.append(emptyChat(state, handlers));
  } else {
    for (const m of state.messages) box.append(bubble(m));
  }

  const card = pendingCard(state, handlers);
  if (card) box.append(card);

  if (state.busy.turn) box.append(thinking());

  return box;
}

function emptyChat(state, handlers) {
  const box = el('div', { class: 'chat__empty' });
  box.append(el('p', { class: 'chat__emptytitle', text: state.activeId ? '这个会话还是空的' : '开始一个新会话' }));

  const ideas = [
    '做一个销售台账，三个客户，金额和签约日期',
    '把上面这张表改成按金额从高到低排',
    '加一列备注，写上每行的跟进状态',
  ];
  const list = el('div', { class: 'chat__ideas' });
  for (const text of ideas) {
    // A suggestion fills the box; it does not send. Sending on click would put
    // a message the user never wrote into the transcript, and the third one
    // refers to "上面这张表" — it is not a first message at all. What the user
    // needs is the text in front of them, editable, and the caret already there.
    list.append(el('button', {
      class: 'chat__idea',
      type: 'button',
      text,
      onclick: () => handlers.onIdea(text),
    }));
  }
  box.append(list);
  return box;
}

/** One message bubble. */
function bubble(message) {
  const mine = message.role === 'user';
  const row = el('div', { class: `chat__row chat__row--${mine ? 'me' : 'bot'}` });

  row.append(el('div', {
    class: `chat__avatar chat__avatar--${mine ? 'me' : 'bot'}`,
    html: icon(mine ? 'text' : 'sparkle'),
  }));

  const body = el('div', { class: 'chat__body' });

  // Preserve the reply's own line breaks — the model uses them for its reasons.
  const text = el('div', { class: 'chat__text' });
  for (const line of String(message.content || '').split('\n')) {
    text.append(el('div', { text: line }));
  }
  body.append(text);

  // Which files went with this message. Names only: the content was context
  // for that turn, not something the user said.
  if (message.attachments && message.attachments.length) {
    const files = el('div', { class: 'chat__files' });
    for (const name of message.attachments) {
      // Not `.chip`: that class means "attached to the NEXT message, removable",
      // and the composer's code and probes count it as such.
      files.append(el('span', { class: 'chat__file', title: name }, [
        el('span', { class: 'chat__file-icon', html: icon('paperclip') }),
        el('span', { class: 'chat__file-name', text: name }),
      ]));
    }
    body.append(files);
  }

  // A refused change is the most important thing on the screen when it
  // happens, so it gets its own line rather than being folded into the prose.
  if (message.guarded) {
    body.append(el('div', { class: 'chat__guard', text: '这次改动被拦下了 —— 表里的行会变少，而你没有要求删行。' }));
  }
  for (const n of message.notes || []) {
    body.append(el('div', { class: 'chat__note', text: typeof n === 'string' ? n : n.text || '' }));
  }

  if (message.at) body.append(el('div', { class: 'chat__time', text: hhmm(message.at) }));

  row.append(body);
  return row;
}

/**
 * The pending-change card.
 *
 * Rendered inside the stream, at the end, because it belongs to the sentence
 * that produced it. It is the one decision on screen, so it is the one thing
 * with buttons.
 */
function pendingCard(state, handlers) {
  const p = state.pending;
  if (!p) return null;

  const row = el('div', { class: 'chat__row chat__row--bot' });
  row.append(el('div', { class: 'chat__avatar chat__avatar--bot', html: icon('alert') }));

  const card = el('div', { class: 'chat__card' });
  card.append(el('div', { class: 'chat__cardtitle', text: '这处修改还没有写进表格' }));

  if (p.rows !== undefined && p.rows !== null) {
    card.append(el('div', { class: 'chat__cardmeta', text: `改完后是 ${p.rows} 行。右边预览已经显示改后的样子。` }));
  }

  const actions = el('div', { class: 'chat__cardactions' });

  const ok = el('button', { class: 'btn btn--primary btn--sm', type: 'button' });
  ok.innerHTML = state.busy.apply
    ? '<span class="spinner"></span><span>应用中…</span>'
    : `${icon('check')}<span>写进表格</span>`;
  ok.disabled = state.busy.apply;
  ok.addEventListener('click', handlers.onApply);
  actions.append(ok);

  const no = el('button', { class: 'btn btn--sm', type: 'button', text: '不要了' });
  no.disabled = state.busy.apply;
  no.addEventListener('click', handlers.onDismiss);
  actions.append(no);

  card.append(actions);
  row.append(card);
  return row;
}

function thinking() {
  const row = el('div', { class: 'chat__row chat__row--bot' });
  row.append(el('div', { class: 'chat__avatar chat__avatar--bot', html: icon('sparkle') }));
  const body = el('div', { class: 'chat__thinking' });
  body.append(el('span', { class: 'spinner' }));
  body.append(el('span', { text: '正在想…' }));
  row.append(body);
  return row;
}

function notice(text) {
  return el('div', { class: 'chat__empty' }, [el('p', { class: 'chat__emptytitle', text })]);
}

// ── composer ────────────────────────────────────────────────────────

function composerBox(state, handlers) {
  const box = el('div', { class: 'composer' });

  const chips = chipsRow(state, handlers);
  if (chips) box.append(chips);

  const row = el('div', { class: 'composer__row' });

  // The paperclip opens the same file input a drag-drop lands in — one code
  // path for both, so a file that works one way works the other.
  const clip = el('button', { class: 'iconbtn composer__clip', type: 'button', title: '添加文件（也可以直接拖进来）', html: icon('paperclip') });
  clip.disabled = Boolean(state.attaching) || !state.activeId;
  clip.addEventListener('click', handlers.onPickFiles);
  row.append(clip);

  const ta = prepareComposer(state.activeId, {
    placeholder: PLACEHOLDER,
    onInput: handlers.onDraft,
    onSend: handlers.onSend,
  });
  // Hand the live node back so the controller can read it without re-querying
  // the DOM, and so a repaint does not lose track of it.
  handlers.onDraftNode(ta);

  const live = composer();
  // Only push state into the node when the user is not mid-composition and the
  // node is not the thing being typed into — otherwise the caret jumps.
  if (live && document.activeElement !== ta && ta.value !== (state.draft || '')) {
    ta.value = state.draft || '';
  }

  row.append(ta);

  const send = el('button', { class: 'btn btn--primary composer__send', type: 'button' });
  send.innerHTML = state.busy.turn
    ? '<span class="spinner"></span>'
    : icon('play');
  send.title = '发送（Enter）';
  send.disabled = state.busy.turn || !state.settings?.hasKey || !state.activeId;
  send.addEventListener('click', handlers.onSend);
  row.append(send);

  box.append(row);

  if (!state.activeId) {
    box.append(el('div', { class: 'composer__mask', text: '先新建一个会话' }));
  }

  return box;
}

/**
 * The row of upload chips, or null when nothing is attached.
 *
 * Each chip is the file the assistant will read this turn. Its × is the only
 * way to take a file back out before sending, so it is a real button rather
 * than a decorative glyph.
 */
function chipsRow(state, handlers) {
  const list = state.attachments || [];
  if (!list.length && !state.attaching) return null;

  const wrap = el('div', { class: 'chips' });
  list.forEach((a, i) => {
    const chip = el('div', { class: `chip chip--${a.kind || 'unknown'}`, title: a.note || a.name });
    chip.append(el('span', { class: 'chip__icon', html: icon(kindGlyph(a)) }));
    chip.append(el('span', { class: 'chip__name', text: a.name }));
    if (a.kind === 'error') chip.classList.add('chip--err');
    chip.append(el('button', {
      class: 'chip__x', type: 'button', title: '移除', html: icon('x'),
      onclick: () => handlers.onRemoveAttachment(i),
    }));
    wrap.append(chip);
  });
  if (state.attaching) {
    wrap.append(el('div', { class: 'chip chip--busy' }, [
      el('span', { class: 'spinner' }),
      el('span', { class: 'chip__name', text: '正在读取…' }),
    ]));
  }
  return wrap;
}

/** A single glyph for a chip, keyed on the parsed kind. */
function kindGlyph(a) {
  switch (a.kind) {
    case 'table': return 'table';
    case 'sheet': return 'sheet';
    case 'image': return 'image';
    case 'error': return 'alert';
    case 'text': case 'docx': case 'json': return 'text';
    default: return 'paperclip';
  }
}

function hhmm(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
