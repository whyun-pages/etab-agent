'use strict';
/**
 * CSV and TSV: RFC 4180 parsing, delimiter sniffing, and decoding the bytes
 * (UTF-8 with or without a BOM, else GBK).
 */

// --------------------------------------------------------------------- CSV

/**
 * Parse CSV/TSV text. Handles a UTF-8 BOM, quoted fields with embedded
 * delimiters and newlines, and doubled quotes.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const delim = delimiter || guessDelimiter(src);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      // CRLF and lone CR both terminate a record.
      if (src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing record without a final newline.
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Pick the delimiter that yields the most consistent column count. */
export function guessDelimiter(text: string): string {
  const sample = text
    .slice(0, 8192)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 20);
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const counts = sample.map((line) => countOutsideQuotes(line, d));
    if (!counts.length) continue;
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    if (avg < 1) continue;
    const variance = counts.reduce((a, c) => a + (c - avg) ** 2, 0) / counts.length;
    const score = avg - variance;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, delim: string): number {
  let n = 0,
    inQ = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQ && line[i + 1] === '"') {
        i++;
        continue;
      }
      inQ = !inQ;
    } else if (line[i] === delim && !inQ) n++;
  }
  return n;
}

/**
 * Decode text that may be UTF-8 or GBK. Node cannot decode GBK natively, so we
 * detect invalid UTF-8 sequences and fall back to a lossy Latin-1 read rather
 * than producing replacement characters everywhere.
 */
export function decodeText(buffer: Buffer): { text: string; encoding: string } {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  const asUtf8 = buffer.toString('utf8');
  if (!asUtf8.includes('\ufffd')) return { text: asUtf8, encoding: 'utf-8' };
  try {
    const decoder = new TextDecoder('gbk', { fatal: false });
    return { text: decoder.decode(buffer), encoding: 'gbk' };
  } catch {
    return { text: buffer.toString('latin1'), encoding: 'latin1' };
  }
}
