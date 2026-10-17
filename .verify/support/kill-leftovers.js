'use strict';
/**
 * Kill what the .verify scripts leave behind when they die halfway, and report
 * what was found: TabAgent.exe processes, and the probes' own Edge instances.
 *
 * Only the probes' Edge. An earlier helper (support/cdp.js) once listed every
 * msedge.exe and killed the lot, which closed the user's own browser along
 * with the probe's. A probe's Edge runs on a profile under .verify/out, and
 * Edge's child processes inherit `--user-data-dir`, so matching the command
 * line on that folder finds those instances and nothing else.
 *
 * Why it matters: a probe's Edge left running holds its profile, and the next
 * launch on that profile hands its request to the old instance and exits.
 * Playwright then reports "browser has been closed", which names nothing.
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROFILES = path.join(__dirname, '..', 'out');

function list(name) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
    return out
      .split(/\r?\n/)
      .filter((l) => l.toUpperCase().includes(name.toUpperCase()))
      .map((l) => l.split('","')[1])
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * msedge.exe processes whose command line names a profile under .verify/out.
 * The folder reaches PowerShell through the environment, not the command, so
 * no character in it needs quoting.
 */
function probeEdges() {
  const script =
    'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | ' +
    'Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:TAB_AGENT_PROBE_PROFILES) } | ' +
    'ForEach-Object { $_.ProcessId }';
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, TAB_AGENT_PROBE_PROFILES: PROFILES },
    });
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function kill(label, pids) {
  if (!pids.length) {
    console.log(label + ': none running');
    return 0;
  }
  console.log(label + ': killing ' + pids.join(', '));
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/PID', pid, '/F', '/T'], { stdio: 'ignore' });
    } catch {}
  }
  return pids.length;
}

const n = kill('TabAgent.exe', list('TabAgent.exe')) + kill('probe Edge (profiles in .verify/out)', probeEdges());
console.log('killed ' + n + ' process(es)');
