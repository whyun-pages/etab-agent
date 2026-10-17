'use strict';
/**
 * Tests for the agent: what a turn is allowed to change.
 *
 * The parts that decide whether a change is allowed are ordinary code, and
 * ordinary code can be pinned down exactly. What this file guards:
 *   - the cheap filter that decides whether a message is a request for work
 *   - edits that lose rows without being asked to are refused, judged on the
 *     cumulative result of the turn rather than call by call
 */

import test from 'node:test';
import assert from 'node:assert';
import { looksLikeWork, guardChange, INTENT } from '../../src/agent/agent.ts';
import { normalizeSpec } from '../../src/workbook/workbook.ts';

import { turnWith, SPEC_3_ROWS, specWith, rows10 } from '../helpers/agent-turn.ts';

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
  // @ts-expect-error -- null is the point: a missing message is not work either
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
    sheets: [
      {
        name: 'S',
        columns: [{ header: '客户' }, { header: '金额', type: 'currency' }],
        rows: Array.from({ length: n }, (_, i) => [`客户${i}`, i * 100]),
      },
    ],
  });
  const current = normalizeSpec(big(100)).spec;

  // Lost 2 of 100 — under the threshold, ordinary editing.
  assert.strictEqual(guardChange({ current, next: normalizeSpec(big(98)).spec, message: '把第一行改一下' }).ok, true);

  // Lost 50 of 100 — not editing, and not asked for.
  const carved = guardChange({ current, next: normalizeSpec(big(50)).spec, message: '把第一行改一下' });
  assert.strictEqual(carved.ok, false);
  assert.strictEqual(carved.lostRows, 50);

  // The same loss, but asked for this time.
  assert.strictEqual(guardChange({ current, next: normalizeSpec(big(50)).spec, message: '删掉一半的行' }).ok, true);
});

test('guardChange: an empty workbook is refused', () => {
  const current = specWith(SPEC_3_ROWS.sheets[0].rows);
  const next = normalizeSpec({ title: 'T', sheets: [] }).spec;
  assert.strictEqual(guardChange({ current, next, message: '改成空表' }).ok, false);
});

// ── the turn: the guard ──────────────────────────────────────────────

test('runTurn: edits that lose rows unasked become a question', async () => {
  const res = await turnWith(
    [
      { tool: 'delete_rows', args: { rows: [2, 3] } },
      { tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: 500 }] } },
      '已把第一行的金额改成 500。',
    ],
    { message: '把第一行的金额改成 500', spec: specWith(SPEC_3_ROWS.sheets[0].rows) },
  );
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
  const res = await turnWith(
    [
      { tool: 'delete_rows', args: { rows: [10] } },
      { tool: 'delete_rows', args: { rows: [9] } },
      { tool: 'delete_rows', args: { rows: [8] } },
      '整理好了。',
    ],
    { message: '整理一下这个表', spec: rows10() },
  );
  assert.strictEqual(res.intent, INTENT.QUESTION);
  assert.strictEqual(res.guarded, true);
  assert.strictEqual(res.lostRows, 3);
});

test('runTurn: a rebuild that drops rows is refused like any other loss', async () => {
  // The failure mode the guard was written for: "change one number" satisfied
  // by rewriting the table with one row.
  const res = await turnWith(
    [
      {
        tool: 'create_workbook',
        args: {
          title: '销售',
          sheets: [
            {
              name: '明细',
              columns: [
                { header: '客户', type: 'text' },
                { header: '金额', type: 'currency' },
              ],
              rows: [['甲', 500]],
            },
          ],
        },
      },
      '已把第一行的金额改成 500。',
    ],
    { message: '把第一行的金额改成 500', spec: specWith(SPEC_3_ROWS.sheets[0].rows) },
  );
  assert.strictEqual(res.intent, INTENT.QUESTION);
  assert.strictEqual(res.guarded, true);
});

test('runTurn: dropping rows passes when the user asked for it', async () => {
  const res = await turnWith([{ tool: 'delete_rows', args: { rows: [2, 3] } }, '删掉了。'], {
    message: '删掉后面两行',
    spec: specWith(SPEC_3_ROWS.sheets[0].rows),
  });
  assert.strictEqual(res.intent, INTENT.ACTION);
  assert.deepStrictEqual(res.spec!.sheets[0].rows, [['甲', 100]]);
});

test('runTurn: notes from normalisation are passed through', async () => {
  const res = await turnWith(
    [{ tool: 'update_cells', args: { cells: [{ row: 1, column: '金额', value: '四十几万吧' }] } }, '好了。'],
    { message: '把甲的金额改一下', spec: specWith(SPEC_3_ROWS.sheets[0].rows) },
  );
  assert.ok(Array.isArray(res.notes));
  assert.ok(
    res.notes.some((n) => /不是金额/.test(n.message)),
    JSON.stringify(res.notes),
  );
  // …and reach the model too, so it can tell the user.
  const result = res.contexts[1].messages.find((m) => m.role === 'toolResult');
  assert.match(result.content[0].text, /注意：/);
});
