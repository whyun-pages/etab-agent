'use strict';
/**
 * Verify the single-instance handoff.
 *
 * What must be true:
 *   1. the first launch binds a port and publishes it
 *   2. a second launch detects that instance, points a window at it, and EXITS
 *      without binding a second port
 *   3. the first instance keeps serving throughout
 *
 * Point 2 is the one that matters: the original bug was a second launch taking
 * the first one's server down with it. Run against either the source entry or
 * the packaged exe — see TARGET below.
 *
 * Usage: node .verify/single-instance.js [--exe]
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const USE_EXE = process.argv.includes('--exe');
const OUT = path.join(__dirname, 'out');
const DATA = path.join(OUT, 'single-instance-data');

fs.mkdirSync(DATA, { recursive: true });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        try { resolve({ ok: JSON.parse(s).ok === true, port }); } catch { resolve({ ok: false, port }); }
      });
    });
    req.on('error', () => resolve({ ok: false, port }));
    req.setTimeout(2500, () => { req.destroy(); resolve({ ok: false, port }); });
  });
}

/** Which ports does this PID have open for listening? */
function listeningPortsOf(pid) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue).LocalPort -join ','`,
    ], { encoding: 'utf8' });
    return out.trim().split(',').map((s) => Number(s.trim())).filter(Boolean);
  } catch { return []; }
}

function launch(label, extraArgs = []) {
  const cmd = USE_EXE
    ? { file: path.join(ROOT, 'dist', 'TabAgent.exe'), args: ['--data-dir', DATA, ...extraArgs] }
    : { file: process.execPath, args: [path.join(ROOT, '.build', 'js', 'desktop.js'), '--data-dir', DATA, ...extraArgs] };

  const child = spawn(cmd.file, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { label, child, output: '', exitedAt: null, code: null, started: Date.now() };
  child.stdout.on('data', (d) => { rec.output += d.toString(); });
  child.stderr.on('data', (d) => { rec.output += d.toString(); });
  child.on('exit', (code) => { rec.exitedAt = Date.now() - rec.started; rec.code = code; });
  return rec;
}

function readRecord() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'instance.json'), 'utf8')); } catch { return null; }
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
  console.log('data:   ' + DATA + '\n');

  console.log('=== A) first launch ===');
  const a = launch('A', ['--port', '3231']);
  let rec = null;
  for (let i = 0; i < 30 && !rec; i++) { await sleep(500); rec = readRecord(); }
  check('instance record published', !!rec && Number.isInteger(rec.port), true);
  console.log('     record: ' + JSON.stringify(rec));
  const portA = rec ? rec.port : 3231;
  check('first instance answers health', (await health(portA)).ok, true);
  check('A still alive', a.exitedAt === null, true);

  console.log('\n=== B) second launch (same data dir) ===');
  const b = launch('B', ['--port', '3232']);
  // The second launch should finish quickly: it only opens a window.
  for (let i = 0; i < 20 && b.exitedAt === null; i++) await sleep(400);

  console.log('     B output:\n' + b.output.split(/\r?\n/).filter(Boolean).map((l) => '       ' + l).join('\n'));
  check('B exited on its own (did not linger as a second server)', b.exitedAt !== null, true);
  check('B did not bind a port of its own', listeningPortsOf(b.child.pid).length, 0);
  check('B mentioned the running instance', /已在运行的实例/.test(b.output), true);

  const recAfter = readRecord();
  check('instance record still points at the first port', recAfter && recAfter.port, portA);

  console.log('\n=== C) first instance unharmed ===');
  await sleep(1500);
  check('first instance still answers', (await health(portA)).ok, true);
  check('A still alive', a.exitedAt === null, true);

  console.log('\n=== D) cleanup ===');
  if (a.exitedAt === null) a.child.kill();
  if (b.exitedAt === null) b.child.kill();
  await sleep(1200);
  const recGone = readRecord();
  console.log('     record after shutdown: ' + JSON.stringify(recGone) +
    ' (a forced kill may leave it; the next launch clears a stale record)');

  console.log('\n' + (failures === 0
    ? 'SINGLE-INSTANCE HANDOFF OK'
    : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
