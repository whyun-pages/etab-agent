/* ════════════════════════════════════════════════════════════════════
   Column-name helpers.
   The browser needs A1-style references in a few places (grid headers,
   field annotations), so the small conversion lives here rather than
   being duplicated across views.
   ════════════════════════════════════════════════════════════════════ */

/** 1 → A, 26 → Z, 27 → AA */
export function colName(index) {
  let n = Math.max(1, Math.floor(index));
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A → 1, Z → 26, AA → 27 */
export function colIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** {row, col} (both 1-based) → "B3" */
export function cellRef(row, col) {
  return `${colName(col)}${row}`;
}
