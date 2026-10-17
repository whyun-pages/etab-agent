'use strict';
/**
 * Reading a cell value out of text: numbers (Chinese numerals and scales
 * included), dates and yes/no. `coerce` in workbook.ts calls these when a
 * value arrives as text for a typed column.
 *
 * Deliberately NOT an LLM wrapper: a spreadsheet cell is a commitment. Parsing
 * in code means the same input always gives the same cell, and a wrong value
 * is traceable to a rule rather than a mood.
 *
 * The label-driven half of this file — find the number after 合同金额：, the
 * text after 客户： — served the template engine, and went with it.
 */

// ---------------------------------------------------------------- normalise

/** Full-width punctuation and digits → ASCII, normalise whitespace. */
export function normalizeText(s: unknown): string {
  if (s == null) return '';
  let out = String(s);
  // Full-width forms (U+FF01..U+FF5E) map to ASCII by offset 0xFEE0.
  out = out.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  out = out.replace(/\u3000/g, ' '); // ideographic space
  out = out.replace(/[，、]/g, ',');
  out = out.replace(/[。；]/g, ';');
  out = out.replace(/[：]/g, ':');
  out = out.replace(/[（]/g, '(').replace(/[）]/g, ')');
  out = out.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  return out;
}

// ------------------------------------------------------------------ numbers

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  两: 2,
  贰: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
};
const CN_UNITS: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };

/** Scale multipliers that commonly follow a number in Chinese text. */
const SCALES: Array<{ re: RegExp; mul: number }> = [
  { re: /(亿|億)/, mul: 1e8 },
  { re: /(千万|仟万)/, mul: 1e7 },
  { re: /(百万|佰万)/, mul: 1e6 },
  { re: /(万|萬)/, mul: 1e4 },
  { re: /(千|仟)/, mul: 1e3 },
  { re: /(百|佰)/, mul: 1e2 },
];

const CURRENCY_MARKS = /[¥$€£￥]/;

/** A parsed number together with the decorations that were stripped off it. */
interface ParsedNumber {
  value: number;
  raw: string;
  scale: number;
  hadCurrency: boolean;
  percent: boolean;
}

/**
 * Parse a Chinese numeral such as 三千五百 or 十二 into a number.
 * Handles the unit-stacking form; returns null when the text is not a numeral.
 * A lone digit character is accepted only when it was passed as a standalone
 * value, which is why callers pass single tokens rather than embedded text.
 */
export function parseChineseNumber(text: string): number | null {
  const s = String(text).trim();
  if (!s) return null;
  if (!/^[零〇一二两三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾佰仟萬亿万]+$/.test(s)) return null;

  let total = 0;
  let section = 0; // accumulates below 万/亿
  let number = 0; // current digit run

  for (const ch of s) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch];
      continue;
    }
    if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      // "十五" means 15: a unit with no preceding digit implies one.
      section += (number || 1) * unit;
      number = 0;
      continue;
    }
    if (ch === '万' || ch === '萬') {
      total += (section + number) * 1e4;
      section = 0;
      number = 0;
      continue;
    }
    if (ch === '亿' || ch === '億') {
      total += (section + number) * 1e8;
      section = 0;
      number = 0;
    }
  }
  return total + section + number;
}

/**
 * Extract a numeric value with its scale and unit from a fragment.
 */
export function parseNumber(token: string): ParsedNumber | null {
  const s = normalizeText(token).trim();
  if (!s) return null;

  const hadCurrency = CURRENCY_MARKS.test(s);
  const percent = /%/.test(s);
  const negative = /^[-−]/.test(s) || /负/.test(s);

  // Strip decorations; keep digits, separators and scale chars. The percent sign
  // is consumed here but already recorded in `percent` above.
  let body = s
    .replace(/[¥$€£￥%\s]/g, '')
    .replace(/^[-−+]/, '')
    .replace(/[元圆整人民币RMBrmb]/g, '');

  // Apply a scale suffix only to an Arabic digit run (1.5万, 3千万). A Chinese
  // numeral carries its own units, so stripping 千 out of 三千五百 would be wrong.
  let scale = 1;
  const scaleMatch = /^(.*\d)\s*(亿|億|千万|仟万|百万|佰万|万|萬|千|仟|百|佰)$/.exec(body);
  if (scaleMatch) {
    // The pattern guarantees the captured scale word and the digit prefix, so
    // both groups are present whenever the match is.
    scale = SCALES.find(({ re }) => re.test(scaleMatch[2]!))!.mul;
    body = scaleMatch[1]!;
  }

  // Remove thousands separators between digits.
  body = body.replace(/(\d),(?=\d{3}\b)/g, '$1');

  let num: number | null = null;
  if (/^\d+(\.\d+)?$/.test(body)) {
    num = Number(body);
  } else if (/^\.\d+$/.test(body)) {
    num = Number('0' + body);
  } else {
    // Chinese numeral, possibly a decimal like 三点五.
    const cnDecimal = /^(.+?)点(.+)$/.exec(body);
    if (cnDecimal) {
      const whole = parseChineseNumber(cnDecimal[1]);
      const fracDigits = [...cnDecimal[2]].map((c) => (c in CN_DIGITS ? CN_DIGITS[c] : c)).join('');
      if (whole !== null && /^\d+$/.test(fracDigits)) num = Number(whole + '.' + fracDigits);
    } else {
      num = parseChineseNumber(body);
    }
  }
  if (num === null || !Number.isFinite(num)) return null;

  let value = num * scale;
  if (negative) value = -value;
  if (percent) value = value / 100;

  return { value, raw: s, scale, hadCurrency, percent };
}

// -------------------------------------------------------------------- dates

const DATE_RE = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*(?:[-/.月]\s*(\d{1,2})\s*日?)?/g;

/** Parse a date, tolerating 2026年3月1日 / 2026-03-01 / 2026/03/01 / 20260301. */
export function parseDate(token: string, today?: string): Date | null {
  const s = normalizeText(token).trim();
  let m;
  DATE_RE.lastIndex = 0;
  if ((m = DATE_RE.exec(s))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = m[3] ? Number(m[3]) : 1;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(Date.UTC(y, mo - 1, d));
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact) {
    const y = Number(compact[1]),
      mo = Number(compact[2]),
      d = Number(compact[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(Date.UTC(y, mo - 1, d));
  }
  const cn = /([一二三四五六七八九十]{1,3})月([一二三四五六七八九十]{1,3})日/.exec(s);
  if (cn) {
    const mo = parseChineseNumber(cn[1]);
    const d = parseChineseNumber(cn[2]);
    const yMatch = /(\d{4})\s*年/.exec(s);
    const y = yMatch ? Number(yMatch[1]) : base(today)?.getUTCFullYear();
    if (mo && d && y !== undefined) return new Date(Date.UTC(y, mo - 1, d));
  }
  // Relative dates are resolved against the supplied `today`, and without
  // one they are not dates: reading the clock here made the same spec
  // normalise differently tomorrow, and a replay land a different day.
  const rel = /(今天|今日|昨天|明日|明天|后天|前天)/.exec(s);
  const start = base(today);
  if (rel && start) {
    const deltas: Record<string, number> = { 今天: 0, 今日: 0, 昨天: -1, 前天: -2, 明天: 1, 明日: 1, 后天: 2 };
    start.setUTCDate(start.getUTCDate() + deltas[rel[1]]);
    return start;
  }
  return null;
}

/** `today` (YYYY-MM-DD) as a UTC midnight, or undefined when absent or malformed. */
function base(today: string | undefined): Date | undefined {
  const m = today ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(today) : null;
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
}

// ---------------------------------------------------------------- booleans

/** Decide yes/no for boolean-ish columns, honouring negatives. */
const AFFIRMATIVE = /^(是|对|有|要|需要|已|已完成|启用|有效|true|yes|y|1|续约|续签)$/i;
const NEGATIVE = /^(否|不|没有|无|未|未完成|停用|无效|false|no|n|0|不续约|不续签)$/i;

export function parseBoolean(token: string): boolean | null {
  const s = normalizeText(token).trim();
  if (AFFIRMATIVE.test(s)) return true;
  if (NEGATIVE.test(s)) return false;
  if (/不[续签约]|不再|停止|取消|作废/.test(s)) return false;
  if (/续[签约]|继续|保持/.test(s)) return true;
  return null;
}
