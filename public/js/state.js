/* ════════════════════════════════════════════════════════════════════
   Store — the single source of truth for the workspace.

   The server owns sessions; this mirrors just enough of that to render, and
   notifies subscribers on every change so the views stay declarative. Nothing
   here computes business results: the preview and the reply always come from
   the API.

   What lives here rather than in the DOM
   --------------------------------------
   Anything that has to survive a repaint: the text being composed, which
   session is open, and the proposal waiting for an answer. The grid actually
   drawn does NOT live here — it is derived from the active session on demand,
   so there is one copy of it and no way for the two to disagree.
   ════════════════════════════════════════════════════════════════════ */

const listeners = new Set();

export const state = {
  /** Sidebar list: [{ id, title, messages, rows, updatedAt }] */
  sessions: [],
  /** The open session's id, or null. */
  activeId: null,
  /** The open session's transcript: [{ role, content, at, intent, guarded, notes }] */
  messages: [],
  /** The grid of the open session's workbook, or null when it has none. */
  preview: null,
  /** The open session's title, as the server has it. */
  title: '',
  /**
   * A change the model proposed and the user has not answered yet:
   * { preview, rows, reply }. Held in memory by the server too — an
   * unconfirmed proposal is not part of the document.
   */
  pending: null,
  /** Text being composed, kept across re-renders. */
  draft: '',
  /** The live composer node, so a repaint does not drop focus mid-message. */
  draftNode: null,

  /**
   * Files uploaded this session, as the server describes them:
   * [{ name, kind, note, meta, textPreview, columns, preview, ... }].
   * Kept in state rather than the DOM so a repaint does not lose them, and so
   * a send can read them without re-querying the server.
   */
  attachments: [],
  /** True while an upload is in flight, so the chip row can show progress. */
  attaching: false,

  /** Model settings as the server reports them (never includes the key). */
  settings: null,
  /** Unsaved edits in the settings form, kept across re-renders. */
  settingsDraft: {},
  /** Result of the last connection test: { ok, reply | error } */
  settingsTest: null,

  /** Which surface is showing: 'chat' | 'settings'. */
  view: 'chat',
  /** Busy flags so buttons can disable and show a spinner. */
  busy: { boot: false, sessions: false, turn: false, apply: false, settings: false, create: false, attach: false },
  /** Free-form status line. */
  status: '就绪',
  /** Last error message, for the banner and toasts. */
  error: null,
};

/** Apply a patch and notify subscribers once. */
export function set(patch) {
  Object.assign(state, patch);
  emit();
}

/** Set one busy flag and notify. */
export function setBusy(key, value) {
  state.busy = { ...state.busy, [key]: value };
  emit();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.error('[render]', err); }
  }
}

/** The sidebar entry for the open session, if it is still listed. */
export function activeSummary() {
  return state.sessions.find((s) => s.id === state.activeId) || null;
}

/** True when a model is configured; nothing works without one. */
export function ready() {
  return Boolean(state.settings && state.settings.hasKey);
}
