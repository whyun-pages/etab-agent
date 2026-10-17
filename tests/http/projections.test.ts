'use strict';
/**
 * The attachment block the model reads each turn (`attachmentContext`). The
 * route test (session-api.turn.test.ts) checks it reaches the model and never
 * the stored history; this pins what the block itself says, because evals/run.js
 * builds the same block without going through the route.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAttachment } from '../../src/ingest/ingest.ts';
import { attachmentContext } from '../../src/http/projections.ts';

test('attachmentContext: no attachments is an empty string, not an empty block', () => {
  assert.equal(attachmentContext([]), '');
});

test('attachmentContext: a table shows its header, its preview rows and how to read the rest', async () => {
  const csv = [
    '工号,姓名,工资',
    ...Array.from({ length: 8 }, (_, i) => `E00${i + 1},员工${i + 1},${8000 + i * 100}`),
  ].join('\n');
  const att = await readAttachment(Buffer.from(csv, 'utf8'), '工资.csv');
  const text = attachmentContext([att]);

  assert.match(text, /^--- 附件资料 ---\n【附件：工资\.csv】/);
  assert.match(text, /共 8 行/);
  assert.match(text, /read_attachment/);
  assert.match(text, /列：工号、姓名、工资/);
  assert.match(text, /E001\t员工1\t8000/);
  // A preview, not the whole file.
  assert.doesNotMatch(text, /E008/);
});

test('attachmentContext: a text file shows its opening and the full length when cut', async () => {
  const body = '合同编号：HT-2026-001\n'.repeat(200);
  const att = await readAttachment(Buffer.from(body, 'utf8'), '合同.txt');
  const text = attachmentContext([att]);

  assert.match(text, /【附件：合同\.txt】\n合同编号：HT-2026-001/);
  assert.match(text, new RegExp(`共 ${body.length} 字`));
});
