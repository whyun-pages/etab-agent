/* ════════════════════════════════════════════════════════════════════
   API client — thin wrapper over fetch with uniform error handling.

   Every endpoint answers JSON. When one answers { ok: false, error }, the
   caller wants the message, not a rejected promise it has to unwrap at each
   call site, so failures surface as an ApiError carrying the payload.

   The surface is sessions. There is no template, no plan and no run anymore:
   a conversation and the workbook it produced are one object, and everything
   the UI shows is derived from it.
   ════════════════════════════════════════════════════════════════════ */

export class ApiError extends Error {
  constructor(message, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.payload = payload;
  }
}

async function parse(res) {
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { ok: false, error: text.slice(0, 300) }; }
  }
  if (!res.ok) {
    throw new ApiError((data && data.error) || `HTTP ${res.status}`, data);
  }
  return data;
}

async function req(method, path, { body, formData } = {}) {
  const init = { method };
  if (formData !== undefined) {
    // Content-Type is left unset on purpose: the browser writes the multipart
    // boundary, and setting the header by hand drops it, which makes the
    // server fail to parse the body.
    init.body = formData;
  } else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return parse(await fetch(path, init));
}

const q = (id) => encodeURIComponent(id);

export const api = {
  health: () => req('GET', '/api/health'),

  // ── model settings ────────────────────────────────────────────────
  getSettings: () => req('GET', '/api/settings'),
  saveSettings: (patch) => req('POST', '/api/settings', { body: patch }),
  testSettings: () => req('POST', '/api/settings/test', { body: {} }),

  // ── sessions ──────────────────────────────────────────────────────
  listSessions: () => req('GET', '/api/sessions'),
  createSession: (title) => req('POST', '/api/sessions', { body: { title: title || '' } }),
  getSession: (id) => req('GET', `/api/sessions/${q(id)}`),
  removeSession: (id) => req('DELETE', `/api/sessions/${q(id)}`),

  /** One conversation turn. Returns the intent plus, when it changed something, a preview. */
  turn: (id, message) => req('POST', `/api/sessions/${q(id)}/turn`, { body: { message } }),

  /** Accept (or discard) a proposal that was held for confirmation. */
  applyTurn: (id, accept = true) => req('POST', `/api/sessions/${q(id)}/apply`, { body: { accept } }),

  /** The workbook as bytes, derived from the stored spec. */
  async workbook(id) {
    const res = await fetch(`/api/sessions/${q(id)}/workbook.xlsx`);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* keep the status text */ }
      throw new ApiError(msg);
    }
    const blob = await res.blob();
    return { blob, name: filenameOf(res.headers.get('content-disposition')) || '工作簿.xlsx' };
  },

  // ── attachments ───────────────────────────────────────────────────
  listAttachments: () => req('GET', '/api/attachments'),
  clearAttachments: () => req('DELETE', '/api/attachments'),

  /** Upload files as multipart/form-data under the `files` field. */
  attach(files) {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    return req('POST', '/api/attachments', { formData: fd });
  },
};

/** Pull the RFC 5987 (or plain) filename out of a Content-Disposition header. */
function filenameOf(header) {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1]); } catch { /* fall through */ }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : null;
}

/** Save a blob to disk via a temporary anchor. */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick: revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
