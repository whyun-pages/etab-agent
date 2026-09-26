'use strict';
/**
 * Self-test for check-imports.cjs.
 *
 * A checker that only ever says "clean" proves nothing. This reintroduces the
 * exact bug it exists to catch — `app.js` calling `openModal` with no import —
 * runs the checker, and requires it to FAIL. Then it restores the file and
 * requires it to pass.
 *
 * If the "bug present" run passes, the checker is a blank sheet.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'public', 'js', 'app.js');
const CHECKER = path.join(__dirname, 'check-imports.cjs');

const GOOD = "import { toast, openModal, closeModal, initModal } from './ui.js';";
const BAD = "import { toast, initModal } from './ui.js';";

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}

function runChecker() {
  try {
    const out = execFileSync(process.execPath, [CHECKER], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout || '') + (err.stderr || '') };
  }
}

const original = fs.readFileSync(APP, 'utf8');
check('app.js has the fixed import to start from', original.includes(GOOD), 'expected the good import');

try {
  // --- bug present ---
  fs.writeFileSync(APP, original.replace(GOOD, BAD), 'utf8');
  const bad = runChecker();
  check('with the missing import reintroduced, the checker FAILS', bad.code !== 0, `exit ${bad.code}`);
  check('and it names openModal', /openModal/.test(bad.out), bad.out.trim().split('\n').slice(-3).join(' | '));
} finally {
  fs.writeFileSync(APP, original, 'utf8');
}

// --- bug absent ---
const good = runChecker();
check('with the import restored, the checker PASSES', good.code === 0, `exit ${good.code}\n${good.out}`);

console.log(failures === 0 ? '\nIMPORT-CHECK SELFTEST PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
