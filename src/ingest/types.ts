'use strict';
/**
 * The common shape every reader returns, and the options and hooks a read
 * takes.
 */

/**
 * The common shape every reader returns.
 *
 * `kind` decides which of the optional fields are populated: a table carries
 * `rows`/`header`/`table`, a text file carries `text`, an image carries only
 * metadata plus whatever an extractor added. Callers branch on `kind` and never
 * on the file extension.
 */
export interface Attachment {
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
export interface AttachmentMeta {
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
export type CellValue = string | number | boolean | Date | null;

/** One inferred column of a table. */
interface TableColumn {
  index: number;
  label: string;
  values: CellValue[];
  type: string;
}

/** A header + typed columns, as inferred from a matrix of rows. */
export interface Table {
  sheet?: string | null;
  header: string[];
  rows: CellValue[][];
  columns: TableColumn[];
  headerIndex?: number;
}

/** The hook signature for a model-backed extractor. */
export type Extractor = (
  buffer: Buffer,
  mime: string,
  filename: string,
  kind: string,
  text: string | null,
) => Promise<ExtractResult | null> | ExtractResult | null;

export interface ReadAttachmentOptions {
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
