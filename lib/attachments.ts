'use strict';
/**
 * Attachment readers — turn an uploaded file into text or rows that the
 * generation engine can use.
 *
 * Supported without any external service:
 *   .xlsx/.xlsm  rows (via our own reader)
 *   .csv/.tsv    rows (RFC 4180 quoting, GBK/UTF-8 aware)
 *   .json/.jsonl rows or object
 *   .txt/.md/.log/.xml/.html  text
 *   .docx/.xlsx-embedded-office  text (WordprocessingML, via ZIP+XML)
 *   images        metadata only, unless an extractor (model) is supplied
 *
 * Everything returns a common shape so the generator never has to branch on
 * file type:
 *   { kind: 'table'|'text'|'image'|'unknown', name, rows?, text?, meta }
 */

import path from 'node:path';
import * as xlsx from './xlsx.ts';

/**
 * The part of `lib/xlsx.ts` this module calls.
 *
 * Kept as an explicit shape even though `import * as` carries the module's own
 * types: it documents the exact surface this reader depends on, and it is what
 * `readZip`/`readWorkbook` are destructured through below.
 */
interface XlsxModule {
  readZip(buf: Buffer): Map<string, import('./zip.ts').ZipEntry>;
  readWorkbook(buf: Buffer): import('./xlsx.ts').Workbook;
}

const { readZip, readWorkbook }: XlsxModule = xlsx;

export const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.log', '.ini', '.conf', '.yml', '.yaml', '.sql', '.sh', '.ps1', '.js', '.ts', '.py']);
export const TABLE_EXT = new Set(['.xlsx', '.xlsm', '.csv', '.tsv']);
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);

/**
 * The common shape every reader returns.
 *
 * `kind` decides which of the optional fields are populated: a table carries
 * `rows`/`header`/`table`, a text file carries `text`, an image carries only
 * metadata plus whatever an extractor added. Callers branch on `kind` and never
 * on the file extension.
 */
interface Attachment {
  kind: 'table' | 'text' | 'image' | 'unknown';
  name: string;
  meta: AttachmentMeta;
  rows?: CellValue[][];
  header?: string[];
  text?: string | null;
  table?: Table | null;
  sheets?: Table[];
  tables?: Table[];
  data?: unknown;
  raw?: string;
  note?: string;
  error?: string;
  extractError?: string;
  extracted?: ExtractResult | null;
}

/** Metadata common to every attachment, plus whatever the reader learned. */
interface AttachmentMeta {
  size: number;
  ext: string;
  kind: string;
  filename: string;
  sheetNames?: string[];
  encoding?: string;
  rowCount?: number;
  delimiter?: string;
  embeddedTables?: number;
  mime?: string;
  width?: number;
  height?: number;
}

/** Whatever a model-backed extractor hands back. Shape is the hook's own. */
interface ExtractResult {
  text?: string | null;
  table?: Table | null;
  fields?: unknown[];
  records?: unknown[];
  [key: string]: unknown;
}

/** A value that may appear in a table cell. */
type CellValue = string | number | boolean | Date | null;

/** One inferred column of a table. */
interface TableColumn {
  index: number;
  label: string;
  values: CellValue[];
  type: string;
}

/** A header + typed columns, as inferred from a matrix of rows. */
interface Table {
  sheet?: string | null;
  header: string[];
  rows: CellValue[][];
  columns: TableColumn[];
  headerIndex?: number;
}

/** The hook signature for a model-backed extractor. */
type Extractor = (buffer: Buffer, mime: string, filename: string, kind: string, text: string | null) => Promise<ExtractResult | null> | ExtractResult | null;

interface ReadAttachmentOptions {
  /**
   * Optional model-backed OCR/vision hook for images.
   */
  imageExtractor?: Extractor;
  /**
   * Optional model-backed field-extraction hook for text-bearing files
   * (.txt, .docx, .csv, .html). Sits beside imageExtractor so the same model
   * plumbing serves both, with the deterministic reading kept as the fallback
   * when it fails.
   */
  textExtractor?: Extractor;
  /** specific sheet name for workbooks */
  sheet?: string;
}

/** What a parsed Excel document looks like, reduced to what sniffing needs. */
interface RawImageSignature {
  ext: string;
  sig: number[];
}

const IMAGE_MAGIC: RawImageSignature[] = [
  { ext: 'png', sig: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', sig: [0xff, 0xd8, 0xff] },
  { ext: 'gif', sig: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'bmp', sig: [0x42, 0x4d] },
];

/** Detect a file's real type from its leading bytes, not its extension. */
export function sniffKind(buffer: Buffer, filename = ''): string {
  const ext = path.extname(filename).toLowerCase();
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    // ZIP container: could be xlsx, docx, pptx, or a plain zip.
    try {
      const zip = readZip(buffer);
      if (zip.has('xl/workbook.xml')) return 'xlsx';
      if (zip.has('word/document.xml')) return 'docx';
      if (zip.has('ppt/presentation.xml')) return 'pptx';
      return 'zip';
    } catch { /* fall through to extension */ }
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  for (const { ext: magicExt, sig } of IMAGE_MAGIC) {
    if (buffer.length >= sig.length && sig.every((b, i) => buffer[i] === b)) return magicExt === 'jpg' ? 'jpeg' : magicExt;
  }
  if (ext) return ext.slice(1);
  return 'unknown';
}

export const isImage = (kind: string): boolean => ['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp', 'tiff', 'tif'].includes(kind);

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
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') {
      // CRLF and lone CR both terminate a record.
      if (src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; i++; continue;
    }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  // Trailing record without a final newline.
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Pick the delimiter that yields the most consistent column count. */
export function guessDelimiter(text: string): string {
  const sample = text.slice(0, 8192).split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
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
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function countOutsideQuotes(line: string, delim: string): number {
  let n = 0, inQ = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { if (inQ && line[i + 1] === '"') { i++; continue; } inQ = !inQ; }
    else if (line[i] === delim && !inQ) n++;
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

// ------------------------------------------------------------------- tables

/** Options for text → rows scoring: numbers and dates are strong data signals. */
const NUMERIC_RE = /^-?[\d,]+(\.\d+)?%?$/;

/**
 * Convert a matrix (CSV rows or sheet rows) into a table with a header row and
 * typed columns, reusing the same inference rules as template schemas.
 */
export function matrixToTable(rows: unknown[][], { sheetName = null }: { sheetName?: string | null } = {}): Table {
  const clean = rows.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''));
  if (!clean.length) return { header: [], rows: [], columns: [] };

  const headerIdx = detectHeaderRow(clean);
  const header = (clean[headerIdx] || []).map((h, i) => {
    const t = h === null || h === undefined ? '' : String(h).trim();
    return t || '列' + (i + 1);
  });
  const data = clean.slice(headerIdx + 1).map((r) => {
    const out: unknown[] = [];
    for (let i = 0; i < header.length; i++) {
      const v = r[i];
      // Normalise "absent" to null so callers never branch on undefined vs ''.
      out.push(v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : v);
    }
    return out;
  });

  const columns = header.map((label, i) => {
    const values = data.map((r) => coerce(r[i])).filter((v): v is CellValue => v !== null && v !== '');
    return {
      index: i,
      label,
      values,
      type: columnType(values, label),
    };
  });

  // `rows` keeps the RAW cell values (only absent normalised to null); `columns`
  // carries the coerced copies. Callers read the two differently — a sheet
  // round-trip wants the text Excel holds, the inference wants the number.
  return { sheet: sheetName, header, rows: data as CellValue[][], columns, headerIndex: headerIdx };
}

/** Pick the first row that looks like labels rather than data. */
export function detectHeaderRow(rows: unknown[][]): number {
  const limit = Math.min(rows.length, 8);
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let r = 0; r < limit; r++) {
    const row = rows[r];
    let score = 0;
    for (const cell of row) {
      const s = cell === null || cell === undefined ? '' : String(cell).trim();
      if (!s) continue;
      // Text that is not a bare number reads as a label.
      if (!NUMERIC_RE.test(s) && !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(s)) score += 2;
      else score -= 1;
    }
    // Prefer earlier rows when scores tie, and reward filling the row.
    score -= r * 0.1;
    if (score > bestScore) { bestScore = score; bestIdx = r; }
  }
  return bestIdx;
}

/** Turn a raw string cell into a number/date/string where obvious. */
export function coerce(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  const s = String(v).trim();
  if (s === '') return null;
  if (NUMERIC_RE.test(s)) {
    const cleaned = s.replace(/[,\s]/g, '').replace(/%$/, '');
    const n = Number(cleaned);
    if (Number.isFinite(n)) return /%$/.test(s) ? n / 100 : n;
  }
  return s;
}

export function columnType(values: CellValue[], label: string): string {
  if (!values.length) return 'text';
  const numeric = values.filter((v) => typeof v === 'number').length;
  const dates = values.filter((v) => v instanceof Date
    || (typeof v === 'string' && /^\d{4}[-/年]\d{1,2}([-/月]\d{1,2})?/.test(v))).length;
  const bools = values.filter((v) => typeof v === 'boolean').length;
  const total = values.length;
  if (bools / total > 0.8) return 'boolean';
  if (dates / total > 0.7) return 'date';
  if (numeric / total > 0.8) {
    if (/金额|单价|价格|总额|合计|费用|成本|税率|价|amount|price|total|cost/i.test(label)) return 'currency';
    if (values.every((v) => typeof v !== 'number' || Number.isInteger(v))) return 'integer';
    return 'number';
  }
  return 'text';
}

// -------------------------------------------------------------------- docx

interface DocxText {
  text: string;
  tables: string[][][];
}

/** Extract visible text from a WordprocessingML document part. */
export function docxText(buffer: Buffer): DocxText | null {
  let zip: ReturnType<typeof readZip>;
  try { zip = readZip(buffer); } catch { return null; }
  const doc = zip.get('word/document.xml');
  if (!doc) return null;
  const xml = doc.data.toString('utf8');

  const paragraphs: string[] = [];
  // Split on paragraph boundaries, then join runs inside each paragraph.
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g;
  let m;
  while ((m = paraRe.exec(xml))) {
    const inner = m[1] || '';
    let text = '';
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let t;
    while ((t = tRe.exec(inner))) text += decodeEntities(t[1]);
    // Tab and break elements map to whitespace.
    if (/<w:tab\b/.test(inner)) text = text.replace(/\t/g, '\t');
    if (text.trim()) paragraphs.push(text);
    else if (paragraphs.length && paragraphs[paragraphs.length - 1] !== '') paragraphs.push('');
  }

  // Tables: pull cell text out so tabular data in a doc is at least readable.
  const tables: string[][][] = [];
  const tableRe = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g;
  let tb;
  while ((tb = tableRe.exec(xml))) {
    const rows: string[][] = [];
    const trRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
    let tr;
    while ((tr = trRe.exec(tb[1]))) {
      const cells: string[] = [];
      const tcRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
      let tc;
      while ((tc = tcRe.exec(tr[1]))) {
        let text = '';
        const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
        let t;
        while ((t = tRe.exec(tc[1]))) text += decodeEntities(t[1]);
        cells.push(text.trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }

  return { text: paragraphs.join('\n').replace(/\n{3,}/g, '\n\n'), tables };
}

function decodeEntities(s: string): string {
  const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[g] ?? m;
  });
}

/** Strip tags for html/xml attachments, keeping block boundaries as newlines. */
export function markupToText(xml: string): string {
  let s = xml;
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|section|article)>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, '\t');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // Collapse runs of whitespace-only lines: a closing block tag next to a <br>
  // both emit newlines, and the blank line between them is noise.
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{2,}/g, '\n');
  s = s.replace(/\n\t/g, '\t');
  return s.trim();
}

// ------------------------------------------------------------------ entry

/**
 * Read one attachment.
 */
export async function readAttachment(buffer: Buffer, filename: string, opts: ReadAttachmentOptions = {}): Promise<Attachment> {
  const ext = path.extname(filename).toLowerCase();
  const kind = sniffKind(buffer, filename);
  const meta: AttachmentMeta = { size: buffer.length, ext, kind, filename };

  /**
   * Run the model hook over a text-bearing attachment, if one is supplied.
   *
   * Returns whatever the hook produced (fields, records, an OCR text) merged
   * onto the deterministic base under `extracted`, so downstream code sees one
   * shape regardless of whether a model was involved. A failure is recorded
   * as `extractError` and the deterministic reading stands — an attachment
   * that parsed fine by rules must not become an error because a model was
   * unreachable.
   */
  const withTextModel = async (base: Attachment, text: string): Promise<Attachment> => {
    if (typeof opts.textExtractor !== 'function') return base;
    try {
      const extracted = await opts.textExtractor(buffer, mimeFor(kind), filename, kind, text);
      if (!extracted) return base;
      return {
        ...base,
        extracted,
        // Prefer the model's structured table when it produced one; keep the
        // rule-based table otherwise.
        table: extracted.table || base.table,
        text: extracted.text || base.text,
      };
    } catch (err) {
      return { ...base, extractError: String(err && (err as Error).message || err) };
    }
  };

  // ---- spreadsheets
  if (kind === 'xlsx' || kind === 'xlsm' || ext === '.xlsx' || ext === '.xlsm') {
    const wb = readWorkbook(buffer);
    // A workbook is a set of tables, one per sheet.
    const sheets = wb.sheets.map((s) => matrixToTable(sheetToMatrix(s), { sheetName: s.name }));
    const primary = opts.sheet ? sheets.find((t) => t.sheet === opts.sheet) : null;
    const chosen = primary || sheets.find((t) => t.rows.length) || sheets[0] || null;
    return {
      kind: 'table',
      name: filename,
      meta: { ...meta, sheetNames: wb.sheets.map((s) => s.name), ...meta },
      sheets,
      table: chosen,
      rows: chosen ? chosen.rows : [],
      header: chosen ? chosen.header : [],
    };
  }

  if (kind === 'csv' || kind === 'tsv' || ext === '.csv' || ext === '.tsv') {
    const { text, encoding } = decodeText(buffer);
    const delimiter = ext === '.tsv' ? '\t' : undefined;
    const rows = parseCsv(text, delimiter);
    const table = matrixToTable(rows);
    return withTextModel({
      kind: 'table',
      name: filename,
      meta: { ...meta, encoding, rowCount: table.rows.length, delimiter: delimiter || guessDelimiter(text) },
      table,
      rows: table.rows,
      header: table.header,
      text,
    }, table.rows.map((r) => r.join('\t')).join('\n').slice(0, 60_000));
  }

  // ---- docx
  if (kind === 'docx') {
    const parsed = docxText(buffer);
    if (!parsed) return unknownAttachment(buffer, filename, meta);
    const table = parsed.tables.length ? matrixToTable(parsed.tables[0]) : null;
    return withTextModel({
      kind: 'text',
      name: filename,
      meta: { ...meta, embeddedTables: parsed.tables.length },
      text: parsed.text,
      table,
      tables: parsed.tables.map((t) => matrixToTable(t)),
    }, parsed.text);
  }

  // ---- json / jsonl
  if (ext === '.json' || ext === '.jsonl' || ext === '.ndjson') {
    const { text, encoding } = decodeText(buffer);
    const parsedJson = tryParseJson(text);
    if (parsedJson != null) {
      const table = jsonToTable(parsedJson);
      return {
        kind: table ? 'table' : 'text',
        name: filename,
        meta: { ...meta, encoding },
        text,
        table,
        rows: table ? table.rows : [],
        header: table ? table.header : [],
        data: parsedJson,
      };
    }
    return withTextModel({ kind: 'text', name: filename, meta: { ...meta, encoding }, text }, text);
  }

  // ---- markup / plain text
  if (ext === '.html' || ext === '.htm' || ext === '.xml' || ext === '.svg' || kind === 'html') {
    const { text, encoding } = decodeText(buffer);
    const flat = markupToText(text);
    return withTextModel(
      { kind: 'text', name: filename, meta: { ...meta, encoding }, text: flat, raw: text },
      flat,
    );
  }

  // ---- images
  if (isImage(kind)) {
    const dims = imageDimensions(buffer, kind);
    const base: Attachment = {
      kind: 'image',
      name: filename,
      meta: { ...meta, ...dims, mime: mimeFor(kind) },
      text: null,
    };
    if (typeof opts.imageExtractor === 'function') {
      try {
        // The hook receives the file kind and text so one implementation can
        // serve any attachment; older three-argument hooks still work.
        const extracted = await opts.imageExtractor(buffer, mimeFor(kind), filename, 'image', null);
        if (extracted) {
          return { ...base, extracted, text: extracted.text || null, table: extracted.table || null };
        }
      } catch (err) {
        base.extractError = String(err && (err as Error).message || err);
      }
    }
    return base;
  }

  // ---- pdf: no bundled parser
  if (kind === 'pdf') {
    return {
      kind: 'unknown',
      name: filename,
      meta,
      text: null,
      note: 'PDF 未解析：当前环境没有 PDF 解析器。可先转为文本或把关键数据放进图片/表格。',
    };
  }

  // ---- generic text by extension
  if (TEXT_EXT.has(ext) || looksLikeText(buffer)) {
    const { text, encoding } = decodeText(buffer);
    return { kind: 'text', name: filename, meta: { ...meta, encoding }, text };
  }

  return unknownAttachment(buffer, filename, meta);
}

function unknownAttachment(buffer: Buffer, filename: string, meta: AttachmentMeta): Attachment {
  void buffer;
  return {
    kind: 'unknown',
    name: filename,
    meta,
    text: null,
    note: `无法识别 ${filename} 的内容类型，已作为附件保留元信息。`,
  };
}

/** Quick heuristic: mostly printable bytes means text. */
function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 2048);
  if (!sample.length) return true;
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 0x20 && b < 0x7f)) printable++;
    else if (b >= 0x80) printable++; // multibyte utf-8 bytes count toward text
  }
  return printable / sample.length > 0.9;
}

function mimeFor(kind: string): string {
  return {
    png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff',
  }[kind] || 'application/octet-stream';
}

/** Pixel dimensions, when the header could be read. */
interface ImageDimensions {
  width?: number;
  height?: number;
}

/** Read pixel dimensions from image headers — enough to describe an image. */
export function imageDimensions(buffer: Buffer, kind: string): ImageDimensions {
  try {
    if (kind === 'png' && buffer.length > 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if ((kind === 'jpeg' || kind === 'jpg') && buffer.length > 4) {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) { i++; continue; }
        const marker = buffer[i + 1];
        const len = buffer.readUInt16BE(i + 2);
        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry dimensions.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
    if (kind === 'gif' && buffer.length > 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (kind === 'bmp' && buffer.length > 26) {
      return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
    }
  } catch { /* dimensions are best-effort */ }
  return {};
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* try jsonl */ }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 1 || (lines.length === 1 && lines[0].trim().startsWith('{'))) {
    const objs: unknown[] = [];
    for (const line of lines) {
      try { objs.push(JSON.parse(line)); } catch { return null; }
    }
    if (objs.length && objs.every((o) => o && typeof o === 'object')) return objs;
  }
  return null;
}

/** Flatten JSON into a table when it is an array of flat-ish objects. */
export function jsonToTable(data: unknown): Table | null {
  const arr = findObjectArray(data, 0);
  if (!arr) return null;

  const header: string[] = [];
  for (const item of arr.slice(0, 200)) {
    for (const k of Object.keys(item)) if (!header.includes(k)) header.push(k);
  }
  const rows = arr.map((item) => header.map((k) => flattenValue(item[k])));
  const table = matrixToTable([header, ...rows]);
  // matrixToTable may pick a different header row; force ours.
  table.header = header;
  table.rows = rows;
  table.headerIndex = 0;
  return table;
}

/**
 * Locate an array of objects anywhere in a JSON payload. API responses nest the
 * useful rows under a wrapper, so a shallow check on the top level is not enough.
 */
export function findObjectArray(data: unknown, depth: number): Array<Record<string, unknown>> | null {
  if (depth > 4) return null;
  if (Array.isArray(data)) {
    return data.length && data.every((x) => x && typeof x === 'object' && !Array.isArray(x))
      ? data as Array<Record<string, unknown>>
      : null;
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    // Prefer conventional payload keys before falling back to declaration order.
    const preferred = ['data', 'list', 'items', 'rows', 'records', 'result', 'results'];
    const keys = [...preferred.filter((k) => k in obj), ...Object.keys(obj)];
    for (const key of keys) {
      const found = findObjectArray(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function flattenValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as CellValue;
}

/** Convert a parsed sheet into a dense matrix, using cached formula values. */
export function sheetToMatrix(sheet: import('./xlsx.ts').ParsedSheet): CellValue[][] {
  const maxRow = Math.max(sheet.maxRow || 0, 1);
  const maxCol = Math.max(sheet.maxCol || 0, 1);
  const grid: CellValue[][] = Array.from({ length: maxRow }, () => new Array<CellValue>(maxCol).fill(null));
  for (const c of sheet.cells || []) {
    if (!c.row || !c.col) continue;
    if (c.row > maxRow || c.col > maxCol) continue;
    const raw = c.value;
    let v: CellValue;
    if (raw && typeof raw === 'object') {
      if ('formula' in raw) v = (raw.cached ?? null) as CellValue;
      else v = null;
    } else {
      v = raw;
    }
    grid[c.row - 1][c.col - 1] = v;
  }
  return grid;
}
