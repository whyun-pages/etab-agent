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

import {
  aggregate,
  selectRows,
  compileExpression,
  computeRows,
  toNumber,
  QueryError,
} from '../../src/workbook/table-query.ts';

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
  assert.deepStrictEqual(r.rows, [
    ['已签收', 2, 1250],
    ['派送中', 2, 300],
    ['（空）', 1, 10],
  ]);
  assert.strictEqual(r.matched, 5);
});

test('aggregate: no groupBy is one row; an expression can be a group key', () => {
  assert.deepStrictEqual(aggregate(t, {}).rows, [[5]]);
  const byMonth = aggregate(t, {
    groupBy: ['MONTH([日期])'],
    metrics: [{ fn: 'count', as: '单数' }],
    sort: { by: 'MONTH([日期])', order: 'asc' },
  });
  assert.deepStrictEqual(byMonth.rows, [
    [5, 2],
    [6, 3],
  ]);
});

test('aggregate: where narrows the rows; nothing matched is still an answer', () => {
  const r = aggregate(t, {
    where: [{ column: '日期', op: '>=', value: '2024-06-01' }],
    metrics: [{ fn: 'count' }, { fn: 'distinct', column: '状态' }],
  });
  assert.deepStrictEqual(r.rows, [[3, 2]]);
  assert.deepStrictEqual(aggregate(t, { where: [{ column: '状态', op: '=', value: '无' }] }).rows, [[0]]);
});

test('selectRows: every condition op', () => {
  const ids = (where, match?) => selectRows(t, { where, match }).map((i) => t.rows[i][0]);
  assert.deepStrictEqual(ids([{ column: '金额', op: '>', value: 100 }]), ['A1', 'A2']);
  assert.deepStrictEqual(ids([{ column: '状态', op: 'empty' }]), ['A4']);
  assert.deepStrictEqual(
    ids(
      [
        { column: '状态', op: 'in', value: ['派送中'] },
        { column: '金额', op: '<', value: 20 },
      ],
      'any',
    ),
    ['A2', 'A4', 'A5'],
  );
  assert.deepStrictEqual(
    ids([
      { column: '订单', op: 'starts_with', value: 'a' },
      { column: '状态', op: 'contains', value: '签' },
    ]),
    ['A1', 'A3'],
  );
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

test('expressions: a date without quotes is refused, not computed as 2025/5/3 = 135', () => {
  assert.throws(() => compileExpression(t, '2025/5/3'), /2025\/5\/3 没有引号.*135.*DATE\(2025,5,3\)/);
  assert.throws(() => compileExpression(t, '2025-5-3'), /2025-5-3 没有引号.*2017/);
  // Anywhere in the expression, not only on its own.
  assert.throws(() => compileExpression(t, 'IF([金额] > 0, 2025/5/3, "")'), QueryError);
  // The spellings that work, and arithmetic that only looks similar, still compile.
  const ev = (src) => compileExpression(t, src)(t.rows[0], 1);
  assert.strictEqual(ev('"2025/5/3"'), '2025/5/3');
  assert.ok(ev('DATE(2025,5,3)') instanceof Date);
  assert.strictEqual(ev('[金额]/5/3'), 80);
  assert.strictEqual(ev('100/5/2'), 10);
  assert.strictEqual(ev('2025/13/3'), 51.923077, 'no month 13: not a date');
});

test('expressions: a large integer comes out exactly as it went in', () => {
  // round6 scaled by 1e6 first: 10147810868016 came back as 10147810868016.002.
  const ids = { header: ['商品ID'], rows: [['10147810868016'], ['10143326869328']] };
  for (const src of ['NUMBER([商品ID])', '[商品ID] * 1', '[商品ID] + 0']) {
    assert.strictEqual(compileExpression(ids, src)(ids.rows[0], 1), 10147810868016, src);
    assert.strictEqual(compileExpression(ids, src)(ids.rows[1], 2), 10143326869328, src);
  }
  assert.strictEqual(compileExpression(t, '0.1 + 0.2')(t.rows[0], 1), 0.3, 'small decimals are still tidied');
});

test('expressions: TEXT with a format writes numbers and dates the way Excel does', () => {
  const row = [7.955, '2025-02-20 17:04:05', 0.007, 1234567.891, 8];
  const tt = { header: ['x', 'd', 'p', 'big', 'n'], rows: [row] };
  const ev = (src) => compileExpression(tt, src)(row, 1);
  assert.strictEqual(ev('TEXT([x], "0.00")'), '7.96', 'a half rounds up even when binary holds it as 7.95499…');
  assert.strictEqual(ev('TEXT([n], "0.00")'), '8.00');
  assert.strictEqual(ev('TEXT([big], "#,##0.00")'), '1,234,567.89');
  assert.strictEqual(ev('TEXT([p], "0.00%")'), '0.70%');
  assert.strictEqual(ev('TEXT(-2.5, "0")'), '-3');
  assert.strictEqual(ev('TEXT([d], "yyyy/m/d")'), '2025/2/20');
  assert.strictEqual(ev('TEXT([d], "yyyy-mm-dd hh:mm:ss")'), '2025-02-20 17:04:05', 'mm next to hh or ss is minutes');
  assert.strictEqual(ev('TEXT(DATE(2025,5,3), "yyyy年m月d日")'), '2025年5月3日');
  assert.strictEqual(ev('TEXT([x])'), '7.955', 'one argument is plain text, as before');
  // An unknown format fails the row, naming the formats that work.
  const { values, failed } = computeRows(tt, 'TEXT([x], "abc")', [0]);
  assert.strictEqual(values.get(0), null);
  assert.match(failed[0].reason, /TEXT 不认识格式「abc」。可用：0、0\.00/);
});

test('expressions: ROW() is the 1-based row number', () => {
  assert.strictEqual(compileExpression(t, '"FY25Q1-" & ROW()')(t.rows[0], 1), 'FY25Q1-1');
});

test('computeRows: a row that cannot compute is null and reported, the rest compute', () => {
  const { values, failed } = computeRows(t, '[金额] / 10', [0, 4]);
  assert.strictEqual(values.get(0), 120);
  assert.strictEqual(values.get(4), null);
  assert.deepStrictEqual(
    failed.map((f) => f.row),
    [5],
  );
});

test('expressions: refuse what they do not know, naming it', () => {
  assert.throws(() => compileExpression(t, '[价格]'), /没有名为「价格」的列/);
  assert.throws(() => compileExpression(t, 'exit(1)'), /不认识的函数或名字「exit」/);
  assert.throws(() => compileExpression(t, 'process.exit()'), /「\.」处无法识别/);
  assert.throws(() => compileExpression(t, 'ROUND()'), /需要 1–2 个参数/);
  assert.throws(() => compileExpression(t, '"abc'), /引号没有闭合/);
  assert.throws(() => compileExpression(t, '1 +'), /不完整/);
});

test('deep nesting is a QueryError, not a stack overflow', () => {
  // 990 levels of brackets overflowed the parser's stack; the RangeError
  // escaped past every handler that expected a QueryError.
  const deep = (n) => '('.repeat(n) + '1' + ')'.repeat(n);
  assert.throws(
    () => compileExpression(t, deep(990)),
    (err) => err instanceof QueryError && /嵌套太深/.test(err.message),
  );
  assert.throws(() => compileExpression(t, 'not '.repeat(400) + 'true'), QueryError);
  assert.throws(() => compileExpression(t, '-'.repeat(1500) + '1'), QueryError);
  assert.throws(() => compileExpression(t, 'ABS('.repeat(300) + '1' + ')'.repeat(300)), QueryError);
  // Ordinary nesting is untouched.
  assert.strictEqual(compileExpression(t, deep(20))(t.rows[0], 1), 1);
});
