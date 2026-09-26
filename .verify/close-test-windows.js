'use strict';
/**
 * Close only the Edge processes whose command line mentions OUR profile
 * directory. The user's own Edge windows must not be touched — killing every
 * msedge.exe would close their browsing session.
 *
 * Uses PowerShell via execFile (not a shell) so no quoting is lost in transit.
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MARKER = path.join(__dirname, 'out', 'one-instance-data').replace(/\\/g, '\\');
const MARKER2 = path.join(__dirname, 'out').replace(/\\/g, '\\');

const script = `
$procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*${MARKER}*' -or $_.CommandLine -like '*edge-single-*' -or $_.CommandLine -like '*window-profile*' }
if (-not $procs) { 'no matching Edge processes'; exit 0 }
foreach ($p in $procs) { "closing pid $($p.ProcessId)" }
$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
"closed $($procs.Count) process(es)"
`;

try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  console.log(out.trim());
} catch (e) {
  console.error('failed: ' + (e.stderr || e.message));
  process.exit(1);
}
console.log('\nmarkers used: ' + MARKER2);
