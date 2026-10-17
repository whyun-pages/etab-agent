'use strict';
/**
 * The desktop entry's argument checks, against a real process.
 *
 * Spawned, not imported: src/desktop.ts starts itself on load. Only the cases
 * that exit before a window or a server exists are tested here; the rest of
 * the entry (Edge, single instance, the window) needs a desktop and lives in
 * .verify/exe/.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(__dirname, '..');

function desktop(t, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-desktop-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, TAB_AGENT_HOME: home };
  delete env.TAB_AGENT_PORT;
  return spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src', 'desktop.ts'), ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
}

test('a bad --port is refused by name, before anything starts', (t) => {
  for (const [args, said] of [
    [['--port', 'abc'], /--port 不是可用端口：abc/],
    [['--port=70000'], /--port 不是可用端口：70000/],
    // No value at all is a parse error, and says which flag it was.
    [['--port'], /参数有误：.*--port/],
  ] as [string[], RegExp][]) {
    const r = desktop(t, ['--headless', '--new-instance', ...args]);
    assert.notStrictEqual(r.status, 0, `${args.join(' ')} exited 0`);
    assert.match(r.stderr, said, `${args.join(' ')}: ${r.stderr}`);
  }
});

test('an unknown or misspelled flag is refused, not ignored', (t) => {
  // The hand-written parser skipped what it did not know: `--prot 4000`
  // started on the defaults without a word.
  const r = desktop(t, ['--headless', '--new-instance', '--prot', '4000']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /参数有误：.*--prot/);
  assert.match(r.stderr, /可用的参数：.*--port <值>/);
});
