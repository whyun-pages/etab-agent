'use strict';
/**
 * The agent turn — one message in, one decision out.
 *
 * The model edits through tools
 * -----------------------------
 * A turn runs a pi-agent loop (`runAgentLoop` from @earendil-works/pi-agent-core).
 * The model is given the current workbook as a numbered summary and a set of
 * tools — `update_cells`, `add_rows`, `delete_rows`, `add_columns`, … — each a
 * thin wrapper over one pure operation in src/workbook/spec-ops.ts. It calls them, sees
 * each result (or each refusal), and may call more, until it answers in text.
 * The tools act on a DRAFT that belongs to this turn; nothing is stored here.
 *
 * The boundary did not move: **the model decides what the text MEANS; code
 * decides what lands in a cell.** A model that emits a malformed workbook is
 * the one failure a user cannot work around — Excel refuses to open it and
 * there is nothing to look at — so every tool result goes through
 * `normalizeSpec` and `validateSpec` before it becomes the draft, and a refused
 * edit is reported back to the model, which can correct its call.
 *
 * Why incremental, when the old design replaced the WHOLE spec
 * ------------------------------------------------------------
 * The single-call design had the model return a complete spec every turn, and
 * it said why: a patch "needs a matching algorithm, and a matching algorithm on
 * a spreadsheet means deciding that 'the row with 125万' is the same row as
 * before — silently, and possibly wrongly." That stays true, and these tools do
 * not match. A row is addressed by the number the summary showed next to it, a
 * column by its header, a sheet by its name; an address that does not exist is
 * an error, not a best guess (src/workbook/spec-ops.ts). What the wholesale design cost
 * — every turn re-emitting every row, a large table hitting the output cap and
 * arriving as truncated JSON — is gone. `create_workbook` still exists for a
 * fresh table or a requested rebuild.
 *
 * The three gates, kept because they were measured
 * ------------------------------------------------
 *   1. `looksLikeWork` — a cheap pre-filter, reported to the caller.
 *   2. Intent is DERIVED, never declared. The old design trusted an `intent`
 *      field and checked it; now there is nothing to trust. A turn is an
 *      `action` only if an edit tool succeeded, a `question` if the model
 *      called `ask_user`, and an `answer` otherwise. Prose has no path to a
 *      cell, however confident it sounds — and when chat editing is switched
 *      off, the edit tools are not offered at all.
 *   3. `guardChange` — deterministic, run once on the turn's CUMULATIVE result
 *      against the spec the turn started from. Ten small `delete_rows` calls
 *      are judged as the one big loss they add up to.
 *
 * Gate #3 exists because of a failure mode that only shows up once there is no
 * template: "make it a bit higher" is a request a model can satisfy by throwing
 * away every row and writing one new one. It will not say it did that. So the
 * check is arithmetic — the row count fell, was that asked for — and it does
 * not trust the reply text.
 *
 * "Do not touch the document" is the default branch. A misread of "你能做什么"
 * produces an `answer` at worst, and an answer carries no spec at all.
 *
 * Saving and fetching
 * -------------------
 * Two tools reach outside the draft, each behind its own setting:
 *
 * - `save_file` does NOT write anything. It records an export request
 *   (`TurnResult.exports`) and the server performs it after the turn's edits
 *   have actually landed. Writing from inside the turn would save the DRAFT,
 *   and the draft may yet be refused by gate #3, held for confirmation, or
 *   rejected by the replay because another turn changed the table meanwhile —
 *   a saved file showing a change that never happened is worse than none.
 * - `fetch_url` reads a web resource (src/access/fetch.ts, which owns the SSRF
 *   rules). With `importAs` it also records an edit — `create_workbook` or
 *   `add_sheet` with the fetched rows written into the arguments — so the
 *   server's replay stays a pure function and never goes back to the network.
 *
 * Where the parts are
 * -------------------
 * This file is `runTurn` and its clocks. Around it, one module per concern,
 * none importing this one back:
 *
 *   types.ts             what goes in and out of a turn
 *   prompt.ts            the system prompt and the per-switch notes
 *   context.ts           the spec summary, change log and history the model sees
 *   gates.ts             the work filter, the row-loss guard, prose claims
 *   tools/               the tools offered: tools.ts picks them for the turn's
 *                        switches, defs/ defines one tool (or the edit tools) per file
 *   transcript.ts        pi's messages in and out
 *
 * Callers import from here; the names they use are re-exported below.
 */

import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { loadPi } from './pi.ts';
import { modelFromSecrets, MAX_OUTPUT_TOKENS } from './model.ts';
import { stripReasoning, LlmError, createClocks, toLlmError, textOf, isEmptyReply, EMPTY_REPLY } from './llm.ts';
import { INTENT } from './types.ts';
import type { RunTurnArgs, TurnResult } from './types.ts';
import {
  READ_ONLY_NOTE,
  SAVE_NOTE,
  SAVE_NOTE_WITH_DIR,
  SAVE_OFF_NOTE,
  FETCH_OFF_NOTE,
  FETCH_NOTE,
  FILE_NOTES,
  ATTACH_NOTE,
} from './prompt.ts';
import { DEFAULT_ROW_BUDGET, describeChange, agentMessages } from './context.ts';
import { looksLikeWork, guardChange, proseReply } from './gates.ts';
import { buildTools } from './tools/tools.ts';
import type { TurnState } from './tools/tools.ts';
import { toLlm, transcript, streamingReply } from './transcript.ts';

// The public surface stays here, so callers keep importing from agent.ts.
export { describeChange, agentMessages, specSummary, changesSummary } from './context.ts';
export { guardChange, looksLikeWork, proseReply } from './gates.ts';
export { INTENT } from './types.ts';
export type { ExportRequest } from './types.ts';

/**
 * How long a turn may wait.
 *
 * Idle: no streamed event at all, reasoning and tool execution included. Two
 * windows, because not every silence means the same thing:
 *
 * - Before a reply starts (waiting on the request, or between steps), a minute
 *   of nothing is a provider that is not coming back.
 * - Once a reply is streaming, silence is often the model still working where
 *   we cannot see it. MiniMax, among others, does not stream tool-call
 *   arguments: a create_workbook carrying a few thousand rows' worth of tokens
 *   arrives in one piece after half a minute or more of quiet. Measured on a
 *   134-row import: 33 s with no event, then the whole call at once. At 60 s
 *   that turn failed whenever the provider was a little slower.
 *
 * Total: the outer cap across every call in the loop, so a model that keeps
 * calling tools — or a stream that keeps going quiet — still ends.
 */
export const TURN_IDLE_TIMEOUT_MS = 60_000;
export const TURN_STREAM_IDLE_TIMEOUT_MS = 180_000;
export const TURN_TOTAL_TIMEOUT_MS = 600_000;

/**
 * Model calls per turn. A normal edit is one or two (call the tools, then say
 * what was done); a correction after a refused call adds one.
 *
 * It was twelve, and a request that reshapes a downloaded report — import it
 * and a lookup table, drop the summary row, look up a column, compute four,
 * lay out forty — hit twelve on the first turn in three runs out of three:
 * several models call one tool per reply even when told they may batch. 24
 * still stops a model that loops on the same failing call; the total clock
 * (TURN_TOTAL_TIMEOUT_MS) rose with it, since a capped turn keeps its edits
 * and a timed-out one loses them.
 */
export const MAX_STEPS = 24;

/** Said when the model came back with nothing, retried once, and did it again. */
const SILENT_TWICE = '模型这次没有给出任何回复（已自动重试一次）。可以再发一次，或换个模型试试。';

/** Steps listed in the step-cap note; the rest are counted. */
const CAP_NOTE_ITEMS = 8;

/** The step-cap note: that the turn stopped, what it got done, and how to go on. */
function capNoteOf(summaries: string[]): string {
  const head = `（操作步数达到上限（${MAX_STEPS} 步），这一轮停在中途。`;
  if (!summaries.length) return `\n\n${head}还没有改动表格。回复「继续」可以接着做。）`;
  const shown = summaries.slice(-CAP_NOTE_ITEMS);
  const earlier = summaries.length - shown.length;
  return `\n\n${head}已完成：${earlier ? `（前面还有 ${earlier} 步）` : ''}${shown.join('；')}。回复「继续」可以接着做。）`;
}

/** Nudges per run of the loop; each is a step, so the step cap still bounds them. */
const MAX_NUDGES = 2;

/**
 * Sent when a step ended in thought alone. It names both ways out, so a
 * model that had in fact finished says so instead of inventing more work.
 */
const NUDGE =
  '（系统提示）你上一条回复只有思考，没有调用工具，也没有给出回复。如果还有没做完的步骤，请现在调用工具接着做；如果已经全部完成，用一两句话告诉用户做了什么。';

/** Sent when a step's reasoning used up the output budget before any call or word. */
const NUDGE_CUT =
  '（系统提示）你上一条回复在思考阶段就用完了输出长度，被截断了，没有调用工具。不要再从头分析：直接调用工具做下一步，每次只想清楚下一步；如果已经全部完成，用一两句话告诉用户做了什么。';

/**
 * How a step ended with nothing in it but reasoning — no tool call, no words
 * for the user — or null when it did not.
 *
 * - `cut`: the reasoning ran into the output cap (`stopReason: 'length'`).
 *   This is most of what looked like a model "stopping to think": in 12
 *   MiniMax runs of a multi-step reshape, 8 turns ended on reasoning of
 *   20–28 thousand characters — the whole 8192-token budget — broken off
 *   mid-sentence ("…Then</think>"). Asked again from scratch it thinks the
 *   same length again, so it is nudged even before any tool has run, and
 *   told to stop re-planning.
 * - `thought`: the model ended the step itself with only a plan in it, as if
 *   the plan were the work. Nudged only once a tool has run; before that, an
 *   empty reply is `silentRun`'s to retry.
 *
 * There must BE reasoning. A reply that is simply empty after an edit is a
 * model that finished without words, and that is fine: the reply is then
 * described from the change. Nudging it would cost a request for nothing.
 */
function stalled(reply: AssistantMessage): 'cut' | 'thought' | null {
  if (reply.stopReason !== 'stop' && reply.stopReason !== 'length') return null;
  if (reply.content.some((c) => c.type === 'toolCall')) return null;
  const text = textOf(reply);
  // A reply cut off mid-thought may never close its <think>: the rest is still reasoning.
  if (
    stripReasoning(text)
      .replace(/<think\b[^>]*>[\s\S]*$/i, '')
      .trim()
  )
    return null;
  const thought = reply.content.some((c) => c.type === 'thinking' && c.thinking.trim()) || /<think\b/i.test(text);
  if (!thought) return null;
  return reply.stopReason === 'length' ? 'cut' : 'thought';
}

function lastAssistant(messages: PiAgentMessage[]): AssistantMessage | undefined {
  const assistants = messages.filter((m): m is AssistantMessage => (m as { role?: string }).role === 'assistant');
  return assistants[assistants.length - 1];
}

/**
 * A run that came back with nothing at all: no edit, no question, nothing to
 * save or write, and no words — or a stream that closed empty.
 *
 * Worth one more try. Measured against MiniMax over a 16-turn session: 6
 * replies empty, and the same message sent again answered properly every
 * time. A failed provider call (401, 429, timeout) is NOT silence and is not
 * retried — `maxRetries: 0` holds for those, for the reason given there.
 */
function silentRun(last: AssistantMessage | undefined, state: TurnState): boolean {
  if (state.ops.length || state.question || state.exports.length || state.writes.length) return false;
  if (!last) return true;
  if (last.stopReason === 'aborted') return false;
  if (last.stopReason === 'error') return toLlmError(last).code === 'empty';
  if (last.stopReason === 'toolUse') return false;
  return isEmptyReply(last) || !proseReply(stripReasoning(textOf(last)).trim()).reply;
}

/**
 * Run one agent turn.
 *
 * Pure with respect to the document: it decides and returns. Nothing here
 * writes a file, publishes a preview, or touches stored state. The tools edit a
 * draft that dies with the turn; the caller decides whether the result is
 * applied or held for confirmation, which is why a change has to survive this
 * function before it can exist anywhere.
 */
export async function runTurn({
  settings,
  message,
  spec = null,
  history = [],
  changes = [],
  signal,
  rowBudget = DEFAULT_ROW_BUDGET,
  canEdit = true,
  model: modelOverride,
  canSave = false,
  canFetch = false,
  fetchOptions = {},
  attachments = [],
  fileAccess = 'off',
  fileOptions = {},
  idleTimeoutMs = TURN_IDLE_TIMEOUT_MS,
  streamIdleTimeoutMs = TURN_STREAM_IDLE_TIMEOUT_MS,
  today,
}: RunTurnArgs): Promise<TurnResult> {
  if (!(await settings.isConfigured())) {
    throw new LlmError('尚未配置模型', { code: 'not-configured' });
  }

  const prefiltered = looksLikeWork(message);
  const secrets = await settings.secrets();
  const pi = await loadPi();
  const { ai, agent } = pi;
  const model = modelOverride || modelFromSecrets({ ...secrets, api: secrets.api || 'openai-completions' });

  const freshState = (): TurnState => ({
    draft: spec,
    ops: [],
    notes: [],
    summaries: [],
    question: null,
    exports: [],
    writes: [],
    loaded: [],
    today,
  });
  let state = freshState();
  const [system, user] = agentMessages({ history, message, spec, rowBudget, changes });

  // Streamed, and judged by silence rather than by total time — every event
  // the loop emits counts as life, tool execution included. See src/agent/llm.ts,
  // and TURN_STREAM_IDLE_TIMEOUT_MS for why the window depends on the event.
  const clocks = createClocks({ timeoutMs: TURN_TOTAL_TIMEOUT_MS, idleTimeoutMs, signal });
  let steps = 0;
  // Per run of the loop, for the stalled-step nudge: whether a tool has run, the
  // reply that ended the last step, and how many nudges have been sent.
  let worked = false;
  let lastReply: AssistantMessage | undefined;
  let nudges = 0;
  let messages: PiAgentMessage[] = [];
  // One run of the loop over a fresh `state`; see the retry below.
  const runLoop = (): Promise<PiAgentMessage[]> =>
    agent.runAgentLoop(
      [
        // pi 1.x carries the system prompt in the transcript, not beside it.
        // Sent with the prompt rather than seeded into the context so the loop
        // declares the tools on this same message instead of adding a second.
        {
          role: 'system',
          // Each note appears only with its tool: describing a tool the model
          // does not have invites it to call one that does not exist.
          content: [
            system.content,
            canEdit ? '' : READ_ONLY_NOTE,
            canSave ? (fileAccess === 'readwrite' ? SAVE_NOTE_WITH_DIR : SAVE_NOTE) : SAVE_OFF_NOTE,
            canFetch ? FETCH_NOTE : FETCH_OFF_NOTE,
            attachments.length || fileAccess !== 'off' ? ATTACH_NOTE : '',
            FILE_NOTES[fileAccess],
          ]
            .filter(Boolean)
            .join('\n\n'),
          timestamp: 0,
        },
        { role: 'user', content: user.content, timestamp: 0 },
      ],
      {
        messages: [],
        tools: buildTools(ai, state, {
          canEdit,
          canSave,
          canFetch,
          fetchOptions,
          signal: clocks.signal,
          attachments: [...attachments],
          fileAccess,
          fileOptions,
        }),
      },
      {
        model,
        apiKey: secrets.apiKey,
        temperature: 0,
        maxTokens: MAX_OUTPUT_TOKENS,
        // No silent retries, for the same reason as `chat`: the user should
        // see a 429 now, not after a long wait that the idle clock may cut.
        maxRetries: 0,
        // The tools share one draft; running two at once would let one edit
        // land on a spec the other had already replaced.
        toolExecution: 'sequential',
        convertToLlm: toLlm,
        finishTurn: (turn) => {
          lastReply = turn.message;
          if (turn.message.content.some((c) => c.type === 'toolCall')) worked = true;
          return ++steps >= MAX_STEPS ? { action: 'end' } : undefined;
        },
        // Asked when the loop is about to stop. See `stalled`.
        getFollowUpMessages: async () => {
          const how = lastReply && nudges < MAX_NUDGES ? stalled(lastReply) : null;
          if (!how || (how === 'thought' && !worked)) return [];
          nudges++;
          return [{ role: 'user', content: how === 'cut' ? NUDGE_CUT : NUDGE, timestamp: 0 }];
        },
      },
      (event) => {
        clocks.touch(streamingReply(event) ? streamIdleTimeoutMs : idleTimeoutMs);
      },
      clocks.signal,
      pi.streamSimple,
    );

  let retried = false;
  try {
    // At most twice: once, and once more when the first came back with
    // nothing in it. See `silentRun`.
    for (;;) {
      state = freshState();
      steps = 0;
      worked = false;
      lastReply = undefined;
      nudges = 0;
      messages = await runLoop();
      if (retried || clocks.reason() || !silentRun(lastAssistant(messages), state)) break;
      retried = true;
    }
  } finally {
    clocks.dispose();
  }

  const last = lastAssistant(messages);
  // A provider failure anywhere in the loop fails the turn, edits and all: a
  // half-finished multi-step change is not something the user asked for.
  if (clocks.reason()) throw toLlmError({ stopReason: 'aborted' }, clocks);
  if (!last) throw new LlmError('模型没有返回内容');
  if (last.stopReason === 'error' || last.stopReason === 'aborted') throw toLlmError(last, clocks);
  if (isEmptyReply(last) && !state.ops.length) throw new LlmError(EMPTY_REPLY, { code: 'empty' });

  const raw = transcript(messages);
  // Stopped by the step cap with tool calls still pending: what landed is kept
  // (and still guarded), but the user is told it may be incomplete — and what
  // DID land, since the model's last words were the lead-in to calls that never
  // ran ("接下来把组件列填上：") and read as a report of work not done.
  const capped = steps >= MAX_STEPS && last.stopReason === 'toolUse';
  const said = capped ? '' : stripReasoning(textOf(last)).trim();
  const capNote = capped ? capNoteOf(state.summaries) : '';
  const reason = state.summaries.join('；');
  // What every outcome carries unless it says otherwise; each return below
  // spells out only how it differs.
  const result = (r: Pick<TurnResult, 'intent' | 'reply' | 'reason'> & Partial<TurnResult>): TurnResult => ({
    spec: null,
    ops: [],
    exports: state.exports,
    notes: [],
    prefiltered,
    raw,
    writes: state.writes,
    loaded: state.loaded,
    ...r,
  });

  if (!state.ops.length) {
    if (state.question) {
      const reply = said && !said.includes(state.question) ? `${said}\n\n${state.question}` : said || state.question;
      return result({ intent: INTENT.QUESTION, reply, reason });
    }
    // An answer. If it reads as though something was changed, it is wrong —
    // no tool ran — and the user has no reason to distrust it. Say so, in the
    // reply, where it will be seen.
    const prose = proseReply(said);
    const claimNote = prose.claimed ? '\n\n（本次回复没有形成可执行的修改，预览未发生变化。）' : '';
    // Nothing said, twice: that is the model, not the user's sentence. Saying
    // "I did not understand" sent users rewording a request that was fine.
    const blank = capped ? '' : retried ? SILENT_TWICE : '抱歉，我没有理解这句。可以换个说法吗？';
    return result({
      intent: INTENT.ANSWER,
      reply: ((prose.reply || blank) + claimNote + capNote).trim(),
      reason: prose.reply ? '' : '模型返回了空内容',
    });
  }

  // ── at least one edit landed on the draft ──────────────────────────────
  const next = state.draft!;
  const reply = (said || describeChange(spec, next)) + (state.question ? `\n\n${state.question}` : '');
  const verdict = guardChange({ current: spec, next, message });
  if (!verdict.ok) {
    // Nothing is saved either: the file would show the refused change, or —
    // saved from the stored table — not the change the user asked to save.
    // Text writes are dropped with the edit: one may well be a report OF the
    // refused change. What was read stays — reading changed nothing.
    const unsaved = state.exports.length || state.writes.length ? '（没有保存文件。）' : '';
    return result({
      intent: INTENT.QUESTION,
      reply: `${reply}\n\n（${verdict.reason}）${unsaved}`,
      reason,
      exports: [],
      writes: [],
      notes: state.notes,
      guarded: true,
      lostRows: verdict.lostRows,
    });
  }

  return result({
    intent: INTENT.ACTION,
    reply: reply + capNote,
    reason,
    spec: next,
    ops: state.ops,
    notes: state.notes,
    guarded: false,
    lostRows: verdict.lostRows,
  });
}
