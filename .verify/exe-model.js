'use strict';
/**
 * Confirm the model modules made it into the packaged executable.
 *
 * A build can report "16 modules" and still ship a binary that lacks a file if
 * the module graph is wrong. Reading the bytes is the only way to know, and it
 * is cheap.
 *
 * Also asserts the settings endpoints are reachable on the running exe, because
 * "the code is in there" and "the server exposes it" are different claims.
 *
 * Usage: node .verify/exe-model.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'TabAgent.exe');
const OUT = path.join(__dirname, 'out');
const DATA = path.join(OUT, 'exe-model-data');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label +
    (ok ? '' : `\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`));
}

function jsonReq(port, method, p, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {},
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  if (!fs.existsSync(EXE)) { console.log('no exe built'); process.exit(1); }

  console.log('=== 1) the new modules are inside the binary ===');
  const buf = fs.readFileSync(EXE);
  for (const marker of [
    'settings.json',                  // settings.js
    '尚未配置 API key',               // llm.js guard
    'chat/completions',               // llm.js endpoint
    '你是一个信息抽取器',              // model-parse.js prompt
    'response_format',                // json mode
    'useForAttachments',              // settings shape
  ]) {
    const found = buf.includes(Buffer.from(marker, 'utf8'));
    check(`binary contains ${JSON.stringify(marker)}`, found, true);
  }

  console.log('\n=== 2) the endpoints answer on the running exe ===');
  fs.rmSync(DATA, { recursive: true, force: true });
  const child = spawn(EXE, ['--headless', '--port', '3241', '--data-dir', DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  let dead = false;
  child.on('exit', () => { dead = true; });

  // Wait for the port to answer.
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    const r = await jsonReq(3241, 'GET', '/api/health');
    if (r.status === 200) up = true; else await sleep(250);
  }
  check('the exe is serving', up, true);

  const health = await jsonReq(3241, 'GET', '/api/health');
  check('health reports modelConfigured false (fresh data dir)', health.body.modelConfigured, false);

  const read = await jsonReq(3241, 'GET', '/api/settings');
  check('GET /api/settings works', read.status, 200);
  check('it returns defaults', read.body.settings.hasKey, false);

  const SECRET = 'sk-exe-check-778899';
  const saved = await jsonReq(3241, 'POST', '/api/settings', {
    apiKey: SECRET, baseUrl: 'https://api.example.test/v1', model: 'gpt-4o-mini',
  });
  check('POST /api/settings works', saved.status, 200);
  check('the save response does not echo the key', JSON.stringify(saved.body).includes(SECRET), false);

  const reread = await jsonReq(3241, 'GET', '/api/settings');
  check('the key persisted', reread.body.settings.hasKey, true);
  check('and still never comes back', JSON.stringify(reread.body).includes(SECRET), false);

  const health2 = await jsonReq(3241, 'GET', '/api/health');
  check('health now reports configured', health2.body.modelConfigured, true);

  // The settings file must exist on disk, which is where the key actually lives.
  const settingsFile = path.join(DATA, 'settings.json');
  check('settings.json was written to the data dir', fs.existsSync(settingsFile), true);

  console.log('\n=== 3) cleanup ===');
  if (!dead) child.kill();
  await sleep(900);
  check('the exe process exited', child.exitCode !== null || dead, true);

  console.log('\n' + (failures === 0 ? 'EXE MODEL PLUMBING OK' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
