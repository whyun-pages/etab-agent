/* ════════════════════════════════════════════════════════════════════
   The session list: refreshing it, opening, creating and removing a session.
   ════════════════════════════════════════════════════════════════════ */

import { api } from '../api.js';
import { el } from '../dom.js';
import { state, set, setBusy } from '../state.js';
import { toast, openModal, closeModal } from '../ui.js';
import { resetComposer } from '../composer.js';
import { fail } from '../feedback.js';

// ── sessions ────────────────────────────────────────────────────────

export async function refreshSessions() {
  try {
    const res = await api.listSessions();
    set({ sessions: res.sessions || [] });
  } catch (err) {
    console.warn('session list failed', err);
  }
}

/** Open a session: its transcript, its workbook, and clear any held proposal. */
export async function openSession(id) {
  if (!id || state.busy.sessions) return;
  setBusy('sessions', true);
  try {
    // Attachments are per session, so they come with it. A failed list read is
    // an empty list, not a failed open: the transcript is what was asked for.
    const [res, att] = await Promise.all([
      api.getSession(id),
      api.listAttachments(id).catch((err) => {
        console.warn('attachments read failed', err);
        return null;
      }),
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
export async function createSession() {
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

export function confirmRemoveSession(session) {
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
