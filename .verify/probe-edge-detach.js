'use strict';
/**
 * Why does the handoff window never appear?
 *
 * The handoff branch spawns Edge with { detached: false, stdio: 'ignore' } and
 * then returns, so the launcher exits within milliseconds. In that test the
 * window never showed up, while the normal (long-lived parent) path does open
 * one. This probe isolates the variable: spawn Edge two ways from a parent that
 * exits immediately, and see which survives.
 *
 *   case 1  detached: false   (what desktop.js does now)
 *   case 2  detached: true    (own process group)
 *
 * Each case spawns Edge with its own marker in the profile path so the process
 * table can be attributed unambiguously.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');

const OUT = path.join(__dirname, 'out');
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
  .find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function procsFor(marker) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
      `ForEach-Object { $_.ProcessId }`,
    ], { encoding: 'utf8', timeout: 20000 });
    return out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

function killFor(marker) {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { encoding: 'utf8', timeout: 20000 });
  } catch {}
}

const case_ = process.argv[2]; // '1' | '2'
if (!EDGE) { console.log('no Edge'); process.exit(1); }

const marker = `detach-probe-${case_}`;
const profileDir = path.join(OUT, marker, 'profile');
fs.mkdirSync(profileDir, { recursive: true });

const detached = case_ === '2';
const child = spawn(EDGE, [
  '--app=about:blank',
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
], { stdio: 'ignore', detached });

// Record spawn-level failures that a fire-and-forget caller would never see.
child.on('error', (e) => {
  console.log(`SPAWN ERROR (${marker}): ${e.code || ''} ${e.message}`);
});

child.unref();

console.log(`${marker}: spawned with detached=${detached}, parent exiting now`);

// The parent exits here, exactly like the handoff branch does.
process.on('exit', () => {
  fs.writeFileSync(path.join(OUT, marker + '.txt'), `detached=${detached}\n`);
});
