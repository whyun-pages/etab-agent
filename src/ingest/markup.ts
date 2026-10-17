'use strict';
/**
 * Text out of markup: a .docx's paragraphs and tables (WordprocessingML),
 * and HTML/XML reduced to readable lines.
 */

import { readZip } from '../formats/xlsx.ts';

// -------------------------------------------------------------------- docx

interface DocxText {
  text: string;
  tables: string[][][];
}

/** Extract visible text from a WordprocessingML document part. */
export function docxText(buffer: Buffer): DocxText | null {
  let zip: ReturnType<typeof readZip>;
  try {
    zip = readZip(buffer);
  } catch {
    return null;
  }
  const doc = zip.get('word/document.xml');
  if (!doc) return null;
  const xml = doc.data.toString('utf8');

  const paragraphs: string[] = [];
  // Split on paragraph boundaries, then join runs inside each paragraph.
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g;
  let m;
  while ((m = paraRe.exec(xml))) {
    const text = runText(m[1] || '');
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
      while ((tc = tcRe.exec(tr[1]))) cells.push(runText(tc[1]).trim());
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }

  return { text: paragraphs.join('\n').replace(/\n{3,}/g, '\n\n'), tables };
}

/**
 * The text of a run of WordprocessingML, in document order: <w:t> as text,
 * <w:tab/> as a tab, <w:br/> and <w:cr/> as a line break.
 *
 * Only the <w:t> elements were read before, and the "tab and break elements
 * map to whitespace" step was a replace of \t by \t — so 姓名<w:tab/>张三
 * came out as 姓名张三, and a line break inside a paragraph vanished.
 * (`<w:t\b` does not match <w:tab>, <w:tbl> or <w:tc>: the next character is
 * a letter, so there is no word boundary.)
 */
function runText(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/?>/g)) {
    if (m[2] === 'tab') out += '\t';
    else if (m[2]) out += '\n';
    else out += decodeEntities(m[1]);
  }
  return out;
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
