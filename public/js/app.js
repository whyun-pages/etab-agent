/* ════════════════════════════════════════════════════════════════════
   App controller — wires the shell, the views and the API together.

   Rendering is deliberately simple: one subscription re-paints the rail, the
   conversation and the preview from state. Anything that survives a repaint
   (the half-typed message) lives in state or in a cached node, not in the DOM.

   The shape of the app is one sentence long: a conversation, and the workbook
   it produced, side by side. There is no template to pick and no plan to
   approve — the spec IS the document, and it changes only when the user says
   it should.

   This file is the boot, the conversation, the render pass and the handlers
   the views call. The rest is one module per area, none importing this one:
   controllers/sessions.js, attachments.js, preview.js and settings.js, with
   feedback.js for the failure toast they all use.
   ════════════════════════════════════════════════════════════════════ */

import { api, saveBlob } from './api.js';
import { hydrateIcons, icon } from './icons.js';
import { $, el, mount, beginRender, endRender } from './dom.js';
import { state, set, setBusy, subscribe, ready } from './state.js';
import { toast, initModal, initDragDrop } from './ui.js';
import { fillComposer } from './composer.js';
import { initSplitters } from './splitters.js';
import { chatView } from './views/chat.js';
import { captureChatScroll, restoreChatScroll, stickChat } from './chat-scroll.js';
import { previewView } from './views/preview.js';
import { sessionsView } from './views/sessions.js';
import { settingsView } from './views/settings.js';
import { errText, fail } from './feedback.js';
import { refreshSessions, openSession, createSession, confirmRemoveSession } from './controllers/sessions.js';
import {
  bindFileInput,
  pasteFiles,
  pickFiles,
  pickFolder,
  handleFiles,
  clearAttachments,
  openAttachment,
} from './controllers/attachments.js';
import { loadMorePreview, setColumnWidth } from './controllers/preview.js';
import {
  toggleSettings,
  openSettings,
  closeSettings,
  refreshSettings,
  saveSettings,
  clearSettingsKey,
  testSettings,
} from './controllers/settings.js';

// ── boot ────────────────────────────────────────────────────────────

async function boot() {
  hydrateIcons();
  initModal();
  initDragDrop(handleFiles);
  bindShell();
  bindKeyboard();
  bindFileInput();

  // Before the first paint, so a folded rail does not flash open on load.
  state.railCollapsed = readRailCollapsed();

  subscribe(render);
  render();

  // No attachments here: they belong to a session, and openSession reads them.
  await Promise.all([refreshSettings(), refreshSessions()]);
  checkHealth();

  if (!ready()) {
    set({
      status: '还没有配置模型 —— 点右上角设置填一个 API key',
      view: 'settings',
    });
    return;
  }

  // Open the most recent conversation, so the app starts with the user's own
  // work rather than an empty screen they have to navigate away from.
  const first = state.sessions[0];
  if (first) await openSession(first.id);
}

// ── shell wiring ────────────────────────────────────────────────────

function bindShell() {
  $('#btn-new-session').addEventListener('click', createSession);
  $('#btn-settings').addEventListener('click', toggleSettings);
  initSplitters();
}

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = $('#modal');
      if (modal && !modal.hidden) {
        modal.hidden = true;
        return;
      }
      if (state.view === 'settings') closeSettings();
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() === 'n') {
      e.preventDefault();
      createSession();
    }
    // Ctrl+B, the sidebar toggle in VS Code and most editors.
    if (e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleRail();
    }
  });
}

// ── conversation ────────────────────────────────────────────────────

/**
 * Put a suggestion into the composer and focus it, without sending.
 *
 * With no session open the composer is covered by an opaque mask, so filling it
 * would put text somewhere the user cannot see. A session is created first,
 * which is the same thing typing into a fresh window would do on send — and it
 * is what makes the chip's label honest: it starts a new conversation.
 *
 * The draft is set before filling so a later repaint still has the text; the
 * live node is filled by the composer module, which owns the caret and growth.
 */
async function useIdea(text) {
  if (!state.activeId) {
    await createSession();
    if (!state.activeId) return;
  }
  set({ draft: text });
  fillComposer(text);
}

/**
 * Create a session from the composer's mask and put the caret in the box.
 *
 * The click landed where the user meant to type, so the focus goes there; an
 * empty fill is how the composer module focuses its own node.
 */
async function startSession() {
  if (state.activeId) return;
  await createSession();
  if (state.activeId) fillComposer('');
}

/**
 * Send one message and handle whatever comes back.
 *
 * Four outcomes, and the difference matters to the user:
 *
 *   - an answer        — nothing changed, just show it
 *   - a change applied — confirmation is off; the preview moves now
 *   - a change held    — show the card and wait; the preview already shows
 *                        what it WOULD be, which is what makes the decision
 *                        answerable
 *   - a refusal        — the guard fired; the reply says why
 */
async function send(text) {
  const message = String(text || '').trim();
  if (!message || state.busy.turn) return;
  if (!state.activeId) {
    await createSession();
    if (!state.activeId) return;
  }

  set({ draft: '' });
  const ta = state.draftNode;
  if (ta) ta.value = '';

  // Sending is a request to see the answer: follow it even if the transcript
  // was scrolled up. Before setBusy, whose repaint is the first to show it.
  stickChat();
  setBusy('turn', true);
  // Show the user's own message immediately; a turn is a model call and can
  // take seconds, and a box that empties with nothing appearing reads as a
  // dropped message.
  set({
    // The server folds attachment content into the model's message itself and
    // stores only the names; the optimistic bubble shows the same names.
    messages: [
      ...state.messages,
      {
        role: 'user',
        content: message,
        attachments: attachedNames(),
        at: new Date().toISOString(),
      },
    ],
    error: null,
    status: '正在想…',
  });

  try {
    const res = await api.turn(state.activeId, message);

    if (!res.ok) {
      // A provider failure is not a turn: drop the optimistic message and give
      // the text back, so retrying does not mean retyping.
      restoreDraft(message, `对话失败：${res.error || '未知错误'}`);
      return;
    }

    // The server returns the preview for whichever spec is now authoritative:
    // the applied one, or the existing one when nothing changed. When a change
    // is HELD, `proposed` carries the preview of the spec that is not yet real,
    // and showing it is the whole point of asking.
    const preview = res.pending && res.proposed ? res.proposed.preview : res.preview;

    set({
      messages: res.messages || state.messages,
      // Marked so the pager asks for the held change's rows, not the stored ones.
      preview: preview ? { ...preview, proposed: preview === res.proposed?.preview } : state.preview,
      previewError: null,
      pending: res.pending ? { rows: res.proposed?.rows, reply: res.reply } : null,
      status: res.pending ? '改好了，等你确认' : res.applied ? '已改' : '已回复',
    });

    // A rename lands on the first change, so the list needs refreshing.
    if (res.applied) refreshSessions();
  } catch (err) {
    restoreDraft(message, errText(err));
  } finally {
    setBusy('turn', false);
    focusComposer();
  }
}

/** Names of the attached files that parsed, as the server will record them. */
function attachedNames() {
  const names = (state.attachments || []).filter((a) => a.kind !== 'error').map((a) => a.name);
  return names.length ? names : undefined;
}

/** Put the user's text back after a failed turn, with the reason shown. */
function restoreDraft(text, why) {
  set({
    messages: state.messages.slice(0, -1),
    draft: text,
    error: why,
    status: why,
  });
  const ta = state.draftNode;
  if (ta) {
    ta.value = text;
    try {
      ta.focus();
    } catch {
      /* not focusable yet */
    }
  }
  toast({ tone: 'err', title: '对话失败', body: why, ms: 7000 });
}

/** Accept a held change. This is the only path from "proposed" to "written". */
async function applyPending() {
  if (!state.pending || state.busy.apply) return;
  setBusy('apply', true);
  try {
    const res = await api.applyTurn(state.activeId, true);
    if (!res.applied) {
      set({ pending: null, status: '已忽略' });
      return;
    }
    await openSession(state.activeId);
    await refreshSessions();
    // A save the turn asked for happens here, once the change has landed, and
    // the apply response is the only place its outcome is reported.
    const saved = res.saved || [];
    set({ pending: null, status: saved.length ? `已写进表格，已保存 ${saved.length} 个文件` : '已写进表格' });
    if (saved.length) toast({ tone: 'ok', title: '已写进表格并保存', body: saved.join('\n'), ms: 7000 });
    else toast('已写进表格', 'ok');
    if (res.saveError) toast({ tone: 'err', title: '保存文件失败', body: res.saveError, ms: 7000 });
  } catch (err) {
    fail('应用失败', err);
  } finally {
    setBusy('apply', false);
  }
}

/** Discard a held change. The stored spec never moved, so this is local. */
async function dismissPending() {
  if (!state.pending || state.busy.apply) return;
  setBusy('apply', true);
  try {
    const res = await api.applyTurn(state.activeId, false);
    await openSession(state.activeId);
    set({ pending: null, status: '已忽略这处修改' });
    void res;
  } catch (err) {
    fail('忽略失败', err);
  } finally {
    setBusy('apply', false);
  }
}

async function downloadWorkbook(format = 'xlsx', sheet = null) {
  if (!state.activeId) return;
  try {
    const { blob, name } = await api.workbook(state.activeId, format, sheet);
    saveBlob(blob, name);
    set({ status: `已下载 ${name}` });
  } catch (err) {
    fail('下载失败', err);
  }
}

// ── misc ────────────────────────────────────────────────────────────

async function checkHealth() {
  const node = $('#status-server');
  try {
    await api.health();
    node.className = 'status__item status__item--ok';
    node.innerHTML = '<span class="dot dot--ok"></span>服务端就绪';
  } catch {
    node.className = 'status__item status__item--err';
    node.innerHTML = '<span class="dot dot--err"></span>服务端离线';
  }
}

function focusComposer() {
  const ta = state.draftNode;
  if (!ta) return;
  try {
    ta.focus({ preventScroll: true });
  } catch {
    try {
      ta.focus();
    } catch {
      /* ignore */
    }
  }
}

// ── render ──────────────────────────────────────────────────────────

function render() {
  // One pass: repaint everything, then put focus back. The individual mounts
  // cannot do this themselves — repainting the rail blurs the composer before
  // the chat body is ever reached.
  const pass = beginRender();
  try {
    renderTitlebar();
    if (renderSettings()) {
      renderStatusbar();
      return;
    }
    renderError();
    renderRail();
    renderPane();
    renderPreview();
    renderStatusbar();
  } finally {
    endRender(pass);
  }
}

function renderTitlebar() {
  const node = $('#titlebar-title');
  node.textContent = state.view === 'settings' ? '设置' : state.title || '';
}

function renderError() {
  const banner = $('#error-banner');
  if (!state.error) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  mount(banner, [
    el('span', { class: 'pane__errortext', text: state.error }),
    el('button', {
      class: 'iconbtn',
      type: 'button',
      title: '关闭',
      html: icon('x'),
      onclick: () => set({ error: null }),
    }),
  ]);
}

function renderRail() {
  // The grid track is set by a class on the shell, not by the rail itself: the
  // column width belongs to the layout, and the splitter beside it has to go too.
  $('#shell').classList.toggle('is-rail-collapsed', state.railCollapsed);
  mount(
    $('#rail'),
    sessionsView(state, {
      onOpen: openSession,
      onRemove: confirmRemoveSession,
      onCreate: createSession,
      onToggle: toggleRail,
    }),
  );
}

// ── rail folding ────────────────────────────────────────────────────
// Per window, like the column widths in splitters.js, so localStorage rather
// than the server. Every access is guarded: storage can be unavailable, and a
// preference that cannot be read is simply the default.

const RAIL_KEY = 'tab-agent:rail-collapsed';

function readRailCollapsed() {
  try {
    return localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

function toggleRail() {
  const railCollapsed = !state.railCollapsed;
  try {
    localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0');
  } catch {
    /* not fatal */
  }
  set({ railCollapsed });
}

/**
 * The settings page replaces the three-column shell; it is not a panel in it.
 *
 * Returns true when the page is showing, so the shell is not repainted behind
 * it: those panes are hidden, and keeping their last paint means coming back
 * shows the conversation exactly as it was left, scroll position included.
 */
function renderSettings() {
  const page = $('#settings-page');
  const on = state.view === 'settings';
  $('#shell').hidden = on;
  page.hidden = !on;
  if (!on) {
    page.replaceChildren();
    return false;
  }
  // Every repaint rebuilds the page — pressing 保存 alone repaints twice — so
  // the scroll offset is carried over by hand, or the form would jump to the
  // top under the user. A different tab is a different page and starts at 0.
  const prev = page.querySelector('.settings__main');
  const keep = prev && page.dataset.tab === state.settingsTab ? prev.scrollTop : 0;
  mount(page, [settingsView({ state, handlers })]);
  page.dataset.tab = state.settingsTab;
  const next = page.querySelector('.settings__main');
  if (next) next.scrollTop = keep;
  return true;
}

/** Repaint the conversation; chat-scroll.js decides where it ends up scrolled. */
function renderPane() {
  const body = $('#pane-body');
  const before = captureChatScroll(body, state.activeId);
  mount(body, [chatView(state, handlers)]);
  restoreChatScroll(body, before);
}

/**
 * Repaint the preview, keeping its scroll position while it shows the same
 * table. Every state change repaints, and a page arriving at the bottom must
 * not throw the user back to row 1; a different table starts at the top.
 */
function renderPreview() {
  const pane = $('#preview-pane');
  const p = state.preview;
  // `view` rather than `key` when there is one: a saved column width changes
  // the key but not the table, and must not throw the user back to row 1.
  const identity = p ? `${p.view || p.key || ''}:${p.proposed ? 1 : 0}` : '';
  const prev = pane.querySelector('.preview__body');
  const keep = prev && pane.dataset.preview === identity ? { top: prev.scrollTop, left: prev.scrollLeft } : null;
  mount(pane, previewView(state, handlers));
  pane.dataset.preview = identity;
  const next = pane.querySelector('.preview__body');
  if (keep && next) {
    next.scrollTop = keep.top;
    next.scrollLeft = keep.left;
  }
}

function renderStatusbar() {
  $('#status-msg').textContent = state.status || '就绪';

  const busy = Object.entries(state.busy)
    .filter(([, v]) => v)
    .map(([k]) => k);
  $('#status-busy').textContent = busy.length ? `进行中：${busy.join(' / ')}` : '';
}

// ── handlers passed into views ──────────────────────────────────────

const handlers = {
  onSend: () => {
    const ta = state.draftNode;
    send(ta ? ta.value : state.draft);
  },
  onDraft: (v) => {
    // Keep the node reference and the text, but never push state back into the
    // node from here — that is what a repaint would trample.
    state.draft = v;
  },
  onDraftNode: (node) => {
    state.draftNode = node;
  },
  onIdea: (text) => {
    useIdea(text);
  },
  onStartSession: () => {
    startSession();
  },
  onPickFiles: pickFiles,
  onPickFolder: pickFolder,
  onPasteFiles: pasteFiles,
  onClearAttachments: clearAttachments,
  onOpenAttachment: openAttachment,
  onApply: applyPending,
  onDismiss: dismissPending,
  onDownload: downloadWorkbook,
  onMorePreview: loadMorePreview,
  onColumnWidth: setColumnWidth,

  // ── settings ──────────────────────────────────────────────────────
  onSaveSettings: saveSettings,
  onTestSettings: testSettings,
  onClearSettingsKey: clearSettingsKey,
  onSettingsTab: (tab) => openSettings(tab),
  onCloseSettings: closeSettings,
};

boot();
