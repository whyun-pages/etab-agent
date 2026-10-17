'use strict';
/**
 * Attachment readers — turn an uploaded file into text or rows that the
 * generation engine can use.
 *
 * Supported without any external service:
 *   .xlsx/.xlsm  rows (via our own reader)
 *   .xls         rows (Excel 97-2003 / BIFF8, via src/formats/xls.ts)
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
import { readWorkbook } from '../formats/xlsx.ts';
import type { ParsedSheet } from '../formats/xlsx.ts';
import { readXls } from '../formats/xls.ts';
import type { Attachment, AttachmentMeta, ReadAttachmentOptions } from './types.ts';
import { TEXT_EXT, ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_BYTES, sniffKind, isImage } from './kinds.ts';
import { expandZip } from './archive.ts';
import { parseCsv, guessDelimiter, decodeText } from './csv.ts';
import { matrixToTable } from './table.ts';
import { docxText, markupToText } from './markup.ts';
import { imageDimensions } from './image.ts';
import { m3uToMatrix } from './m3u.ts';
import { tryParseJson, jsonToTable } from './json.ts';
import { sheetToMatrix, MATRIX_MAX_CELLS, gridSize } from './grid.ts';

// ------------------------------------------------------------------ entry

/**
 * Read one attachment.
 */
export async function readAttachment(
  buffer: Buffer,
  filename: string,
  opts: ReadAttachmentOptions = {},
): Promise<Attachment> {
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
      return { ...base, extractError: String((err && (err as Error).message) || err) };
    }
  };

  if (kind === 'oversize') {
    return {
      ...unknownAttachment(buffer, filename, meta),
      note: `${filename} 解压后超过 ${ARCHIVE_MAX_BYTES / 1024 / 1024}MB 或文件数超过 ${ARCHIVE_MAX_ENTRIES} 个，没有读取。`,
    };
  }

  // ---- spreadsheets
  // Checked on the sniffed kind first: an .xls renamed to .xlsx (common when a
  // system "upgrades" an export by extension only) must not reach readWorkbook.
  if (kind === 'xls') {
    let parsed: ReturnType<typeof readXls>;
    try {
      parsed = readXls(buffer);
    } catch (err) {
      // Encrypted and Excel 95 files are reported, not dropped silently: the
      // note tells the model what to ask the user for.
      return { ...unknownAttachment(buffer, filename, meta), note: `${filename} 读取失败：${(err as Error).message}` };
    }
    return workbookAttachment(parsed.sheets, filename, meta, opts.sheet);
  }

  if (kind === 'xlsx' || kind === 'xlsm' || ext === '.xlsx' || ext === '.xlsm') {
    return workbookAttachment(readWorkbook(buffer).sheets, filename, meta, opts.sheet);
  }

  if (kind === 'csv' || kind === 'tsv' || ext === '.csv' || ext === '.tsv') {
    const { text, encoding } = decodeText(buffer);
    const delimiter = ext === '.tsv' ? '\t' : undefined;
    const rows = parseCsv(text, delimiter);
    const table = matrixToTable(rows);
    return withTextModel(
      {
        kind: 'table',
        name: filename,
        meta: { ...meta, encoding, rowCount: table.rows.length, delimiter: delimiter || guessDelimiter(text) },
        table,
        rows: table.rows,
        header: table.header,
        text,
      },
      table.rows
        .map((r) => r.join('\t'))
        .join('\n')
        .slice(0, 60_000),
    );
  }

  // ---- docx
  if (kind === 'docx') {
    const parsed = docxText(buffer);
    if (!parsed) return unknownAttachment(buffer, filename, meta);
    const table = parsed.tables.length ? matrixToTable(parsed.tables[0]) : null;
    return withTextModel(
      {
        kind: 'text',
        name: filename,
        meta: { ...meta, embeddedTables: parsed.tables.length },
        text: parsed.text,
        table,
        tables: parsed.tables.map((t) => matrixToTable(t)),
      },
      parsed.text,
    );
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

  // ---- m3u / m3u8 playlists
  // A playlist is a table in disguise — one entry per channel, with a name,
  // attributes and a URL — and the user asking for one almost always wants
  // that table. Read as plain text, the model would have to transcribe every
  // entry by hand; read as a table, it can be imported whole.
  if (
    ext === '.m3u' ||
    ext === '.m3u8' ||
    (looksLikeText(buffer) && /^\uFEFF?#EXTM3U/i.test(buffer.subarray(0, 16).toString('utf8')))
  ) {
    const { text, encoding } = decodeText(buffer);
    const matrix = m3uToMatrix(text);
    if (matrix) {
      const table = matrixToTable(matrix);
      return {
        kind: 'table',
        name: filename,
        meta: { ...meta, encoding, rowCount: table.rows.length },
        table,
        rows: table.rows,
        header: table.header,
        text,
      };
    }
    return { kind: 'text', name: filename, meta: { ...meta, encoding }, text };
  }

  // ---- markup / plain text
  if (ext === '.html' || ext === '.htm' || ext === '.xml' || ext === '.svg' || kind === 'html') {
    const { text, encoding } = decodeText(buffer);
    const flat = markupToText(text);
    return withTextModel({ kind: 'text', name: filename, meta: { ...meta, encoding }, text: flat, raw: text }, flat);
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
        base.extractError = String((err && (err as Error).message) || err);
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

/** One file as `ingestFile` read it: parsed, or the reason it could not be. */
export interface Ingested {
  /** what the user and the model see: `box3.zip/订单/5月.xlsx` for an archive member */
  name: string;
  /** the bare file name, for writing a copy to open */
  filename: string;
  data: Buffer;
  att?: Attachment;
  error?: string;
}

/**
 * Read one file as attachments: itself, or — for a plain ZIP — each readable
 * member, named by its path inside the archive.
 *
 * A .docx or .xlsx is a ZIP too; `sniffKind` tells them apart, so only an
 * archive that is nothing else is opened. Members are read WITHOUT the model
 * extractors: an archive can hold a hundred images, and a hundred vision calls
 * for one upload is not something to do unasked. The deterministic reading is
 * what every member gets.
 */
export async function ingestFile(
  data: Buffer,
  name: string,
  opts: ReadAttachmentOptions = {},
): Promise<{ items: Ingested[]; skipped: string[] }> {
  const base = path.basename(name.replace(/\\/g, '/'));
  if (sniffKind(data, name) !== 'zip') {
    try {
      return { items: [{ name, filename: base, data, att: await readAttachment(data, name, opts) }], skipped: [] };
    } catch (err) {
      return { items: [{ name, filename: base, data, error: String((err as Error).message || err) }], skipped: [] };
    }
  }
  let expanded: ReturnType<typeof expandZip>;
  try {
    expanded = expandZip(data);
  } catch (err) {
    return { items: [{ name, filename: base, data, error: `解压失败：${(err as Error).message}` }], skipped: [] };
  }
  const items: Ingested[] = [];
  for (const m of expanded.members) {
    const memberName = `${name}/${m.path}`;
    const filename = path.basename(m.path);
    try {
      items.push({ name: memberName, filename, data: m.data, att: await readAttachment(m.data, memberName) });
    } catch (err) {
      items.push({ name: memberName, filename, data: m.data, error: String((err as Error).message || err) });
    }
  }
  if (!items.length) {
    items.push({
      name,
      filename: base,
      data,
      error: `压缩包里没有能读的文件${expanded.skipped.length ? `（跳过了 ${expanded.skipped.length} 个不支持的文件）` : ''}`,
    });
  }
  return { items, skipped: expanded.skipped };
}

/** A workbook is a set of tables, one per sheet; .xlsx and .xls share this. */
function workbookAttachment(
  parsedSheets: ParsedSheet[],
  filename: string,
  meta: AttachmentMeta,
  sheet?: string,
): Attachment {
  const sheets = parsedSheets.map((s) => matrixToTable(sheetToMatrix(s), { sheetName: s.name }));
  const primary = sheet ? sheets.find((t) => t.sheet === sheet) : null;
  const chosen = primary || sheets.find((t) => t.rows.length) || sheets[0] || null;
  // Rows cut by the grid limit are said out loud: a count or a sum over this
  // table would otherwise be silently short.
  const cut = parsedSheets
    .map((s) => ({ name: s.name, dropped: gridSize(s).droppedRows }))
    .filter((s) => s.dropped > 0)
    .map((s) => `「${s.name}」末尾 ${s.dropped} 行`);
  return {
    kind: 'table',
    name: filename,
    meta: { ...meta, sheetNames: parsedSheets.map((s) => s.name) },
    sheets,
    table: chosen,
    rows: chosen ? chosen.rows : [],
    header: chosen ? chosen.header : [],
    ...(cut.length
      ? {
          note: `${filename} 太大，超过 ${MATRIX_MAX_CELLS} 个单元格的读取上限，${cut.join('、')}没有读取。`,
        }
      : {}),
  };
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
  return (
    {
      png: 'image/png',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      tiff: 'image/tiff',
    }[kind] || 'application/octet-stream'
  );
}
