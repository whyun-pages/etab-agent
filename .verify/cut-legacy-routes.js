'use strict';
// One-shot surgery: remove the legacy template/plan/run/skill route blocks from
// lib/server.js. Deletes bottom-up so earlier line numbers stay valid.
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'lib', 'server.js');
const lines = fs.readFileSync(file, 'utf8').split('\n');

// Inclusive 1-indexed ranges, verified against the survey:
// the blank line preceding each block's banner through its last content line.
const cuts = [
  { name: 'chat', start: 360, end: 529, expectLine: 'chat', expectAt: 361 },
  { name: 'template+schema', start: 710, end: 744, expectLine: 'template', expectAt: 711 },
  { name: 'plan', start: 784, end: 816, expectLine: 'plan', expectAt: 785 },
  { name: 'generate+download', start: 817, end: 886, expectLine: 'generate', expectAt: 818 },
  { name: 'skills', start: 888, end: 937, expectLine: 'skills', expectAt: 889 },
  { name: 'old workbook', start: 938, end: 943, expectLine: 'workbook', expectAt: 938 },
];

for (const c of cuts) {
  const text = lines[c.expectAt - 1] || '';
  if (!text.includes(c.expectLine)) {
    throw new Error(`line ${c.expectAt} expected "${c.expectLine}", got: ${JSON.stringify(text)}`);
  }
}

// Boundaries that MUST survive: the banner lines themselves.
for (const [ln, word] of [[746, 'attachments'], [530, 'sessions']]) {
  const text = lines[ln - 1] || '';
  if (!text.includes(word)) {
    throw new Error(`line ${ln} should be the "${word}" banner, got: ${JSON.stringify(text)}`);
  }
}

for (const c of [...cuts].sort((a, b) => b.start - a.start)) {
  const removed = c.end - c.start + 1;
  lines.splice(c.start - 1, removed);
  console.log(`removed ${removed} lines (${c.name}) at ${c.start}`);
}

fs.writeFileSync(file, lines.join('\n'));
console.log('done, now', lines.length, 'lines');
