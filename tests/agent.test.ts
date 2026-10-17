'use strict';
/**
 * Tests for the agent turn.
 *
 * No network. The model is pi-ai's faux provider, scripted step by step: each
 * step is either plain text or a set of tool calls, and the REAL loop runs
 * around it — the tools, the spec operations, the derived intent, the guard.
 * The parts that decide whether a change is allowed are ordinary code, and
 * ordinary code can be pinned down exactly.
 *
 * What this file guards:
 *   - text alone can never produce a spec, whatever it claims
 *   - a turn's edits that lose rows without being asked to are refused,
 *     judged on the cumulative result
 *   - a refused tool call is reported to the model, which can correct it
 *   - read-only mode offers no edit tools at all
 *   - history is not presented as a conversation to continue
 */

import test from 'node:test';
import assert from 'node:assert';
import { listenLocal } from './helpers/listen.ts';

import {
  runTurn,
  agentMessages,
  specSummary,
  looksLikeWork,
  guardChange,
  proseReply,
  describeChange,
  changesSummary,
  INTENT,
  MAX_STEPS,
} from '../src/agent/agent.ts';
import { loadPi } from '../src/agent/pi.ts';

import { normalizeSpec } from '../src/workbook/workbook.ts';

// ── helpers ─────────────────────────────────────────────────────────

/** A settings object that claims to be configured. */
function fakeSettings() {
  return {
    isConfigured: () => true,
    secrets: () => ({ api: 'openai-completions', baseUrl: 'http://127.0.0.1/v1', apiKey: 'k', model: 'm' }),
  };
}

// pi-ai is ESM-only, so it is reached with import() even from this CommonJS
// file. One faux provider per file; each test replaces its script. It is
// registered in the app's own stream table (src/agent/pi.ts), the way a protocol is.
let pi = null;
async function loadFaux() {
  if (!pi) {
    const ai = await import('@earendil-works/pi-ai');
    const faux = ai.fauxProvider();
    (await loadPi()).apis.set(faux.api, faux.provider);
    pi = { ai, faux };
  }
  return pi;
}

/**
 * A request context as the tests read it. pi 1.x carries the system prompt
 * and the tool declarations as system messages in the transcript; this lifts
 * them back out, and leaves `messages` as the conversation alone.
 */
function view(ai, context) {
  return {
    systemPrompt: ai.getCurrentSystemPrompt(context.messages),
    tools: ai.getCurrentTools(context.messages),
    messages: context.messages.filter((m) => m.role !== 'system'),
  };
}

/**
 * One scripted model response. A string is a final text answer; an object
 * `{ tool, args }` (or an array of them, optionally with `text`) is a turn
 * that calls tools.
 */
function step(ai, s) {
  if (typeof s === 'string') return ai.fauxAssistantMessage(s);
  if (s && s.error) return ai.fauxAssistantMessage([], { stopReason: 'error', errorMessage: s.error });
  const calls = Array.isArray(s) ? s : (s.calls || [s]);
  const content = calls.map((c) => ai.fauxToolCall(c.tool, c.args));
  if (s.text) content.unshift(ai.fauxText(s.text));
  return ai.fauxAssistantMessage(content, { stopReason: 'toolUse' });
}

/**
 * Run one turn against a script. The contexts the model was sent are kept on
 * the result, so a test can inspect the prompt and the tools offered.
 */
async function turnWith(steps, args) {
  const { ai, faux } = await loadFaux();
  const contexts = [];
  faux.setResponses(steps.map((s) => (context) => {
    contexts.push(view(ai, context));
    return step(ai, s);
  }));
  const res = await runTurn({ settings: fakeSettings(), model: faux.getModel(), ...args });
  res.contexts = contexts;
  return res;
}

const SPEC_3_ROWS = {
  title: '销售',
  sheets: [{
    name: '明细',
    columns: [{ header: '客户', type: 'text' }, { header: '金额', type: 'currency' }],
    rows: [['甲', 100], ['乙', 200], ['丙', 300]],
  }],
};

const specWith = (rows) => normalizeSpec({
  ...SPEC_3_ROWS,
  sheets: [{ ...SPEC_3_ROWS.sheets[0], rows }],
}).spec;

const rows10 = () => specWith(Array.from({ length: 10 }, (_, i) => [`客户${i + 1}`, (i + 1) * 100]));


// ── the cheap filter ────────────────────────────────────────────────

test('looksLikeWork: a plain question is not work', () => {
  assert.strictEqual(looksLikeWork('你能做什么'), false);
  assert.strictEqual(looksLikeWork('你是谁'), false);
});

test('looksLikeWork: a request to build is work', () => {
  assert.strictEqual(looksLikeWork('做一个销售表'), true);
  assert.strictEqual(looksLikeWork('帮我生成一个台账'), true);
  assert.strictEqual(looksLikeWork('再加一列税率'), true);
});

test('looksLikeWork: a question ABOUT the table is still a question', () => {
  // The trap this exists for: both markers are present, and it must not be read
  // as an instruction.
  assert.strictEqual(looksLikeWork('这个表怎么加一行？'), false);
  assert.strictEqual(looksLikeWork('表格里的金额为什么算错了？'), false);
  assert.strictEqual(looksLikeWork('你能做表格吗'), false);
});

test('looksLikeWork: empty and whitespace are not work', () => {
  assert.strictEqual(looksLikeWork(''), false);
  assert.strictEqual(looksLikeWork('   '), false);
  assert.strictEqual(looksLikeWork(null), false);
});

// ── the guard ───────────────────────────────────────────────────────

test('guardChange: a fresh start with no current spec is allowed', () => {
  const v = guardChange({ current: null, next: specWith(SPEC_3_ROWS.sheets[0].rows), message: '做一个销售表' });
  assert.strictEqual(v.ok, true);
});

test('guardChange: adding a row is allowed', () => {
  const current = specWith(SPEC_3_ROWS.sheets[0].rows);
  const next = specWith([...SPEC_3_ROWS.sheets[0].rows, ['丁', 400]]);
  assert.strictEqual(guardChange({ current, next, message: '再加一行' }).ok, true);
});

test('guardChange: silently dropping rows is refused', () => {
  // The failure this exists for: "把第一行金额改成500" answered by a tidy
  // one-row sheet. The reply would describe the edit and say nothing about the
  // two rows that vanished.
  const current = specWith(SPEC_3_ROWS.sheets[0].rows);
  const next = specWith([['甲', 500]]);
  const v = guardChange({ current, next, message: '把第一行金额改成500' });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.lostRows, 2);
  assert.match(v.reason, /少 2 行/);
});

test('guardChange: losing rows IS allowed when the user asked', () => {
  const current = specWith(SPEC_3_ROWS.sheets[0].rows);
  const next = specWith([['甲', 100]]);
  const v = guardChange({ current, next, message: '把后面两行删掉' });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.lostRows, 2);
});

test('guardChange: a small edit in a big table is judged by proportion', () => {
  // Small edits must not trip the guard, or every legitimate change gets a
  // confirmation prompt and the check becomes noise the user clicks through.
  const big = (n) => ({
    title: 'T',
    sheets: [{
      name: 'S',
      columns: [{ header: '客户' }, { header: '金额', type: 'currency' }],
      rows: Array.from({ length: n }, (_, i) => [`客户${i}`, i * 100]),
    }],
  });
  const current = normalizeSpec(big(100)).spec;

  // Lost 2 of 100 — under the threshold, ordinary editing.
  assert.strictEqual(
    guardChange({ current, next: normalizeSpec(big(98)).spec, message: '把第一行改一下' }).ok,
    true,
  );

  // Lost 50 of 100 — not editing, and not asked for.
  const carved = guardChange({ current, next: normalizeSpec(big(50)).spec, message: '把第一行改一下' });
  assert.strictEqual(carved.ok, false);
  assert.strictEqual(carved.lostRows, 50);

  // The same loss, but asked for this time.
  assert.strictEqual(
    guardChange({ current, next: normalizeSpec(big(50)).spec, message: '删掉一半的行' }).ok,
    true,
  );
});

test('guardChange: an empty workbook is refused', () => {
  const current = specWith(SPEC_3_ROWS.sheets[0].rows);
  const next = normalizeSpec({ title: 'T', sheets: [] }).spec;
  assert.strictEqual(guardChange({ current, next, message: '改成空表' }).ok, false);
});

// ── the turn: text never carries a spec ──────────────────────────────

test('runTurn: a text answer carries no spec and no operations', async () => {
  const res = await turnWith(['我可以帮你做表格，也能改。'], { message: '你能做什么' });
  assert.strictEqual(res.intent, INTENT.ANSWER);
  assert.strictEqual(res.spec, null, 'an answer must never carry a spec');
  assert.deepStrictEqual(res.ops, []);
  assert.strictEqual(res.reply, '我可以帮你做表格，也能改。');
});

test('runTurn: ask_user is a question, and carries no spec', async () => {
  const res = await turnWith([{ tool: 'ask_user', args: { question: '要改成多少？' } }], {
    message: '金额改高点',
    spec: specWith(SPEC_3_ROWS.sheets[0].rows),
  });
  assert.strictEqual(res.intent, INTENT.QUESTION);
  assert.strictEqual(res.spec, null);
  assert.strictEqual(res.reply, '要改成多少？');
  // ask_user terminates the loop: the model is not called again afterwards.
  assert.strictEqual(res.contexts.length, 1);
});

test('runTurn: prose cannot change anything', async () => {
  // A model that writes "done" without calling a tool has changed nothing,
  // however confident it sounds.
  const res = await turnWith(['好的，已把金额改成40万了。'], {
    message: '把金额改成40万',
    spec: specWith(SPEC_3_ROWS.sheets[0].rows),
  });
  assert.strictEqual(res.intent, INTENT.ANSWER);
  assert.strictEqual(res.spec, null);
  assert.ok(res.reply.includes('40万'), 'the prose is passed through');
  assert.match(res.reply, /没有形成可执行的修改/, 'a false completion claim is flagged in the reply');
});

test('runTurn: an honest prose reply gets no false-alarm warning', async () => {
  const res = await turnWith(['我是一个 Excel 助手，可以帮你做表。'], { message: '你能做什么' });
  assert.strictEqual(res.intent, INTENT.ANSWER);
  assert.ok(!/没有形成可执行的修改/.test(res.reply), res.reply);
});

test('runTurn: an inline reasoning block is not shown as the reply', async () => {
  const res = await turnWith(['<think>用户在问能力</think>我可以帮你做表。'], { message: '你能做什么' });
  assert.strictEqual(res.reply, '我可以帮你做表。');
});

test('proseReply: detects a claim of a change that did not happen', () => {
  assert.strictEqual(proseReply('已把金额改成40万').claimed, true);
  assert.strictEqual(proseReply('表格已经创建好了').claimed, true);
  assert.strictEqual(proseReply('我可以帮你改表格').claimed, false);
});

// ── the turn: edits through tools ────────────────────────────────────

test('runTurn: create_workbook produces a normalised spec', async () => {
  const res = await turnWith([
    {
      tool: 'create_workbook',
      args: {
        title: '销售明细',
        sheets: [{ name: '一月', columns: [{ header: '客户', type: 'text' }, { header: '金额', type: 'currency' }], rows: [['甲', '一百二十五万']] }],
      },
    },
    '已经建好了。',
  ], { message: '做一个销售表，客户甲，金额一百二十五万' });
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.strictEqual(res.reply, '已经建好了。');
  // Normalisation ran: 一百二十五万 became a number rather than text.
  assert.deepStrictEqual(res.spec.sheets[0].rows[0], ['甲', 1250000]);
  assert.deepStrictEqual(res.ops.map((o) => o.op), ['create_workbook']);
});

test('runTurn: update_cells changes one cell and keeps every other row', async () => {
  const res = await turnWith([
    { tool: 'update_cells', args: { cells: [{ row: 2, column: '金额', value: '40万' }] } },
    '已把乙的金额改成 40 万。',
  ], { message: '把乙的金额改成40万', spec: specWith(SPEC_3_ROWS.sheets[0].rows) });
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.deepStrictEqual(res.spec.sheets[0].rows, [['甲', 100], ['乙', 400000], ['丙', 300]]);
  assert.match(res.reason, /修改「明细」1 个单元格/);
});

test('runTurn: a refused tool call goes back to the model, which corrects it', async () => {
  const res = await turnWith([
    { tool: 'update_cells', args: { cells: [{ row: 9, column: '金额', value: 1 }] } },
    { tool: 'update_cells', args: { cells: [{ row: 3, column: '金额', value: 1 }] } },
    '改好了。',
  ], { message: '把丙的金额改成1', spec: specWith(SPEC_3_ROWS.sheets[0].rows) });
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.deepStrictEqual(res.spec.sheets[0].rows[2], ['丙', 1]);
  // Only the call that worked is recorded for replay.
  assert.strictEqual(res.ops.length, 1);
  // The refusal reached the model as a tool result it could read.
  const second = res.contexts[1].messages;
  const refusal = second.find((m) => m.role === 'toolResult');
  assert.strictEqual(refusal.isError, true);
  assert.match(refusal.content[0].text, /行号 9 超出范围/);
});

test('runTurn: with no reply text, the change is described from the specs', async () => {
  const res = await turnWith([
    { tool: 'add_columns', args: { columns: [{ header: '备注', type: 'text' }] } },
    '',
  ], { message: '加一列备注', spec: specWith(SPEC_3_ROWS.sheets[0].rows) });
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.match(res.reply, /新增列：备注/);
});

// ── the turn: the guard ──────────────────────────────────────────────

test('runTurn: edits that lose rows unasked become a question', async () => {
  const res = await turnWith([
    { tool: 'delete_rows', args: { rows: [2, 3] } },
    { tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: 500 }] } },
    '已把第一行的金额改成 500。',
  ], { message: '把第一行的金额改成 500', spec: specWith(SPEC_3_ROWS.sheets[0].rows) });
  assert.strictEqual(res.intent, INTENT.QUESTION);
  assert.strictEqual(res.spec, null, 'the destructive result must not be applied');
  assert.deepStrictEqual(res.ops, [], 'nothing is offered for replay');
  assert.strictEqual(res.guarded, true);
  assert.strictEqual(res.lostRows, 2);
  assert.match(res.reply, /为免误删/);
});

test('runTurn: the guard judges the cumulative result, not each call', async () => {
  // Three one-row deletions are each "ordinary editing" on their own; together
  // they are the loss the guard exists for.
  const res = await turnWith([
    { tool: 'delete_rows', args: { rows: [10] } },
    { tool: 'delete_rows', args: { rows: [9] } },
    { tool: 'delete_rows', args: { rows: [8] } },
    '整理好了。',
  ], { message: '整理一下这个表', spec: rows10() });
  assert.strictEqual(res.intent, INTENT.QUESTION);
  assert.strictEqual(res.guarded, true);
  assert.strictEqual(res.lostRows, 3);
});

test('runTurn: a rebuild that drops rows is refused like any other loss', async () => {
  // The failure mode the guard was written for: "change one number" satisfied
  // by rewriting the table with one row.
  const res = await turnWith([
    {
      tool: 'create_workbook',
      args: { title: '销售', sheets: [{ name: '明细', columns: [{ header: '客户', type: 'text' }, { header: '金额', type: 'currency' }], rows: [['甲', 500]] }] },
    },
    '已把第一行的金额改成 500。',
  ], { message: '把第一行的金额改成 500', spec: specWith(SPEC_3_ROWS.sheets[0].rows) });
  assert.strictEqual(res.intent, INTENT.QUESTION);
  assert.strictEqual(res.guarded, true);
});

test('runTurn: dropping rows passes when the user asked for it', async () => {
  const res = await turnWith([
    { tool: 'delete_rows', args: { rows: [2, 3] } },
    '删掉了。',
  ], { message: '删掉后面两行', spec: specWith(SPEC_3_ROWS.sheets[0].rows) });
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.deepStrictEqual(res.spec.sheets[0].rows, [['甲', 100]]);
});

test('runTurn: notes from normalisation are passed through', async () => {
  const res = await turnWith([
    { tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: '四十几万吧' }] } },
    '好了。',
  ], { message: '把甲的金额改一下', spec: specWith(SPEC_3_ROWS.sheets[0].rows) });
  assert.ok(Array.isArray(res.notes));
  assert.ok(res.notes.some((n) => /不是金额/.test(n.message)), JSON.stringify(res.notes));
  // …and reach the model too, so it can tell the user.
  const result = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.match(result.content[0].text, /注意：/);
});

// ── the turn: modes, limits and failures ─────────────────────────────

test('runTurn: read-only mode offers no edit tools', async () => {
  const res = await turnWith([
    { tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: 1 }] } },
    '当前是只读模式，无法修改。',
  ], { message: '把甲的金额改成1', spec: specWith(SPEC_3_ROWS.sheets[0].rows), canEdit: false });
  const offered = res.contexts[0].tools.map((t) => t.name);
  // Only the read tools: query_table reads, and its saveAs is refused when read-only.
  assert.deepStrictEqual(offered, ['read_rows', 'query_table']);
  assert.match(res.contexts[0].systemPrompt, /只读模式/);
  assert.strictEqual(res.intent, INTENT.ANSWER);
  assert.strictEqual(res.spec, null);
});

test('runTurn: read_rows shows rows beyond the summary, numbered', async () => {
  const res = await turnWith([
    { tool: 'read_rows', args: { from: 9, to: 10 } },
    '第 10 行是客户10。',
  ], { message: '第十行是谁', spec: rows10() });
  const result = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.match(result.content[0].text, /9\. \["客户9",900\]/);
  assert.match(result.content[0].text, /10\. \["客户10",1000\]/);
  assert.strictEqual(res.intent, INTENT.ANSWER);
});

test('runTurn: a model that never stops calling tools is cut off at the step cap', async () => {
  const calls = Array.from({ length: MAX_STEPS + 3 }, () => ({ tool: 'read_rows', args: { from: 1 } }));
  const res = await turnWith(calls, { message: '看看表', spec: rows10() });
  assert.strictEqual(res.contexts.length, MAX_STEPS);
  assert.match(res.reply, /步数达到上限/);
});

test('runTurn: a provider error fails the turn with the provider\'s words', async () => {
  await assert.rejects(
    () => turnWith([{ error: '401 Incorrect API key provided' }], { message: '你好' }),
    (err) => err.status === 401 && /模型服务返回 401：Incorrect API key/.test(err.message),
  );
});

test('runTurn: a provider error after an edit discards the edit', async () => {
  await assert.rejects(
    () => turnWith([
      { tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: 1 }] } },
      { error: '500 upstream exploded' },
    ], { message: '把甲的金额改成1', spec: specWith(SPEC_3_ROWS.sheets[0].rows) }),
    /模型服务返回 500/,
  );
});

test('runTurn: throws when there is no model configured', async () => {
  await assert.rejects(
    () => runTurn({
      settings: { isConfigured: () => false, secrets: () => ({}) },
      message: '做一个表',
    }),
    /尚未配置模型/,
  );
});

test('runTurn: the prompt describes tools, not a JSON envelope or a template', async () => {
  // A regression guard on both refactors: the old chat layer's prompt named
  // 模板/字段/operations, and the single-call design asked for an `intent`
  // JSON envelope. A model told either will answer in a grammar nothing reads.
  const res = await turnWith(['你好'], { message: '你好' });
  const sys = res.contexts[0].systemPrompt;
  assert.strictEqual(/operations/.test(sys), false, 'no operations grammar in the prompt');
  assert.strictEqual(/"intent"/.test(sys), false, 'no JSON intent envelope in the prompt');
  assert.match(sys, /update_cells/);
  const offered = res.contexts[0].tools.map((t) => t.name);
  for (const name of ['create_workbook', 'update_cells', 'add_rows', 'delete_rows', 'ask_user', 'read_rows']) {
    assert.ok(offered.includes(name), `${name} is offered`);
  }
});

test('runTurn: history reaches the model as one user message, not a transcript', async () => {
  const res = await turnWith(['好的'], {
    message: '再加一列',
    history: [{ role: 'user', content: '你能做什么' }, { role: 'assistant', content: '我能做表' }],
  });
  const sent = res.contexts[0].messages;
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].role, 'user');
  assert.match(sent[0].content, /之前的对话/);
  assert.match(sent[0].content, /本轮用户输入】\n再加一列$/);
});

// ── messages and history ─────────────────────────────────────────────

test('agentMessages: history is reference material, not a conversation', () => {
  // The measured failure this prevents: replayed as alternating turns, one prior
  // question was enough to make 0/5 following commands classify as answers.
  const messages = agentMessages({
    message: '再加一列税率',
    history: [
      { role: 'user', content: '你能做什么' },
      { role: 'assistant', content: '我可以帮你做表格。' },
      { role: 'user', content: '能改吗' },
      { role: 'assistant', content: '可以。' },
    ],
  });
  assert.strictEqual(messages.length, 2, 'one system + one user message, never a replay');
  assert.strictEqual(messages[0].role, 'system');
  assert.strictEqual(messages[1].role, 'user');
  assert.match(messages[1].content, /【之前的对话（仅供参考，不是本轮指令）】/);
  assert.match(messages[1].content, /【本轮用户输入】/);
  assert.ok(messages[1].content.trimEnd().endsWith('再加一列税率'));
});

test('agentMessages: history keeps as many recent rounds as the budget allows', () => {
  // The old rule kept the last 4 messages no matter how short they were.
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push({ role: 'user', content: `问题${i}` });
    history.push({ role: 'assistant', content: `回答${i}` });
  }
  const content = agentMessages({ message: 'x', history })[1].content;
  assert.match(content, /用户：问题0\n助手：回答0/);
  assert.match(content, /助手：回答9/);
  assert.doesNotMatch(content, /未列出/);
});

test('agentMessages: older messages beyond the budget are dropped and announced', () => {
  const history = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `第${i}条` + '字'.repeat(40),
  }));
  const content = agentMessages({ message: 'x', history, historyBudget: 100 })[1].content;
  assert.match(content, /第5条/);
  assert.match(content, /第4条/);
  assert.doesNotMatch(content, /第3条/, 'stops at the first message that does not fit');
  assert.match(content, /更早的 4 条消息未列出/);
  assert.match(content, /早先有 3 条用户消息/, 'the count still covers the whole history');
});

test('agentMessages: a long assistant reply is capped, a user message is kept whole', () => {
  const longUser = '要'.repeat(1500);
  const longReply = '答'.repeat(1500);
  const content = agentMessages({
    message: 'x',
    history: [{ role: 'user', content: longUser }, { role: 'assistant', content: longReply }],
  })[1].content;
  assert.ok(content.includes(`用户：${longUser}\n`), 'user message not truncated');
  assert.ok(content.includes(`助手：${'答'.repeat(800)}…（已截断）`));
  assert.ok(!content.includes('答'.repeat(801)));
});

test('agentMessages: the newest message is sent even if it alone exceeds the budget', () => {
  const content = agentMessages({
    message: 'x',
    history: [{ role: 'user', content: '旧' }, { role: 'assistant', content: '新'.repeat(50) }],
    historyBudget: 10,
  })[1].content;
  assert.match(content, /助手：新{50}/);
  assert.doesNotMatch(content, /用户：旧/);
});

test('agentMessages: attachments in history are named, not replayed', () => {
  const content = agentMessages({
    message: 'x',
    history: [{ role: 'user', content: '照着做', attachments: ['a.csv', 'b.xlsx'] }],
  })[1].content;
  assert.match(content, /用户：照着做（附件：a\.csv、b\.xlsx）/);
});

// ── the change log ──────────────────────────────────────────────────

const specOf = (raw) => normalizeSpec(raw).spec;

test('describeChange: a first spec is described as created', () => {
  assert.strictEqual(describeChange(null, specWith(SPEC_3_ROWS.sheets[0].rows)), '新建工作簿「销售」：1 个工作表，共 3 行');
});

test('describeChange: columns, rows and totals are read off the specs', () => {
  const before = specWith(SPEC_3_ROWS.sheets[0].rows);
  const after = specOf({
    title: '销售',
    sheets: [{
      name: '明细',
      columns: [{ header: '客户', type: 'text' }, { header: '金额', type: 'currency' }, { header: '备注', type: 'text' }],
      rows: [['甲', 100, ''], ['乙', 200, ''], ['丙', 300, ''], ['丁', 400, '']],
      totals: { enabled: true, sumColumns: ['金额'] },
    }],
  });
  const d = describeChange(before, after);
  assert.match(d, /新增列：备注/);
  assert.match(d, /行数 3→4/);
  assert.match(d, /加上合计行/);
  assert.doesNotMatch(d, /「明细」/, 'a one-sheet workbook does not name its sheet');
});

test('describeChange: an edited cell is "修改了数据"; an identical spec says nothing changed', () => {
  const before = specWith(SPEC_3_ROWS.sheets[0].rows);
  assert.strictEqual(describeChange(before, specWith([['甲', 100], ['乙', 250], ['丙', 300]])), '修改了数据');
  assert.strictEqual(describeChange(before, specWith(SPEC_3_ROWS.sheets[0].rows)), '内容没有变化');
});

test('describeChange: one sheet out and one in is a rename, compared as one sheet', () => {
  const before = specWith(SPEC_3_ROWS.sheets[0].rows);
  const after = specOf({ ...SPEC_3_ROWS, sheets: [{ ...SPEC_3_ROWS.sheets[0], name: '汇总' }] });
  assert.strictEqual(describeChange(before, after), '工作表「明细」改名为「汇总」');
});

test('changesSummary: lists the tail, oldest first, and says how many were left out', () => {
  const changes = Array.from({ length: 12 }, (_, i) => ({ request: `要求${i}`, summary: `结果${i}` }));
  const s = changesSummary(changes);
  assert.match(s, /共 12 次，列出最近 10 次/);
  assert.doesNotMatch(s, /要求1」/);
  assert.match(s, /1\. 用户：「要求2」 → 结果2/);
  assert.match(s, /10\. 用户：「要求11」 → 结果11/);
  assert.strictEqual(changesSummary([]), '');
});

test('agentMessages: the change log goes into the state section, not the history', () => {
  const messages = agentMessages({
    message: '改回去',
    spec: specWith(SPEC_3_ROWS.sheets[0].rows),
    changes: [{ request: '加一列备注', summary: '新增列：备注' }],
  });
  assert.match(messages[0].content, /--- 当前状态 ---[\s\S]*已做过的修改（共 1 次/);
  assert.match(messages[0].content, /用户：「加一列备注」 → 新增列：备注/);
  assert.strictEqual(messages[1].content, '改回去');
});

test('agentMessages: no history means no preamble', () => {
  const messages = agentMessages({ message: '做一个表', history: [] });
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[1].content, '做一个表');
});

test('agentMessages: the current spec is summarised into the system message', () => {
  const messages = agentMessages({ message: '加一列', spec: specWith(SPEC_3_ROWS.sheets[0].rows) });
  const sys = messages[0].content;
  assert.match(sys, /当前工作簿：销售/);
  assert.match(sys, /客户:text/);
  // Numbered: the numbers are the addresses the edit tools take.
  assert.match(sys, /1\. \["甲",100\]/);
});

test('agentMessages: rows beyond the budget are announced, not hidden', () => {
  // A model that does not know it is seeing a subset will "restore" the rows it
  // believes are missing. Saying so is the whole fix.
  const many = {
    title: 'T',
    sheets: [{
      name: 'S',
      columns: [{ header: '客户' }],
      rows: Array.from({ length: 30 }, (_, i) => [`客户${i}`]),
    }],
  };
  const messages = agentMessages({ message: 'x', spec: normalizeSpec(many).spec, rowBudget: 10 });
  assert.match(messages[0].content, /第 11–30 行没有列出来/);
  assert.match(messages[0].content, /read_rows/);
});

test('specSummary: an empty spec has nothing to say', () => {
  assert.strictEqual(specSummary(null), '');
  assert.strictEqual(specSummary({ sheets: [] }), '');
});

test('specSummary: dates are rendered, not serialised as numbers', () => {
  const { spec } = normalizeSpec({
    title: 'T',
    sheets: [{ name: 'S', columns: [{ header: '日期', type: 'date' }], rows: [['2026-03-01']] }],
  });
  const text = specSummary(spec);
  assert.match(text, /2026-03-01/);
  assert.strictEqual(/\d{5}/.test(text), false, 'no raw serial numbers in the summary');
});

// ── saving and fetching ─────────────────────────────────────────────

import { applyOps } from '../src/workbook/spec-ops.ts';
import http from 'node:http';
import { readAttachment } from '../src/formats/attachments.ts';

function csvServer(body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('connection', 'close');
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.end(body);
    });
    listenLocal(server).then(() => resolve({
      url: `http://127.0.0.1:${server.address().port}/cities.csv`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

test('runTurn: save_file and fetch_url are offered only when switched on', async () => {
  const off = await turnWith(['好'], { message: '你好', spec: specWith([['甲', 1]]) });
  const offNames = off.contexts[0].tools.map((t) => t.name);
  assert.ok(!offNames.includes('save_file') && !offNames.includes('fetch_url'), offNames.join());
  assert.doesNotMatch(off.contexts[0].systemPrompt, /save_file|fetch_url/);

  const on = await turnWith(['好'], { message: '你好', spec: specWith([['甲', 1]]), canSave: true, canFetch: true });
  const onNames = on.contexts[0].tools.map((t) => t.name);
  assert.ok(onNames.includes('save_file') && onNames.includes('fetch_url'), onNames.join());
  assert.match(on.contexts[0].systemPrompt, /save_file/);
  assert.match(on.contexts[0].systemPrompt, /fetch_url/);
});

test('runTurn: save_file records a request and writes nothing; the turn stays an answer', async () => {
  const res = await turnWith([
    { tool: 'save_file', args: { format: 'csv', filename: '../../x/报表' } },
    '已保存。',
  ], { message: '把表保存成 csv', spec: specWith([['甲', 1]]), canSave: true });
  assert.strictEqual(res.intent, INTENT.ANSWER);
  assert.deepStrictEqual(res.exports, [{ format: 'csv', sheet: null, filename: '报表' }]);
  assert.strictEqual(res.ops.length, 0);
});

test('runTurn: save_file refuses an unknown sheet, and the model can correct it', async () => {
  const res = await turnWith([
    { tool: 'save_file', args: { format: 'csv', sheet: '不存在' } },
    { tool: 'save_file', args: { format: 'csv', sheet: '明细' } },
    '好了',
  ], { message: '保存', spec: specWith([['甲', 1]]), canSave: true });
  const refusal = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.strictEqual(refusal.isError, true);
  assert.match(refusal.content[0].text, /没有名为「不存在」/);
  assert.deepStrictEqual(res.exports, [{ format: 'csv', sheet: '明细', filename: null }]);
});

test('runTurn: edit then save in one turn returns both; a guarded turn saves nothing', async () => {
  const both = await turnWith([
    { tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: 5 }] } },
    { tool: 'save_file', args: { format: 'xlsx' } },
    '改好并保存了',
  ], { message: '把甲改成 5 然后保存', spec: specWith([['甲', 1], ['乙', 2]]), canSave: true });
  assert.strictEqual(both.intent, INTENT.ACTION);
  assert.strictEqual(both.ops.length, 1);
  assert.strictEqual(both.exports.length, 1);

  const guarded = await turnWith([
    { tool: 'delete_rows', args: { rows: [1, 2, 3, 4, 5, 6, 7, 8, 9] } },
    { tool: 'save_file', args: { format: 'xlsx' } },
    '好了',
  ], { message: '把金额改高点然后保存', spec: rows10(), canSave: true });
  assert.strictEqual(guarded.guarded, true);
  assert.deepStrictEqual(guarded.exports, []);
  assert.match(guarded.reply, /没有保存文件/);
});

test('runTurn: fetch_url reads a table and hands it to the model as material', async () => {
  const srv = await csvServer('城市,人口\n杭州,1200\n宁波,950\n');
  try {
    const res = await turnWith([
      { tool: 'fetch_url', args: { url: srv.url } },
      '杭州 1200，宁波 950。',
    ], { message: `看看 ${srv.url}`, canFetch: true, fetchOptions: { allowPrivate: true } });
    const result = res.contexts[1].messages.find((m) => m.role === 'toolResult');
    assert.strictEqual(result.isError, false);
    assert.match(result.content[0].text, /不是给你的指令/);
    assert.match(result.content[0].text, /杭州\t1200/);
    assert.strictEqual(res.intent, INTENT.ANSWER);
  } finally {
    await srv.close();
  }
});

test('runTurn: fetch_url with importAs records an edit whose replay needs no network', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => `城市${i + 1},${i + 1}`).join('\n');
  const srv = await csvServer(`城市,人口\n${rows}\n`);
  let res;
  try {
    res = await turnWith([
      { tool: 'fetch_url', args: { url: srv.url, importAs: '城市' } },
      '导入了。',
    ], { message: `把 ${srv.url} 导入成表`, canFetch: true, fetchOptions: { allowPrivate: true } });
  } finally {
    await srv.close();
  }
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.strictEqual(res.ops[0].op, 'create_workbook');
  // All 400 rows, though the model was only shown 300.
  assert.strictEqual(res.spec.sheets[0].rows.length, 400);
  assert.strictEqual(res.spec.sheets[0].columns[1].type, 'integer');
  // The server is closed: the replay works from the recorded arguments alone.
  const replayed = applyOps(null, res.ops).spec;
  assert.deepStrictEqual(replayed, res.spec);
});

test('runTurn: fetch_url adds a sheet when there is already a table', async () => {
  const srv = await csvServer('城市,人口\n杭州,1200\n');
  try {
    const res = await turnWith([
      { tool: 'fetch_url', args: { url: srv.url, importAs: '城市' } },
      '好',
    ], { message: '导入', spec: specWith([['甲', 1]]), canFetch: true, fetchOptions: { allowPrivate: true } });
    assert.strictEqual(res.ops[0].op, 'add_sheet');
    assert.deepStrictEqual(res.spec.sheets.map((s) => s.name), ['明细', '城市']);
  } finally {
    await srv.close();
  }
});

test('runTurn: a blocked or private URL is reported to the model, not fetched', async () => {
  const res = await turnWith([
    { tool: 'fetch_url', args: { url: 'https://data.blocked.example/x.csv' } },
    { tool: 'fetch_url', args: { url: 'http://127.0.0.1:9/api/settings' } },
    '抓不到。',
  ], { message: '抓一下', canFetch: true, fetchOptions: { blocklist: ['blocked.example'] } });
  const results = res.contexts[2].messages.filter((m) => m.role === 'toolResult');
  assert.strictEqual(results.length, 2);
  assert.ok(results.every((r) => r.isError));
  assert.match(results[0].content[0].text, /禁止抓取/);
  assert.match(results[1].content[0].text, /内网/);
});

test('runTurn: read-only mode may fetch and save, but not import', async () => {
  const res = await turnWith([
    { tool: 'fetch_url', args: { url: 'https://example.com/a.csv', importAs: 'X' } },
    '只读模式不能导入。',
  ], { message: '导入', spec: specWith([['甲', 1]]), canEdit: false, canFetch: true, canSave: true });
  const offered = res.contexts[0].tools.map((t) => t.name);
  assert.ok(offered.includes('fetch_url') && offered.includes('save_file'));
  assert.ok(!offered.includes('update_cells'));
  const result = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /只读模式/);
  assert.strictEqual(res.ops.length, 0);
});

test('runTurn: with fetching or saving off, the model is told where the switch is', async () => {
  const res = await turnWith(['好'], { message: '下载 https://x.example/a.m3u', spec: specWith([['甲', 1]]) });
  const prompt = res.contexts[0].systemPrompt;
  assert.match(prompt, /「允许对话联网抓取」已关闭/);
  assert.match(prompt, /「允许对话保存文件」已关闭/);
  assert.match(prompt, /「允许读写本机文件」已关闭/);
  const on = await turnWith(['好'], { message: '下载', spec: specWith([['甲', 1]]), canSave: true, canFetch: true, fileAccess: 'read' });
  assert.doesNotMatch(on.contexts[0].systemPrompt, /已关闭/);
});

test('runTurn: file tools follow the access setting, and save_file gains dir only with write', async () => {
  const names = async (fileAccess) => {
    const r = await turnWith(['好'], { message: '你好', canSave: true, fileAccess });
    const tools = r.contexts[0].tools;
    const save = tools.find((t) => t.name === 'save_file');
    return { names: tools.map((t) => t.name), dir: Boolean(save.parameters.properties.dir), prompt: r.contexts[0].systemPrompt };
  };
  const shellTool = process.platform === 'win32' ? 'powershell' : 'bash';
  const readTools = ['read', 'ls', 'find', 'grep', 'import_file'];
  const writeTools = ['write', 'edit', shellTool];
  const off = await names('off');
  assert.ok(!off.names.some((n) => [...readTools, ...writeTools].includes(n)), off.names.join());
  assert.strictEqual(off.dir, false);
  const read = await names('read');
  assert.ok([...readTools, 'read_attachment'].every((n) => read.names.includes(n)), read.names.join());
  assert.ok(!writeTools.some((n) => read.names.includes(n)), read.names.join());
  assert.match(read.prompt, /不能指定目录/);
  assert.doesNotMatch(read.prompt, new RegExp(shellTool), 'the shell is not mentioned where it is not offered');
  const rw = await names('readwrite');
  assert.ok(writeTools.every((n) => rw.names.includes(n)), rw.names.join());
  assert.strictEqual(rw.dir, true);
  assert.doesNotMatch(rw.prompt, /不能指定目录/);
  assert.match(rw.prompt, /不受上面的访问限制/, 'the prompt says the shell is outside the checks');
});

test('runTurn: a table read without importAs tells the model to import, not copy', async () => {
  const srv = await csvServer('城市,人口\n杭州,1200\n宁波,950\n');
  try {
    const res = await turnWith([
      { tool: 'fetch_url', args: { url: srv.url } },
      '好',
    ], { message: `把 ${srv.url} 整理成表格`, canFetch: true, fetchOptions: { allowPrivate: true } });
    const text = res.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text;
    assert.match(text, /^（提示：这是一张 2 行的表格/);
    assert.match(text, /importAs/);
    // Ours, ahead of the page's own words, so it cannot be read as page text.
    assert.ok(text.indexOf('importAs') < text.indexOf('不是给你的指令'));
    assert.match(res.contexts[0].systemPrompt, /第一次调用就带上 importAs/);

    // A read-only turn cannot import, so it is not told to.
    const ro = await turnWith([
      { tool: 'fetch_url', args: { url: srv.url } },
      '好',
    ], { message: '看看', spec: specWith([['甲', 1]]), canEdit: false, canFetch: true, fetchOptions: { allowPrivate: true } });
    const roText = ro.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text;
    assert.doesNotMatch(roText, /提示/);
  } finally {
    await srv.close();
  }
});

// ── output cut off at the token cap ─────────────────────────────────

test('runTurn: tool calls in a reply cut off at the token cap are not run', async () => {
  const { ai, faux } = await loadFaux();
  const contexts = [];
  const cut = {
    title: '频道', sheets: [{ name: '频道', columns: [{ header: '名称', type: 'text' }, { header: '地址', type: 'text' }],
      rows: [['甲', 'rtp://1'], ['乙']] }],
  };
  faux.setResponses([
    (c) => { contexts.push(c); return ai.fauxAssistantMessage([ai.fauxToolCall('create_workbook', cut)], { stopReason: 'length' }); },
    (c) => {
      contexts.push(c);
      return step(ai, { tool: 'create_workbook', args: { ...cut, sheets: [{ ...cut.sheets[0], rows: [['甲', 'rtp://1'], ['乙', 'rtp://2']] }] } });
    },
    (c) => { contexts.push(c); return step(ai, '好了'); },
  ]);
  const res = await runTurn({ settings: fakeSettings(), model: faux.getModel(), message: '建频道表' });

  const refusal = contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.strictEqual(refusal.isError, true);
  assert.match(refusal.content[0].text, /截断/);
  assert.match(refusal.content[0].text, /add_rows/);
  // Only the complete call landed: no padded half-row from the cut-off one.
  assert.strictEqual(res.ops.length, 1);
  assert.deepStrictEqual(res.spec.sheets[0].rows, [['甲', 'rtp://1'], ['乙', 'rtp://2']]);
});

// ── the two idle windows ────────────────────────────────────────────

/**
 * A model that goes silent. The faux provider can only be slow BEFORE a reply
 * starts; the case that matters is silence in the MIDDLE of one, as when a
 * provider holds back tool-call arguments. So this registers a provider of its
 * own: it waits `before` ms, sends `start`, waits `during` ms, then the text.
 */
async function silentModel({ before = 0, during = 0 }) {
  const { ai, faux } = await loadFaux();
  const api = `silent-${before}-${during}-${Math.random().toString(36).slice(2)}`;
  const wait = (ms, signal) => new Promise((resolve) => {
    if (!ms) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  const stream = (model, _context, options) => {
    const out = ai.createAssistantMessageEventStream();
    const base = { ...ai.fauxAssistantMessage('好'), api: model.api, provider: model.provider, model: model.id };
    const partial = { ...base, content: [] };
    const aborted = () => {
      const msg = { ...partial, stopReason: 'aborted', errorMessage: 'aborted' };
      out.push({ type: 'error', reason: 'aborted', error: msg });
      out.end(msg);
    };
    (async () => {
      await wait(before, options?.signal);
      if (options?.signal?.aborted) return aborted();
      out.push({ type: 'start', partial });
      await wait(during, options?.signal);
      if (options?.signal?.aborted) return aborted();
      out.push({ type: 'text_start', contentIndex: 0, partial });
      out.push({ type: 'text_delta', contentIndex: 0, delta: '好', partial });
      out.push({ type: 'text_end', contentIndex: 0, content: '好', partial: base });
      out.push({ type: 'done', reason: 'stop', message: base });
      out.end(base);
    })();
    return out;
  };
  (await loadPi()).apis.set(api, { stream, streamSimple: stream });
  return { ...faux.getModel(), api };
}

test('runTurn: silence inside a streaming reply gets the longer window', async () => {
  const model = await silentModel({ during: 300 });
  const res = await runTurn({ settings: fakeSettings(), model, message: '你好', idleTimeoutMs: 100, streamIdleTimeoutMs: 2000 });
  assert.strictEqual(res.reply, '好');
});

test('runTurn: the longer window still ends a reply that stays silent', async () => {
  const model = await silentModel({ during: 1000 });
  await assert.rejects(
    () => runTurn({ settings: fakeSettings(), model, message: '你好', idleTimeoutMs: 100, streamIdleTimeoutMs: 250 }),
    (err) => err.code === 'aborted' && /没有任何输出/.test(err.message),
  );
});

test('runTurn: silence before a reply starts gets only the short window', async () => {
  const model = await silentModel({ before: 400 });
  await assert.rejects(
    () => runTurn({ settings: fakeSettings(), model, message: '你好', idleTimeoutMs: 100, streamIdleTimeoutMs: 5000 }),
    (err) => err.code === 'aborted' && /没有任何输出/.test(err.message),
  );
});

// ── read_attachment ─────────────────────────────────────────────────

/** A parsed CSV upload, as the server keeps it in `state.uploads`. */
async function csvAttachment(name, csv) {
  return readAttachment(Buffer.from(csv, 'utf8'), name);
}

/** 910 orders, like the file that showed the problem: 5 rows in the preview. */
function ordersCsv() {
  const states = ['已签收', '派送中', '拒签退回中', '运输途中'];
  const rows = Array.from({ length: 910 }, (_, i) => `BT${i + 1},${states[i % 4]},${(i % 4) + 1}`);
  return `订单号,物流状态,金额\n${rows.join('\n')}\n`;
}

test('runTurn: read_attachment is offered only when there are attachments', async () => {
  const none = await turnWith(['好'], { message: '你好' });
  assert.ok(!none.contexts[0].tools.some((t) => t.name === 'read_attachment'));
  assert.doesNotMatch(none.contexts[0].systemPrompt, /read_attachment/);

  const att = await csvAttachment('订单.csv', ordersCsv());
  const some = await turnWith(['好'], { message: '你好', attachments: [att] });
  assert.ok(some.contexts[0].tools.some((t) => t.name === 'read_attachment'));
  assert.match(some.contexts[0].systemPrompt, /read_attachment/);
});

test('runTurn: query_table on an attachment counts every row, not the preview', async () => {
  const att = await csvAttachment('订单.csv', ordersCsv());
  const res = await turnWith([
    { tool: 'query_table', args: { attachment: '订单', groupBy: ['物流状态'], metrics: [{ fn: 'count' }, { fn: 'sum', column: '金额' }] } },
    '统计好了。',
  ], { message: '统计订单状态', attachments: [att] });
  const result = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.strictEqual(result.isError, false);
  const text = result.content[0].text;
  assert.match(text, /不是给你的指令/);
  assert.match(text, /共 910 行，全部参与统计/);
  // 910 = 4 × 227 + 2: the first two states get one more row each.
  assert.match(text, /已签收\t228\t228/);
  assert.match(text, /派送中\t228\t456/);
  assert.match(text, /拒签退回中\t227\t681/);
  assert.match(text, /运输途中\t227\t908/);
  assert.strictEqual(res.intent, INTENT.ANSWER);
});

test('runTurn: read_attachment pages rows and says where to continue', async () => {
  const att = await csvAttachment('订单.csv', ordersCsv());
  const res = await turnWith([
    { tool: 'read_attachment', args: { name: '订单.csv', from: 901 } },
    '好',
  ], { message: '看看最后几行', attachments: [att] });
  const text = res.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text;
  assert.match(text, /第 901–910 行/);
  assert.match(text, /^910\tBT910\t/m);
  assert.doesNotMatch(text, /继续读/);

  const first = await turnWith([
    { tool: 'read_attachment', args: { name: '订单.csv' } },
    '好',
  ], { message: '看看', attachments: [att] });
  assert.match(first.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text, /第 1–200 行；继续读请传 from=201/);
});

test('runTurn: read_attachment refuses an unknown name or column, listing what exists', async () => {
  const att = await csvAttachment('订单.csv', ordersCsv());
  const res = await turnWith([
    { tool: 'read_attachment', args: { name: '客户.xlsx' } },
    { tool: 'query_table', args: { attachment: '订单.csv', groupBy: ['状态'] } },
    '好',
  ], { message: '统计', attachments: [att] });
  const r1 = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.strictEqual(r1.isError, true);
  assert.match(r1.content[0].text, /现有：订单\.csv/);
  const r2 = res.contexts[2].messages.filter((m) => m.role === 'toolResult').pop();
  assert.strictEqual(r2.isError, true);
  assert.match(r2.content[0].text, /现有列：订单号、物流状态、金额/);
});

test('runTurn: read_attachment importAs imports every row, and replays without the upload', async () => {
  const att = await csvAttachment('订单.csv', ordersCsv());
  const res = await turnWith([
    { tool: 'read_attachment', args: { name: '订单.csv', importAs: '订单' } },
    '导入了。',
  ], { message: '把附件做成表', attachments: [att] });
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.strictEqual(res.ops[0].op, 'create_workbook');
  assert.strictEqual(res.spec.sheets[0].rows.length, 910);
  assert.deepStrictEqual(applyOps(null, res.ops).spec, res.spec);
});

test('runTurn: read_attachment reads a long text attachment page by page', async () => {
  const att = await csvAttachment('说明.txt', 'a'.repeat(25_000));
  const res = await turnWith([
    { tool: 'read_attachment', args: { name: '说明.txt', from: 20000 } },
    '好',
  ], { message: '读一下', attachments: [att], canEdit: false });
  const text = res.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text;
  assert.match(text, /共 25000 字，已读到结尾/);
});

// ── query_table and the condition tools ─────────────────────────────

test('runTurn: query_table lists matching workbook rows by number, and saveAs makes a sheet', async () => {
  const spec = specWith([['甲', 100], ['乙', 200], ['甲', 50]]);
  const res = await turnWith([
    { tool: 'query_table', args: { where: [{ column: '客户', op: '=', value: '甲' }] } },
    { tool: 'query_table', args: { groupBy: ['客户'], metrics: [{ fn: 'sum', column: '金额' }], saveAs: '汇总' } },
    '做好了。',
  ], { message: '按客户汇总成一张表', spec });
  const first = res.contexts[1].messages.find((m) => m.role === 'toolResult').content[0].text;
  assert.match(first, /符合条件的 2 行/);
  assert.match(first, /^1\t甲\t100$/m);
  assert.match(first, /^3\t甲\t50$/m);
  assert.strictEqual(res.intent, INTENT.ACTION);
  const sheet = res.spec.sheets.find((s) => s.name === '汇总');
  assert.deepStrictEqual(sheet.rows, [['乙', 200], ['甲', 150]]);
  assert.deepStrictEqual(applyOps(spec, res.ops).spec, res.spec);
});

test('runTurn: query_table saveAs is refused in read-only mode', async () => {
  const res = await turnWith([
    { tool: 'query_table', args: { groupBy: ['客户'], saveAs: '汇总' } },
    '只读模式下不能建表。',
  ], { message: '汇总', spec: specWith([['甲', 1]]), canEdit: false });
  const r = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /只读模式/);
});

test('runTurn: delete_rows with where removes the matching rows, and the guard sees the request', async () => {
  const res = await turnWith([
    { tool: 'delete_rows', args: { where: [{ column: '金额', op: '<', value: 500 }] } },
    '删掉了。',
  ], { message: '删除金额小于 500 的行', spec: rows10() });
  // Four of ten rows is a material loss; it lands because the message asks for it.
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.strictEqual(res.spec.sheets[0].rows.length, 6);
  assert.ok(res.spec.sheets[0].rows.every((r) => r[1] >= 500));
});
