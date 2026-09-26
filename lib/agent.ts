'use strict';
/**
 * The agent turn — one message in, one decision out.
 *
 * What changed from the template era
 * ----------------------------------
 * There is no template any more. The model does not fill cells in someone
 * else's file; it proposes the whole workbook as a spec:
 *
 *   { title, sheets: [{ name, columns: [{header, type}], rows: [[...]], totals }] }
 *
 * and `lib/workbook.js` turns that into bytes. So the boundary moved but it did
 * not disappear, and it is the same boundary: **the model decides what the text
 * MEANS; code decides what lands in a cell.** A model that emits a malformed
 * workbook is the one failure a user cannot work around — Excel refuses to open
 * it and there is nothing to look at — so the model never touches XML. It emits
 * JSON, and a spec that does not survive `normalizeSpec` never becomes a file.
 *
 * Why the change replaces the WHOLE spec
 * --------------------------------------
 * Decided with the user, and worth restating because it looks wasteful: the
 * model returns a complete spec every time, not a patch. A patch needs a
 * matching algorithm, and a matching algorithm on a spreadsheet means deciding
 * that "the row with 125万" is the same row as before — silently, and possibly
 * wrongly. Replacing wholesale means the only thing to verify is the result,
 * and the result is exactly what the preview shows. The cost is tokens.
 *
 * The three gates, kept from the chat layer because they were measured
 * -------------------------------------------------------------------
 *   1. `looksLikeWork` — a cheap pre-filter. A question never reaches the code
 *      path that can replace a workbook.
 *   2. The intent field, declared by the model and CHECKED here: `action` is the
 *      only intent that may carry a spec, and it must actually carry one.
 *   3. `guardChange` — deterministic. Replaces the model's judgement about its
 *      own output with a rule about this specific spec.
 *
 * Intent #3 is new and it exists because of a failure mode that only shows up
 * once there is no template: with nothing to anchor to, "make it a bit higher"
 * is a request the model can satisfy by throwing away every row and writing one
 * new one. It will not say it did that. So the check is arithmetic — the row
 * count fell, was that asked for — and it does not trust the reply text.
 *
 * "Do not touch the document" is the default branch. A misread of "你能做什么"
 * produces an `answer` at worst, and an answer carries no spec at all.
 */

import * as llm from './llm.ts';
import * as workbook from './workbook.ts';

/**
 * The two collaborators, reached through namespace imports.
 *
 * The local interfaces that used to describe them are gone with the `require`s
 * they existed to type: `import * as` carries the module's real exported
 * signatures, including the `LlmError` class, which is now imported as a value
 * rather than re-declared as a constructor type here.
 */
const { chat, parseJsonReply, stripReasoning, LlmError } = llm;
const { normalizeSpec, validateSpec, specStats, MAX_ROWS } = workbook;

/** What the user's message asks for. */
export const INTENT = {
  /** A question or chat. Never carries a spec. */
  ANSWER: 'answer',
  /** A change, with a complete replacement spec. */
  ACTION: 'action',
  /** A change that cannot be made yet — something is missing. */
  QUESTION: 'question',
} as const;

/** One of the three intents a turn may resolve to. */
export type Intent = (typeof INTENT)[keyof typeof INTENT];

/** A session message as this module reads it back. */
export interface HistoryMessage {
  role?: string;
  content?: string;
  intent?: string;
}

/** One entry in the message list the model receives. */
export interface AgentMessage {
  role: string;
  content: string;
}

/** Arguments to `agentMessages`. */
export interface AgentMessagesArgs {
  history?: HistoryMessage[];
  message: string;
  spec?: import('./workbook.ts').WorkbookSpec | null;
  rowBudget?: number;
}

/** What `guardChange` decides. */
export interface GuardVerdict {
  ok: boolean;
  reason: string;
  lostRows: number;
}

/** A settings object, as far as this module is concerned. */
export interface AgentSettings {
  isConfigured(): Promise<boolean>;
  secrets(): Promise<import('./llm.ts').Credentials>;
}

/** How to reach the model; `llm.chat` unless a caller overrides it. */
export type Transport = (args: import('./llm.ts').ChatArgs) => Promise<string>;

/** Arguments to `runTurn`. */
export interface RunTurnArgs {
  settings: AgentSettings;
  message: string;
  spec?: import('./workbook.ts').WorkbookSpec | null;
  history?: HistoryMessage[];
  signal?: AbortSignal;
  rowBudget?: number;
  /**
   * How to reach the model. Defaults to `llm.chat`; overridden in tests so the
   * decision logic can be pinned down without a network, and available to a
   * caller that wants to wrap or record the call.
   */
  transport?: Transport;
}

/** What one turn resolves to. */
export interface TurnResult {
  intent: Intent;
  reply: string;
  reason: string;
  spec: import('./workbook.ts').WorkbookSpec | null;
  notes: import('./workbook.ts').SpecNote[];
  prefiltered: boolean;
  raw: string;
  guarded?: boolean;
  lostRows?: number;
}

/** Rows sent to the model. Enough to see the shape, not enough to blow the budget. */
export const DEFAULT_ROW_BUDGET = 200;

export const SYSTEM = [
  '你是一个 Excel 助手。用户可以跟你聊天，也可以让你创建或修改一个表格。',
  '',
  '你的工作簿**没有模板**。所有内容都由你根据用户的话提出，格式为一份完整的 JSON 规格',
  '（下面叫「spec」）。用户每次要求修改，你都要返回**整份新的 spec**，而不是补丁。',
  '',
  '你必须只输出一个 JSON 对象：',
  '',
  '{"intent":"answer|action|question","reply":"给用户看的话","reason":"判断依据",',
  ' "spec":{"title":"...","sheets":[...]}}',
  '',
  '三种意图：',
  '',
  '1. answer —— 用户在**提问**或聊天（问你能做什么、问某个字段什么意思、问为什么算错了、',
  '   闲聊）。reply 里直接回答。**不要**带 spec，不返回 spec 字段或返回 null。',
  '',
  '2. action —— 用户在**明确要求创建或修改**表格。此时必须返回完整 spec。',
  '   典型说法：「做一个销售表，有客户、金额、日期」「再加一列税率」',
  '   「把第一行的金额改成40万」「把深圳那行删掉」。',
  '',
  '3. question —— 用户在要求做事，但**信息不够**（没说做成什么、没说改成多少）。',
  '   reply 里反问清楚。不要带 spec。不要猜。',
  '',
  'spec 的格式（严格遵守，字段名就是这些）：',
  '',
  '{"title":"工作簿标题",',
  ' "sheets":[{"name":"工作表名",',
  '   "columns":[{"header":"列名","type":"text|number|integer|currency|percent|date|boolean"}],',
  '   "rows":[["第一列值","第二列值",...]],',
  '   "totals":{"enabled":true,"sumColumns":["列名"]}}]}',
  '',
  '规则：',
  '- columns 的 header 是用户看到的中文列名，不要写 abc。',
  '- rows 里每一行的长度要和 columns 一致。单元格值直接写用户会看到的内容：',
  '  日期写 "2026-03-01"，金额写 1250000 这样的数字（不要写 "125万"），',
  '  百分比写 0.06 表示 6%，是否写 true/false。',
  '- 只有用户明确要看合计时才加 totals；sumColumns 只放金额/数量这类可加的列，',
  '  **不要**把百分比列放进 sumColumns。',
  '- 修改已有表格时，把用户没提到的内容**原样保留**。特别是：不要因为用户改一个值',
  '  就把其它行丢掉，不要重新编造原来的数据。',
  '- 只有用户明确说删行/清空时才减少行数。',
  '',
  '判断原则：',
  '- 分不清是提问还是命令时，选 answer 或 question，**不要**选 action。',
  '- 「改高点」「弄好看点」这种没有具体值的，是 question。',
  '- 一句话既提问又要求修改，按 action 处理，reply 里同时回答问题。',
  '',
  '【最重要】只根据**用户最新那一句话**判断意图。前面几轮都是提问，',
  '不代表这一句也是提问；前面改过东西，后面问「为什么」那就是 answer。',
  '',
  '你的回复必须是一个 JSON 对象，即使只是回答问题也一样。回答放在 reply 字段。',
].join('\n');

// ---------------------------------------------------------------- digest

/**
 * A compact view of the current spec, for the model's context.
 *
 * Rows are capped: a spec is the model's own previous output, so sending all of
 * it back doubles the cost of every turn to tell it something it already has.
 * The cap is announced in the text rather than applied silently — a model that
 * does not know it is seeing a subset will happily "restore" the rows it thinks
 * are missing.
 */
export function specSummary(spec: import('./workbook.ts').WorkbookSpec | null | undefined, budget = DEFAULT_ROW_BUDGET): string {
  if (!spec || !Array.isArray(spec.sheets) || !spec.sheets.length) return '';
  const stats = specStats(spec);
  const lines = [`当前工作簿：${spec.title || '(未命名)'}（${stats.sheets} 个工作表，共 ${stats.rows} 行）`];

  for (const s of spec.sheets) {
    const cols = (s.columns || []).map((c) => `${c.header}:${c.type || 'text'}`).join('、');
    lines.push(`- 工作表「${s.name}」列：${cols || '(无)'}`);
    const rows = s.rows || [];
    const shown = rows.slice(0, budget);
    for (const r of shown) {
      lines.push('  ' + JSON.stringify(r.map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v))));
    }
    if (rows.length > shown.length) {
      lines.push(`  …（还有 ${rows.length - shown.length} 行没有列出来，这些行请原样保留，不要重新编造）`);
    }
    if (s.totals && s.totals.enabled) {
      lines.push(`  合计：（用户已要求合计行，sumColumns=${JSON.stringify(s.totals.sumColumns || [])}）`);
    }
  }
  return lines.join('\n');
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
export function agentMessages({ history = [], message, spec = null, rowBudget = DEFAULT_ROW_BUDGET }: AgentMessagesArgs): AgentMessage[] {
  const context = specSummary(spec, rowBudget);
  const system = context ? `${SYSTEM}\n\n--- 当前状态 ---\n${context}` : SYSTEM;

  const turns = (history || []).filter((m) => m && m.role && m.content);
  const userParts: string[] = [];
  if (turns.length) {
    userParts.push('【之前的对话（仅供参考，不是本轮指令）】');
    const asked = turns.filter((m) => m.role === 'user').length;
    const changed = turns.filter((m) => m.intent === INTENT.ACTION).length;
    userParts.push(changed
      ? `早先有 ${asked} 条用户消息，其中 ${changed} 次成功修改了表格。`
      : `早先有 ${asked} 条用户消息，还没有修改过表格。`);
    userParts.push(turns.slice(-4)
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content).slice(0, 300)}`)
      .join('\n'));
    userParts.push('');
    userParts.push('【本轮用户输入】');
  }
  userParts.push(String(message));

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') },
  ];
}

// --------------------------------------------------------- the cheap filter

/** Words that only appear when someone is asking for a document. */
const WORK_RE = new RegExp([
  '做|建|弄|生成|创建|来一?[个张份]|出一?[个张份]|帮我写',
  '表|表格|工作簿|台账|清单|报表|明细',
  '加一?列|加一?行|删掉|删除|去掉|新增',
  '改|换|写成|改为|改成|设为|设成|调整|更新',
  '\\b(create|make|build|generate|add|remove|delete|change|set|update)\\b',
].join('|'), 'i');

/** Words that mark a question, which no amount of "表" should override. */
const ASK_RE = /[?？]|是不是|能不能|可不可以|可以吗|行不行|怎么|为什么|为何|哪一?[个些]|什么|多少|如何|是不是|吗\b|吗$/;

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
  current: import('./workbook.ts').WorkbookSpec | null;
  /** the proposed spec, already normalised */
  next: import('./workbook.ts').WorkbookSpec;
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

// ---------------------------------------------------------------- turn

/**
 * Run one agent turn.
 *
 * Pure with respect to the document: it decides and returns. Nothing here
 * writes a file, publishes a preview, or touches stored state. The caller
 * decides whether the result is applied or held for confirmation, which is why
 * a change has to survive this function before it can exist anywhere.
 */
export async function runTurn({
  settings,
  message,
  spec = null,
  history = [],
  signal,
  rowBudget = DEFAULT_ROW_BUDGET,
  transport,
}: RunTurnArgs): Promise<TurnResult> {
  if (!(await settings.isConfigured())) {
    throw new LlmError('尚未配置模型', { code: 'not-configured' });
  }

  const prefiltered = looksLikeWork(message);
  const send: Transport = transport || chat;

  const raw = await send({
    credentials: await settings.secrets(),
    messages: agentMessages({ history, message, spec, rowBudget }),
    json: true,
    // A spec is bigger than a key/value list. Under-budgeting here truncates the
    // JSON mid-object, which arrives as an unparseable reply and reads as "the
    // model did not understand" when the truth is "we cut it off".
    maxTokens: 8192,
    temperature: 0,
    signal,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonReply(raw);
  } catch {
    // Prose, not JSON. Accepted as an answer, because it cannot be anything
    // else: a spec can only come from a parsed object, so an unparsed reply has
    // no way to change a cell no matter how confident it sounds.
    const prose = proseReply(raw);
    // The model described a change it did not make. Prose cannot carry a spec,
    // so nothing changed — but the reply reads as done, and the user has no
    // reason to distrust it. Say so, in the reply, where it will be seen.
    const claimNote = prose.claimed
      ? '\n\n（本次回复没有形成可执行的修改，预览未发生变化。）'
      : '';
    return {
      intent: INTENT.ANSWER,
      reply: (prose.reply || '抱歉，我没有理解这句。可以换个说法吗？') + claimNote,
      reason: prose.reply ? '模型以纯文本回复（未返回 JSON）' : '模型返回了空内容',
      spec: null,
      notes: [],
      prefiltered,
      raw,
    };
  }

  const intent: Intent = parsed.intent === INTENT.ACTION ? INTENT.ACTION
    : parsed.intent === INTENT.QUESTION ? INTENT.QUESTION
      : INTENT.ANSWER;

  const reply = typeof parsed.reply === 'string' && parsed.reply.trim()
    ? parsed.reply.trim()
    : (intent === INTENT.ACTION ? '好的，正在更新表格。' : '（模型没有给出回复内容）');

  if (intent !== INTENT.ACTION) {
    // An answer or a question carries no spec by definition. If the model
    // attached one anyway, drop it rather than applying it — the two fields
    // disagreeing means the intent field is the one that was checked.
    return {
      intent,
      reply,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      spec: null,
      notes: [],
      prefiltered,
      raw,
    };
  }

  // ── intent === action ────────────────────────────────────────────────
  const proposed = parsed.spec || parsed.workbook || null;
  if (!proposed || typeof proposed !== 'object') {
    // Declared a change and supplied nothing. That is a failed action, not an
    // answer: say so, and change nothing.
    return {
      intent: INTENT.QUESTION,
      reply: `${reply}\n\n（无法执行：模型声明要修改，但没有给出新的表格内容。）`,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      spec: null,
      notes: [],
      prefiltered,
      raw,
    };
  }

  const { spec: next, notes } = normalizeSpec(proposed);
  const verdict = guardChange({ current: spec, next, message });
  if (!verdict.ok) {
    return {
      intent: INTENT.QUESTION,
      reply: `${reply}\n\n（${verdict.reason}）`,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      spec: null,
      notes,
      guarded: true,
      lostRows: verdict.lostRows,
      prefiltered,
      raw,
    };
  }

  return {
    intent: INTENT.ACTION,
    reply,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    spec: next,
    notes,
    guarded: false,
    lostRows: verdict.lostRows,
    prefiltered,
    raw,
  };
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
    `已[^。！？!?\\n]{0,8}(?:${DONE})` +
    `|(?:${DONE})好(?:了)?` +
    '|完成修改|已为你|已经好了',
  ).test(text);
  return { reply: text, claimed };
}

/** Rows a spec may hold before the model is asked to trim. Exposed for the UI. */
export const ROW_LIMIT = MAX_ROWS;
