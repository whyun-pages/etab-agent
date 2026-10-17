/* ════════════════════════════════════════════════════════════════════
   Settings page — the user's own model credentials, and what chat may do.

   A page of its own rather than a panel in the centre column: squeezed in
   between the session list and the preview it had no way back, and the save
   feedback landed out of sight. Left is a menu (back, then one tab per topic);
   right is the tab's form under a bar that holds the save button and says,
   right next to it, whether the save took.

   Two things this screen owes the user, stated on the screen rather than in
   a manual:

     1. Where the key is stored, and that it is not encrypted.
     2. That using the model sends their content to a third party.

   (2) is the one people are surprised by. It goes at the top of the model
   tab, not in a footnote, because the decision it informs is whether to turn
   the thing on at all.
   ════════════════════════════════════════════════════════════════════ */

import { esc, el } from '../dom.js';
import { icon } from '../icons.js';

/**
 * The wire protocols the server accepts, in display order, with each one's
 * official endpoint and an example model name.
 *
 * Mirrors MODEL_APIS and BASE_URLS in src/agent/model.ts. Browser code cannot import
 * that module, and the list is three entries that change only when a protocol
 * is added — at which point the server refuses an unknown value with a 400, so
 * a drift between the two shows up the first time someone saves.
 */
const PROTOCOLS = [
  { api: 'openai-completions', label: 'OpenAI 兼容（/chat/completions）', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hint: 'OpenAI 兼容的 /v1 地址。国内大多数服务商和自建网关都用这种。' },
  { api: 'anthropic-messages', label: 'Anthropic Messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', hint: 'Anthropic 原生接口地址，不带 /v1。兼容 Anthropic 协议的服务也可以填在这里。' },
  { api: 'google-generative-ai', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', hint: 'Gemini 原生接口地址，带版本号（/v1beta）。' },
];

const protocolOf = (api) => PROTOCOLS.find((p) => p.api === api) || PROTOCOLS[0];

/** The tabs, in menu order. `id` is what `state.settingsTab` holds. */
const TABS = [
  { id: 'model', label: '模型', icon: 'cpu', title: '模型设置', lede: '用你自己的 API key 让模型读懂你说的话，并把它变成表格。不填就什么都做不了 —— 这个应用没有内置规则可以退回。' },
  { id: 'chat', label: '会话', icon: 'message', title: '会话设置', lede: '对话能做什么：改表格、保存文件、上网抓数据。每一项都可以单独关掉。' },
];

const tabOf = (id) => TABS.find((t) => t.id === id) || TABS[0];

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
 * @param {object} ctx.handlers
 *   { onSaveSettings, onTestSettings, onClearSettingsKey, onSettingsTab, onCloseSettings }
 * @returns {HTMLElement}
 */
export function settingsView({ state, handlers }) {
  const tab = tabOf(state.settingsTab);
  const root = el('section', { class: 'settings' });

  // ── menu ───────────────────────────────────────────────────────────
  const nav = el('nav', { class: 'settings__nav', 'aria-label': '设置分类' });
  nav.appendChild(el('button', {
    class: 'settings__back', type: 'button', title: '返回会话（Esc）',
    html: `<span class="row__icon">${icon('back')}</span><span>返回会话</span>`,
    onclick: handlers.onCloseSettings,
  }));
  nav.appendChild(el('div', { class: 'settings__navtitle', text: '设置' }));
  for (const t of TABS) {
    nav.appendChild(el('button', {
      class: `settings__tab${t.id === tab.id ? ' is-active' : ''}`,
      type: 'button',
      'aria-current': t.id === tab.id ? 'page' : null,
      html: `<span class="row__icon">${icon(t.icon)}</span><span>${esc(t.label)}</span>`,
      onclick: () => handlers.onSettingsTab(t.id),
    }));
  }
  root.appendChild(nav);

  // ── the tab ────────────────────────────────────────────────────────
  const main = el('div', { class: 'settings__main' });
  main.appendChild(actionBar({ state, handlers, tab }));
  const content = el('div', { class: 'settings__content' });
  if (tab.id === 'model') modelTab(content, state);
  else chatTab(content, state);
  main.appendChild(content);
  root.appendChild(main);

  return root;
}

/**
 * The bar at the top of the tab: title, save, and the save's outcome.
 *
 * Sticky, so the button and its answer are on screen however far the form is
 * scrolled. The outcome is a line next to the button rather than only a toast:
 * a toast is gone in seconds and appears somewhere else; this stays where the
 * user is already looking until the next save.
 */
function actionBar({ state, handlers, tab }) {
  const s = state.settings || {};
  const draft = state.settingsDraft || {};
  const busy = state.busy.settings;

  const bar = el('header', { class: 'settings__bar' });
  const text = el('div', { class: 'settings__head' });
  text.appendChild(el('h2', { class: 'settings__title', text: tab.title }));
  text.appendChild(el('p', { class: 'settings__lede', text: tab.lede }));
  bar.appendChild(text);

  const actions = el('div', { class: 'settings__actions' });
  // Save writes the whole draft, both tabs: an edit made on 模型 is not lost
  // by switching to 会话 and saving there.
  actions.appendChild(el('button', {
    class: 'btn btn--primary', type: 'button',
    text: busy ? '保存中…' : '保存',
    disabled: busy,
    onclick: () => handlers.onSaveSettings({ ...draft }),
  }));
  if (tab.id === 'model') {
    actions.appendChild(el('button', {
      class: 'btn', type: 'button', text: '测试连接',
      title: '用已保存的设置发一条测试消息',
      disabled: busy || !(s.hasKey || draft.apiKey),
      onclick: () => handlers.onTestSettings(),
    }));
    actions.appendChild(el('button', {
      class: 'btn btn--danger', type: 'button', text: '清除 key',
      disabled: busy || !s.hasKey,
      onclick: () => handlers.onClearSettingsKey(),
    }));
  }
  bar.appendChild(actions);

  const notice = state.settingsNotice;
  if (notice) {
    bar.appendChild(el('div', {
      class: `settings__saved settings__saved--${notice.tone}`,
      role: notice.tone === 'err' ? 'alert' : 'status',
      html: `<span class="row__icon">${icon(notice.tone === 'ok' ? 'check' : 'alert')}</span><span>${esc(notice.text)}</span>`,
    }));
  }
  return bar;
}

/** 模型: protocol, endpoint, key, model — and the connection test's answer. */
function modelTab(root, state) {
  const s = state.settings || {};
  const draft = state.settingsDraft || {};

  // The test answers "does what I saved work", so it goes first, right under
  // the button that produced it.
  if (state.settingsTest) {
    const t = state.settingsTest;
    const box = el('div', {
      class: `settings__result settings__result--${t.ok ? 'ok' : 'bad'}`,
    });
    box.appendChild(el('div', {
      class: 'settings__resulttitle',
      text: t.ok ? '连接正常' : '连接失败',
    }));
    box.appendChild(el('pre', { class: 'settings__resultbody', text: t.ok ? `模型回复：${t.reply}` : t.error }));
    root.appendChild(box);
  }

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

  const protocol = protocolOf(draft.api ?? s.api);

  const protoWrap = el('label', { class: 'settings__field' });
  protoWrap.appendChild(el('span', { class: 'settings__label', text: '接口协议' }));
  protoWrap.appendChild(el('span', { class: 'settings__hint', text: '按服务商提供的接口类型选择。' }));
  const select = el('select', { class: 'settings__input' });
  for (const p of PROTOCOLS) {
    const opt = el('option', { value: p.api, text: p.label });
    opt.selected = p.api === protocol.api;
    select.appendChild(opt);
  }
  protoWrap.appendChild(select);
  form.appendChild(protoWrap);

  const baseField = field({
    label: '接口地址 (baseUrl)',
    hint: protocol.hint,
    value: draft.baseUrl ?? s.baseUrl ?? '',
    placeholder: protocol.baseUrl,
    onInput: (v) => { draft.baseUrl = v; },
  });
  form.appendChild(baseField);

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

  const modelField = field({
    label: '模型名 (model)',
    hint: '必须填服务商支持的模型名。',
    value: draft.model ?? s.model ?? '',
    placeholder: protocol.model,
    onInput: (v) => { draft.model = v; },
  });
  form.appendChild(modelField);

  // Switching protocol carries the endpoint and the model name along only when
  // each is still the previous protocol's default (or empty): that value was
  // never the user's choice, and leaving OpenAI's URL or `gpt-4o-mini` under
  // "Gemini" would guarantee a failed first request. What the user typed is
  // theirs and stays.
  select.addEventListener('change', () => {
    const before = protocolOf(draft.api ?? s.api);
    const next = protocolOf(select.value);
    draft.api = next.api;
    const baseInput = baseField.querySelector('input');
    const current = baseInput.value.trim().replace(/\/+$/, '');
    if (!current || current === before.baseUrl) {
      baseInput.value = next.baseUrl;
      draft.baseUrl = next.baseUrl;
    }
    baseInput.placeholder = next.baseUrl;
    baseField.querySelector('.settings__hint').textContent = next.hint;
    const modelInput = modelField.querySelector('input');
    const currentModel = modelInput.value.trim();
    if (!currentModel || currentModel === before.model) {
      modelInput.value = next.model;
      draft.model = next.model;
    }
    modelInput.placeholder = next.model;
  });

  root.appendChild(form);
}

/** 会话: what a chat turn may do — edit, save, fetch. */
function chatTab(root, state) {
  const s = state.settings || {};
  const draft = state.settingsDraft || {};
  const form = el('div', { class: 'settings__form' });

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

  // ── saving and fetching ────────────────────────────────────────────
  form.appendChild(el('div', { class: 'settings__group', text: '保存与联网' }));

  form.appendChild(toggle({
    label: '允许对话保存文件',
    hint: '可以让对话把表格存成 xlsx / CSV / JSON 到下面的目录。同名文件不会被覆盖，会自动加编号。',
    checked: draft.chatCanSave ?? s.chatCanSave ?? true,
    onChange: (v) => { draft.chatCanSave = v; },
  }));

  form.appendChild(field({
    label: '导出目录',
    hint: '填完整路径。留空则保存到下载文件夹。',
    value: draft.exportDir ?? s.exportDir ?? '',
    placeholder: s.exportDirResolved || '',
    onInput: (v) => { draft.exportDir = v; },
  }));

  // The blocklist only means something while fetching is on, so it is shown
  // only then — toggled in place, without re-rendering the form and losing
  // whatever is typed in the other fields.
  const blockWrap = el('label', { class: 'settings__field' });
  blockWrap.appendChild(el('span', { class: 'settings__label', text: '禁止抓取的网站' }));
  blockWrap.appendChild(el('span', {
    class: 'settings__hint',
    text: '每行一个域名，同时禁止它的子域名。例如填 example.com，www.example.com 也会被拒绝。',
  }));
  const blockInput = el('textarea', {
    class: 'settings__input',
    rows: '4',
    spellcheck: 'false',
    placeholder: 'example.com',
  });
  blockInput.value = draft.fetchBlocklist ?? (s.fetchBlocklist || []).join('\n');
  blockInput.addEventListener('input', () => { draft.fetchBlocklist = blockInput.value; });
  blockWrap.appendChild(blockInput);

  const canFetch = draft.chatCanFetch ?? s.chatCanFetch ?? false;
  blockWrap.hidden = !canFetch;
  form.appendChild(toggle({
    label: '允许对话联网抓取',
    // The risk is stated here because this is where the decision is made:
    // with no list of allowed sites, nothing stops a fetched page from
    // talking the model into sending table data to another address.
    hint: '可以让对话下载网页、CSV、JSON、xlsx 来建表或补数据。请求从本机发出；内网地址一律不抓。注意：抓到的网页内容可能诱导模型把表格数据发到别的网址，表里有敏感数据时不要开启。',
    checked: canFetch,
    onChange: (v) => { draft.chatCanFetch = v; blockWrap.hidden = !v; },
  }));
  form.appendChild(blockWrap);

  // ── local files ────────────────────────────────────────────────────
  // A select, not a toggle: reading and writing are different risks, and
  // "read only" is the setting most people want. Read-write also hands the
  // model a shell (src/agent/pi-tools/shell.ts), which the blocklist cannot narrow;
  // the option says so in its own words, not only in the hint.
  const fileWrap = el('label', { class: 'settings__field' });
  fileWrap.appendChild(el('span', { class: 'settings__label', text: '允许读写本机文件' }));
  fileWrap.appendChild(el('span', {
    class: 'settings__hint',
    text: '开启后，在对话里给出本地路径（文件、文件夹或 zip）就能直接读取和统计。只对在本机打开的页面生效。'
      + '注意：文件内容可能诱导模型去读别的文件，含敏感数据的位置请加到下面的禁止列表。'
      + '「读写」还允许模型在本机执行命令，命令不受禁止列表限制，能做到你这个账户能做的任何事。',
  }));
  const fileSelect = el('select', { class: 'settings__input' });
  const fileMode = draft.chatFileAccess ?? s.chatFileAccess ?? 'off';
  for (const [value, text] of [['off', '关闭'], ['read', '只读'], ['readwrite', '读写，并允许执行命令']]) {
    const opt = el('option', { value, text });
    opt.selected = value === fileMode;
    fileSelect.appendChild(opt);
  }
  fileWrap.appendChild(fileSelect);
  form.appendChild(fileWrap);

  const fileBlockWrap = el('label', { class: 'settings__field' });
  fileBlockWrap.appendChild(el('span', { class: 'settings__label', text: '禁止访问的路径' }));
  fileBlockWrap.appendChild(el('span', {
    class: 'settings__hint',
    // The built-in list is named so nobody adds ~/.ssh "to be safe" and then
    // wonders whether removing it here would unblock it.
    text: '每行一个：文件夹路径（如 D:\\财务、~/私人）会连同里面的内容一起禁止；不带路径的名字（如 *.bak、合同）按文件名或文件夹名匹配。'
      + '密钥、浏览器数据、系统目录和本程序的数据目录始终禁止，不用填。',
  }));
  const fileBlockInput = el('textarea', { class: 'settings__input', rows: '4', spellcheck: 'false', placeholder: 'D:\\财务\n*.bak' });
  fileBlockInput.value = draft.fileBlocklist ?? (s.fileBlocklist || []).join('\n');
  fileBlockInput.addEventListener('input', () => { draft.fileBlocklist = fileBlockInput.value; });
  fileBlockWrap.appendChild(fileBlockInput);
  fileBlockWrap.hidden = fileMode === 'off';
  form.appendChild(fileBlockWrap);
  fileSelect.addEventListener('change', () => {
    draft.chatFileAccess = fileSelect.value;
    fileBlockWrap.hidden = fileSelect.value === 'off';
  });

  root.appendChild(form);
}
