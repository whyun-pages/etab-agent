'use strict';
/** Probe: can we start Edge headless and reach its CDP endpoint? */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 4190;
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const PROFILE = path.join(OUT, 'edge-probe2');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function tryGet(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => resolve(s));
    });
    req.on('error', (e) => resolve('ERR ' + e.code));
    req.setTimeout(2000, () => { req.destroy(); resolve('ERR timeout'); });
  });
}

async function main() {
  for (const mode of ['--headless=new', '--headless']) {
    console.log('\n===== ' + mode + ' =====');
    const child = spawn(EDGE, [
      mode, '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}-${mode.replace(/[^a-z]/gi, '')}`,
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let log = '';
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });

    for (let i = 0; i < 16; i++) {
      await sleep(500);
      const v = await tryGet('/json/version');
      if (!v.startsWith('ERR')) {
        console.log('  version reachable after ' + ((i + 1) * 500) + 'ms');
        console.log('  ' + v.replace(/\s+/g, ' ').slice(0, 160));
        const list = await tryGet('/json/list');
        const targets = JSON.parse(list);
        console.log('  targets:');
        for (const t of targets) console.log('    type=' + t.type + '  url=' + t.url.slice(0, 60));
        break;
      }
      if (i === 15) console.log('  never reachable; last=' + v);
    }

    console.log('  alive after probe: ' + (child.exitCode === null));
    console.log('  stderr head: ' + log.replace(/\s+/g, ' ').slice(0, 240));

    child.kill();
    await sleep(800);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
