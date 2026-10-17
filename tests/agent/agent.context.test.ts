'use strict';
/**
 * Tests for what the agent shows the model: history, the change log, and the
 * summary of the current spec.
 *
 * History is reference material, not a conversation to continue, and it is
 * cut to a budget; the change log and the spec summary go into the state
 * section of the system message.
 */

import test from 'node:test';
import assert from 'node:assert';
import { agentMessages, specSummary, describeChange, changesSummary } from '../../src/agent/agent.ts';
import { normalizeSpec } from '../../src/workbook/workbook.ts';
import type { WorkbookSpec } from '../../src/workbook/workbook.ts';
import type { HistoryMessage } from '../../src/agent/types.ts';

import { SPEC_3_ROWS, specWith } from '../helpers/agent-turn.ts';

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
  const history: HistoryMessage[] = [];
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
    history: [
      { role: 'user', content: longUser },
      { role: 'assistant', content: longReply },
    ],
  })[1].content;
  assert.ok(content.includes(`用户：${longUser}\n`), 'user message not truncated');
  assert.ok(content.includes(`助手：${'答'.repeat(800)}…（已截断）`));
  assert.ok(!content.includes('答'.repeat(801)));
});

test('agentMessages: the newest message is sent even if it alone exceeds the budget', () => {
  const content = agentMessages({
    message: 'x',
    history: [
      { role: 'user', content: '旧' },
      { role: 'assistant', content: '新'.repeat(50) },
    ],
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
  assert.strictEqual(
    describeChange(null, specWith(SPEC_3_ROWS.sheets[0].rows)),
    '新建工作簿「销售」：1 个工作表，共 3 行',
  );
});

test('describeChange: columns, rows and totals are read off the specs', () => {
  const before = specWith(SPEC_3_ROWS.sheets[0].rows);
  const after = specOf({
    title: '销售',
    sheets: [
      {
        name: '明细',
        columns: [
          { header: '客户', type: 'text' },
          { header: '金额', type: 'currency' },
          { header: '备注', type: 'text' },
        ],
        rows: [
          ['甲', 100, ''],
          ['乙', 200, ''],
          ['丙', 300, ''],
          ['丁', 400, ''],
        ],
        totals: { enabled: true, sumColumns: ['金额'] },
      },
    ],
  });
  const d = describeChange(before, after);
  assert.match(d, /新增列：备注/);
  assert.match(d, /行数 3→4/);
  assert.match(d, /加上合计行/);
  assert.doesNotMatch(d, /「明细」/, 'a one-sheet workbook does not name its sheet');
});

test('describeChange: an edited cell is "修改了数据"; an identical spec says nothing changed', () => {
  const before = specWith(SPEC_3_ROWS.sheets[0].rows);
  assert.strictEqual(
    describeChange(
      before,
      specWith([
        ['甲', 100],
        ['乙', 250],
        ['丙', 300],
      ]),
    ),
    '修改了数据',
  );
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
    sheets: [
      {
        name: 'S',
        columns: [{ header: '客户' }],
        rows: Array.from({ length: 30 }, (_, i) => [`客户${i}`]),
      },
    ],
  };
  const messages = agentMessages({ message: 'x', spec: normalizeSpec(many).spec, rowBudget: 10 });
  assert.match(messages[0].content, /第 11–30 行没有列出来/);
  assert.match(messages[0].content, /read_rows/);
});

test('specSummary: an empty spec has nothing to say', () => {
  assert.strictEqual(specSummary(null), '');
  assert.strictEqual(specSummary({ sheets: [] } as unknown as WorkbookSpec), '');
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
