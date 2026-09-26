'use strict';
/**
 * Fetch EVERY asset the packaged exe embeds, one request at a time, and report
 * status + byte size. Also cross-checks that the set of files the UI actually
 * references has no holes.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'TabAgent.exe');
const PUBLIC = path.join(ROOT, 'public');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function get(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), type: res.headers['content-type'] }));
    });
    req.on('error', (e) => resolve({ status: 0, err: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
  });
}

/**
 * Files deliberately not served. `package.json` exists only to mark public/ as
 * an ESM directory for Node; it is excluded from the embedded asset set by
 * tools/build-exe.js and rejected by the .json allowlist in lib/assets.js.
 * A 404 for it is the designed behaviour, not a gap.
 */
const INTENTIONALLY_EXCLUDED = new Set(['package.json']);

function sha(buf) { return require('node:crypto').createHash('sha256').update(buf).digest('hex').slice(0, 16); }

/** Every file under public/, as POSIX relative paths. */
function diskKeys(dir = PUBLIC, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...diskKeys(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * Files the UI actually pulls at runtime: everything referenced by relative
 * import in the JS modules, plus src/href in index.html.
 */
function referencedKeys() {
  const refs = new Set();
  const jsFiles = diskKeys().filter((k) => k.endsWith('.js'));
  for (const k of jsFiles) {
    const text = fs.readFileSync(path.join(PUBLIC, k), 'utf8');
    const re = /(?:from|import)\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(text))) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(k), spec));
      refs.add(resolved);
    }
  }
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const re2 = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m2;
  while ((m2 = re2.exec(html))) {
    const v = m2[1];
    if (/^(https?:|data:|#|mailto:)/.test(v)) continue;
    refs.add(v.replace(/^\.?\/+/, '').split('?')[0]);
  }
  return [...refs].sort();
}

async function main() {
  const disk = diskKeys();
  const refs = referencedKeys();

  console.log('=== public/ on disk (' + disk.length + ') ===');
  disk.forEach((k) => console.log('   ' + k));

  console.log('\n=== referenced by UI (' + refs.length + ') ===');
  refs.forEach((k) => console.log('   ' + k));

  const missing = refs.filter((r) => !disk.includes(r));
  console.log('\nreferenced but absent from public/: ' + (missing.length ? missing.join(', ') : 'none'));

  console.log('\n=== starting packaged exe --headless ===');
  const child = spawn(EXE, ['--headless', '--data-dir', path.join(ROOT, '.verify', 'out', 'win-data')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  let port = null;
  for (let i = 0; i < 20 && !port; i++) {
    await sleep(500);
    const m = /127\.0\.0\.1:(\d+)/.exec(out);
    if (m) port = Number(m[1]);
  }
  if (!port) {
    console.log('could not determine port. output was:\n' + out);
    child.kill();
    process.exit(1);
  }
  console.log('port ' + port);

  // Ordered fetch of every embedded/disk asset.
  const results = [];
  for (const k of disk) {
    const r = await get(port, '/' + k);
    results.push({ key: k, ...r });
  }

  console.log('\n=== one-by-one fetch (byte-compared against public/) ===');
  let bad = 0;
  let excluded = 0;
  for (const r of results) {
    const diskBuf = fs.readFileSync(path.join(PUBLIC, r.key));
    const diskHash = sha(diskBuf);
    const gotHash = r.body ? sha(r.body) : '-';

    if (INTENTIONALLY_EXCLUDED.has(r.key)) {
      excluded++;
      console.log('  SKIP ' + String(r.status).padEnd(4) + r.key.padEnd(24) + ' intentionally not served (404 = designed)');
      continue;
    }

    const ok = r.status === 200 && gotHash === diskHash;
    if (!ok) bad++;
    console.log(
      '  ' + (ok ? ' OK ' : 'FAIL') + ' ' +
      String(r.status).padEnd(4) +
      String(r.body ? r.body.length : 0).padStart(7) + 'B  ' +
      gotHash + (ok ? ' == ' + diskHash : ' != ' + diskHash) + '  /' + r.key
    );
  }

  console.log('\n=== special paths ===');
  for (const p of ['/', '/index.html', '/nope.css', '/../lib/server.js', '/package.json']) {
    const r = await get(port, p);
    console.log('  ' + String(r.status).padEnd(4) + p + (r.status === 200 ? '  ' + r.body.length + 'B' : ''));
  }

  console.log('\nfailures: ' + bad + ' / ' + (results.length - excluded) + ' servable assets (' + excluded + ' intentionally excluded)');
  console.log(bad === 0 ? 'EVERY SERVABLE ASSET BYTE-IDENTICAL' : 'EMBEDDED ASSET GAPS REMAIN');

  child.kill();
  await sleep(500);
}

main().catch((e) => { console.error(e); process.exit(1); });
