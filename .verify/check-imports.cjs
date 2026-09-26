'use strict';
/**
 * Static check: a call to a PROJECT-EXPORTED function that this module never
 * imported.
 *
 * Origin: `openModal(...)` in app.js with no import for it. A ReferenceError at
 * CLICK time — the module parses, the page renders, nothing fails until a user
 * clicks the thing. No tool here sees it: no bundler, no linter, tsc does not
 * read `public/`, and the unit suite never loads browser code.
 *
 * WHY THIS SHAPE, after two worse drafts:
 *   A hand-rolled "is every bare call in scope?" checker produced 17 false
 *   positives (method shorthand, destructured params, `super(`), and a
 *   home-made tokenizer kept desyncing on regex literals. A probe that cries
 *   wolf is as useless as one that never barks.
 *
 *   So the check is a CROSS-REFERENCE, not a parse:
 *     1. collect every name `public/js` exports
 *     2. in each file, find `NAME(` where NAME is one of those exports
 *     3. flag it only if that file did not import NAME
 *   `super(`/`constructor(` are not exports of anything, so they cannot match.
 *   A file's own private helpers are not exports either, so they cannot match.
 *   Only the real failure mode — calling a sibling module's function without
 *   importing it — fits all three conditions.
 *
 * Verified against the real bug: .verify/check-imports-selftest.cjs reintroduces
 * the missing import and expects this to fail.
 */
const fs = require('node:fs');
const path = require('node:path');

const JS_ROOT = path.join(__dirname, '..', 'public', 'js');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Comments and string/template literals blanked out, so their contents cannot match. */
function strip(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; out += ' '; continue;
    }
    // Regex literal or division: only treat `/` as a regex start when the
    // previous significant character cannot end an expression. Mis-classifying
    // this is what desynced the earlier drafts.
    if (c === '/') {
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out[j])) j--;
      const prev = j >= 0 ? out[j] : '';
      if (!/[\w$)\]]/.test(prev)) {
        // regex literal: copy through to the closing unescaped `/`
        i++;
        let inClass = false;
        while (i < src.length) {
          const rc = src[i];
          if (rc === '\\') { i += 2; continue; }
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) { i++; break; }
          else if (rc === '\n') break;
          i++;
        }
        out += ' ';
        continue;
      }
    }
    out += c; i++;
  }
  return out;
}

/** Names exported by a module (function / class / const / let / var, and `export { a, b }`). */
function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const p of m[1].split(',')) {
      const n = p.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  return names;
}

/** Names this module imports. */
function importsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:,\s*([\w$]+))?\s*from\s*['"][^'"]+['"]/g)) {
    if (m[1]) names.add(m[1].trim());
    if (m[2]) for (const p of m[2].split(',')) { const n = p.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
    if (m[3]) names.add(m[3].trim());
  }
  return names;
}

/**
 * Names this module declares ITSELF, exported or not.
 *
 * Load-bearing: `dom.js` exports `money`/`num` AND declares them locally, so a
 * call to them in that same file is fine. Without this set the checker flags
 * every file for using its own exports — 46 false positives.
 */
function declaredOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:^|[\s;{}])(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class)\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/(?:^|[\s;{}])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  // Destructured declarations: `const { a, b } = ...`
  for (const m of src.matchAll(/(?:^|[\s;{}])(?:export\s+)?(?:const|let|var)\s*\{([^}]*)\}/gm)) {
    for (const p of m[1].split(',')) {
      const n = p.trim().split(':').pop().split('=')[0].trim();
      if (n) names.add(n);
    }
  }
  return names;
}

const files = walk(JS_ROOT);

// 1. Every name any module in this tree exports.
const projectExports = new Set();
for (const f of files) {
  for (const n of exportsOf(fs.readFileSync(f, 'utf8'))) projectExports.add(n);
}

// 2. Flag calls to an export this file did not import.
let failures = 0;
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const src = strip(raw);
  const imported = importsOf(raw);
  const declared = declaredOf(raw);
  const rel = path.relative(path.join(__dirname, '..'), f);

  const flagged = new Set();
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const n = m[1];
    if (!projectExports.has(n)) continue;   // not a project export -> not this bug
    if (imported.has(n)) continue;          // imported -> fine
    if (declared.has(n)) continue;          // declared in THIS file -> fine
    flagged.add(n);
  }
  for (const n of flagged) {
    failures++;
    console.log(`  MISS ${rel}: calls \`${n}(\` — it is exported elsewhere in public/js but not imported here`);
  }
}

if (!failures) console.log('every call to a project export is imported');
console.log(failures === 0 ? '\nIMPORT CHECK PASSED' : `\n${failures} MISSING IMPORT(S)`);
process.exit(failures === 0 ? 0 : 1);
