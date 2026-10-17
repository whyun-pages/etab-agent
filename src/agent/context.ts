'use strict';
/**
 * What the model sees of the session: the current spec as a numbered summary,
 * the recent changes, and the prior conversation cut to a character budget —
 * presented as reference material, not as a conversation to continue.
 */

import { specStats } from '../workbook/workbook.ts';
import { INTENT } from './types.ts';
import type { HistoryMessage, ChangeLine, AgentMessage, AgentMessagesArgs } from './types.ts';
import { SYSTEM } from './prompt.ts';

/** Rows sent to the model. Enough to see the shape, not enough to blow the budget. */
export const DEFAULT_ROW_BUDGET = 200;

/**
 * How much prior conversation goes to the model, in characters.
 *
 * Characters, not tokens: counting tokens properly means shipping a tokenizer
 * per provider, and the model behind a custom base URL is unknown. For Chinese
 * one character is roughly one token; for Latin text a character is well under
 * one, so counting characters over-estimates and errs toward sending less,
 * never toward overflowing.
 *
 * Replaces a fixed "last 4 messages, 300 characters each". That kept two rounds
 * at most, and cut an assistant answer mid-sentence even when the budget had
 * plenty of room — the model then saw half a reply and, from the user's side,
 * "forgot" what it had just said. A budget keeps as many recent rounds as fit.
 */
export const DEFAULT_HISTORY_BUDGET = 4000;

/**
 * Per-message caps inside the history budget.
 *
 * A user message is what the user meant, so it is kept nearly whole. An
 * assistant reply is capped harder: what later turns need from it is what it
 * said or changed, and a long explanation would otherwise crowd out the rounds
 * before it. Both caps sit well under the budget, so the newest message always
 * fits.
 */
export const HISTORY_USER_CAP = 2000;
export const HISTORY_ASSISTANT_CAP = 800;

/**
 * How many applied changes the model sees, and how much of each request. One
 * line per change, so ten cost a few hundred characters — cheap next to the
 * spec itself, and enough to cover any session a user is likely to refer back
 * into.
 */
export const RECENT_CHANGES = 10;
const CHANGE_REQUEST_CAP = 80;

// ---------------------------------------------------------------- digest

/**
 * A compact view of the current spec, for the model's context.
 *
 * Rows are capped: sending a large table back in full doubles the cost of every
 * turn. The cap is announced in the text rather than applied silently, and the
 * model is pointed at `read_rows` for the rest — a model that does not know it
 * is seeing a subset will happily "restore" the rows it thinks are missing.
 *
 * Every row is numbered. The numbers are the addresses the edit tools take
 * (see src/workbook/spec-ops.ts), so the model refers to a row by the label it was
 * shown, and never has to count.
 */
export function specSummary(
  spec: import('../workbook/workbook.ts').WorkbookSpec | null | undefined,
  budget = DEFAULT_ROW_BUDGET,
): string {
  if (!spec || !Array.isArray(spec.sheets) || !spec.sheets.length) return '';
  const stats = specStats(spec);
  const lines = [`当前工作簿：${spec.title || '(未命名)'}（${stats.sheets} 个工作表，共 ${stats.rows} 行）`];

  for (const s of spec.sheets) {
    const cols = (s.columns || []).map((c) => `${c.header}:${c.type || 'text'}`).join('、');
    lines.push(`- 工作表「${s.name}」列：${cols || '(无)'}`);
    const rows = s.rows || [];
    const shown = rows.slice(0, budget);
    shown.forEach((r, i) => {
      lines.push(`  ${i + 1}. ` + JSON.stringify(r.map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v))));
    });
    if (rows.length > shown.length) {
      lines.push(`  …（第 ${shown.length + 1}–${rows.length} 行没有列出来；需要时用 read_rows 读取，不要凭空编造）`);
    }
    if (s.totals && s.totals.enabled) {
      lines.push(`  合计：（用户已要求合计行，sumColumns=${JSON.stringify(s.totals.sumColumns || [])}）`);
    }
  }
  return lines.join('\n');
}

type Spec = import('../workbook/workbook.ts').WorkbookSpec;
type Sheet = import('../workbook/workbook.ts').SheetSpec;

/**
 * What a change did to the document, in one line, from the two specs.
 *
 * Computed, not quoted from the model. The reply says what the model believes
 * it did; this says what the spec shows, and the two have disagreed before —
 * that is why the row guard exists. It is also deterministic: same pair of
 * specs, same sentence, so a stored record never depends on how a reply was
 * worded.
 *
 * Sheets are matched by name. When exactly one sheet disappeared and one
 * appeared, that is read as a rename — the far likelier story than "deleted one
 * and made an unrelated one" — and the two are compared column by column.
 */
export function describeChange(before: Spec | null | undefined, after: Spec | null | undefined): string {
  if (!after || !Array.isArray(after.sheets) || !after.sheets.length) return '清空了表格';
  if (!before || !Array.isArray(before.sheets) || !before.sheets.length) {
    const st = specStats(after);
    return `新建工作簿「${after.title || '(未命名)'}」：${st.sheets} 个工作表，共 ${st.rows} 行`;
  }

  const parts: string[] = [];
  if ((before.title || '') !== (after.title || '')) parts.push(`标题改为「${after.title || '(未命名)'}」`);

  const beforeNames = new Set(before.sheets.map((s) => s.name));
  const afterNames = new Set(after.sheets.map((s) => s.name));
  const gone = before.sheets.filter((s) => !afterNames.has(s.name));
  const added = after.sheets.filter((s) => !beforeNames.has(s.name));
  const renamed = gone.length === 1 && added.length === 1 ? { from: gone[0], to: added[0] } : null;
  if (renamed) {
    parts.push(`工作表「${renamed.from.name}」改名为「${renamed.to.name}」`);
  } else {
    for (const s of added) parts.push(`新增工作表「${s.name}」（${(s.rows || []).length} 行）`);
    for (const s of gone) parts.push(`删除工作表「${s.name}」`);
  }

  // Name the sheet only when there is more than one; "「明细」新增列" on a
  // one-sheet workbook is noise.
  const many = before.sheets.length > 1 || after.sheets.length > 1;
  for (const s of after.sheets) {
    const prev = before.sheets.find((b) => b.name === s.name) || (renamed && renamed.to === s ? renamed.from : null);
    if (prev) parts.push(...sheetChanges(prev, s, many ? `「${s.name}」` : ''));
  }

  return parts.length ? parts.join('；') : '内容没有变化';
}

/** Column, row and totals differences between two versions of one sheet. */
function sheetChanges(before: Sheet, after: Sheet, label: string): string[] {
  const out: string[] = [];
  const bCols = before.columns || [];
  const aCols = after.columns || [];
  const bHeaders = bCols.map((c) => c.header);
  const aHeaders = aCols.map((c) => c.header);

  const addedCols = aHeaders.filter((h) => !bHeaders.includes(h));
  const removedCols = bHeaders.filter((h) => !aHeaders.includes(h));
  if (addedCols.length) out.push(`${label}新增列：${addedCols.join('、')}`);
  if (removedCols.length) out.push(`${label}删除列：${removedCols.join('、')}`);

  const common = aHeaders.filter((h) => bHeaders.includes(h));
  for (const h of common) {
    const bt = bCols.find((c) => c.header === h)!.type;
    const at = aCols.find((c) => c.header === h)!.type;
    if (bt !== at) out.push(`${label}列「${h}」类型 ${bt}→${at}`);
  }
  const bOrder = bHeaders.filter((h) => common.includes(h));
  if (bOrder.join('\u0000') !== common.join('\u0000')) out.push(`${label}调整了列顺序`);

  const bRows = before.rows || [];
  const aRows = after.rows || [];
  if (bRows.length !== aRows.length) {
    out.push(`${label}行数 ${bRows.length}→${aRows.length}`);
  } else {
    // Compare only the columns both versions have: adding a column changes
    // every row's shape, and that is already said above.
    const project = (rows: unknown[][], headers: string[]): string =>
      JSON.stringify(rows.map((r) => common.map((h) => r[headers.indexOf(h)] ?? null)));
    if (project(bRows, bHeaders) !== project(aRows, aHeaders)) out.push(`${label}修改了数据`);
  }

  const bTotals = Boolean(before.totals && before.totals.enabled);
  const aTotals = Boolean(after.totals && after.totals.enabled);
  if (bTotals !== aTotals) out.push(`${label}${aTotals ? '加上' : '去掉'}合计行`);
  return out;
}

/**
 * The tail of the change log, for the state section of the system message.
 *
 * This is what outlives the history window. History is a budget of recent
 * conversation and drops old rounds; the change log is one line per change
 * that actually landed, so "改回之前的样子" or "第一次建表时那几列" still has
 * something to point at twenty rounds later.
 */
export function changesSummary(changes: ChangeLine[] | null | undefined, limit = RECENT_CHANGES): string {
  const list = (changes || []).filter((c) => c && c.summary);
  if (!list.length) return '';
  const shown = list.slice(-limit);
  const head =
    list.length > shown.length
      ? `最近的修改（共 ${list.length} 次，列出最近 ${shown.length} 次，从早到晚）：`
      : `已做过的修改（共 ${list.length} 次，从早到晚）：`;
  const lines = shown.map((c, i) => {
    const req = String(c.request || '');
    const asked = req.length > CHANGE_REQUEST_CAP ? `${req.slice(0, CHANGE_REQUEST_CAP)}…` : req;
    return `${i + 1}. 用户：「${asked}」 → ${c.summary}`;
  });
  return [head, ...lines].join('\n');
}

/**
 * The most recent history that fits the budget, oldest first.
 *
 * Walks from the newest message back and stops at the first one that does not
 * fit, rather than skipping it and packing in older, shorter ones: a transcript
 * with a hole in the middle reads as a conversation that never happened. The
 * cut is marked in the text, so the model knows it is reading an excerpt.
 */
function historyLines(turns: HistoryMessage[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i];
    const isUser = m.role === 'user';
    const cap = isUser ? HISTORY_USER_CAP : HISTORY_ASSISTANT_CAP;
    const text = String(m.content);
    const body = text.length > cap ? `${text.slice(0, cap)}…（已截断）` : text;
    // Only the names: the content went to the model on that turn and is not
    // replayed. Naming them still lets "按刚才那个文件" resolve to something.
    const files = m.attachments && m.attachments.length ? `（附件：${m.attachments.join('、')}）` : '';
    const line = `${isUser ? '用户' : '助手'}：${body}${files}`;
    if (used + line.length > budget && out.length) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.reverse();
}

/**
 * The message list for one turn.
 *
 * History is a labelled block on the latest user message, never alternating
 * user/assistant turns. This is not stylistic. Measured on the chat layer, with
 * one prior question replayed as a real conversation, 0 of 5 following commands
 * were classified as actions; the model continued the shape of the transcript
 * instead of reading the new sentence. The same fix applies here for the same
 * reason, and the instruction to judge only the latest sentence has something
 * concrete to point at.
 */
export function agentMessages({
  history = [],
  message,
  spec = null,
  rowBudget = DEFAULT_ROW_BUDGET,
  historyBudget = DEFAULT_HISTORY_BUDGET,
  changes = [],
}: AgentMessagesArgs): AgentMessage[] {
  const context = [specSummary(spec, rowBudget), changesSummary(changes)].filter(Boolean).join('\n\n');
  const system = context ? `${SYSTEM}\n\n--- 当前状态 ---\n${context}` : SYSTEM;

  const turns = (history || []).filter((m) => m && m.role && m.content);
  const userParts: string[] = [];
  if (turns.length) {
    userParts.push('【之前的对话（仅供参考，不是本轮指令）】');
    const asked = turns.filter((m) => m.role === 'user').length;
    const changed = turns.filter((m) => m.intent === INTENT.ACTION).length;
    userParts.push(
      changed
        ? `早先有 ${asked} 条用户消息，其中 ${changed} 次成功修改了表格。`
        : `早先有 ${asked} 条用户消息，还没有修改过表格。`,
    );
    const lines = historyLines(turns, historyBudget);
    if (lines.length < turns.length) {
      userParts.push(`（更早的 ${turns.length - lines.length} 条消息未列出）`);
    }
    userParts.push(lines.join('\n'));
    userParts.push('');
    userParts.push('【本轮用户输入】');
  }
  userParts.push(String(message));

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') },
  ];
}
