'use strict';
/**
 * Tests for the agent turn: how text, tools and failures become a result.
 *
 * What this file guards:
 *   - text alone can never produce a spec, whatever it claims
 *   - a refused tool call is reported to the model, which can correct it
 *   - read-only mode offers no edit tools at all
 *   - limits hold: the step cap, the token cap, the two idle windows
 *   - a provider failure fails the turn and discards its edits
 */

import test from 'node:test';
import assert from 'node:assert';
import { runTurn, proseReply, INTENT, MAX_STEPS } from '../../src/agent/agent.ts';
import { loadPi } from '../../src/agent/pi.ts';
import type { Credentials } from '../../src/agent/llm.ts';

import { fakeSettings, loadFaux, step, turnWith, SPEC_3_ROWS, specWith, rows10 } from '../helpers/agent-turn.ts';

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
  const res = await turnWith(
    [
      {
        tool: 'create_workbook',
        args: {
          title: '销售明细',
          sheets: [
            {
              name: '一月',
              columns: [
                { header: '客户', type: 'text' },
                { header: '金额', type: 'currency' },
              ],
              rows: [['甲', '一百二十五万']],
            },
          ],
        },
      },
      '已经建好了。',
    ],
    { message: '做一个销售表，客户甲，金额一百二十五万' },
  );
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.strictEqual(res.reply, '已经建好了。');
  // Normalisation ran: 一百二十五万 became a number rather than text.
  assert.deepStrictEqual(res.spec!.sheets[0].rows[0], ['甲', 1250000]);
  assert.deepStrictEqual(
    res.ops.map((o) => o.op),
    ['create_workbook'],
  );
});

test('runTurn: update_cells changes one cell and keeps every other row', async () => {
  const res = await turnWith(
    [
      { tool: 'update_cells', args: { cells: [{ row: 2, column: '金额', value: '40万' }] } },
      '已把乙的金额改成 40 万。',
    ],
    { message: '把乙的金额改成40万', spec: specWith(SPEC_3_ROWS.sheets[0].rows) },
  );
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.deepStrictEqual(res.spec!.sheets[0].rows, [
    ['甲', 100],
    ['乙', 400000],
    ['丙', 300],
  ]);
  assert.match(res.reason, /修改「明细」1 个单元格/);
});

test('runTurn: a refused tool call goes back to the model, which corrects it', async () => {
  const res = await turnWith(
    [
      { tool: 'update_cells', args: { cells: [{ row: 9, column: '金额', value: 1 }] } },
      { tool: 'update_cells', args: { cells: [{ row: 3, column: '金额', value: 1 }] } },
      '改好了。',
    ],
    { message: '把丙的金额改成1', spec: specWith(SPEC_3_ROWS.sheets[0].rows) },
  );
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.deepStrictEqual(res.spec!.sheets[0].rows[2], ['丙', 1]);
  // Only the call that worked is recorded for replay.
  assert.strictEqual(res.ops.length, 1);
  // The refusal reached the model as a tool result it could read.
  const second = res.contexts[1].messages;
  const refusal = second.find((m) => m.role === 'toolResult');
  assert.strictEqual(refusal.isError, true);
  assert.match(refusal.content[0].text, /行号 9 超出范围/);
});

test('runTurn: with no reply text, the change is described from the specs', async () => {
  const res = await turnWith([{ tool: 'add_columns', args: { columns: [{ header: '备注', type: 'text' }] } }, ''], {
    message: '加一列备注',
    spec: specWith(SPEC_3_ROWS.sheets[0].rows),
  });
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.match(res.reply, /新增列：备注/);
});

// ── the turn: modes, limits and failures ─────────────────────────────

test('runTurn: read-only mode offers no edit tools', async () => {
  const res = await turnWith(
    [{ tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: 1 }] } }, '当前是只读模式，无法修改。'],
    { message: '把甲的金额改成1', spec: specWith(SPEC_3_ROWS.sheets[0].rows), canEdit: false },
  );
  const offered = res.contexts[0].tools.map((t) => t.name);
  // Only the read tools: query_table reads, and its saveAs is refused when read-only.
  assert.deepStrictEqual(offered, ['read_rows', 'query_table']);
  assert.match(res.contexts[0].systemPrompt, /只读模式/);
  assert.strictEqual(res.intent, INTENT.ANSWER);
  assert.strictEqual(res.spec, null);
});

test('runTurn: read_rows shows rows beyond the summary, numbered', async () => {
  const res = await turnWith([{ tool: 'read_rows', args: { from: 9, to: 10 } }, '第 10 行是客户10。'], {
    message: '第十行是谁',
    spec: rows10(),
  });
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

test('runTurn: the step-cap note says what landed and how to go on, not the cut-off lead-in', async () => {
  const calls = Array.from({ length: MAX_STEPS }, (_, i) => ({
    text: '接下来改金额：',
    calls: [{ tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: i + 1 }] } }],
  }));
  const res = await turnWith(calls, { message: '把甲的金额一步步改', spec: rows10() });
  assert.strictEqual(res.intent, INTENT.ACTION, 'the edits that landed are kept');
  assert.match(res.reply, new RegExp(`步数达到上限（${MAX_STEPS} 步）`));
  assert.match(res.reply, /已完成：（前面还有 \d+ 步）/);
  assert.match(res.reply, /回复「继续」可以接着做/);
  assert.doesNotMatch(res.reply, /接下来改金额/);
});

// ── a step that ends in thought alone ────────────────────────────────

const edit = (row, value) => ({ tool: 'update_cells', args: { cells: [{ row, column: '金额', value }] } });

test('runTurn: a step that ends in thought alone is nudged to carry on, inside the turn', async () => {
  const res = await turnWith([edit(1, 11), '<think>接下来把第二行也改掉。</think>', edit(2, 22), '两行都改好了。'], {
    message: '把前两行的金额改成 11 和 22',
    spec: rows10(),
  });
  assert.strictEqual(res.contexts.length, 4);
  const nudge = res.contexts[2].messages.at(-1);
  assert.strictEqual(nudge.role, 'user');
  assert.match(String(nudge.content), /只有思考，没有调用工具/);
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.deepStrictEqual(
    res.spec!.sheets[0].rows.slice(0, 2).map((r) => r[1]),
    [11, 22],
  );
  assert.strictEqual(res.reply, '两行都改好了。');
  assert.match(res.raw, /^user: （系统提示）你上一条回复只有思考/m, 'the nudge is in the transcript');
});

test('runTurn: the nudge is bounded, and the edits made before it are kept', async () => {
  const think = '<think>还有一步……</think>';
  const res = await turnWith([edit(1, 11), think, think, think, '多余的'], {
    message: '把第一行的金额改成 11',
    spec: rows10(),
  });
  assert.strictEqual(res.contexts.length, 4, 'one step, then two nudges, then it stops');
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.strictEqual(res.spec!.sheets[0].rows[0][1], 11);
});

test('runTurn: reasoning cut off at the output cap is nudged to act, even before any tool ran', async () => {
  // 8 of 12 MiniMax runs: 20–28 thousand characters of planning, then the cap.
  const cut = { text: '<think>先分析一下……然后', stopReason: 'length' };
  const res = await turnWith([cut, edit(1, 11), '改好了。'], { message: '把第一行的金额改成 11', spec: rows10() });
  assert.strictEqual(res.contexts.length, 3, 'nudged, not restarted');
  assert.match(String(res.contexts[1].messages.at(-1).content), /思考阶段就用完了输出长度.*不要再从头分析/);
  assert.strictEqual(res.spec!.sheets[0].rows[0][1], 11);
  assert.strictEqual(res.reply, '改好了。');
});

test('runTurn: thought alone before any tool ran is not nudged; that is an empty reply, retried', async () => {
  const res = await turnWith(['<think>嗯</think>', '我能帮你做表格。'], { message: '你能做什么' });
  assert.strictEqual(res.contexts.length, 2);
  assert.ok(
    res.contexts[1].messages.every((m) => !/只有思考/.test(String(m.content))),
    'the retry starts over; it is not a nudge',
  );
  assert.strictEqual(res.reply, '我能帮你做表格。');
});

test('runTurn: an empty reply is asked again once, and the second answer is the turn', async () => {
  const res = await turnWith(['', '我能帮你做表格。'], { message: '你能做什么' });
  assert.strictEqual(res.contexts.length, 2);
  assert.strictEqual(res.reply, '我能帮你做表格。');
});

test('runTurn: empty twice says the model was silent, not that the user was unclear', async () => {
  const res = await turnWith(['', ''], { message: '你能做什么' });
  assert.strictEqual(res.contexts.length, 2, 'retried once, not more');
  assert.match(res.reply, /模型这次没有给出任何回复（已自动重试一次）/);
  assert.doesNotMatch(res.reply, /没有理解/);
});

test('runTurn: a reply that did something is not retried, words or not', async () => {
  const res = await turnWith([{ tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: 5 }] } }, ''], {
    message: '把甲的金额改成 5',
    spec: rows10(),
  });
  assert.strictEqual(res.contexts.length, 2);
  assert.strictEqual(res.intent, INTENT.ACTION);
});

test("runTurn: a provider error fails the turn with the provider's words", async () => {
  await assert.rejects(
    () => turnWith([{ error: '401 Incorrect API key provided' }], { message: '你好' }),
    (err: any) => err.status === 401 && /模型服务返回 401：Incorrect API key/.test(err.message),
  );
});

test('runTurn: a provider error after an edit discards the edit', async () => {
  await assert.rejects(
    () =>
      turnWith(
        [
          { tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: 1 }] } },
          { error: '500 upstream exploded' },
        ],
        { message: '把甲的金额改成1', spec: specWith(SPEC_3_ROWS.sheets[0].rows) },
      ),
    /模型服务返回 500/,
  );
});

test('runTurn: throws when there is no model configured', async () => {
  await assert.rejects(
    () =>
      runTurn({
        // secrets() is never reached: the turn stops at isConfigured().
        settings: { isConfigured: async () => false, secrets: async () => ({}) as Credentials },
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
    history: [
      { role: 'user', content: '你能做什么' },
      { role: 'assistant', content: '我能做表' },
    ],
  });
  const sent = res.contexts[0].messages;
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].role, 'user');
  assert.match(sent[0].content, /之前的对话/);
  assert.match(sent[0].content, /本轮用户输入】\n再加一列$/);
});

// ── output cut off at the token cap ─────────────────────────────────

test('runTurn: tool calls in a reply cut off at the token cap are not run', async () => {
  const { ai, faux } = await loadFaux();
  const contexts: any[] = [];
  const cut = {
    title: '频道',
    sheets: [
      {
        name: '频道',
        columns: [
          { header: '名称', type: 'text' },
          { header: '地址', type: 'text' },
        ],
        rows: [['甲', 'rtp://1'], ['乙']],
      },
    ],
  };
  faux.setResponses([
    (c) => {
      contexts.push(c);
      return ai.fauxAssistantMessage([ai.fauxToolCall('create_workbook', cut)], { stopReason: 'length' });
    },
    (c) => {
      contexts.push(c);
      return step(ai, {
        tool: 'create_workbook',
        args: {
          ...cut,
          sheets: [
            {
              ...cut.sheets[0],
              rows: [
                ['甲', 'rtp://1'],
                ['乙', 'rtp://2'],
              ],
            },
          ],
        },
      });
    },
    (c) => {
      contexts.push(c);
      return step(ai, '好了');
    },
  ]);
  const res = await runTurn({ settings: fakeSettings(), model: faux.getModel(), message: '建频道表' });

  const refusal = contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.strictEqual(refusal.isError, true);
  assert.match(refusal.content[0].text, /截断/);
  assert.match(refusal.content[0].text, /add_rows/);
  // Only the complete call landed: no padded half-row from the cut-off one.
  assert.strictEqual(res.ops.length, 1);
  assert.deepStrictEqual(res.spec!.sheets[0].rows, [
    ['甲', 'rtp://1'],
    ['乙', 'rtp://2'],
  ]);
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
  const wait = (ms, signal) =>
    new Promise<void>((resolve) => {
      if (!ms) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  const stream = (model, _context, options) => {
    const out = ai.createAssistantMessageEventStream();
    const base = { ...ai.fauxAssistantMessage('好'), api: model.api, provider: model.provider, model: model.id };
    const partial = { ...base, content: [] };
    const aborted = () => {
      const msg = { ...partial, stopReason: 'aborted' as const, errorMessage: 'aborted' };
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
  const res = await runTurn({
    settings: fakeSettings(),
    model,
    message: '你好',
    idleTimeoutMs: 100,
    streamIdleTimeoutMs: 2000,
  });
  assert.strictEqual(res.reply, '好');
});

test('runTurn: the longer window still ends a reply that stays silent', async () => {
  const model = await silentModel({ during: 1000 });
  await assert.rejects(
    () => runTurn({ settings: fakeSettings(), model, message: '你好', idleTimeoutMs: 100, streamIdleTimeoutMs: 250 }),
    (err: any) => err.code === 'aborted' && /没有任何输出/.test(err.message),
  );
});

test('runTurn: silence before a reply starts gets only the short window', async () => {
  const model = await silentModel({ before: 400 });
  await assert.rejects(
    () => runTurn({ settings: fakeSettings(), model, message: '你好', idleTimeoutMs: 100, streamIdleTimeoutMs: 5000 }),
    (err: any) => err.code === 'aborted' && /没有任何输出/.test(err.message),
  );
});

test('runTurn: the turn stamps its today on every edit it records', async () => {
  const res = await turnWith(
    [
      {
        tool: 'create_workbook',
        args: {
          title: '合同',
          sheets: [{ name: 'S', columns: [{ header: '签约日', type: 'date' }], rows: [['今天']] }],
        },
      },
      '好了。',
    ],
    { message: '今天签的合同记一下', today: '2026-02-28' },
  );
  assert.strictEqual(res.ops[0].today, '2026-02-28');
  assert.strictEqual((res.spec!.sheets[0].rows[0][0] as Date).toISOString().slice(0, 10), '2026-02-28');
});
