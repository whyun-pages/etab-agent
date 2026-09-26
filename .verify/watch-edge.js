'use strict';
/**
 * Watcher for the detach probe.
 *
 * Counts msedge.exe processes whose command line names a marker, over a few
 * seconds, and prints a timeline. Used to answer one question: does the Edge we
 * spawned outlive the parent that spawned it, and does `detached` change that?
 *
 * Usage: node .verify/watch-edge.js <marker>
 */

const { execFileSync } = require('node:child_process');

const marker = process.argv[2] || 'detach-probe-1';

function count() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${marker}*' }).Count`,
    ], { encoding: 'utf8', timeout: 20000 });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch { return -1; }
}

function killAll() {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { encoding: 'utf8', timeout: 20000 });
  } catch {}
}

const samples = [];
let t = 0;
const step = 400;
const total = 5200;

function tick() {
  samples.push(`${t}ms:${count()}`);
  t += step;
  if (t >= total) {
    console.log('  ' + samples.join('  '));
    const peak = Math.max(...samples.map((s) => Number(s.split(':')[1])));
    console.log('  peak = ' + peak);
    killAll();
    console.log('  cleaned up');
    return;
  }
  setTimeout(tick, step);
}

tick();
