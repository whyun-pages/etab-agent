'use strict';
/**
 * The double-click path, verified for real.
 *
 * single-instance.js covers the handoff but launches A with an explicit --port
 * and leaves B's data dir shared. What it does NOT cover is the exact sequence
 * that produced ERR_CONNECTION_REFUSED:
 *
 *   A = first launch, default path: no --port (OS picks), opens a window
 *   B = second launch, the same default path a double-click takes
 *   ...and A must still be serving afterwards.
 *
 * The window is real here (no --headless on B), because the bug lived in the
 * interaction between "spawn Edge" and "Edge hands off and exits at once".
 * A is headless so the test does not litter the desktop with two windows; the
 * handoff logic under test does not depend on A having a window of its own.
 *
 * The exe is shadowed into a temp dir under its own name so the default data
 * dir ($APPDATA/ETabAgent) is untouched — a real double-click would use that
 * dir, and we must not delete the user's actual skills/runs.
 *
 * Usage: node .verify/double-click.js [--exe]
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const USE_EXE = process.argv.includes('--exe');
const OUT = path.join(__dirname, 'out');
const SHADOW = path.join(OUT, 'double-click-shadow');
const DATA = path.join(OUT, 'double-click-data');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        try { const j = JSON.parse(s); resolve(j && j.ok === true); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2500, () => { req.destroy(); resolve(false); });
  });
}

// ---------------------------------------------------- own Edge, own profile

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
  .find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

let edgeKilled = 0;

/**
 * Kill only the Edge windows this test opened.
 *
 * The test's data dir ('double-click-data') appears in the profile path Edge
 * was launched with, so the command line is a precise fingerprint. Matching on
 * it cannot hit the user's normal browsing session, which uses a different
 * --user-data-dir entirely.
 */
function killOurEdges() {
  if (!EDGE) return;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | ' +
      'Where-Object { $_.CommandLine -like \'*double-click-data*\' } | ' +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }',
    ], { encoding: 'utf8' });
    edgeKilled += out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
  } catch { /* none matched */ }
}

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label +
    (ok ? '' : `\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`));
}

async function main() {
  console.log('target: ' + (USE_EXE ? 'dist/TabAgent.exe' : '.build/js/desktop.js (dev build)'));
  if (!EDGE) { console.log('no Edge found — cannot reproduce the double-click path'); process.exit(1); }

  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(SHADOW, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(SHADOW, { recursive: true });

  // Shadow the exe under its own name. A node.exe copy would work too, but the
  // exe carries the assets and is the thing users actually double-click.
  let aFile, bFile;
  if (USE_EXE) {
    aFile = bFile = path.join(SHADOW, 'TabAgent.exe');
    fs.copyFileSync(path.join(ROOT, 'dist', 'TabAgent.exe'), aFile);
  } else {
    aFile = bFile = process.execPath;
  }
  const aArgs = USE_EXE ? [path.join(SHADOW, 'TabAgent.exe')] : [path.join(ROOT, '.build', 'js', 'desktop.js')];

  const base = `"${aFile}" ${aArgs.map((a) => `"${a}"`).join(' ')}`;

  console.log('\n=== A) first launch, DEFAULT path (no --port; --headless so no window) ===');
  // A runs headless: the handoff logic under test does not depend on A owning a
  // window, and this keeps the desktop free of a stray window.
  const a = spawn(aFile, [...aArgs, '--headless', '--data-dir', DATA], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let aOut = '';
  a.stdout.on('data', (d) => { aOut += d.toString(); });
  a.stderr.on('data', (d) => { aOut += d.toString(); });
  let aExitedAt = null;
  a.on('exit', () => { aExitedAt = Date.now(); });

  // The record carries the OS-chosen port.
  let rec = null;
  for (let i = 0; i < 40 && !rec; i++) { await sleep(250); rec = readRecord(); }
  check('A published its instance record', !!rec && Number.isInteger(rec.port), true);
  const portA = rec ? rec.port : 0;
  console.log('     port chosen by OS: ' + portA);

  await sleep(800);
  check('A answers health before B starts', await health(portA), true);

  console.log('\n=== B) second launch, SAME default path (this is the double-click) ===');
  // No --headless: B really spawns Edge. It gets the same --data-dir, so it
  // both finds A's record and reuses the same Edge profile — the exact trap.
  const b = spawn(aFile, [...aArgs, '--data-dir', DATA], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bOut = '';
  b.stdout.on('data', (d) => { bOut += d.toString(); });
  b.stderr.on('data', (d) => { bOut += d.toString(); });
  let bExitedAt = null;
  b.on('exit', () => { bExitedAt = Date.now(); });

  for (let i = 0; i < 40 && bExitedAt === null; i++) await sleep(250);
  console.log('     B output: ' + JSON.stringify(bOut.trim()));

  check('B exited (did not linger as a second server)', bExitedAt !== null, true);
  check('B announced the running instance', /已在运行的实例/.test(bOut), true);
  check('B did not start a server of its own', /Tab Agent/.test(bOut), false);

  console.log('\n=== C) A must be unharmed (the original bug) ===');
  await sleep(2500);
  check('A.process still running', aExitedAt === null, true);
  check('A still answers health', await health(portA), true);
  const recAfter = readRecord();
  check('record still points at A\'s port', recAfter && recAfter.port, portA);
  check('record not overwritten by B', !!recAfter && recAfter.pid === rec.pid, true);

  console.log('\n=== D) cleanup ===');
  if (aExitedAt === null) a.kill();
  if (bExitedAt === null) b.kill();
  killOurEdges();
  await sleep(1000);
  console.log('     Edge processes we started, killed: ' + edgeKilled);
  console.log('     (the user\'s own Edge profile was never touched — B got --data-dir)');

  console.log('\n' + (failures === 0
    ? 'DOUBLE-CLICK PATH OK — second launch does not take the first down'
    : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

function readRecord() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'instance.json'), 'utf8')); } catch { return null; }
}

main().catch((e) => { console.error(e); process.exit(1); });
