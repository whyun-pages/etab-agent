/* ════════════════════════════════════════════════════════════════════
   Attachments: picking files and folders, pasting, uploading in batches, and
   the session's attachment list.
   ════════════════════════════════════════════════════════════════════ */

import { api } from '../api.js';
import { el } from '../dom.js';
import { state, set, setBusy } from '../state.js';
import { toast } from '../ui.js';
import { fail } from '../feedback.js';

// ── attachments ─────────────────────────────────────────────────────

/** The hidden file input the paperclip clicks; created once, reused. */
let fileInput = null;
/** The hidden directory input the folder button clicks; created once, reused. */
let folderInput = null;

/** What the file picker offers, and what a picked folder is filtered down to. */
const ATTACH_EXT = [
  '.csv',
  '.tsv',
  '.txt',
  '.json',
  '.md',
  '.xlsx',
  '.xls',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.docx',
  '.pdf',
  '.zip',
];

/**
 * The server takes at most this many files per request (`MAX_FILES` in
 * src/http/server.ts). A folder easily holds more, so uploads go in batches of it.
 */
const ATTACH_BATCH = 20;

/**
 * Wire the paperclip to a file picker, and the folder button to a directory
 * picker.
 *
 * The inputs are created lazily on the document rather than living in the chat
 * view: the view is rebuilt on every repaint, and a picker whose `<input>` is
 * swapped mid-flow loses the selection the user just made.
 */
export function bindFileInput() {
  fileInput = el('input', {
    type: 'file',
    id: 'file-input',
    multiple: true,
    accept: ATTACH_EXT.join(','),
  });
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) handleFiles(fileInput.files);
    // Reset so picking the SAME file twice still fires `change`.
    fileInput.value = '';
  });
  document.body.append(fileInput);

  // `webkitdirectory` is a property, not an attribute `el` knows about; every
  // browser this app runs in (Edge/Chromium) supports it. `accept` is ignored
  // for directories, which is why folderFiles filters by extension itself.
  folderInput = el('input', { type: 'file', id: 'folder-input', multiple: true });
  folderInput.webkitdirectory = true;
  folderInput.style.display = 'none';
  folderInput.addEventListener('change', () => {
    if (folderInput.files && folderInput.files.length) handleFolder(folderInput.files);
    folderInput.value = '';
  });
  document.body.append(folderInput);
}

/**
 * The files of a picked folder worth uploading: the readable types, minus
 * anything hidden (`.git/`, `.DS_Store`) — the picker hands back the whole tree,
 * and uploading a repository's object store as attachments helps nobody.
 */
function folderFiles(files) {
  return [...files].filter((f) => {
    const rel = f.webkitRelativePath || f.name;
    if (rel.split('/').some((seg) => seg.startsWith('.'))) return false;
    const dot = f.name.lastIndexOf('.');
    return dot > 0 && ATTACH_EXT.includes(f.name.slice(dot).toLowerCase());
  });
}

function handleFolder(files) {
  const all = [...files];
  const list = folderFiles(all);
  const root = (all[0]?.webkitRelativePath || '').split('/')[0] || '文件夹';
  if (!list.length) {
    toast({ tone: 'warn', title: `${root} 里没有能读的文件`, body: `支持：${ATTACH_EXT.join(' ')}`, ms: 6000 });
    return;
  }
  handleFiles(list);
}

/**
 * Files pasted into the composer.
 *
 * A pasted screenshot is always called `image.png` by the browser, so two of
 * them would be two chips with one name and no way to tell which is which.
 * They get the time of the paste instead; a file copied from disk keeps its
 * own name.
 */
export function pasteFiles(files) {
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const named = files.map((f, i) => {
    const m = /^image\.(\w+)$/i.exec(f.name || '');
    if (!m) return f;
    const n = files.length > 1 ? `-${i + 1}` : '';
    return new File([f], `截图-${stamp}${n}.${m[1].toLowerCase()}`, { type: f.type, lastModified: f.lastModified });
  });
  handleFiles(named);
}

/** Attachments belong to a session: without one open, say so and stop. */
function haveSession() {
  if (state.activeId) return true;
  toast({ tone: 'warn', title: '先新建一个会话', body: '附件会跟着这次对话走。', ms: 4000 });
  return false;
}

export function pickFiles() {
  if (!haveSession()) return;
  if (fileInput) fileInput.click();
}

export function pickFolder() {
  if (!haveSession()) return;
  if (folderInput) folderInput.click();
}

/**
 * Upload dropped or picked files and mirror the server's view of them.
 *
 * The server is the source of truth for what an attachment IS (kind, parsed
 * columns, preview). We refetch the list after uploading rather than trusting
 * the POST response's shape alone, so a partial failure (one file of several)
 * is reflected exactly.
 */
export async function handleFiles(files) {
  if (!haveSession()) return;
  const list = [...files];
  if (!list.length) return;
  // Captured now: the user can switch sessions while the upload is in flight,
  // and the files belong to the session they were dropped on.
  const id = state.activeId;
  setBusy('attach', true);
  set({ attaching: true, status: `正在读取 ${list.length} 个文件…` });
  try {
    // In batches, in order: one request per batch keeps each under the server's
    // per-request cap, and sequential keeps the chips in the order picked.
    const modelNotes = [];
    const archiveNotes = [];
    const results = [];
    for (let i = 0; i < list.length; i += ATTACH_BATCH) {
      const res = await api.attach(id, list.slice(i, i + ATTACH_BATCH));
      modelNotes.push(...(res.modelNotes || []));
      archiveNotes.push(...(res.archiveNotes || []));
      results.push(...(res.attachments || []));
    }
    if (modelNotes.length) {
      toast({ tone: 'warn', title: '模型读取失败', body: modelNotes.map((n) => n.error).join('；'), ms: 8000 });
    }
    // A zip expands into its readable members; say what was left out, so a
    // missing file is not a mystery.
    if (archiveNotes.length) {
      toast({
        tone: 'info',
        title: '压缩包已展开',
        body: archiveNotes.map((n) => `${n.name}：跳过 ${n.skipped} 个不支持的文件`).join('\n'),
        ms: 6000,
      });
    }
    await refreshAttachments(id);
    const bad = results.filter((a) => a.kind === 'error');
    set({ status: bad.length ? `${bad.length} 个文件读不了` : `已添加 ${list.length} 个文件` });
    if (bad.length)
      toast({
        tone: 'err',
        title: '有一部文件读不了',
        body: bad.map((a) => `${a.name}：${a.error || '不支持'}`).join('\n'),
        ms: 8000,
      });
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
export async function clearAttachments() {
  if (!state.activeId) return;
  setBusy('attach', true);
  try {
    await api.clearAttachments(state.activeId);
    set({ attachments: [], status: '已清空附件' });
  } catch (err) {
    fail('清空附件失败', err);
  } finally {
    setBusy('attach', false);
  }
}

/** Open one attachment on this computer; the server hands a copy to the OS. */
export async function openAttachment(a) {
  if (!state.activeId || !a.id) return;
  try {
    await api.openAttachment(state.activeId, a.id);
    set({ status: `已在电脑上打开 ${a.name}` });
  } catch (err) {
    fail('打开失败', err);
  }
}
