'use strict';
/**
 * Output truncation for the file and shell tools.
 *
 * Ported from @earendil-works/pi-coding-agent 1.3.0, dist/core/tools/truncate.js
 * (MIT, Copyright (c) 2025 Mario Zechner — see ./LICENSE). Unchanged apart from
 * types; `truncateMiddle`, used only by pi's codemode, is left out.
 *
 * Two independent limits, whichever is hit first: lines and bytes. Never
 * returns partial lines, except the tail-truncation edge case of one line
 * longer than the whole byte budget.
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
/** Max chars per grep match line. */
export const GREP_MAX_LINE_LENGTH = 500;

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

/** Bytes as a short human-readable size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function untruncated(
  content: string,
  totalLines: number,
  totalBytes: number,
  maxLines: number,
  maxBytes: number,
): TruncationResult {
  return {
    content,
    truncated: false,
    truncatedBy: null,
    totalLines,
    totalBytes,
    outputLines: totalLines,
    outputBytes: totalBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/**
 * Keep the first lines/bytes — for file reads, where the beginning matters.
 * If the first line alone is over the byte limit, returns empty content with
 * `firstLineExceedsLimit`.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes)
    return untruncated(content, totalLines, totalBytes, maxLines, maxBytes);

  if (Buffer.byteLength(lines[0], 'utf-8') > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const out: string[] = [];
  let outBytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + (i > 0 ? 1 : 0);
    if (outBytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    out.push(lines[i]);
    outBytes += lineBytes;
  }
  if (out.length >= maxLines && outBytes <= maxBytes) truncatedBy = 'lines';
  const outContent = out.join('\n');
  return {
    content: outContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: out.length,
    outputBytes: Buffer.byteLength(outContent, 'utf-8'),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/**
 * Keep the last lines/bytes — for command output, where errors and results
 * come at the end. May return a partial first line when the last line of the
 * input is itself over the byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes)
    return untruncated(content, totalLines, totalBytes, maxLines, maxBytes);

  const out: string[] = [];
  let outBytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + (out.length > 0 ? 1 : 0);
    if (outBytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      if (out.length === 0) {
        const partial = truncateStringToBytesFromEnd(lines[i], maxBytes);
        out.unshift(partial);
        outBytes = Buffer.byteLength(partial, 'utf-8');
        lastLinePartial = true;
      }
      break;
    }
    out.unshift(lines[i]);
    outBytes += lineBytes;
  }
  if (out.length >= maxLines && outBytes <= maxBytes) truncatedBy = 'lines';
  const outContent = out.join('\n');
  return {
    content: outContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: out.length,
    outputBytes: Buffer.byteLength(outContent, 'utf-8'),
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/** The end of `str` within `maxBytes`, cut at a UTF-8 character boundary. */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf-8');
}

/** One line cut to `maxChars`, with a `[truncated]` mark. For grep matches. */
export function truncateLine(
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
