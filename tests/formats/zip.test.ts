'use strict';
/**
 * Tests for the zip writer. Reading and writing are exercised by every xlsx
 * test; what is checked here is whether the output depends on the machine.
 */

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** What `code` prints, run in a fresh process under time zone `tz`. */
function underTimeZone(tz: string, code: string): string {
  return execFileSync(process.execPath, ['--import', 'tsx', '-e', code], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  }).trim();
}

test('the same entries make the same bytes in any time zone', () => {
  // The time zone is read once per process, so each one needs its own. The
  // DOS timestamp used local getters: the fixed default mtime encoded as
  // 08:00 in Shanghai and 00:00 in UTC.
  const code = `
    const { writeZip } = require('./src/formats/zip.ts');
    const bytes = writeZip([{ name: 'a.txt', data: Buffer.from('hello') }]);
    console.log(require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
  `;
  const zones = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles'];
  const hashes = zones.map((tz) => underTimeZone(tz, code));
  assert.strictEqual(new Set(hashes).size, 1, zones.map((z, i) => `${z}: ${hashes[i]}`).join('\n'));
});
