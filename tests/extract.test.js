'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeText, parseNumber, parseChineseNumber, numberNear,
  parseDate, dateNear, textAfterLabel, parseBoolean, matchEnum,
} = require('../lib/extract');

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
  assert.strictEqual(parseNumber('1234').value, 1234);
  assert.strictEqual(parseNumber('1,234.56').value, 1234.56);
  assert.strictEqual(parseNumber('12,345,678').value, 12345678);
  assert.strictEqual(parseNumber('-500').value, -500);
  assert.strictEqual(parseNumber('−500').value, -500);
  assert.strictEqual(parseNumber('0.5').value, 0.5);
  assert.strictEqual(parseNumber('.5').value, 0.5);
});

test('parses Chinese scale suffixes', () => {
  assert.strictEqual(parseNumber('1.5万').value, 15000);
  assert.strictEqual(parseNumber('2万').value, 20000);
  assert.strictEqual(parseNumber('3千万').value, 3e7);
  assert.strictEqual(parseNumber('1.2亿').value, 1.2e8);
  assert.strictEqual(parseNumber('5千').value, 5000);
  assert.strictEqual(parseNumber('25万').value, 250000);
  assert.strictEqual(parseNumber('1,234万').value, 12340000);
});

test('parses currency marks, 元 suffix and percentages', () => {
  assert.strictEqual(parseNumber('¥5000').value, 5000);
  assert.strictEqual(parseNumber('￥1.2万').value, 12000);
  assert.strictEqual(parseNumber('5000元').value, 5000);
  assert.strictEqual(parseNumber('$99.99').value, 99.99);
  assert.strictEqual(parseNumber('13%').value, 0.13);
  assert.strictEqual(parseNumber('¥5000').hadCurrency, true);
  assert.strictEqual(parseNumber('13%').percent, true);
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
  assert.strictEqual(parseChineseNumber('两万').valueOf(), 20000);
  // 两 is a variant of 二.
  assert.strictEqual(parseChineseNumber('两百'), 200);
  assert.strictEqual(parseChineseNumber('不是数字'), null);
  // Embedded in a parseNumber call with a currency mark.
  assert.strictEqual(parseNumber('¥三千五百').value, 3500);
  assert.strictEqual(parseNumber('一万五千元').value, 15000);
});

test('rejects text that is not a number', () => {
  assert.strictEqual(parseNumber('abc'), null);
  assert.strictEqual(parseNumber(''), null);
  assert.strictEqual(parseNumber('---'), null);
  assert.strictEqual(parseNumber('约'), null);
});

test('numberNear finds the value attached to a label', () => {
  const text = '客户：甲公司\n合同金额：1.2亿元\n签约日期：2026年3月1日\n负责人：张三';
  assert.strictEqual(numberNear(text, '合同金额').value, 1.2e8);
  // A name fragment must not be read as a number.
  assert.strictEqual(numberNear(text, '负责人'), null);
  const plain = '总金额 25万 元，已支付 10万';
  assert.strictEqual(numberNear(plain, '总金额').value, 250000);
  // An explicit currency mark makes even a single numeral a number.
  assert.strictEqual(numberNear('单价：¥三', '单价').value, 3);
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

test('relative dates resolve against today', () => {
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  assert.strictEqual(fmt(parseDate('今天')), fmt(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))));
  const tomorrow = parseDate('明天');
  assert.ok(tomorrow > new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
});

test('dateNear binds a date to its label', () => {
  const text = '客户：甲\n合同金额：100万\n签约日期：2026年3月1日\n开始日期：2026-04-01';
  assert.strictEqual(dateNear(text, '签约日期').date.toISOString().slice(0, 10), '2026-03-01');
  assert.strictEqual(dateNear(text, '开始日期').date.toISOString().slice(0, 10), '2026-04-01');
  assert.strictEqual(dateNear(text, '不存在的字段'), null);
});

// -------------------------------------------------------------- text values
test('textAfterLabel reads the value that follows a label', () => {
  assert.strictEqual(textAfterLabel('客户：北京示例科技有限公司', '客户'), '北京示例科技有限公司');
  assert.strictEqual(textAfterLabel('客户:北京示例科技有限公司', '客户'), '北京示例科技有限公司');
  assert.strictEqual(textAfterLabel('客户 北京示例科技有限公司', '客户'), '北京示例科技有限公司');
  // Stops at the next field.
  assert.strictEqual(textAfterLabel('客户：甲公司,金额：100万', '客户'), '甲公司');
  assert.strictEqual(textAfterLabel('客户：甲公司\n金额：100万', '客户'), '甲公司');
  // Strips wrapping quotes.
  assert.strictEqual(textAfterLabel('名称："某某公司"', '名称'), '某某公司');
  assert.strictEqual(textAfterLabel('名称：「某某公司」', '名称'), '某某公司');
  // Missing label.
  assert.strictEqual(textAfterLabel('没有这个字段', '客户'), null);
  // Label present but no value.
  assert.strictEqual(textAfterLabel('客户：', '客户'), null);
});

test('textAfterLabel honours custom stop words', () => {
  assert.strictEqual(textAfterLabel('备注：已结清（含税）', '备注', { stopWords: ['（含税）'] }), '已结清');
});

// ---------------------------------------------------------------- booleans
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

test('enum matching maps free text onto template options', () => {
  assert.strictEqual(matchEnum('是', ['是', '否']), '是');
  assert.strictEqual(matchEnum('否', ['是', '否']), '否');
  assert.strictEqual(matchEnum('是', ['否', '是']), '是');
  // Semantic fallback through the boolean reading.
  assert.strictEqual(matchEnum('已完成', ['未完成', '已完成']), '已完成');
  assert.strictEqual(matchEnum('不续约', ['续约', '不续约']), '不续约');
  assert.strictEqual(matchEnum('不太确定', ['是', '否']), null);
  assert.strictEqual(matchEnum('是', []), null);
  assert.strictEqual(matchEnum('是', null), null);
});
