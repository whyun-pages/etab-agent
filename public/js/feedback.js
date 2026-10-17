/* ════════════════════════════════════════════════════════════════════
   Telling the user how an action went: a failure as a toast and in the status
   bar, and the wall-clock stamp an outcome line carries.
   ════════════════════════════════════════════════════════════════════ */

import { ApiError } from './api.js';
import { set } from './state.js';
import { toast } from './ui.js';

/** Wall-clock HH:MM:SS, so a second save visibly changes the outcome line. */
export function clock() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/** What to show for a failure: the server's own message, else whatever was thrown. */
export function errText(err) {
  return err instanceof ApiError ? err.message : String(err?.message || err);
}

export function fail(title, err) {
  const msg = errText(err);
  set({ error: msg, status: msg });
  toast({ tone: 'err', title, body: msg, ms: 7000 });
}
