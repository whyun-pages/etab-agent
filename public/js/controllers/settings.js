/* ════════════════════════════════════════════════════════════════════
   The model settings panel: opening it, saving, clearing the key, testing
   the connection.
   ════════════════════════════════════════════════════════════════════ */

import { api } from '../api.js';
import { state, set, setBusy } from '../state.js';
import { toast } from '../ui.js';
import { clock, errText, fail } from '../feedback.js';
import { refreshSessions } from './sessions.js';

// ── model settings ───────────────────────────────────────────────────

export function toggleSettings() {
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
export function openSettings(tab) {
  set({ view: 'settings', settingsTab: tab || state.settingsTab, settingsTest: null, settingsNotice: null });
}

export function closeSettings() {
  set({ view: 'chat', settingsTest: null, settingsNotice: null });
}

export async function refreshSettings() {
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
export async function saveSettings(draft) {
  setBusy('settings', true);
  try {
    const patch = {};
    for (const k of [
      'api',
      'baseUrl',
      'model',
      'useForAttachments',
      'chatCanEdit',
      'chatConfirmEdits',
      'chatCanSave',
      'exportDir',
      'chatCanFetch',
      'fetchBlocklist',
      'chatFileAccess',
      'fileBlocklist',
    ]) {
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
    const msg = errText(err);
    set({ settingsNotice: { tone: 'err', text: `保存失败：${msg}` }, status: msg });
    toast({ tone: 'err', title: '保存失败', body: msg, ms: 7000 });
  } finally {
    setBusy('settings', false);
  }
}

export async function clearSettingsKey() {
  setBusy('settings', true);
  try {
    const res = await api.saveSettings({ apiKey: '' });
    set({
      settings: res.settings,
      settingsDraft: {},
      settingsTest: null,
      settingsNotice: { tone: 'ok', text: `已清除 API key（${clock()}）` },
      status: '已清除 API key',
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
export async function testSettings() {
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
