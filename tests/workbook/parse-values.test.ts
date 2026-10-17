'use strict';
import { test } from 'node:test';
import assert from 'node:assert';
import {
  normalizeText,
  parseNumber,
  parseChineseNumber,
  parseDate,
  parseBoolean,
} from '../../src/workbook/parse-values.ts';

// -------------------------------------------------------------- normalising
test('full-width text is normalised to ASCII', () => {
  assert.strictEqual(normalizeText('１２３ＡＢＣ'), '123ABC');
  assert.strictEqual(normalizeText('金额：１２３元'), '金额:123元');
  assert.strictEqual(normalizeText('甲，乙、丙；丁'), '甲,乙,丙;丁');
  assert.strictEqual(normalizeText('（备注）'), '(备注)');
  assert.strictEqual(normalizeText('\u3000空格\u3000'), ' 空格 ');
});

// ----------------------------------------------------------------- numbers
test('parses plain, grouped and signed numbers', () => {
  assert.strictEqual(parseNumber('1234')!.value, 1234);
  assert.strictEqual(parseNumber('1,234.56')!.value, 1234.56);
  assert.strictEqual(parseNumber('12,345,678')!.value, 12345678);
  assert.strictEqual(parseNumber('-500')!.value, -500);
  assert.strictEqual(parseNumber('−500')!.value, -500);
  assert.strictEqual(parseNumber('0.5')!.value, 0.5);
  assert.strictEqual(parseNumber('.5')!.value, 0.5);
});

test('parses Chinese scale suffixes', () => {
  assert.strictEqual(parseNumber('1.5万')!.value, 15000);
  assert.strictEqual(parseNumber('2万')!.value, 20000);
  assert.strictEqual(parseNumber('3千万')!.value, 3e7);
  assert.strictEqual(parseNumber('1.2亿')!.value, 1.2e8);
  assert.strictEqual(parseNumber('5千')!.value, 5000);
  assert.strictEqual(parseNumber('25万')!.value, 250000);
  assert.strictEqual(parseNumber('1,234万')!.value, 12340000);
});

test('parses currency marks, 元 suffix and percentages', () => {
  assert.strictEqual(parseNumber('¥5000')!.value, 5000);
  assert.strictEqual(parseNumber('￥1.2万')!.value, 12000);
  assert.strictEqual(parseNumber('5000元')!.value, 5000);
  assert.strictEqual(parseNumber('$99.99')!.value, 99.99);
  assert.strictEqual(parseNumber('13%')!.value, 0.13);
  assert.strictEqual(parseNumber('¥5000')!.hadCurrency, true);
  assert.strictEqual(parseNumber('13%')!.percent, true);
});

test('parses Chinese numerals, including the unitless-one case', () => {
  assert.strictEqual(parseChineseNumber('三'), 3);
  assert.strictEqual(parseChineseNumber('十'), 10);
  assert.strictEqual(parseChineseNumber('十五'), 15);
  assert.strictEqual(parseChineseNumber('二十'), 20);
  assert.strictEqual(parseChineseNumber('三十五'), 35);
  assert.strictEqual(parseChineseNumber('一百二十'), 120);
  assert.strictEqual(parseChineseNumber('三千五百'), 3500);
  assert.strictEqual(parseChineseNumber('一万二千'), 12000);
  assert.strictEqual(parseChineseNumber('两万')!.valueOf(), 20000);
  // 两 is a variant of 二.
  assert.strictEqual(parseChineseNumber('两百'), 200);
  assert.strictEqual(parseChineseNumber('不是数字'), null);
  // Embedded in a parseNumber call with a currency mark.
  assert.strictEqual(parseNumber('¥三千五百')!.value, 3500);
  assert.strictEqual(parseNumber('一万五千元')!.value, 15000);
});

test('rejects text that is not a number', () => {
  assert.strictEqual(parseNumber('abc'), null);
  assert.strictEqual(parseNumber(''), null);
  assert.strictEqual(parseNumber('---'), null);
  assert.strictEqual(parseNumber('约'), null);
});

// ------------------------------------------------------------------- dates
test('parses the date formats Chinese templates use', () => {
  const fmt = (d) => (d ? d.toISOString().slice(0, 10) : null);
  assert.strictEqual(fmt(parseDate('2026-03-01')), '2026-03-01');
  assert.strictEqual(fmt(parseDate('2026/03/01')), '2026-03-01');
  assert.strictEqual(fmt(parseDate('2026.03.01')), '2026-03-01');
  assert.strictEqual(fmt(parseDate('2026年3月1日')), '2026-03-01');
  assert.strictEqual(fmt(parseDate('2026年3月')), '2026-03-01');
  assert.strictEqual(fmt(parseDate('20260301')), '2026-03-01');
  assert.strictEqual(fmt(parseDate('2026年十二月')), null);
  assert.strictEqual(parseDate('没有日期'), null);
  // Single-digit month and day.
  assert.strictEqual(fmt(parseDate('2026-3-5')), '2026-03-05');
});

test('rejects impossible calendar dates', () => {
  assert.strictEqual(parseDate('2026-13-01'), null);
  assert.strictEqual(parseDate('2026-00-10'), null);
});

test('relative dates resolve against the today they are given', () => {
  const fmt = (d) => (d ? d.toISOString().slice(0, 10) : null);
  assert.strictEqual(fmt(parseDate('今天', '2026-02-28')), '2026-02-28');
  assert.strictEqual(fmt(parseDate('明天', '2026-02-28')), '2026-03-01');
  assert.strictEqual(fmt(parseDate('前天', '2026-01-01')), '2025-12-30');
  // A month and day with no year takes today's year.
  assert.strictEqual(fmt(parseDate('三月五日', '2026-10-17')), '2026-03-05');
});

test('without a today, a relative date is not a date — nothing reads the clock', () => {
  // The clock made the same input parse differently tomorrow, so a replayed
  // edit could land a different day than the turn showed.
  assert.strictEqual(parseDate('今天'), null);
  assert.strictEqual(parseDate('三月五日'), null);
  assert.strictEqual(parseDate('2026年三月五日')!.toISOString().slice(0, 10), '2026-03-05');
});

test('boolean parsing handles Chinese and English forms', () => {
  assert.strictEqual(parseBoolean('是'), true);
  assert.strictEqual(parseBoolean('否'), false);
  assert.strictEqual(parseBoolean('有'), true);
  assert.strictEqual(parseBoolean('无'), false);
  assert.strictEqual(parseBoolean('true'), true);
  assert.strictEqual(parseBoolean('no'), false);
  assert.strictEqual(parseBoolean('已完成'), true);
  assert.strictEqual(parseBoolean('未完成'), false);
  assert.strictEqual(parseBoolean('不续约'), false);
  assert.strictEqual(parseBoolean('续约'), true);
  assert.strictEqual(parseBoolean('或许'), null);
});
