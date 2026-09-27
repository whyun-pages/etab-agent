'use strict';
/**
 * The two remaining lifecycle cases.
 *
 *   1. STALE RECORD — the previous run was force-killed, so instance.json
 *      points at a dead port. The next launch must detect this, clear the file,
 *      and start normally. A lock file that blocks all future launches would be
 *      worse than no lock at all.
 *
 *   2. WINDOW CLOSE — when the window we opened is closed, the server should
 *      exit and the record should be removed, so the next launch starts clean.
 *
 * Case 2 is exercised by killing the Edge process that holds our profile: that
 * is what closing the window does to the child we spawned.
 *
 * Usage: node .verify/lifecycle.js [--exe]
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const USE_EXE = process.argv.includes('--exe');
const OUT = path.join(__dirname, 'out');
const DATA = path.join(OUT, 'lifecycle-data');

fs.mkdirSync(DATA, { recursive: true });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
      res.resume();
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

function readRecord() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'instance.json'), 'utf8')); } catch { return null; }
}

function launch(extraArgs = []) {
  const cmd = USE_EXE
    ? { file: path.join(ROOT, 'dist', 'TabAgent.exe'), args: ['--data-dir', DATA, ...extraArgs] }
    : { file: process.execPath, args: [path.join(ROOT, '.build', 'js', 'desktop.js'), '--data-dir', DATA, ...extraArgs] };
  const child = spawn(cmd.file, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { child, output: '', exitedAt: null };
  const t0 = Date.now();
  child.stdout.on('data', (d) => { rec.output += d.toString(); });
  child.stderr.on('data', (d) => { rec.output += d.toString(); });
  child.on('exit', () => { rec.exitedAt = Date.now() - t0; });
  return rec;
}

/** Kill the Edge renderer that owns our window profile. */
function closeOurWindow() {
  const marker = DATA.replace(/\\/g, '\\\\');
  const ps = `
$p = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
     Where-Object { $_.CommandLine -like '*${DATA}*' }
if (-not $p) { 'no window found'; exit 0 }
$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
'closed ' + $p.Count + ' edge process(es)'
`;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
  } catch (e) { return 'close failed: ' + (e.stderr || e.message); }
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

  // ---------------------------------------------------------- stale record
  console.log('=== 1) a stale record must not block startup ===');
  // Fabricate a record pointing at a port nothing listens on.
  fs.writeFileSync(path.join(DATA, 'instance.json'), JSON.stringify({
    port: 3299, pid: 999999, startedAt: new Date(0).toISOString(),
  }, null, 2));
  check('record planted on a dead port', readRecord().port, 3299);

  const a = launch(['--port', '3241']);
  let live = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const r = readRecord();
    if (r && r.port === 3241) { live = r; break; }
  }
  check('startup proceeded and republished the record', live && live.port, 3241);
  check('new server answers', await health(3241), true);
  check('the dead port is not being used', await health(3299), false);

  // ------------------------------------------------------- window close
  console.log('\n=== 2) closing the window stops the server ===');
  console.log('     ' + closeOurWindow());
  let gone = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!(await health(3241))) { gone = true; break; }
  }
  check('server stopped after the window closed', gone, true);
  check('process exited', a.exitedAt !== null, true);

  for (let i = 0; i < 10; i++) {
    await sleep(300);
    if (!readRecord()) break;
  }
  check('record cleaned up on shutdown', readRecord(), null);

  console.log('\n' + (failures === 0 ? 'LIFECYCLE OK' : failures + ' CHECK(S) FAILED'));
  if (a.exitedAt === null) a.child.kill();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
