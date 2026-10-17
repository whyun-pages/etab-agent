'use strict';
/**
 * Exact-text replacement for the `edit` tool.
 *
 * Ported from @earendil-works/pi-coding-agent 1.3.0, dist/core/tools/edit-diff.js
 * and dist/utils/text.js (MIT, Copyright (c) 2025 Mario Zechner — see
 * ./LICENSE). Left out: the unified-diff and patch generation, which only fed
 * pi's terminal renderer and needed the `diff` package; nothing here shows a
 * diff, and the model is told only how many blocks were replaced.
 */

export interface Edit {
  oldText: string;
  newText: string;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

interface Span {
  start: number;
  end: number;
}

/** Split a leading UTF-8 byte order mark from decoded text. */
export function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith('﻿') ? { bom: '﻿', text: content.slice(1) } : { bom: '', text: content };
}

/** The file's line ending, judged by whichever comes first. */
export function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlf = content.indexOf('\r\n');
  const lf = content.indexOf('\n');
  if (lf === -1 || crlf === -1) return '\n';
  return crlf < lf ? '\r\n' : '\n';
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * Text normalised for a forgiving match: trailing whitespace per line
 * stripped, smart quotes, Unicode dashes and special spaces made ASCII. A
 * model retyping a line rarely reproduces those exactly.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[  -   　]/g, ' ');
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): Span[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines: Span[], replacement: MatchedEdit): { startLine: number; endLine: number } {
  const start = replacement.matchIndex;
  const end = replacement.matchIndex + replacement.matchLength;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start >= lines[i].start && start < lines[i].end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) throw new Error('Replacement range is outside the base content.');
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < end) endLine++;
  if (endLine >= lines.length) throw new Error('Replacement range is outside the base content.');
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: MatchedEdit[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    const at = r.matchIndex - offset;
    result = result.substring(0, at) + r.newText + result.substring(at + r.matchLength);
  }
  return result;
}

/**
 * Apply replacements matched against a normalised view (`baseContent`) to the
 * original, rewriting only the lines they touch: every other line keeps its
 * original bytes, so a fuzzy match does not quietly re-quote the whole file.
 */
function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: MatchedEdit[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error('Cannot preserve unchanged lines because the base content has a different line count.');
  }
  const groups: { startLine: number; endLine: number; replacements: MatchedEdit[] }[] = [];
  for (const r of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
    const range = getReplacementLineRange(baseLines, r);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(r);
      continue;
    }
    groups.push({ ...range, replacements: [r] });
  }
  let originalLineIndex = 0;
  let result = '';
  for (const g of groups) {
    result += originalLines.slice(originalLineIndex, g.startLine).join('');
    const from = baseLines[g.startLine].start;
    const to = baseLines[g.endLine - 1].end;
    result += applyReplacements(baseContent.slice(from, to), g.replacements, from);
    originalLineIndex = g.endLine;
  }
  return result + originalLines.slice(originalLineIndex).join('');
}

/** `oldText` in `content`: exactly first, then in fuzzy-normalised space. */
function fuzzyFindText(
  content: string,
  oldText: string,
): { found: boolean; index: number; matchLength: number; usedFuzzyMatch: boolean } {
  const exact = content.indexOf(oldText);
  if (exact !== -1) return { found: true, index: exact, matchLength: oldText.length, usedFuzzyMatch: false };
  const fuzzyOld = normalizeForFuzzyMatch(oldText);
  const fuzzy = normalizeForFuzzyMatch(content).indexOf(fuzzyOld);
  if (fuzzy === -1) return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  return { found: true, index: fuzzy, matchLength: fuzzyOld.length, usedFuzzyMatch: true };
}

function countOccurrences(content: string, oldText: string): number {
  return normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1;
}

function notFound(path: string, i: number, total: number): Error {
  return new Error(
    total === 1
      ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
      : `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
  );
}

function duplicate(path: string, i: number, total: number, n: number): Error {
  return new Error(
    total === 1
      ? `Found ${n} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
      : `Found ${n} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}

/**
 * Apply one or more replacements to LF-normalised content. All edits are
 * matched against the same original; they must be unique and must not
 * overlap. If any needed the fuzzy match, the whole operation runs in
 * normalised space and is laid back over the original line by line.
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): { baseContent: string; newContent: string } {
  const normalized = edits.map((e) => ({ oldText: normalizeToLF(e.oldText), newText: normalizeToLF(e.newText) }));
  normalized.forEach((e, i) => {
    if (e.oldText.length === 0) {
      throw new Error(
        normalized.length === 1
          ? `oldText must not be empty in ${path}.`
          : `edits[${i}].oldText must not be empty in ${path}.`,
      );
    }
  });
  const usedFuzzy = normalized.some((e) => fuzzyFindText(normalizedContent, e.oldText).usedFuzzyMatch);
  const base = usedFuzzy ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
  const matched: MatchedEdit[] = [];
  normalized.forEach((e, i) => {
    const m = fuzzyFindText(base, e.oldText);
    if (!m.found) throw notFound(path, i, normalized.length);
    const n = countOccurrences(base, e.oldText);
    if (n > 1) throw duplicate(path, i, normalized.length, n);
    matched.push({ editIndex: i, matchIndex: m.index, matchLength: m.matchLength, newText: e.newText });
  });
  matched.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matched.length; i++) {
    const prev = matched[i - 1];
    const cur = matched[i];
    if (prev.matchIndex + prev.matchLength > cur.matchIndex) {
      throw new Error(
        `edits[${prev.editIndex}] and edits[${cur.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }
  const newContent = usedFuzzy
    ? applyReplacementsPreservingUnchangedLines(normalizedContent, base, matched)
    : applyReplacements(base, matched);
  if (newContent === normalizedContent) {
    throw new Error(
      normalized.length === 1
        ? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
        : `No changes made to ${path}. The replacements produced identical content.`,
    );
  }
  return { baseContent: normalizedContent, newContent };
}
