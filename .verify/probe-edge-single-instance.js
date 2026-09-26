'use strict';
/**
 * Hypothesis: `child.on('exit') -> server.close()` fires immediately when Edge
 * is ALREADY RUNNING.
 *
 * Edge is single-instance-per-profile. Spawning msedge.exe while another Edge
 * with the same profile (or the user's default profile) is up makes the new
 * process hand the request over and exit at once. That exit looks identical to
 * "the user closed the window", so the server shuts down — the window is up but
 * the page cannot connect.
 *
 * This probe spawns Edge twice and reports how long each process lives.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function spawnEdge(profile, url, label) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(EDGE, [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
    ], { stdio: 'ignore' });

    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      resolve({ label, how, ms: Date.now() - started, pid: child.pid });
    };

    child.on('exit', (code) => {
      console.log(`  [${label}] spawned pid=${child.pid} -> EXITED after ${Date.now() - started}ms (code ${code})`);
      finish('exit');
    });
    child.on('error', (e) => {
      console.log(`  [${label}] spawn error: ${e.message}`);
      finish('error');
    });

    // If it survives this long, treat it as "the window is really up".
    setTimeout(() => {
      if (!done) {
        console.log(`  [${label}] spawned pid=${child.pid} -> still alive after 6000ms`);
        child.kill();
        finish('alive');
      }
    }, 6000);
  });
}

async function main() {
  const profileA = path.join(OUT, 'edge-single-A');
  const profileB = path.join(OUT, 'edge-single-B');

  console.log('=== 1) fresh profile, background, first launch ===');
  const a = spawnEdge(profileA, 'http://127.0.0.1:1/', 'A-first');
  await sleep(4000);

  console.log('\n=== 2) SAME profile again, while A is presumably up ===');
  const a2 = spawnEdge(profileA, 'http://127.0.0.1:1/', 'A-second');
  await sleep(4000);

  console.log('\n=== 3) a DIFFERENT profile, while others are up ===');
  const b = spawnEdge(profileB, 'http://127.0.0.1:1/', 'B-first');
  await sleep(4000);

  const results = await Promise.all([a, a2, b]);
  console.log('\n=== verdict ===');
  for (const r of results) {
    console.log(`  ${r.label.padEnd(10)} ${r.how.padEnd(6)} after ${r.ms}ms`);
  }
  const relaunchDiedFast = results.find((r) => r.label === 'A-second' && r.how === 'exit' && r.ms < 2500);
  console.log('\n' + (relaunchDiedFast
    ? 'CONFIRMED: re-launching with the SAME profile exits almost immediately —'
      + '\n  a live Edge instance takes the request and the spawned process dies.'
    : 'NOT CONFIRMED: the second launch did not die fast.'));
}

main().catch((e) => { console.error(e); process.exit(1); });
