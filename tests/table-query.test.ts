'use strict';
/**
 * Tests for src/workbook/table-query.ts — the filtering, aggregation and expressions
 * behind query_table and the condition-based edit operations.
 *
 * What this file guards:
 *   - counts and sums are exact over every row, with stable ordering
 *   - numbers written as text (`1,200`, `¥3`, `12%`) count as numbers
 *   - the expression language computes what it says and refuses what it
 *     does not know, with an error naming the problem
 */

import test from 'node:test';
import assert from 'node:assert';

import { aggregate, selectRows, compileExpression, computeRows, toNumber, QueryError } from '../src/workbook/table-query.ts';

const t = {
  header: ['订单', '状态', '金额', '日期'],
  rows: [
    ['A1', '已签收', '1,200', '2024-05-01'],
    ['A2', '派送中', 300, '2024-05-20'],
    ['A3', '已签收', '¥50', '2024-06-02'],
    ['A4', null, 10, new Date(Date.UTC(2024, 5, 3))],
    ['A5', '派送中', 'abc', '2024-06-30'],
  ],
};

test('toNumber reads numbers people write as text', () => {
  assert.strictEqual(toNumber('1,200'), 1200);
  assert.strictEqual(toNumber('¥50'), 50);
  assert.strictEqual(toNumber('12%'), 0.12);
  assert.strictEqual(toNumber('abc'), null);
  assert.strictEqual(toNumber(''), null);
});

test('aggregate: count and sum per group, largest first, blanks labelled', () => {
  const r = aggregate(t, { groupBy: ['状态'], metrics: [{ fn: 'count' }, { fn: 'sum', column: '金额' }] });
  assert.deepStrictEqual(r.header, ['状态', '行数', '金额合计']);
  assert.deepStrictEqual(r.rows, [['已签收', 2, 1250], ['派送中', 2, 300], ['（空）', 1, 10]]);
  assert.strictEqual(r.matched, 5);
});

test('aggregate: no groupBy is one row; an expression can be a group key', () => {
  assert.deepStrictEqual(aggregate(t, {}).rows, [[5]]);
  const byMonth = aggregate(t, { groupBy: ['MONTH([日期])'], metrics: [{ fn: 'count', as: '单数' }], sort: { by: 'MONTH([日期])', order: 'asc' } });
  assert.deepStrictEqual(byMonth.rows, [[5, 2], [6, 3]]);
});

test('aggregate: where narrows the rows; nothing matched is still an answer', () => {
  const r = aggregate(t, { where: [{ column: '日期', op: '>=', value: '2024-06-01' }], metrics: [{ fn: 'count' }, { fn: 'distinct', column: '状态' }] });
  assert.deepStrictEqual(r.rows, [[3, 2]]);
  assert.deepStrictEqual(aggregate(t, { where: [{ column: '状态', op: '=', value: '无' }] }).rows, [[0]]);
});

test('selectRows: every condition op', () => {
  const ids = (where, match) => selectRows(t, { where, match }).map((i) => t.rows[i][0]);
  assert.deepStrictEqual(ids([{ column: '金额', op: '>', value: 100 }]), ['A1', 'A2']);
  assert.deepStrictEqual(ids([{ column: '状态', op: 'empty' }]), ['A4']);
  assert.deepStrictEqual(ids([{ column: '状态', op: 'in', value: ['派送中'] }, { column: '金额', op: '<', value: 20 }], 'any'), ['A2', 'A4', 'A5']);
  assert.deepStrictEqual(ids([{ column: '订单', op: 'starts_with', value: 'a' }, { column: '状态', op: 'contains', value: '签' }]), ['A1', 'A3']);
  assert.throws(() => selectRows(t, { where: [{ column: '状态', op: 'like', value: 'x' }] }), QueryError);
  assert.throws(() => selectRows(t, { where: [{ column: '状态', op: 'in', value: 'x' }] }), /必须是数组/);
});

test('expressions: arithmetic, text, dates, IF laziness', () => {
  const ev = (src, row) => compileExpression(t, src)(row, 1);
  assert.strictEqual(ev('[金额] * 2 + 1', t.rows[0]), 2401);
  assert.strictEqual(ev('[订单] & "-" & [状态]', t.rows[0]), 'A1-已签收');
  assert.strictEqual(ev('YEAR([日期])*100+MONTH([日期])', t.rows[3]), 202406);
  assert.strictEqual(ev('DATEDIFF([日期], "2024-05-01")', t.rows[1]), 19);
  assert.strictEqual(ev('IF([金额] = 0, 0, 100 / [金额])', t.rows[1]), 0.333333);
  assert.strictEqual(ev('ROUND(0.1 + 0.2, 2)', t.rows[0]), 0.3);
  assert.strictEqual(ev('not ([金额] > 100) and LEN([订单]) = 2', t.rows[3]), true);
});

test('computeRows: a row that cannot compute is null and reported, the rest compute', () => {
  const { values, failed } = computeRows(t, '[金额] / 10', [0, 4]);
  assert.strictEqual(values.get(0), 120);
  assert.strictEqual(values.get(4), null);
  assert.deepStrictEqual(failed.map((f) => f.row), [5]);
});

test('expressions: refuse what they do not know, naming it', () => {
  assert.throws(() => compileExpression(t, '[价格]'), /没有名为「价格」的列/);
  assert.throws(() => compileExpression(t, 'exit(1)'), /不认识的函数或名字「exit」/);
  assert.throws(() => compileExpression(t, 'process.exit()'), /「\.」处无法识别/);
  assert.throws(() => compileExpression(t, 'ROUND()'), /需要 1–2 个参数/);
  assert.throws(() => compileExpression(t, '"abc'), /引号没有闭合/);
  assert.throws(() => compileExpression(t, '1 +'), /不完整/);
});
