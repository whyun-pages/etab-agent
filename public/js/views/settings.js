/* ════════════════════════════════════════════════════════════════════
   Settings view — the user's own model credentials.

   Two things this screen owes the user, stated on the screen rather than in
   a manual:

     1. Where the key is stored, and that it is not encrypted.
     2. That using the model sends their content to a third party.

   (2) is the one people are surprised by. It goes at the top of the form, not
   in a footnote, because the decision it informs is whether to turn the thing
   on at all.
   ════════════════════════════════════════════════════════════════════ */

import { esc, el } from '../dom.js';

/** A labelled text input, with the styling the rest of the app uses. */
function field({ label, hint, value, type = 'text', placeholder, onInput, autocomplete = 'off' }) {
  const wrap = el('label', { class: 'settings__field' });
  wrap.appendChild(el('span', { class: 'settings__label', text: label }));
  if (hint) wrap.appendChild(el('span', { class: 'settings__hint', text: hint }));

  const input = el('input', {
    class: 'settings__input',
    type,
    value: value || '',
    placeholder: placeholder || '',
    autocomplete,
    spellcheck: 'false',
  });
  input.addEventListener('input', () => onInput(input.value));
  wrap.appendChild(input);
  return wrap;
}

function toggle({ label, hint, checked, onChange }) {
  const wrap = el('label', { class: 'settings__toggle' });
  const box = el('input', { type: 'checkbox' });
  box.checked = Boolean(checked);
  box.addEventListener('change', () => onChange(box.checked));

  const text = el('span', { class: 'settings__toggletext' });
  text.appendChild(el('span', { class: 'settings__label', text: label }));
  if (hint) text.appendChild(el('span', { class: 'settings__hint', text: hint }));

  wrap.appendChild(box);
  wrap.appendChild(text);
  return wrap;
}

/**
 * @param {object} ctx
 * @param {object} ctx.state
 * @param {object} ctx.handlers { save, test, open }
 * @returns {HTMLElement}
 */
export function settingsView({ state, handlers }) {
  const root = el('section', { class: 'settings' });

  const head = el('header', { class: 'settings__head' });
  head.appendChild(el('h2', { class: 'settings__title', text: '模型设置' }));
  head.appendChild(el('p', {
    class: 'settings__lede',
    text: '用你自己的 API key 让模型读懂你说的话，并把它变成表格。不填就什么都做不了 —— 这个应用没有内置规则可以退回。',
  }));
  root.appendChild(head);

  const s = state.settings || {};
  const draft = state.settingsDraft || {};

  // ── where the key goes, and what leaves the machine ────────────────
  const notice = el('div', { class: 'settings__notice' });
  notice.appendChild(el('div', { class: 'settings__noticetitle', text: '开始前请知悉' }));
  const ul = el('ul', { class: 'settings__noticelist' });
  for (const line of [
    'key 会以明文保存在本机 data 目录的 settings.json（仅当前用户可读，未加密）。',
    '启用后，你输入的内容和表格数据会发送给你填写的接口地址，不再只留在本机。',
  ]) {
    ul.appendChild(el('li', { text: line }));
  }
  notice.appendChild(ul);
  root.appendChild(notice);

  // ── the form ───────────────────────────────────────────────────────
  const form = el('div', { class: 'settings__form' });

  form.appendChild(field({
    label: '接口地址 (baseUrl)',
    hint: 'OpenAI 兼容的 /v1 地址。可换成任何兼容服务。',
    value: draft.baseUrl ?? s.baseUrl ?? '',
    placeholder: 'https://api.openai.com/v1',
    onInput: (v) => { draft.baseUrl = v; },
  }));

  form.appendChild(field({
    label: 'API key',
    hint: s.hasKey
      ? `已保存 ${esc(s.keyHint || '')}。留空表示不改动；要清除请点「清除 key」。`
      : '只保存在本机。不会回显到页面上。',
    value: draft.apiKey ?? '',
    type: 'password',
    placeholder: s.hasKey ? '（已保存，留空则不修改）' : 'sk-...',
    onInput: (v) => { draft.apiKey = v; },
  }));

  form.appendChild(field({
    label: '模型名 (model)',
    hint: '必须填服务商支持的模型名。',
    value: draft.model ?? s.model ?? '',
    placeholder: 'gpt-4o-mini',
    onInput: (v) => { draft.model = v; },
  }));

  // ── chat behaviour ─────────────────────────────────────────────────
  form.appendChild(el('div', { class: 'settings__group', text: '对话' }));

  form.appendChild(toggle({
    label: '允许对话修改字段',
    hint: '关闭后对话只能回答问题，不会提出任何修改。',
    checked: draft.chatCanEdit ?? s.chatCanEdit ?? true,
    onChange: (v) => { draft.chatCanEdit = v; },
  }));

  form.appendChild(toggle({
    label: '修改前需要确认',
    hint: '推荐开启。关闭后对话提出的修改会直接落到预览，不再问你。',
    checked: draft.chatConfirmEdits ?? s.chatConfirmEdits ?? true,
    onChange: (v) => { draft.chatConfirmEdits = v; },
  }));

  root.appendChild(form);

  // ── actions ────────────────────────────────────────────────────────
  const actions = el('div', { class: 'settings__actions' });
  const busy = state.busy.settings;

  const saveBtn = el('button', {
    class: 'btn btn--primary',
    type: 'button',
    text: busy ? '保存中…' : '保存',
  });
  saveBtn.disabled = busy;
  saveBtn.addEventListener('click', () => handlers.onSaveSettings({ ...draft }));

  const testBtn = el('button', { class: 'btn', type: 'button', text: '测试连接' });
  testBtn.disabled = busy || !(s.hasKey || draft.apiKey);
  testBtn.addEventListener('click', () => handlers.onTestSettings());

  const clearBtn = el('button', { class: 'btn btn--danger', type: 'button', text: '清除 key' });
  clearBtn.disabled = busy || !s.hasKey;
  clearBtn.addEventListener('click', () => handlers.onClearSettingsKey());

  actions.appendChild(saveBtn);
  actions.appendChild(testBtn);
  actions.appendChild(clearBtn);
  root.appendChild(actions);

  // ── last test result ───────────────────────────────────────────────
  if (state.settingsTest) {
    const t = state.settingsTest;
    const box = el('div', {
      class: `settings__result settings__result--${t.ok ? 'ok' : 'bad'}`,
    });
    box.appendChild(el('div', {
      class: 'settings__resulttitle',
      text: t.ok ? '连接正常' : '连接失败',
    }));
    if (t.ok) {
      box.appendChild(el('pre', { class: 'settings__resultbody', text: `模型回复：${t.reply}` }));
    } else {
      box.appendChild(el('pre', { class: 'settings__resultbody', text: t.error }));
    }
    root.appendChild(box);
  }

  return root;
}
