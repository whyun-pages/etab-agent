'use strict';
/**
 * Black-box check of the single-instance shutdown bug.
 *
 * Scenario: a window for this profile is already open, and the user launches
 * again (double-click, or the browser's relaunch). Edge hands the request to
 * the running instance and the process we spawned exits at once. Acting on that
 * exit shuts the server down under a live window -> ERR_CONNECTION_REFUSED.
 *
 * This starts one instance, waits until it serves, starts a second against the
 * SAME profile, then re-checks whether the second instance's port is still
 * serving. It also reports how long the second process lived, which is the
 * signal the fix keys on.
 *
 * Usage: node .verify/one-instance.js
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'TabAgent.exe');
const OUT = path.join(__dirname, 'out');
const DATA = path.join(OUT, 'one-instance-data');
const PORT_A = Number(process.argv[2] || 3201);
const PORT_B = Number(process.argv[3] || 3202);

fs.mkdirSync(DATA, { recursive: true });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => resolve({ up: res.statusCode === 200, body: s.replace(/\s+/g, ' ') }));
    });
    req.on('error', (e) => resolve({ up: false, err: e.code }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ up: false, err: 'timeout' }); });
  });
}

async function waitHealthy(port, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const h = await health(port);
    if (h.up) return h;
    await sleep(400);
  }
  return null;
}

/**
 * Start the app the way a double-click does: no flags beyond a fixed port, a
 * window (not --headless), the same data directory.
 */
function launch(port, label) {
  const started = Date.now();
  const child = spawn(EXE, ['--port', String(port), '--data-dir', DATA], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rec = { label, port, child, started, exitedAt: null, code: null, output: '' };
  child.stdout.on('data', (d) => { rec.output += d.toString(); });
  child.stderr.on('data', (d) => { rec.output += d.toString(); });
  child.on('exit', (code) => { rec.exitedAt = Date.now() - started; rec.code = code; });
  return rec;
}

async function main() {
  console.log('=== A) first launch (no window open yet) ===');
  const a = launch(PORT_A, 'A');
  const aHealth = await waitHealthy(PORT_A);
  console.log('  A served: ' + (aHealth ? 'YES  ' + aHealth.body : 'NO'));
  if (!aHealth) { a.child.kill(); process.exit(1); }
  await sleep(2000);
  console.log('  A process ' + (a.exitedAt === null ? 'alive' : 'exited after ' + a.exitedAt + 'ms'));

  console.log('\n=== B) second launch, SAME profile already held open ===');
  const b = launch(PORT_B, 'B');
  const bHealth = await waitHealthy(PORT_B, 12000);
  console.log('  B served: ' + (bHealth ? 'YES  ' + bHealth.body : 'NO'));
  await sleep(3000);
  console.log('  B process: ' + (b.exitedAt === null ? 'alive' : 'exited after ' + b.exitedAt + 'ms (code ' + b.code + ')'));

  console.log('\n=== C) re-check both ports ===');
  const a2 = await health(PORT_A);
  const b2 = await health(PORT_B);
  console.log('  A/' + PORT_A + ': ' + (a2.up ? 'UP' : 'DOWN (' + a2.err + ')'));
  console.log('  B/' + PORT_B + ': ' + (b2.up ? 'UP' : 'DOWN (' + b2.err + ')'));

  const bDiedFast = b.exitedAt !== null && b.exitedAt < 1500;
  console.log('\n--- verdict ---');
  console.log('  second process exited fast: ' + bDiedFast);
  console.log('  second port still serving : ' + b2.up);

  if (bDiedFast && !b2.up) {
    console.log('\nBUG REPRODUCED: the window stays open but its server is gone.');
    console.log('  This is the ERR_CONNECTION_REFUSED the user saw.');
  } else if (!b2.up) {
    console.log('\nBUG REPRODUCED (slow path): the second port is dead.');
    console.log('  Its server shut down while its window stayed open.');
  } else if (bDiedFast && b2.up) {
    console.log('\nFIXED: the second process exited fast, but its server kept serving,');
    console.log('  so the window (which Edge pointed at that port) still loads.');
  } else {
    console.log('\nNO BUG: the second launch kept its own server up.');
    console.log('  (Edge opened a second window rather than reusing the first, which');
    console.log('  also means the reported failure did not reproduce this run.)');
  }

  if (a.child.exitCode === null) a.child.kill();
  if (b.child.exitCode === null) b.child.kill();
  await sleep(600);
  const leftover = [a, b].filter((r) => r.child.exitCode === null);
  console.log('\nleftover processes: ' + (leftover.length ? leftover.map((r) => r.label).join(', ') : 'none'));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
