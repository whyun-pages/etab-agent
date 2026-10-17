'use strict';
/**
 * One value into one column type: numbers (Chinese numerals and scales
 * included), dates, yes/no, links, clamped text — and the type names a model
 * might spell a column's type with.
 */

import { parseNumber, parseChineseNumber, parseDate, parseBoolean } from './extract.ts';
import { TYPES, TYPE_LABELS, MAX_CELL_CHARS, MAX_NAME_CHARS } from './spec-types.ts';
import type { ColumnType, CellValue, ColumnSpec } from './spec-types.ts';

/** Spellings a model might use for a type, mapped onto the canonical name. */
const TYPE_ALIASES: Record<string, ColumnType> = {
  string: 'text',
  str: 'text',
  strng: 'text',
  label: 'text',
  num: 'number',
  float: 'number',
  decimal: 'number',
  double: 'number',
  int: 'integer',
  whole: 'integer',
  money: 'currency',
  amount: 'currency',
  金额: 'currency',
  pct: 'percent',
  percentage: 'percent',
  百分比: 'percent',
  datetime: 'date',
  time: 'date',
  日期: 'date',
  bool: 'boolean',
  yesno: 'boolean',
  布尔: 'boolean',
  link: 'url',
  hyperlink: 'url',
  href: 'url',
  uri: 'url',
  website: 'url',
  链接: 'url',
  网址: 'url',
  超链接: 'url',
};

// --------------------------------------------------------------- utilities

export const isBlank = (v: unknown): boolean => v === null || v === undefined || v === '';

/**
 * A declared column width, clamped to 4..80; null when none was declared.
 *
 * Blank is tested before the number: `Number(null)` is 0, a finite number, so
 * an absent width (stored as null) used to come back as the minimum, 4. A spec
 * normalised once had auto-sized columns; the same spec read back from disk
 * and normalised again had every column 4 wide.
 */
export function columnWidth(raw: unknown): number | null {
  if (isBlank(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(4, Math.min(80, n)) : null;
}

/** Excel's day 0. 1899-12-30 because Excel believes 1900 was a leap year. */
const SERIAL_EPOCH = Date.UTC(1899, 11, 30);

/**
 * A Date to an Excel serial number.
 * @returns days since 1899-12-30, with the time as a fraction
 */
export function dateToSerial(date: Date): number {
  const ms = date.getTime() - SERIAL_EPOCH;
  return ms / 86400000;
}

/** Clamp a string to the cell limit, marking that it was cut. */
export function clampText(s: unknown): string {
  const t = String(s);
  if (t.length <= MAX_CELL_CHARS) return t;
  return t.slice(0, MAX_CELL_CHARS) + '…';
}

/**
 * Excel refuses a hyperlink target longer than this; a file carrying one opens
 * with a repair prompt. A longer URL stays in the cell as text.
 */
const MAX_LINK_CHARS = 2079;

/**
 * The hyperlink a url cell should carry, or null when it should stay text.
 *
 * An allow-list of schemes, not a block-list: tables are filled from fetched
 * web pages (src/agent/fetch-url.ts), and a `file:`, `javascript:` or UNC target in
 * a cell Excel will open on a click is exactly what a hostile page would put
 * there. A bare `www.` host is what people type, and gets https.
 */
export function linkTarget(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || /\s/.test(s)) return null;
  let target: string;
  if (/^https?:\/\/[^/]/i.test(s) || /^mailto:[^@\s]+@[^@\s]+$/i.test(s)) target = s;
  else if (/^www\.[^/\s.]+\.[^\s]+$/i.test(s)) target = `https://${s}`;
  else return null;
  return target.length <= MAX_LINK_CHARS ? target : null;
}

/** A heading that is present, printable, and not absurdly long. */
export function cleanName(raw: unknown, fallback: string): string {
  let s = isBlank(raw)
    ? ''
    : String(raw)
        .replace(/[\r\n\t]+/g, ' ')
        .trim();
  // Excel forbids : \ / ? * [ ] in a sheet name.
  s = s.replace(/[:\\/?*[\]]/g, '_');
  if (!s) s = fallback;
  return s.slice(0, MAX_NAME_CHARS);
}

/**
 * Extract a number from either a bare number or a parser result object.
 *
 * `parseNumber` answers with `{value, raw, scale, percent}`; `parseChineseNumber`
 * answers with a bare number. Both mean "here is the number", so accept both
 * rather than making every caller remember which is which.
 */
function unwrapNumber(r: unknown): number | null {
  if (r === null || r === undefined) return null;
  if (typeof r === 'number') return Number.isFinite(r) ? r : null;
  if (
    typeof r === 'object' &&
    typeof (r as { value?: unknown }).value === 'number' &&
    Number.isFinite((r as { value: number }).value)
  ) {
    return (r as { value: number }).value;
  }
  return null;
}

/** The result of coercing one raw value to a column's type. */
export interface CoerceResult {
  value: CellValue;
  note: string | null;
}

/**
 * Coerce one value to a column's type.
 *
 * Returns `{ value, note }` — `note` is non-null when the input could not be
 * represented, and the caller decides whether that is a failure or a blank.
 * Nothing is ever silently turned into a plausible-looking wrong number: a
 * currency cell holding "四十几万吧" is reported, not stored as 40.
 */
export function coerce(raw: unknown, type: ColumnType, today?: string): CoerceResult {
  if (isBlank(raw)) return { value: null, note: null };

  switch (type) {
    case 'number':
    case 'integer':
    case 'currency':
    case 'percent': {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        return { value: type === 'integer' ? Math.round(raw) : raw, note: null };
      }
      const s = String(raw).trim();
      // Chinese numerals first: "125万" and "一百二十五万" are both numbers a
      // Chinese speaker would expect to work.
      //
      // Both helpers are quirky in the same way: `parseChineseNumber` returns a
      // number or null, but `parseNumber` returns a RESULT OBJECT
      // ({value, raw, scale, percent}) or null. Treating that object as a number
      // silently discarded every ordinary value — "1200" became a blank cell
      // with a note, which is the one outcome this whole layer exists to avoid.
      let n = parseChineseNumber(s);
      if (n === null || n === undefined) n = unwrapNumber(parseNumber(s));
      if (n === null || n === undefined || !Number.isFinite(n)) {
        return { value: null, note: `「${s.slice(0, 24)}」不是${TYPE_LABELS[type]}，已留空` };
      }
      return { value: type === 'integer' ? Math.round(n) : n, note: null };
    }

    case 'date': {
      if (raw instanceof Date) {
        return Number.isNaN(raw.getTime()) ? { value: null, note: '日期无效，已留空' } : { value: raw, note: null };
      }
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        // Excel serial in, serial out.
        if (raw > 1 && raw < 200000) return { value: new Date(SERIAL_EPOCH + raw * 86400000), note: null };
      }
      // A date that has been through JSON is a string again, and a date-shaped
      // string is ambiguous with text that merely looks like a date. The column
      // type is what resolves it: this branch only runs because the column IS a
      // date, so an ISO/`YYYY-MM-DD` string here is a date that lost its type on
      // the way through `JSON.stringify` — which is exactly what happens every
      // time a session is reloaded from disk.
      const iso = isoToDate(raw);
      if (iso) return { value: iso, note: null };
      const d = parseDate(String(raw), today);
      if (!d) return { value: null, note: `「${String(raw).slice(0, 24)}」不是日期，已留空` };
      return { value: d, note: null };
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw, note: null };
      const b = parseBoolean(String(raw));
      if (b === null || b === undefined) {
        const s = String(raw).trim().toLowerCase();
        if (s === 'true' || s === 'yes' || s === '1') return { value: true, note: null };
        if (s === 'false' || s === 'no' || s === '0') return { value: false, note: null };
        return { value: null, note: `「${String(raw).slice(0, 24)}」不是是否值，已留空` };
      }
      return { value: Boolean(b), note: null };
    }

    // A url column keeps whatever it was given as text. Whether that text is
    // also a link is decided at write time (`linkTarget`), so a cell that is not
    // a link loses nothing — it is shown, just not clickable.
    case 'url':
    default:
      return { value: clampText(raw), note: null };
  }
}

/**
 * A date that came back from JSON, or null.
 *
 * `new Date(string)` is deliberately not used on its own: it accepts almost
 * anything (`new Date('5')` is a valid date in 2001) and a text column that
 * happens to read "March" would silently become a date. Only the two shapes
 * this codebase itself writes are accepted — an ISO timestamp, and a bare
 * `YYYY-MM-DD`, which is what `parseDate` emits before `Date` takes over.
 */
function isoToDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null;
  // A time with no zone is UTC, like a bare date and like every date here.
  // `new Date` reads it as LOCAL time, so 10:00 became 02:00Z in Shanghai and
  // the serial in the file depended on the machine.
  let iso = s.includes('T') || s.includes(' ') ? s.replace(' ', 'T') : `${s}T00:00:00.000`;
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Map a free-form type name onto a known one. */
export function normalizeType(raw: unknown): ColumnType {
  if (isBlank(raw)) return 'text';
  const s = String(raw).trim().toLowerCase();
  if ((TYPES as readonly string[]).includes(s)) return s as ColumnType;
  if (TYPE_ALIASES[s]) return TYPE_ALIASES[s];
  // "currency (CNY)" / "金额 元" — take the first recognised word.
  for (const word of s.split(/[^a-z\u4e00-\u9fa5]+/)) {
    if (!word) continue;
    if ((TYPES as readonly string[]).includes(word)) return word as ColumnType;
    if (TYPE_ALIASES[word]) return TYPE_ALIASES[word];
  }
  for (const [zh, en] of Object.entries(TYPE_ALIASES)) {
    if (/[\u4e00-\u9fa5]/.test(zh) && s.includes(zh)) return en;
  }
  return 'text';
}

/** Make keys unique within a sheet, keeping the first occurrence stable. */
export function uniqueKeys(columns: ColumnSpec[]): ColumnSpec[] {
  const seen = new Map<string, number>();
  for (const c of columns) {
    const n = (seen.get(c.key) || 0) + 1;
    seen.set(c.key, n);
    if (n > 1) c.key = `${c.key}_${n}`;
  }
  return columns;
}
