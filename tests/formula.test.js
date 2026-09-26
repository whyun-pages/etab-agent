'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateFormula, recomputeCachedValues, splitArgs } = require('../lib/formula');

/** Build a grid list from a compact spec: {B4: 100, B5: 50}. */
function cellsFrom(spec) {
  const { parseRef } = require('../lib/xlsx');
  return Object.entries(spec).map(([ref, value]) => {
    const { col, row } = parseRef(ref);
    return { ref, col, row, value };
  });
}

test('evaluateFormula: SUM over a range', () => {
  const cells = cellsFrom({ B4: 100, B5: 50, B6: 25 });
  assert.strictEqual(evaluateFormula('SUM(B4:B6)', new Map(cells.map((c) => [c.col + ',' + c.row, c]))), 175);
});

test('evaluateFormula: SUM over scattered arguments', () => {
  const cells = cellsFrom({ B4: 100, B5: 50, D4: 10 });
  const grid = new Map(cells.map((c) => [c.col + ',' + c.row, c]));
  assert.strictEqual(evaluateFormula('SUM(B4,B5,D4)', grid), 160);
});

test('evaluateFormula: numbers as literals', () => {
  assert.strictEqual(evaluateFormula('SUM(1,2,3)', new Map()), 6);
});

test('evaluateFormula: AVERAGE / MIN / MAX / COUNT', () => {
  const cells = cellsFrom({ B4: 10, B5: 20, B6: 30 });
  const grid = new Map(cells.map((c) => [c.col + ',' + c.row, c]));
  assert.strictEqual(evaluateFormula('AVERAGE(B4:B6)', grid), 20);
  assert.strictEqual(evaluateFormula('MIN(B4:B6)', grid), 10);
  assert.strictEqual(evaluateFormula('MAX(B4:B6)', grid), 30);
  assert.strictEqual(evaluateFormula('COUNT(B4:B6)', grid), 3);
});

test('evaluateFormula: blank cells are skipped, not treated as zero', () => {
  // B6 absent entirely; B5 is a label. SUM of a 3-row range still works.
  const cells = cellsFrom({ B4: 100, B5: 'n/a' });
  const grid = new Map(cells.map((c) => [c.col + ',' + c.row, c]));
  assert.strictEqual(evaluateFormula('SUM(B4:B6)', grid), 100);
});

test('evaluateFormula: whole blank range sums to 0 like Excel', () => {
  assert.strictEqual(evaluateFormula('SUM(B4:B6)', new Map()), 0);
});

test('evaluateFormula: out-of-scope constructs return null', () => {
  const grid = new Map();
  assert.strictEqual(evaluateFormula('IF(B4>0,B4,0)', grid), null);
  assert.strictEqual(evaluateFormula('SUM(Sheet2!A1:A3)', grid), null);
  assert.strictEqual(evaluateFormula('SUM(SUBTOTAL(9,B4:B6))', grid), null);
  assert.strictEqual(evaluateFormula('MyNamedRange', grid), null);
  assert.strictEqual(evaluateFormula('=SUM(B4:B5)', grid), null);
  assert.strictEqual(evaluateFormula('SUM()', grid), null);
});

test('recomputeCachedValues: fixes a stale total', () => {
  const cells = cellsFrom({ B4: 100, B5: 50, B6: 25 });
  cells.push({ ref: 'B7', col: 2, row: 7, value: 150, formula: 'SUM(B4:B6)' });
  const { cells: out, recomputed } = recomputeCachedValues(cells);
  const b7 = out.find((c) => c.ref === 'B7');
  assert.strictEqual(b7.value, 175);
  assert.strictEqual(b7.formula, 'SUM(B4:B6)');
  assert.deepStrictEqual(recomputed, [{ ref: 'B7', from: 150, to: 175 }]);
});

test('recomputeCachedValues: leaves an already-correct cache alone', () => {
  const cells = cellsFrom({ B4: 100, B5: 50 });
  cells.push({ ref: 'B6', col: 2, row: 6, value: 150, formula: 'SUM(B4:B5)' });
  const { recomputed, unresolved } = recomputeCachedValues(cells);
  assert.strictEqual(recomputed.length, 0);
  assert.strictEqual(unresolved.length, 0);
});

test('recomputeCachedValues: keeps the old cache when the formula is out of scope', () => {
  const cells = cellsFrom({ B4: 100 });
  cells.push({ ref: 'B5', col: 2, row: 5, value: 999, formula: 'IF(B4>0,B4,0)' });
  const { cells: out, unresolved, recomputed } = recomputeCachedValues(cells);
  assert.strictEqual(out.find((c) => c.ref === 'B5').value, 999);
  assert.deepStrictEqual(unresolved, ['B5']);
  assert.strictEqual(recomputed.length, 0);
});

test('recomputeCachedValues: refuses a range containing a formula cell', () => {
  // B5 is itself a formula. A SUM over B4:B5 cannot be resolved from caches we
  // do not trust, so the old value stays and the ref is reported unresolved.
  const cells = cellsFrom({ B4: 10 });
  cells.push({ ref: 'B5', col: 2, row: 5, value: 999, formula: 'B4*2' });
  cells.push({ ref: 'B6', col: 2, row: 6, value: 1009, formula: 'SUM(B4:B5)' });
  const { cells: out, unresolved, recomputed } = recomputeCachedValues(cells);
  assert.strictEqual(out.find((c) => c.ref === 'B6').value, 1009, 'old cache kept, not a wrong total');
  assert.ok(unresolved.includes('B6'));
  assert.strictEqual(recomputed.length, 0);
});

test('recomputeCachedValues: a formula outside the range does not block it', () => {
  // B9 is a formula, but SUM(B4:B6) never touches it.
  const cells = cellsFrom({ B4: 100, B5: 50, B6: 25 });
  cells.push({ ref: 'B9', col: 2, row: 9, value: 0, formula: 'B4*2' });
  cells.push({ ref: 'B7', col: 2, row: 7, value: 0, formula: 'SUM(B4:B6)' });
  const { cells: out } = recomputeCachedValues(cells);
  assert.strictEqual(out.find((c) => c.ref === 'B7').value, 175);
});

test('splitArgs: respects nesting and drops empties', () => {
  assert.deepStrictEqual(splitArgs('B4:B6'), ['B4:B6']);
  assert.deepStrictEqual(splitArgs('B4, B5 ,D4'), ['B4', 'B5', 'D4']);
  assert.deepStrictEqual(splitArgs('SUM(B4:B5),C1'), ['SUM(B4:B5)', 'C1']);
});
