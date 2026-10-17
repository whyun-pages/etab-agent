'use strict';
/**
 * A conversation turn, and applying the change it held for confirmation.
 *
 *   POST /api/sessions/:id/turn
 *   POST /api/sessions/:id/apply
 *
 * Plus what both do after the session is written: perform the saves and text
 * writes the turn asked for, and tell the user how that went.
 */

import type { Router } from '@koa/router';
import { isFileAccessMode, performWrite, checkPath } from '../../agent/tools/file-access.ts';
import type { FileAccessOptions, FileWrite } from '../../agent/tools/file-access.ts';
import { resolveExportDir } from '../../store/settings.ts';
import { runTurn as runAgentTurn, describeChange, guardChange } from '../../agent/agent.ts';
import { applyOps } from '../../workbook/spec-ops.ts';
import { exportSpec, writeExports } from '../../workbook/export.ts';
import { specStats } from '../../workbook/workbook.ts';
import { previewOf, toUpload } from '../app-state.ts';
import type { AppState, UploadedAttachment } from '../app-state.ts';
import { fail, jsonBody, bodyOf, isLocalRequest, messageOf, sessionOr404, noSession } from '../respond.ts';
import { publicAttachment, publicMessages, publicSession } from '../projections.ts';
import type { RouteDeps } from './index.ts';

type WorkbookSpec = import('../../workbook/workbook.ts').WorkbookSpec;
type Session = import('../../store/session-store.ts').Session;
type ChangeRecord = import('../../store/session-store.ts').ChangeRecord;
type SpecOp = import('../../workbook/spec-ops.ts').SpecOp;
type ExportRequest = import('../../agent/agent.ts').ExportRequest;
type ExportFile = import('../../workbook/export.ts').ExportFile;
type FetchOptions = import('../../agent/tools/fetch-url.ts').FetchOptions;
type Settings = Awaited<ReturnType<AppState['settings']['load']>>;

/** An export file, and the folder it was asked to go to (null: the export folder). */
type DirectedExport = ExportFile & { dir?: string | null };

/**
 * A turn's operations replayed on the spec as stored now, then guarded.
 *
 * Pure, and run inside the store's queue slot by both the turn and the apply
 * route: the operations were computed from a snapshot, and another turn may
 * have changed the table since. When nothing raced the replay reproduces the
 * turn's spec exactly; when the operations no longer fit, nothing lands and
 * `conflict` says why.
 */
function replayChange(
  current: WorkbookSpec | null,
  ops: SpecOp[],
  message: string,
): { landed: WorkbookSpec | null; conflict: string } {
  try {
    const next = applyOps(current, ops).spec;
    const verdict = next ? guardChange({ current, next, message }) : { ok: false, reason: '修改结果为空' };
    return verdict.ok && next ? { landed: next, conflict: '' } : { landed: null, conflict: verdict.reason };
  } catch (err) {
    return { landed: null, conflict: messageOf(err) };
  }
}

/** The files a turn asked to save, as bytes of `spec`, each with the folder it goes to. */
function directedExports(spec: WorkbookSpec, wanted: ExportRequest[]): DirectedExport[] {
  return wanted.flatMap((r) => exportSpec(spec, r).map((file) => ({ ...file, dir: r.dir || null })));
}

/** The change-log entry for an edit that landed, judged from the two specs. */
function changeLine(request: string, before: WorkbookSpec | null, after: WorkbookSpec): ChangeRecord {
  return { request, summary: describeChange(before, after), at: new Date().toISOString() };
}

/** The file checks for a turn: the user's blocklist, and this app's data folder. */
function fileOptionsOf(state: AppState, live: Settings): FileAccessOptions {
  return {
    blocklist: Array.isArray(live.fileBlocklist) ? live.fileBlocklist : [],
    dataDir: state.dataDir,
  };
}

export function turnRoutes(router: Router, { state }: RouteDeps): void {
  /**
   * One conversation turn.
   *
   * Returns the decision and, when it is a change, the preview of what it would
   * produce. Applying is a SECOND call (`POST .../apply`), because a
   * confirmation step has to be able to show the result before it exists — and
   * because it keeps the risky step a separate, explicit request rather than a
   * flag a parser slip could flip.
   *
   * The pending spec is held in memory per session rather than written to
   * disk: an unconfirmed proposal is not part of the document, and a restart
   * losing it is correct behaviour, not data loss.
   */
  router.post('/api/sessions/:id/turn', jsonBody('1mb'), async (ctx) => {
    const session = await sessionOr404(ctx, state.sessions);
    if (!session) return;
    if (!(await state.settings.isConfigured())) return fail(ctx, 400, '尚未配置模型，无法对话');

    const message = String(bodyOf(ctx).message || '').trim();
    if (!message) return fail(ctx, 400, '消息不能为空');

    // Snapshotted before the model call: an upload or a clear landing while the
    // turn is in flight must not change what this turn says it read.
    const uploads = state.uploads.get(session.id) || [];
    const files = uploads.map((u) => u.name);
    const context = attachmentContext(uploads);

    // Read once: the same values decide which tools the model is offered and,
    // below, whether a change may land and where a save goes.
    const live = await state.settings.load();
    const canEdit = Boolean(live.chatCanEdit);
    const canSave = Boolean(live.chatCanSave);
    const canFetch = Boolean(live.chatCanFetch);
    const fetchOptions: FetchOptions = {
      ...state.fetchOptions,
      blocklist: Array.isArray(live.fetchBlocklist) ? live.fetchBlocklist : [],
    };
    const exportDir = resolveExportDir(live);
    // Only a turn from this machine gets this machine's files: with `--host` a
    // LAN client can chat too, and the switch the user flipped was for
    // themselves. An unknown stored value reads as off.
    const fileAccess = isLocalRequest(ctx) && isFileAccessMode(live.chatFileAccess) ? live.chatFileAccess : 'off';
    const fileOptions = fileOptionsOf(state, live);

    let turn;
    try {
      turn = await runAgentTurn({
        settings: state.settings,
        message: context ? `${message}\n\n${context}` : message,
        spec: session.spec,
        history: session.messages,
        changes: session.changes,
        canEdit,
        canSave,
        canFetch,
        fetchOptions,
        attachments: uploads,
        fileAccess,
        fileOptions,
        model: state.agentModel,
        // The one clock read: 今天 is the user's day, on this machine's clock.
        today: localDay(new Date()),
      });
    } catch (err) {
      // A provider failure is not recorded: the user's own message is kept so
      // retrying does not mean retyping. Answered 200 with ok:false on purpose:
      // the request was fine and the session is intact (`messages` is what the
      // client re-renders); it is the turn that failed, and `error` says why.
      ctx.body = { ok: false, error: messageOf(err), messages: publicMessages(session.messages) };
      return;
    }

    // Read-only mode offers the model no edit tools, so a change cannot arrive
    // here. Kept as a backstop: if one ever did, it is downgraded rather than
    // shown as something the user cannot make.
    let spec = turn.spec;
    let ops = turn.ops;
    let note = '';
    if (spec && !canEdit) {
      spec = null;
      ops = [];
      note = '（「允许修改」已关闭，本次没有改动表格）';
    }

    const confirmEdits = Boolean(live.chatConfirmEdits);
    const pending = Boolean(spec) && confirmEdits;
    let applied = Boolean(spec) && !confirmEdits;
    // Backstop like the one above: the tool is not offered when saving is off,
    // so a request cannot arrive — and if one did, it is dropped.
    const exportsWanted = canSave ? turn.exports || [] : [];
    // Same backstop for writes: the tools exist only with readwrite access.
    const writesWanted = fileAccess === 'readwrite' ? turn.writes || [] : [];

    // Files read from disk become the session's attachments, as an upload
    // would — the chips show them, and the next turn can query them without
    // reading the disk again. Same name replaces, as on re-upload.
    if (turn.loaded && turn.loaded.length && (await state.sessions.load(session.id))) {
      const current = state.uploads.get(session.id) || [];
      const fresh = turn.loaded.filter((it) => it.att).map((it) => toUpload({ ...it, att: it.att! }));
      const names = new Set(fresh.map((u) => u.name));
      state.uploads.set(session.id, [...current.filter((u) => !names.has(u.name)), ...fresh]);
    }

    if (pending) {
      state.pending.set(session.id, {
        spec,
        ops,
        exports: exportsWanted,
        writes: writesWanted,
        message,
        at: Date.now(),
      });
    } else {
      state.pending.delete(session.id);
    }

    // The write is a read-modify-write that must run INSIDE the store's queue,
    // against the freshest on-disk session — not against the snapshot loaded
    // before the model call. Two turns firing at once would otherwise each save
    // a transcript that predates the other, and one turn's messages would
    // vanish with no error (measured: 12 concurrent turns left 4 of 26
    // messages). `update` loads and writes in one slot.
    //
    // The same holds for the spec. `turn.spec` was computed from the snapshot,
    // so writing it back would erase a change another turn made meanwhile. The
    // turn's OPERATIONS are replayed against `current.spec` instead, and the
    // row guard re-run on the result. When nothing raced, the replay
    // reproduces `turn.spec` exactly (the operations are pure). When something
    // did and the operations no longer fit — a row number past the end, a
    // column renamed away — nothing lands, and the reply says so rather than
    // applying an edit to rows it was not aimed at. Saves are computed in the
    // slot (pure: bytes from the spec that is actually stored after this turn)
    // and written after it, so slow disk I/O does not hold the session queue.
    // The reply gets the outcome in a second, small update — see saveAndNote.
    let exportFiles: DirectedExport[] = [];
    let replyIndex = -1;
    const saved = await state.sessions.update(session.id, (current: Session) => {
      let landed: WorkbookSpec | null = null;
      if (applied) {
        const replay = replayChange(current.spec, ops, message);
        landed = replay.landed;
        const conflict = replay.conflict;
        if (!landed) {
          applied = false;
          note = `${note}（表格在这期间被改动过，本次修改没有应用：${conflict}）`;
        }
      }
      if (exportsWanted.length) {
        exportFiles = [];
        if (pending) {
          note = `${note}（确认修改后会保存文件。）`;
        } else if (spec && !landed) {
          // The edit the user wanted saved did not happen; saving the old table
          // under their request would be the wrong file.
          note = `${note}（没有保存文件：本次修改没有应用。）`;
        } else {
          const target = landed || current.spec;
          if (!target) note = `${note}（没有保存文件：还没有表格。）`;
          else {
            try {
              exportFiles = directedExports(target, exportsWanted);
            } catch (err) {
              note = `${note}（没有保存文件：${messageOf(err)}）`;
            }
          }
        }
      }
      replyIndex = current.messages.length + 1;
      return {
        ...current,
        // First change names the session, unless the user named it earlier.
        title: current.title || (landed && landed.title) || '',
        spec: landed || current.spec,
        // Recorded against `current.spec`, the freshest one, inside the queue
        // slot — the same reason the spec itself is written here.
        changes: landed ? [...current.changes, changeLine(message, current.spec, landed)] : current.changes,
        messages: [
          ...current.messages,
          {
            role: 'user',
            content: message,
            at: new Date().toISOString(),
            attachments: files.length ? files : undefined,
          },
          {
            role: 'assistant',
            content: turn.reply + (note ? `\n${note}` : ''),
            at: new Date().toISOString(),
            intent: turn.intent,
            guarded: turn.guarded === true,
            // `notes` on the stored message is `StoredMessage['notes']`
            // (`string[]`); the turn produces `SpecNote[]`. The two have been
            // passed through unchanged since before the migration — the value
            // is what a live session serves and what a reloaded one compares
            // against — so the cast records the existing shape rather than
            // changing it. Flattening to strings here would alter what a
            // session stores.
            notes: turn.notes as unknown as string[],
          },
        ],
      };
    });
    if (!saved) return noSession(ctx);

    // Held with the change when it waits for confirmation; otherwise now.
    const writesNow = pending ? [] : writesWanted;
    if (pending && writesWanted.length) {
      note = `${note}（确认修改后会写入文件。）`;
    }
    const { session: final, paths } = await saveAndNote(
      state,
      saved,
      replyIndex,
      exportDir,
      exportFiles,
      writesNow,
      fileOptions,
    );

    ctx.body = {
      ok: true,
      intent: turn.intent,
      reply: final.messages[replyIndex]
        ? final.messages[replyIndex].content
        : final.messages[final.messages.length - 1].content,
      saved: paths,
      guarded: turn.guarded === true,
      lostRows: turn.lostRows || 0,
      notes: turn.notes || [],
      pending,
      applied,
      messages: publicMessages(final.messages),
      preview: saved.spec ? previewOf(state, saved.spec) : null,
      proposed: pending && spec ? { rows: specStats(spec).rows, preview: previewOf(state, spec) } : null,
    };
  });

  /** Apply a proposal that was held for confirmation, or (`accept: false`) drop it. */
  router.post('/api/sessions/:id/apply', jsonBody('64kb'), async (ctx) => {
    const session = await sessionOr404(ctx, state.sessions);
    if (!session) return;
    const held = state.pending.get(session.id);
    if (!held) return fail(ctx, 409, '没有待确认的修改');

    if (bodyOf(ctx).accept === false) {
      state.pending.delete(session.id);
      ctx.body = { ok: true, applied: false, messages: publicMessages(session.messages) };
      return;
    }

    // Replayed against the stored spec inside the queue slot, for the same
    // reason as in the turn route: the proposal was computed from a snapshot,
    // and the table may have changed since.
    let conflict = '';
    let files: DirectedExport[] = [];
    let saveError = '';
    const saved = await state.sessions.update(session.id, (current: Session) => {
      const replay = replayChange(current.spec, held.ops, held.message);
      const landed = replay.landed;
      conflict = replay.conflict;
      if (!landed) return current;
      if (held.exports.length) {
        try {
          files = directedExports(landed, held.exports);
        } catch (err) {
          saveError = messageOf(err);
        }
      }
      return {
        ...current,
        title: current.title || landed.title || '',
        spec: landed,
        changes: [...current.changes, changeLine(held.message, current.spec, landed)],
      };
    });
    state.pending.delete(session.id);
    if (!saved) return noSession(ctx);
    if (conflict) return fail(ctx, 409, `表格在这期间被改动过，这条修改已无法应用：${conflict}`);
    let paths: string[] = [];
    if (files.length || held.writes.length) {
      const live = await state.settings.load();
      const out = await writeOutputs(resolveExportDir(live), files, held.writes, fileOptionsOf(state, live));
      paths = out.paths;
      if (out.errors.length) saveError = out.errors.join('；');
    }
    ctx.body = {
      ok: true,
      applied: true,
      saved: paths,
      saveError: saveError || undefined,
      session: publicSession(saved),
      preview: saved.spec ? previewOf(state, saved.spec) : null,
    };
  });
}

// ----------------------------------------------------------------- outputs

/**
 * Write a turn's exports and tell the user how it went, in the turn's reply.
 *
 * Runs after the session write, outside the store's queue: the files were
 * computed in the slot, and only the disk I/O happens here. The outcome is
 * appended to the reply with a second `update`, addressed by index — messages
 * are only ever appended, so the index recorded in the slot still names the
 * same message. Nothing to write means nothing to update.
 */
async function saveAndNote(
  state: AppState,
  session: Session,
  replyIndex: number,
  dir: string,
  files: DirectedExport[],
  writes: FileWrite[],
  fileOptions: FileAccessOptions,
): Promise<{ session: Session; paths: string[] }> {
  if (!files.length && !writes.length) return { session, paths: [] };
  const { paths, errors } = await writeOutputs(dir, files, writes, fileOptions);
  const parts = [
    paths.length ? `已保存：${paths.join('、')}` : '',
    errors.length ? `保存文件失败：${errors.join('；')}` : '',
  ].filter(Boolean);
  const note = `（${parts.join('；')}）`;
  const updated = await state.sessions.update(session.id, (current: Session) => {
    const target = current.messages[replyIndex];
    if (!target) return current;
    const messages = [...current.messages];
    messages[replyIndex] = { ...target, content: `${target.content}\n${note}` };
    return { ...current, messages };
  });
  return { session: updated || session, paths };
}

/**
 * Write a turn's outputs: exports, grouped by folder, then text writes in the
 * order asked. One failure does not stop the rest; each is reported.
 *
 * A folder other than the export folder came from the model, so it is checked
 * against the file blocklist again HERE, at write time — the check made during
 * the turn was seconds ago, and the folder could be a symlink by now. The
 * export folder is the user's own setting and is not second-guessed.
 */
async function writeOutputs(
  defaultDir: string,
  files: DirectedExport[],
  writes: FileWrite[],
  fileOptions: FileAccessOptions,
): Promise<{ paths: string[]; errors: string[] }> {
  const paths: string[] = [];
  const errors: string[] = [];
  const byDir = new Map<string, ExportFile[]>();
  for (const f of files) {
    const key = f.dir || '';
    byDir.set(key, [...(byDir.get(key) || []), f]);
  }
  for (const [dir, group] of byDir) {
    try {
      const target = dir ? await checkPath(dir, fileOptions, { forWrite: true, folder: true }) : defaultDir;
      paths.push(...(await writeExports(target, group)));
    } catch (err) {
      errors.push(messageOf(err));
    }
  }
  for (const w of writes) {
    try {
      paths.push(await performWrite(w, fileOptions));
    } catch (err) {
      errors.push(`${w.path}：${messageOf(err)}`);
    }
  }
  return { paths, errors };
}

/**
 * `d`'s calendar day on this machine, as YYYY-MM-DD. Local, not UTC: the
 * spec layer used to resolve 今天 from the UTC date, which in Shanghai before
 * 08:00 is still yesterday.
 */
function localDay(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

// ------------------------------------------------------------- attachments

/**
 * The current attachments, as the text the model reads this turn.
 *
 * Composed HERE, per turn, and never stored. It used to be composed in the
 * client (NOTES.md #59) and sent as part of the user's message, which meant the
 * server saved it as what the user said: the block showed up in the chat bubble,
 * was saved again on every turn while the file stayed attached, and then ate the
 * history budget on every turn after that. The user's message is what they
 * typed; the attachment is context for the turn, the same way the spec is.
 *
 * Built from `publicAttachment` so the model sees exactly what the chips
 * describe — the same five preview rows, the same text cap — not a richer view
 * the user has no way to check.
 */
function attachmentContext(uploads: UploadedAttachment[]): string {
  const blocks = uploads.map((u) => {
    const a = publicAttachment(u);
    const head = `【附件：${a.name}】`;
    if (a.kind === 'table' || a.kind === 'sheet') {
      const cols = ((a.columns as Array<{ label: string }> | undefined) || []).map((c) => c.label).join('、');
      const rows = ((a.preview as unknown[][] | undefined) || []).map((r) => r.join('\t')).join('\n');
      const more = a.rowCount ? `（共 ${a.rowCount} 行，下面只给前几行；全部内容用 read_attachment 读取）` : '';
      // A table's note says what was NOT read (rows past the grid limit).
      const note = a.note ? `\n（${a.note}）` : '';
      return `${head}${more}${note}\n列：${cols}\n${rows}`;
    }
    if (a.textPreview) {
      const full = String(u.text || '').length;
      const cut =
        full > String(a.textPreview).length ? `\n（共 ${full} 字，上面只是开头；全部内容用 read_attachment 读取）` : '';
      return `${head}\n${String(a.textPreview)}${cut}`;
    }
    return `${head}（${a.note || '无法预览内容'}）`;
  });
  return blocks.length ? `--- 附件资料 ---\n${blocks.join('\n\n')}` : '';
}
