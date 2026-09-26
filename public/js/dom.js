/* ════════════════════════════════════════════════════════════════════
   Small DOM + formatting helpers shared by the views.
   ════════════════════════════════════════════════════════════════════ */

import { icon } from './icons.js';

/** Escape for interpolation into an HTML string. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Create an element with attributes and children. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Replace a container's contents, preserving focus across a whole render pass.
 *
 * Repainting tears down the nodes it replaces, and tearing down the focused
 * element blurs it. That is fine for everything derived from state, but it is
 * fatal for a textarea someone is typing into: the browser moves focus to
 * <body> and the next keystrokes land nowhere.
 *
 * The save/restore cannot live here, per call, because the first container
 * mounted in a pass usually does not contain the focused element — repainting
 * `#tabs` blurs the prompt box on its way past. By the time the editor body is
 * reached, focus is already gone. So the pass brackets itself with
 * `beginRender` / `endRender` and this function just does the swap.
 */
export function mount(container, node) {
  container.replaceChildren(...[].concat(node).filter(Boolean));
}

/**
 * Focus carried across one render pass.
 *
 * Held as a stack because a render can be triggered from inside a render
 * (setting state in a subscriber); the inner pass restores first, and the outer
 * one sees a still-connected node and restores again.
 */
const focusPasses = [];

/**
 * Start a render pass: remember what is focused and where the caret is.
 *
 * Returns a token to hand to `endRender`.
 */
export function beginRender() {
  const active = document.activeElement;
  const token = {
    active: active && active !== document.body ? active : null,
    selection: null,
  };
  if (token.active && typeof token.active.selectionStart === 'number') {
    token.selection = { start: token.active.selectionStart, end: token.active.selectionEnd };
  }
  focusPasses.push(token);
  return token;
}

/**
 * Finish a render pass: put focus and the caret back if the element survived.
 *
 * A re-created element is a different object — its `isConnected` is true but it
 * is not the one we saved — so the check is identity, not connectivity. That
 * distinction is the whole point: reusing the node is what makes restoring
 * focus meaningful, and if a future change goes back to rebuilding the textarea
 * this quietly stops hiding it.
 */
export function endRender(token) {
  const idx = focusPasses.lastIndexOf(token);
  if (idx !== -1) focusPasses.splice(idx, 1);

  const { active, selection } = token;
  if (!active || !active.isConnected) return;
  // Something else claimed focus during the pass; leave it alone.
  if (document.activeElement !== document.body && document.activeElement !== active) return;

  try { active.focus({ preventScroll: true }); } catch { try { active.focus(); } catch { return; } }
  if (selection && typeof active.setSelectionRange === 'function') {
    try { active.setSelectionRange(selection.start, selection.end); } catch { /* not a text control */ }
  }
}

/** `<span data-icon=...>` placeholder to be hydrated later. */
export function iconSlot(name) {
  return `<span class="row__icon" data-icon="${name}"></span>`;
}

export function iconBox(name, cls = 'row__icon') {
  return `<span class="${cls}">${icon(name)}</span>`;
}

// ── numbers ─────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 });
const cf = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
const df = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

/** Thousands-separated integer/decimal. */
export function num(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v ?? '');
  return Number.isInteger(v) ? nf.format(v) : df.format(v);
}

export function money(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v ?? '');
  return cf.format(v);
}

/** Human-readable value for a table cell. */
export function display(v, type) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'number') return type === 'currency' ? money(v) : num(v);
  return String(v);
}

/** Byte size for the runs list. */
export function bytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Clock time for the runs list. */
export function clock(iso) {
  const d = iso ? new Date(iso) : new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ── domain vocabulary ───────────────────────────────────────────────

const TYPE_LABEL = {
  text: '文本', number: '数字', integer: '整数', currency: '金额',
  percent: '百分比', date: '日期', boolean: '是否', formula: '公式', unknown: '未知',
};
export const typeLabel = (t) => TYPE_LABEL[t] || t || '—';

const STATUS_META = {
  ok: { label: '已填充', cls: 'ok', dot: 'dot--ok' },
  conflict: { label: '冲突', cls: 'err', dot: 'dot--err' },
  missing: { label: '缺失', cls: 'warn', dot: 'dot--warn' },
  optional: { label: '选填未填', cls: 'mute', dot: 'dot--mute' },
  skipped: { label: '公式跳过', cls: 'info', dot: 'dot--info' },
  'unmatched-enum': { label: '选项不匹配', cls: 'err', dot: 'dot--err' },
};
export const statusMeta = (s) => STATUS_META[s] || { label: s || '—', cls: 'mute', dot: 'dot--mute' };

const KIND_LABEL = {
  table: '表格', text: '文本', image: '图片', csv: '表格', tsv: '表格',
  xlsx: '工作簿', xlsm: '工作簿', docx: '文档', json: '数据', unknown: '未知', error: '失败',
};
export const kindLabel = (k) => KIND_LABEL[k] || k || '文件';

const KIND_ICON = {
  table: 'table', text: 'text', image: 'image', docx: 'file',
  json: 'text', unknown: 'alert', error: 'alert',
};
export const kindIcon = (a) => KIND_ICON[a.kind] || (a.meta && KIND_ICON[a.meta.kind]) || 'paperclip';

/** Label for a field, annotating its source kind. */
export function fieldSub(f) {
  const bits = [typeLabel(f.type)];
  if (f.kind === 'table' && f.colName) bits.push(`列 ${f.colName}`);
  if (f.source === 'placeholder') bits.push('占位符');
  if (f.isFormula) bits.push('公式');
  return bits.join(' · ');
}

/** Prompt template for a placeholder, so the user knows the shape. */
export function placeholderFor(schema) {
  const fields = (schema && schema.fields) || [];
  if (!fields.length) return '用中文描述要填的内容，例如：客户名称：甲公司，合同金额：12万，签约日期：2026年3月1日';
  const parts = fields.slice(0, 3).map((f) => {
    const sample = (f.sampleValues && f.sampleValues[0]) ?? sampleFor(f.type);
    return `${f.name}：${sample}`;
  });
  return `例如：${parts.join('，')}${fields.length > 3 ? '，…' : ''}`;
}

function sampleFor(type) {
  switch (type) {
    case 'currency': case 'number': case 'integer': return '12000';
    case 'percent': return '13%';
    case 'date': return '2026年3月1日';
    case 'boolean': return '是';
    default: return '示例';
  }
}

/** Debounce a function; used for the live plan preview. */
export function debounce(fn, ms = 320) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}
