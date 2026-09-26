'use strict';
/**
 * Does the packaged exe open a real window when run without --headless?
 *
 * Confirms three things: the process survives startup, it binds an HTTP port,
 * and it launches Edge in app mode with its own profile directory.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'TabAgent.exe');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

/** Count processes whose name matches, via tasklist (no PowerShell). */
function countProcesses(name) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
    return (out.match(new RegExp(name, 'gi')) || []).length;
  } catch { return -1; }
}

async function main() {
  const dataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'TabAgent');
  const edgeBefore = countProcesses('msedge.exe');
  console.log('Edge processes before : ' + edgeBefore);
  console.log('data dir exists before: ' + fs.existsSync(dataDir));

  console.log('\nstarting dist/TabAgent.exe (no --headless)...');
  const child = spawn(EXE, [], { stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  // Give it time to start the server and spawn the browser.
  await sleep(9000);

  console.log('still running         : ' + (child.exitCode === null));
  console.log('stdout/stderr         : ' + JSON.stringify(out.trim().slice(0, 400)));

  const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
  if (m) {
    const url = 'http://127.0.0.1:' + m[1];
    console.log('bound url             : ' + url);
    try {
      const h = await get(url + '/api/health');
      console.log('health                : HTTP ' + h.status + ' ' + h.body.replace(/\s+/g, ' ').trim());
      const page = await get(url + '/');
      console.log('index.html            : ' + page.body.length + ' bytes');
    } catch (e) {
      console.log('http failed           : ' + e.message);
    }
  } else {
    console.log('no url parsed from output');
  }

  const edgeAfter = countProcesses('msedge.exe');
  console.log('Edge processes after  : ' + edgeAfter + '  (delta ' + (edgeAfter - edgeBefore) + ')');

  console.log('data dir created      : ' + fs.existsSync(dataDir));
  if (fs.existsSync(dataDir)) {
    for (const e of fs.readdirSync(dataDir)) console.log('   ' + e);
  }
  const profile = path.join(dataDir, 'window-profile');
  console.log('edge profile dir      : ' + (fs.existsSync(profile) ? 'created' : 'missing'));

  console.log('\nwindow actually opened : ' + (edgeAfter > edgeBefore ? 'YES (Edge spawned)' : 'NO'));
  console.log('closing window should end the server; killing the process for this check.');

  child.kill();
  await sleep(800);
  console.log('process killed        : ' + (child.exitCode !== null || child.signalCode !== null));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
