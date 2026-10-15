/* ════════════════════════════════════════════════════════════════════
   App controller — wires the shell, the views and the API together.

   Rendering is deliberately simple: one subscription re-paints the rail, the
   conversation and the preview from state. Anything that survives a repaint
   (the half-typed message) lives in state or in a cached node, not in the DOM.

   The shape of the app is one sentence long: a conversation, and the workbook
   it produced, side by side. There is no template to pick and no plan to
   approve — the spec IS the document, and it changes only when the user says
   it should.
   ════════════════════════════════════════════════════════════════════ */

import { api, ApiError, saveBlob } from './api.js';
import { hydrateIcons, icon } from './icons.js';
import { $, el, mount, beginRender, endRender } from './dom.js';
import { state, set, setBusy, subscribe, ready } from './state.js';
import { toast, openModal, closeModal, initModal, initDragDrop } from './ui.js';
import { resetComposer, fillComposer } from './composer.js';
import { initSplitters } from './splitters.js';
import { chatView } from './views/chat.js';
import { captureChatScroll, restoreChatScroll, stickChat } from './chat-scroll.js';
import { previewView } from './views/preview.js';
import { sessionsView } from './views/sessions.js';
import { settingsView } from './views/settings.js';

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
      if (modal && !modal.hidden) { modal.hidden = true; return; }
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

// ── sessions ────────────────────────────────────────────────────────

async function refreshSessions() {
  try {
    const res = await api.listSessions();
    set({ sessions: res.sessions || [] });
  } catch (err) {
    console.warn('session list failed', err);
  }
}

/** Open a session: its transcript, its workbook, and clear any held proposal. */
async function openSession(id) {
  if (!id || state.busy.sessions) return;
  setBusy('sessions', true);
  try {
    // Attachments are per session, so they come with it. A failed list read is
    // an empty list, not a failed open: the transcript is what was asked for.
    const [res, att] = await Promise.all([
      api.getSession(id),
      api.listAttachments(id).catch((err) => { console.warn('attachments read failed', err); return null; }),
    ]);
    // A different conversation means a different message box. The cached node
    // is keyed by session id, so this also clears the half-typed text.
    if (state.activeId !== id) resetComposer();
    set({
      activeId: id,
      title: res.session.title || '',
      messages: res.session.messages || [],
      attachments: (att && att.attachments) || [],
      preview: res.preview || null,
      previewError: null,
      pending: null,
      draft: '',
      view: 'chat',
      error: null,
      status: res.preview ? '已载入会话' : '新会话',
    });
  } catch (err) {
    fail('打开会话失败', err);
  } finally {
    setBusy('sessions', false);
  }
}

/**
 * Create a session and open it.
 *
 * Created eagerly rather than held until the first message: the user asked for
 * a new conversation, and a session that exists on the server is one they can
 * come back to even if they never type anything.
 */
async function createSession() {
  if (state.busy.create) return;
  setBusy('create', true);
  try {
    const res = await api.createSession('');
    await refreshSessions();
    resetComposer();
    set({
      activeId: res.session.id,
      title: '',
      messages: [],
      attachments: [],
      preview: null,
      pending: null,
      draft: '',
      view: 'chat',
      error: null,
      status: '新会话',
    });
    setBusy('sessions', false);
  } catch (err) {
    fail('新建会话失败', err);
  } finally {
    setBusy('create', false);
  }
}

function confirmRemoveSession(session) {
  const cancel = el('button', { class: 'btn', type: 'button', text: '取消' });
  const del = el('button', { class: 'btn btn--danger', type: 'button', text: '删除' });
  const close = openModal({
    title: '删除会话',
    body: el('p', {
      class: 'hint',
      text: `删除「${session.title || '未命名会话'}」？对话和表格一起删掉，不可撤销。`,
    }),
    footer: [cancel, del],
  });
  cancel.addEventListener('click', closeModal);
  del.addEventListener('click', async () => {
    close();
    try {
      await api.removeSession(session.id);
      const wasActive = state.activeId === session.id;
      await refreshSessions();
      if (wasActive) {
        resetComposer();
        set({ activeId: null, title: '', messages: [], attachments: [], preview: null, pending: null, draft: '' });
        const next = state.sessions[0];
        if (next) await openSession(next.id);
      }
      toast('已删除会话', 'ok');
    } catch (err) {
      fail('删除失败', err);
    }
  });
}

// ── attachments ─────────────────────────────────────────────────────

/** The hidden file input the paperclip clicks; created once, reused. */
let fileInput = null;

/**
 * Wire the paperclip to a file picker.
 *
 * The input is created lazily on the document rather than living in the chat
 * view: the view is rebuilt on every repaint, and a picker whose `<input>` is
 * swapped mid-flow loses the selection the user just made.
 */
function bindFileInput() {
  fileInput = el('input', {
    type: 'file', id: 'file-input', multiple: true,
    accept: '.csv,.tsv,.txt,.json,.md,.xlsx,.xls,.png,.jpg,.jpeg,.webp,.gif,.docx,.pdf',
  });
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) handleFiles(fileInput.files);
    // Reset so picking the SAME file twice still fires `change`.
    fileInput.value = '';
  });
  document.body.append(fileInput);
}

/**
 * Files pasted into the composer.
 *
 * A pasted screenshot is always called `image.png` by the browser, so two of
 * them would be two chips with one name and no way to tell which is which.
 * They get the time of the paste instead; a file copied from disk keeps its
 * own name.
 */
function pasteFiles(files) {
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const named = files.map((f, i) => {
    const m = /^image\.(\w+)$/i.exec(f.name || '');
    if (!m) return f;
    const n = files.length > 1 ? `-${i + 1}` : '';
    return new File([f], `截图-${stamp}${n}.${m[1].toLowerCase()}`, { type: f.type, lastModified: f.lastModified });
  });
  handleFiles(named);
}

function pickFiles() {
  if (!state.activeId) {
    toast({ tone: 'warn', title: '先新建一个会话', body: '附件会跟着这次对话走。', ms: 4000 });
    return;
  }
  if (fileInput) fileInput.click();
}

/**
 * Upload dropped or picked files and mirror the server's view of them.
 *
 * The server is the source of truth for what an attachment IS (kind, parsed
 * columns, preview). We refetch the list after uploading rather than trusting
 * the POST response's shape alone, so a partial failure (one file of several)
 * is reflected exactly.
 */
async function handleFiles(files) {
  if (!state.activeId) {
    toast({ tone: 'warn', title: '先新建一个会话', body: '附件会跟着这次对话走。', ms: 4000 });
    return;
  }
  const list = [...files];
  if (!list.length) return;
  // Captured now: the user can switch sessions while the upload is in flight,
  // and the files belong to the session they were dropped on.
  const id = state.activeId;
  setBusy('attach', true);
  set({ attaching: true, status: `正在读取 ${list.length} 个文件…` });
  try {
    const res = await api.attach(id, list);
    if (res.modelNotes && res.modelNotes.length) {
      toast({ tone: 'warn', title: '模型读取失败', body: res.modelNotes.map((n) => n.error).join('；'), ms: 8000 });
    }
    await refreshAttachments(id);
    const bad = (res.attachments || []).filter((a) => a.kind === 'error');
    set({ status: bad.length ? `${bad.length} 个文件读不了` : `已添加 ${list.length} 个文件` });
    if (bad.length) toast({ tone: 'err', title: '有一部文件读不了', body: bad.map((a) => `${a.name}：${a.error || '不支持'}`).join('\n'), ms: 8000 });
  } catch (err) {
    fail('上传失败', err);
  } finally {
    setBusy('attach', false);
    set({ attaching: false });
  }
}

/**
 * Pull a session's attachment list into state — only if it is still the open
 * one, so a slow read for a session the user left does not overwrite the chips
 * of the one they are looking at.
 */
async function refreshAttachments(id = state.activeId) {
  if (!id) return;
  try {
    const res = await api.listAttachments(id);
    if (state.activeId === id) set({ attachments: res.attachments || [] });
  } catch (err) {
    console.warn('attachments read failed', err);
  }
}

/**
 * Remove one file.
 *
 * The server offers only clear-all (per session), and the bytes live only in
 * this process, so dropping one file means clearing and re-sending the survivors. We no
 * longer hold the File objects for those survivors, so the honest move is to
 * clear and say so — silently keeping a file the user removed would be worse.
 */
async function removeAttachment(index) {
  if (!state.activeId) return;
  setBusy('attach', true);
  try {
    await api.clearAttachments(state.activeId);
    set({ attachments: [], status: '已清空附件' });
    void index;
  } catch (err) {
    fail('移除失败', err);
  } finally {
    setBusy('attach', false);
  }
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
    messages: [...state.messages, {
      role: 'user',
      content: message,
      attachments: attachedNames(),
      at: new Date().toISOString(),
    }],
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
      status: res.pending
        ? '改好了，等你确认'
        : res.applied ? '已改' : '已回复',
    });

    // A rename lands on the first change, so the list needs refreshing.
    if (res.applied) refreshSessions();
  } catch (err) {
    restoreDraft(message, err instanceof ApiError ? err.message : String(err?.message || err));
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
    try { ta.focus(); } catch { /* not focusable yet */ }
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

// ── preview paging ───────────────────────────────────────────────────

/**
 * Fetch the next page of preview rows and append it.
 *
 * Driven by the grid's bottom edge coming into view. One page at a time; a
 * preview replaced while the request was out (a turn landed, another session
 * opened) drops the answer, and a table that changed under the key reloads
 * the preview from the top instead of appending rows of a different table.
 */
async function loadMorePreview() {
  const p = state.preview;
  const id = state.activeId;
  if (!p || !id || !p.key || state.previewLoading) return;
  const loaded = (p.startRow || 1) - 1 + p.rows.length;
  if (loaded >= (p.totalRows || 0)) return;

  set({ previewLoading: true, previewError: null });
  try {
    const res = await api.previewRows(id, { key: p.key, from: loaded + 1, count: PREVIEW_PAGE, proposed: p.proposed });
    if (state.activeId !== id || state.preview !== p) return;
    if (res.stale) {
      const fresh = await api.getSession(id);
      if (state.activeId === id) set({ preview: fresh.preview || null });
      return;
    }
    set({
      preview: {
        ...p,
        rows: p.rows.concat(res.rows || []),
        formats: (p.formats || []).concat(res.formats || []),
        totalRows: res.totalRows,
      },
    });
  } catch (err) {
    if (state.activeId === id) set({ previewError: err instanceof ApiError ? err.message : String(err?.message || err) });
  } finally {
    set({ previewLoading: false });
  }
}

/** Rows per page request; the server caps it too. */
const PREVIEW_PAGE = 200;

/**
 * Save a column width dragged in the preview.
 *
 * Shown at the new width at once; the server's answer brings the table's new
 * `key` (the file's bytes changed) and its `cols`. `view` keeps the table's
 * identity across that key change, so the rows already loaded and the scroll
 * position stay — not a single row changed. A refusal (the table changed
 * under the drag) puts the old width back and says why.
 */
async function setColumnWidth(index, width) {
  const p = state.preview;
  const id = state.activeId;
  // The first window always starts at row 1, which is the header row.
  const header = p && (p.startRow || 1) === 1 && p.rows[0] ? p.rows[0][index] : null;
  if (!p || !id || p.proposed || header === null || header === undefined) return;

  const view = p.view || p.key;
  const same = () => state.activeId === id && state.preview && (state.preview.view || state.preview.key) === view;
  set({ preview: { ...p, view, cols: withWidth(p.cols, index + 1, width) } });
  try {
    const res = await api.columnWidth(id, { sheet: p.name, index, header: String(header), width });
    if (same()) set({ preview: { ...state.preview, key: res.key, cols: res.cols || [] } });
  } catch (err) {
    if (same()) set({ preview: { ...state.preview, cols: p.cols } });
    fail('列宽没有保存', err);
  }
}

/** `cols` ranges with column `c` (1-based) set to `width`, splitting a range it sits in. */
function withWidth(cols, c, width) {
  const out = [];
  for (const r of cols || []) {
    if (c < r.min || c > r.max) { out.push(r); continue; }
    if (r.min < c) out.push({ ...r, max: c - 1 });
    if (r.max > c) out.push({ ...r, min: c + 1 });
  }
  out.push({ min: c, max: c, width });
  return out;
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

// ── model settings ───────────────────────────────────────────────────

function toggleSettings() {
  if (state.view === 'settings') closeSettings();
  else openSettings();
}

/**
 * Show the settings page.
 *
 * The outcome line and the test result belong to the visit that produced
 * them; opening the page again starts clean. The draft is kept: leaving with
 * unsaved edits and coming back should not have thrown them away.
 */
function openSettings(tab) {
  set({ view: 'settings', settingsTab: tab || state.settingsTab, settingsTest: null, settingsNotice: null });
}

function closeSettings() {
  set({ view: 'chat', settingsTest: null, settingsNotice: null });
}

async function refreshSettings() {
  try {
    const res = await api.getSettings();
    set({ settings: res.settings || null });
  } catch (err) {
    console.warn('settings read failed', err);
  }
}

/**
 * Save the settings form.
 *
 * An empty key field means "leave it alone" — the server can never send the
 * existing key back to pre-fill a box, so treating blank as "clear" would wipe
 * the key every time the user changed an unrelated field.
 */
async function saveSettings(draft) {
  setBusy('settings', true);
  try {
    const patch = {};
    for (const k of ['api', 'baseUrl', 'model', 'useForAttachments', 'chatCanEdit', 'chatConfirmEdits',
      'chatCanSave', 'exportDir', 'chatCanFetch', 'fetchBlocklist']) {
      if (k in draft) patch[k] = draft[k];
    }
    if (draft.apiKey) patch.apiKey = draft.apiKey;

    const res = await api.saveSettings(patch);
    // The page stays open: leaving is the 返回会话 button's job. Jumping away
    // on save took the user off the page before they could read that it
    // worked, or press 测试连接 on what they had just saved.
    set({
      settings: res.settings,
      settingsDraft: {},
      settingsTest: null,
      settingsNotice: { tone: 'ok', text: `已保存（${clock()}）` },
      status: '设置已保存',
    });
    toast('设置已保存', 'ok');
    // The first save is what makes the app usable; go find the work.
    if (!state.sessions.length) await refreshSessions();
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : String(err?.message || err);
    set({ settingsNotice: { tone: 'err', text: `保存失败：${msg}` }, status: msg });
    toast({ tone: 'err', title: '保存失败', body: msg, ms: 7000 });
  } finally {
    setBusy('settings', false);
  }
}

async function clearSettingsKey() {
  setBusy('settings', true);
  try {
    const res = await api.saveSettings({ apiKey: '' });
    set({
      settings: res.settings, settingsDraft: {}, settingsTest: null,
      settingsNotice: { tone: 'ok', text: `已清除 API key（${clock()}）` }, status: '已清除 API key',
    });
    toast('已清除 API key', 'ok');
  } catch (err) {
    fail('清除失败', err);
  } finally {
    setBusy('settings', false);
  }
}

/**
 * Test the connection.
 *
 * The provider's own error text is shown verbatim: a wrong key, a wrong model
 * name and an unreachable host are three different fixes, and a generic "测试
 * 失败" would hide which one applies.
 */
async function testSettings() {
  setBusy('settings', true);
  set({ settingsTest: null });
  try {
    const res = await api.testSettings();
    set({ settingsTest: res.ok ? { ok: true, reply: res.reply } : { ok: false, error: res.error } });
  } catch (err) {
    set({ settingsTest: { ok: false, error: err.message } });
  } finally {
    setBusy('settings', false);
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

/** Wall-clock HH:MM:SS, so a second save visibly changes the outcome line. */
function clock() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function fail(title, err) {
  const msg = err instanceof ApiError ? err.message : String(err?.message || err);
  set({ error: msg, status: msg });
  toast({ tone: 'err', title, body: msg, ms: 7000 });
}

function focusComposer() {
  const ta = state.draftNode;
  if (!ta) return;
  try { ta.focus({ preventScroll: true }); } catch { try { ta.focus(); } catch { /* ignore */ } }
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
  node.textContent = state.view === 'settings' ? '设置' : (state.title || '');
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
      class: 'iconbtn', type: 'button', title: '关闭', html: icon('x'),
      onclick: () => set({ error: null }),
    }),
  ]);
}

function renderRail() {
  // The grid track is set by a class on the shell, not by the rail itself: the
  // column width belongs to the layout, and the splitter beside it has to go too.
  $('#shell').classList.toggle('is-rail-collapsed', state.railCollapsed);
  mount($('#rail'), sessionsView(state, {
    onOpen: openSession,
    onRemove: confirmRemoveSession,
    onCreate: createSession,
    onToggle: toggleRail,
  }));
}

// ── rail folding ────────────────────────────────────────────────────
// Per window, like the column widths in splitters.js, so localStorage rather
// than the server. Every access is guarded: storage can be unavailable, and a
// preference that cannot be read is simply the default.

const RAIL_KEY = 'tab-agent:rail-collapsed';

function readRailCollapsed() {
  try { return localStorage.getItem(RAIL_KEY) === '1'; } catch { return false; }
}

function toggleRail() {
  const railCollapsed = !state.railCollapsed;
  try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0'); } catch { /* not fatal */ }
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

  const busy = Object.entries(state.busy).filter(([, v]) => v).map(([k]) => k);
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
  onDraftNode: (node) => { state.draftNode = node; },
  onIdea: (text) => { useIdea(text); },
  onStartSession: () => { startSession(); },
  onPickFiles: pickFiles,
  onPasteFiles: pasteFiles,
  onRemoveAttachment: removeAttachment,
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
