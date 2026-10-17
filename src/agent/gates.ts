'use strict';
/**
 * The checks around a turn that are ordinary code: whether a message is a
 * request for work at all, whether an edit may lose rows, and whether a text
 * reply claims a change that no tool made.
 */

import { stripReasoning } from './llm.ts';
import { validateSpec, specStats } from '../workbook/workbook.ts';
import type { GuardVerdict } from './types.ts';

// --------------------------------------------------------- the cheap filter

/** Words that only appear when someone is asking for a document. */
const WORK_RE = new RegExp(
  [
    '做|建|弄|生成|创建|来一?[个张份]|出一?[个张份]|帮我写',
    '表|表格|工作簿|台账|清单|报表|明细',
    '加一?列|加一?行|删掉|删除|去掉|新增',
    '改|换|写成|改为|改成|设为|设成|调整|更新',
    '\\b(create|make|build|generate|add|remove|delete|change|set|update)\\b',
  ].join('|'),
  'i',
);

/**
 * Words that mark a question, which no amount of "表" should override.
 *
 * A trailing 吗 counts only at the very end. (There was also a `吗\b`, which
 * never fired: JS's \b knows only ASCII word characters, so it needed 吗 to be
 * followed by a Latin letter. Widening it to 吗 before punctuation would turn
 * a polite request — 能加一列吗，谢谢 — into a question, so it is simply gone.)
 */
const ASK_RE = /[?？]|是不是|能不能|可不可以|可以吗|行不行|怎么|为什么|为何|哪一?[个些]|什么|多少|如何|吗$/;

/**
 * Is this message even shaped like a request to build or change something?
 *
 * A pre-filter, not a gatekeeper. It exists so that the entire class of
 * questions — "你能做什么", "这个表怎么用" — never reaches the code path that
 * can replace a workbook. A miss falls through to the model's own declaration
 * and costs one round trip; a false positive costs the same. Erring toward
 * "ask the model" is fine. Erring toward "assume it is a command" is not.
 *
 * The question-mark check comes first and wins: "这个表怎么加一行？" contains
 * both, and it is a question.
 */
export function looksLikeWork(message: string): boolean {
  const text = String(message || '').trim();
  if (!text) return false;
  if (ASK_RE.test(text)) return false;
  return WORK_RE.test(text);
}

// ------------------------------------------------------------- the guard

/** Verbs that mean the user asked for data to go away. */
const SHRINK_RE = /删|清空|去掉|移除|不要了|重新做|重做|换成|换成新|清掉|delete|remove|clear|start over/i;

/** Arguments to `guardChange`. */
export interface GuardChangeArgs {
  /** the spec in force (null on a fresh start) */
  current: import('../workbook/workbook.ts').WorkbookSpec | null;
  /** the proposed spec, already normalised */
  next: import('../workbook/workbook.ts').WorkbookSpec;
  /** what the user actually said */
  message: string;
}

/**
 * Decide whether a proposed spec may replace the current one.
 *
 * This is the gate that does not care what the model said about itself. It
 * compares what it produced against what is already there, and refuses the
 * change when the arithmetic contradicts the request.
 *
 * The rule it protects: **losing the user's data is not allowed to be a side
 * effect.** A model asked to bump one number can satisfy that by emitting a
 * tidy new sheet with one row, and its reply will describe the bump. Nothing in
 * the reply reveals that 40 rows are gone. So the row counts are compared, and
 * a drop is allowed only when the message asks for one.
 */
export function guardChange({ current, next, message }: GuardChangeArgs): GuardVerdict {
  const before = current ? specStats(current) : { sheets: 0, rows: 0, columns: 0 };
  const after = specStats(next);

  if (after.sheets === 0) {
    return { ok: false, reason: '提出的工作簿里没有任何工作表', lostRows: 0 };
  }

  // Reading a spec the model just wrote: if it is not usable there is nothing to
  // guard, and reporting "empty" here is more honest than letting it through.
  const verdict = validateSpec(next);
  if (!verdict.ok) {
    return { ok: false, reason: verdict.blocking.join('；') || '提出的工作簿不可用', lostRows: 0 };
  }

  if (!before.rows) return { ok: true, reason: '', lostRows: 0 };

  const lost = before.rows - after.rows;
  // A row or two is ordinary editing. Losing a fifth of the table, or most of a
  // small table, is the failure this exists for.
  const material = lost > 0 && (lost >= 3 || lost > before.rows * 0.2);
  if (material && !SHRINK_RE.test(String(message || ''))) {
    return {
      ok: false,
      lostRows: lost,
      reason: `新的表格比现在少 ${lost} 行，但你没有要求删除行。为免误删，这次修改没有应用。`,
    };
  }

  return { ok: true, reason: '', lostRows: Math.max(0, lost) };
}

/** What `proseReply` reports back. */
export interface ProseReply {
  reply: string;
  claimed: boolean;
}

/**
 * Did the model describe a change it did not make?
 *
 * Only used on the prose path. A reply that says "已把金额改成 40 万" while
 * nothing was applied reads as done, and the user has no reason to check a
 * preview they believe is stale. Detecting the claim is cheap; the alternative
 * is a document that quietly disagrees with the conversation about it.
 */
export function proseReply(raw: string): ProseReply {
  const text = stripReasoning(raw).trim();
  // Two shapes claim completion, and the first one is the common one:
  //   「已把金额改成40万」 — 已 and the verb are separated by the object.
  //   「表格已经创建好了」 — 已经 immediately before the verb.
  // A bare `已改` catches neither, which is how the first version missed the
  // exact sentence it was written for. The window is small so that
  // 「已有一个表，你可以改」 does not read as a claim.
  const DONE = '改|修改|更新|设|设置|创建|生成|建|做|添加|加|清空|删';
  const claimed = new RegExp(
    `已[^。！？!?\\n]{0,8}(?:${DONE})` + `|(?:${DONE})好(?:了)?` + '|完成修改|已为你|已经好了',
  ).test(text);
  return { reply: text, claimed };
}
