'use strict';
/**
 * What a file is: the extensions each reader takes, and the leading-bytes
 * sniff that decides a file's real type regardless of its name.
 */

import path from 'node:path';
import { readZip } from '../formats/xlsx.ts';
import { cfbStreamNames, isCfb } from '../formats/xls.ts';

export const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.log',
  '.ini',
  '.conf',
  '.yml',
  '.yaml',
  '.sql',
  '.sh',
  '.ps1',
  '.js',
  '.ts',
  '.py',
]);
export const TABLE_EXT = new Set(['.xlsx', '.xlsm', '.xls', '.csv', '.tsv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
/**
 * Everything `readAttachment` reads into something useful. Used to choose the
 * members of an archive or a folder worth reading: the rest (executables,
 * fonts, `.DS_Store`) would each become an "unknown" chip and a line of noise
 * in the model's context.
 */
export const READABLE_EXT = new Set([
  ...TEXT_EXT,
  ...TABLE_EXT,
  ...IMAGE_EXT,
  '.json',
  '.jsonl',
  '.ndjson',
  '.docx',
  '.html',
  '.htm',
  '.xml',
  '.m3u',
  '.m3u8',
  '.pdf',
]);

/** Archive limits: generous for real work, small next to the process's memory. */
export const ARCHIVE_MAX_ENTRIES = 2000;
export const ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;

/** A file type recognised by its leading bytes. */
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
    // ZIP container: could be xlsx, docx, pptx, or a plain zip. Read with the
    // archive limits: this runs on every upload, and an unbounded read here is
    // where a zip bomb would go off. Over the limit is its own kind, so the
    // extension fallback below cannot hand the same bytes to an unbounded
    // reader (`.xlsx` → readWorkbook).
    try {
      const zip = readZip(buffer, { maxEntries: ARCHIVE_MAX_ENTRIES, maxBytes: ARCHIVE_MAX_BYTES });
      if (zip.has('xl/workbook.xml')) return 'xlsx';
      if (zip.has('word/document.xml')) return 'docx';
      if (zip.has('ppt/presentation.xml')) return 'pptx';
      return 'zip';
    } catch (err) {
      if (/压缩包/.test(String((err as Error).message))) return 'oversize';
      /* otherwise fall through to extension */
    }
  }
  if (isCfb(buffer)) {
    // OLE2 compound file: legacy .xls, .doc and .ppt all share this container.
    // Only the .xls case is read; the others fall through to their extension.
    try {
      // Names only: telling .xls from .doc needs the directory, not the data.
      const names = cfbStreamNames(buffer);
      if (names.has('Workbook') || names.has('WORKBOOK') || names.has('Book')) return 'xls';
    } catch {
      /* fall through to extension */
    }
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  for (const { ext: magicExt, sig } of IMAGE_MAGIC) {
    if (buffer.length >= sig.length && sig.every((b, i) => buffer[i] === b))
      return magicExt === 'jpg' ? 'jpeg' : magicExt;
  }
  if (ext) return ext.slice(1);
  return 'unknown';
}

export const isImage = (kind: string): boolean =>
  ['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp', 'tiff', 'tif'].includes(kind);
