'use strict';
/**
 * Did the second launch actually open a window?
 *
 * The handoff has two halves: (a) don't start a second server, (b) point a
 * window at the running one. double-click.js proved (a) and was silent on (b)
 * — its Edge reaper reported "killed: 0", which is either a timing artefact or
 * proof that no window was opened at all. Silence is not evidence, so this
 * script watches the process table directly.
 *
 * Method: snapshot every msedge.exe on the machine before B, then after B and
 * for a few seconds following. A window opened by B must appear as a new
 * process whose command line names our test data dir. The launcher process may
 * exit at once when Edge hands off to an existing instance, so presence AND
 * persistence are both recorded.
 *
 * Usage: node .verify/window-opened.js [--exe]
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const USE_EXE = process.argv.includes('--exe');
const OUT = path.join(__dirname, 'out');
const SHADOW = path.join(OUT, 'window-opened-shadow');
const DATA = path.join(OUT, 'window-opened-data');
const MARK = 'window-opened-data'; // must appear in the edge command line

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s).ok === true); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2500, () => { req.destroy(); resolve(false); });
  });
}

/**
 * Every msedge.exe whose command line mentions the marker.
 *
 * CimInstance, not Get-Process: only the former exposes CommandLine, and the
 * command line is the only reliable way to tell our test's Edge apart from the
 * user's own browser.
 */
function edgeProcsFor(marker) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
      `ForEach-Object { "$($_.ProcessId)|$($_.CreationDate.Ticks)" }`,
    ], { encoding: 'utf8', timeout: 20000 });
    return out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

function killEdgesFor(marker) {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { encoding: 'utf8', timeout: 20000 });
  } catch { /* nothing matched */ }
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

  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(SHADOW, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(SHADOW, { recursive: true });

  let file, args;
  if (USE_EXE) {
    file = path.join(SHADOW, 'TabAgent.exe');
    fs.copyFileSync(path.join(ROOT, 'dist', 'TabAgent.exe'), file);
    args = [file];
  } else {
    file = process.execPath;
    args = [path.join(ROOT, '.build', 'js', 'desktop.js')];
  }

  console.log('\n=== A) headless server (no window) ===');
  const a = spawn(file, [...args, '--headless', '--data-dir', DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
  let aOut = '';
  a.stdout.on('data', (d) => { aOut += d.toString(); });
  a.stderr.on('data', (d) => { aOut += d.toString(); });
  let aDead = false;
  a.on('exit', () => { aDead = true; });

  let rec = null;
  for (let i = 0; i < 40 && !rec; i++) { await sleep(250); rec = readRecord(); }
  const portA = rec ? rec.port : 0;
  check('A is up', await health(portA), true);
  check('no Edge windows yet for our marker', edgeProcsFor(MARK).length, 0);

  console.log('\n=== B) second launch — must OPEN A WINDOW and exit ===');
  const before = edgeProcsFor(MARK).length;
  const b = spawn(file, [...args, '--data-dir', DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
  let bOut = '';
  b.stdout.on('data', (d) => { bOut += d.toString(); });
  b.stderr.on('data', (d) => { bOut += d.toString(); });
  let bDead = false;
  b.on('exit', () => { bDead = true; });

  // Poll while B runs: Edge may hand off and vanish quickly, so presence has to
  // be sampled, not read once at the end.
  let peak = 0;
  const samples = [];
  for (let i = 0; i < 40; i++) {
    const n = edgeProcsFor(MARK).length;
    samples.push(n);
    if (n > peak) peak = n;
    if (bDead && n > 0 && i > 12) break;
    await sleep(250);
  }

  console.log('     B output: ' + JSON.stringify(bOut.trim().replace(/\r?\n/g, ' | ')));
  console.log('     edge process count over time: [' + samples.join(', ') + ']');

  check('B announced the running instance', /已在运行的实例/.test(bOut), true);
  check('B did not start its own server', /Tab Agent/.test(bOut), false);
  check('B exited', bDead, true);
  check('B OPENED A WINDOW (new edge process seen)', peak > before, true);
  check('B did not report an Edge launch failure', /无法启动 Edge/.test(bOut), false);

  console.log('\n=== C) A still serving ===');
  await sleep(1200);
  check('A process alive', aDead, false);
  check('A still answers health', await health(portA), true);

  console.log('\n=== D) cleanup ===');
  killEdgesFor(MARK);
  if (!aDead) a.kill();
  if (!bDead) b.kill();
  await sleep(800);
  const leftover = edgeProcsFor(MARK).length;
  check('our Edge windows closed', leftover, 0);

  console.log('\n' + (failures === 0
    ? 'WINDOW ON HANDOFF OK — the second launch really does open a window'
    : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

function readRecord() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'instance.json'), 'utf8')); } catch { return null; }
}

main().catch((e) => { console.error(e); process.exit(1); });
