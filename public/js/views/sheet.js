/* ════════════════════════════════════════════════════════════════════
   Sheet grid — renders a workbook preview as a spreadsheet-like table.

   Cells arrive as a dense 2-D array of primitive values on a second grid of
   format codes, so the grid receives raw stored values — which is what a
   spreadsheet stores but not what a person reads. A date is a day count
   (46082) and a percent is a fraction (0.06); both are correct and both look
   wrong on screen. The format code travels with the cell, so the fix belongs
   here rather than in the reader.
   ════════════════════════════════════════════════════════════════════ */

import { el } from '../dom.js';
import { colName } from '../colname.js';

/**
 * @param {{name?:string, rows:Array<Array<*>>, merged?:string[],
 *          formats?:Array<Array<string|null>>, cols?:Array, truncated?:boolean}} sheet
 * @returns {HTMLElement}
 */
export function sheetView(sheet) {
  const rows = (sheet && sheet.rows) || [];
  const formats = (sheet && sheet.formats) || [];
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);

  // Track which cells open a merged range so the span can be emitted once.
  const spans = parseMerges((sheet && sheet.merged) || []);

  const table = el('table', { class: 'grid' });

  // ── header: column letters ────────────────────────────────────────
  const thead = el('thead');
  const headRow = el('tr');
  headRow.append(el('th', { class: 'rownum', text: '' }));
  for (let c = 0; c < width; c++) headRow.append(el('th', { text: colName(c + 1) }));
  thead.append(headRow);
  table.append(thead);

  const tbody = el('tbody');
  rows.forEach((row, r) => {
    const tr = el('tr');
    tr.append(el('th', { class: 'rownum', text: String(r + 1) }));

    for (let c = 0; c < width; c++) {
      const span = spans.get(`${r + 1}:${c + 1}`);
      if (span && span.skip) continue;

      const v = row[c];
      const fmt = formats[r] ? formats[r][c] : null;
      const cls = [];
      let text = '';

      if (v === null || v === undefined || v === '') {
        cls.push('is-empty');
      } else if (typeof v === 'number') {
        cls.push('is-num');
        text = formatCell(v, fmt);
        if (fmt) cls.push('has-fmt');
      } else if (typeof v === 'boolean') {
        text = v ? '是' : '否';
      } else {
        text = String(v);
        if (text.startsWith('=')) cls.push('is-formula');
        // A row-1 value under a horizontal merge is the sheet title.
        if (r === 0 && span && span.colSpan > 1) cls.push('is-merged');
      }

      const td = el('td', { class: cls.join(' '), text, title: text || undefined });
      if (span && span.colSpan > 1) td.colSpan = span.colSpan;
      tr.append(td);
    }
    tbody.append(tr);
  });
  table.append(tbody);

  const wrap = el('div', { class: 'grid-wrap' }, [table]);
  if (sheet && sheet.truncated) {
    wrap.append(el('p', { class: 'hint', text: '预览已截断，仅显示左上角区域。' }));
  }
  return wrap;
}

/** Parse A1:C3 style ranges into { colSpan, rowSpan, skip } keyed by "r:c". */
function parseMerges(merges) {
  const map = new Map();
  for (const ref of merges) {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(ref);
    if (!m) continue;
    const c1 = colIndex(m[1]);
    const r1 = Number(m[2]);
    const c2 = colIndex(m[3]);
    const r2 = Number(m[4]);
    const colSpan = c2 - c1 + 1;
    const rowSpan = r2 - r1 + 1;
    map.set(`${r1}:${c1}`, { colSpan, rowSpan, skip: false });
    // Every other cell in the range is absorbed by the anchor.
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r === r1 && c === c1) continue;
        map.set(`${r}:${c}`, { skip: true });
      }
    }
  }
  return map;
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function formatNumber(v) {
  if (Number.isInteger(v)) return new Intl.NumberFormat('zh-CN').format(v);
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(v);
}

// ── number formats ────────────────────────────────────────────────────

/**
 * Codes that merely count or scale a number, not a date or a percentage.
 *
 * The currency symbols are escaped on purpose: `[¥$€£]` reads as the RANGE
 * from ¥ to $, which sweeps in %, &, ', (, ), *, + and more — so `0.00%`
 * matched "plain number" and the percent branch below never ran.
 */
const NON_DATE = /^[#0,.\s%¥\$€£()\-+_]*$/;

/** The currency token in a format code, if it has one. */
const CURRENCY = /[¥￥\$€£]/;

/**
 * Render one cell the way the format code asks for.
 *
 * Deliberately narrow. This is a preview, and a hand-rolled Excel format
 * engine that gets 90% of codes right would be worse than one that renders the
 * common cases and shows the plain number for the rest — a wrong-looking date
 * is more misleading than an unformatted number.
 *
 * @param {number} v
 * @param {string|null} fmt
 * @returns {string}
 */
export function formatCell(v, fmt) {
  if (!fmt || fmt === 'General') return formatNumber(v);
  const bare = stripLiterals(fmt);
  // Percent first: it scales the value, so it has to be decided before any
  // branch that would just group the number as-is.
  if (bare.includes('%')) return formatNumber(v * 100) + '%';
  if (looksLikeDate(fmt)) {
    const d = serialToDate(v);
    if (d) return formatDate(d, fmt);
  }
  // Money: keep the sign the format asks for, then group the number.
  const cur = CURRENCY.exec(bare);
  if (cur && /[#0]/.test(bare)) return cur[0] + formatNumber(Math.abs(v));
  return formatNumber(v);
}

/**
 * A format code with its quoted literals and colour/condition sections removed.
 * `#,##0.00"元"` should not be read as containing a percent because a literal
 * happens to; `[Red]` and `[>=100]` carry no formatting intent here.
 */
function stripLiterals(fmt) {
  return String(fmt)
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
}

function looksLikeDate(fmt) {
  if (NON_DATE.test(fmt)) return false;
  const bare = stripLiterals(fmt);
  // A date code needs a day or year token; `0.00%` has neither, and `mm`
  // alone is ambiguous between months and minutes.
  return /[yYdD]/.test(bare);
}

/** Excel serial to a Date, using the same 1899-12-30 epoch as lib/workbook.js. */
function serialToDate(serial) {
  const ms = Math.round(serial * 86400000);
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(d, fmt) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const p2 = (n) => String(n).padStart(2, '0');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (/d-?mmm/i.test(fmt)) return `${day}-${MON[m - 1]}-${String(y).slice(2)}`;
  if (/yyyy[-\/.]mm[-\/.]dd/i.test(fmt)) return `${y}-${p2(m)}-${p2(day)}`;
  if (/^m\/d/i.test(fmt)) return `${m}/${day}/${y}`;
  return `${y}-${p2(m)}-${p2(day)}`;
}
