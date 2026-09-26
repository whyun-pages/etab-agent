'use strict';
/**
 * Find requires that point at files that are no longer there.
 *
 * The UI rewrite removed four view modules. A leftover `require` to one of them
 * is a runtime crash on the first request that touches it, and this app has had
 * exactly that failure before (a deleted helper still imported by the server).
 *
 * Usage: node .verify/probe-requires.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.verify', '.build', '.git', 'out', 'dist']);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
}(ROOT));

let missing = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    if (!fs.existsSync(target) && !fs.existsSync(`${target}.js`)) {
      console.log(`MISSING  ${path.relative(ROOT, f)}  ->  ${m[1]}`);
      missing += 1;
    }
  }
}

// ESM imports in the browser bundle, the other half of the same problem.
for (const f of files.filter((p) => p.includes(`${path.sep}public${path.sep}`))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    if (!fs.existsSync(target)) {
      console.log(`MISSING  ${path.relative(ROOT, f)}  ->  ${m[1]}`);
      missing += 1;
    }
  }
}

console.log(`\nscanned ${files.length} files · ${missing} broken imports`);
process.exit(missing ? 1 : 0);
