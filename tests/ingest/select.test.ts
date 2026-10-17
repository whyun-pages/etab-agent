'use strict';
/**
 * Finding an attachment by the name a model used, and a table inside it.
 * These used to live with the tools; they are exercised through
 * read_attachment and query_table in tests/agent/, and directly here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAttachment, attachmentTable, headerOnlyNote } from '../../src/ingest/select.ts';
import type { Attachment, Table } from '../../src/ingest/types.ts';

function table(sheet: string | null, rows: unknown[][]): Table {
  return { sheet, header: ['a', 'b'], rows: rows as Table['rows'], columns: [] };
}

function att(name: string, extra: Partial<Attachment> = {}): Attachment {
  return { kind: 'table', name, meta: { size: 0, ext: '.xlsx', kind: 'xlsx', filename: name }, ...extra };
}

test('findAttachment: exact, then case-insensitive, then by stem without folder or extension', () => {
  const list = [att('订单/BTCP.xlsx'), att('Notes.txt', { kind: 'text' })];
  assert.equal(findAttachment(list, '订单/BTCP.xlsx').name, '订单/BTCP.xlsx');
  assert.equal(findAttachment(list, 'notes.txt').name, 'Notes.txt');
  assert.equal(findAttachment(list, 'BTCP').name, '订单/BTCP.xlsx');
  assert.equal(findAttachment(list, 'btcp.csv').name, '订单/BTCP.xlsx');
});

test('findAttachment: an ambiguous stem names the candidates; a miss lists what there is', () => {
  const list = [att('a/报表.xlsx'), att('b/报表.xlsx')];
  assert.throws(() => findAttachment(list, '报表'), /2 个附件都叫「报表」.*a\/报表\.xlsx、b\/报表\.xlsx/);
  assert.throws(
    () => findAttachment(list, '清单.xlsx'),
    /没有名为「清单\.xlsx」的附件。现有：a\/报表\.xlsx、b\/报表\.xlsx/,
  );
});

test('attachmentTable: the default table, a named sheet, and the errors for a wrong name', () => {
  const one = table('Sheet1', [[1, 2]]);
  const two = table('二月', [[3, 4]]);
  const book = att('全年.xlsx', { table: one, sheets: [one, two] });
  assert.equal(attachmentTable(book, undefined), one);
  assert.equal(attachmentTable(book, ' 二月 '), two);
  assert.equal(attachmentTable(book, 'sheet1'), one);
  assert.throws(() => attachmentTable(book, '三月'), /没有工作表「三月」。现有：Sheet1、二月/);

  const single = att('单表.xlsx', { table: one });
  assert.throws(() => attachmentTable(single, 'x'), /只有一张表，不用指定 sheet/);
  assert.equal(attachmentTable(att('说明.txt', { kind: 'text', text: 'hi' }), undefined), null);
});

test('headerOnlyNote: says it is the file, not a failed read, and how many columns there are', () => {
  const note = headerOnlyNote(7);
  assert.match(note, /只有表头（7 列）/);
  assert.match(note, /不是读取失败/);
});
