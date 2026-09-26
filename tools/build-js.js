'use strict';
/**
 * Step 0 of the build: compile TypeScript into `.build/js/`.
 *
 * This replaced `tools/strip-types.js`. Two reasons, and the second is the one
 * that matters:
 *
 *   1. `stripTypeScriptTypes` only *erases* types; it never touches module
 *      syntax. A source file written as `import`/`export` stayed that way in
 *      the output, which cannot be bundled into our CommonJS registry — the
 *      bundler wraps each module in `function (exports, require, module, ...)`
 *      and `export` is a parse error there. The old tool also had to hand-
 *      rewrite every relative `require('./x.ts')` specifier, because Node's CJS
 *      resolver will not find a `.ts` file from a plain specifier.
 *
 *   2. `tsc` does both jobs correctly and knows far more than a regex. With
 *      `module: commonjs` it emits real `exports.x = x`; with
 *      `rewriteRelativeImportExtensions` it rewrites `./x.ts` -> `./x.js` in the
 *      emitted require. It also typechecks on the way through, so a build
 *      cannot silently ship a type error that the strip path would have kept.
 *
 * Compiled vs copied, during the migration:
 *   - `lib/*.ts`                -> emitted by tsc (15 modules today)
 *   - nothing                   -> COPY_THROUGH is empty; every module has a
 *                                  `.ts` source and tsc is the only producer
 *                                  in `.build/js/`
 *
 * The copy-through is deliberately loud about each file it carries forward.
 * The old version's warning applies with full force: silently copying a .js
 * forward is exactly how a stale file survives a migration, so this prints
 * every one and the list shrinks to empty on its own as modules are converted.
 * It is empty now — `lib/server.js`, `server.js` and `desktop.js` were the last
 * three, and the `.ts` sources compiled here replace them.
 *
 * Why `.build/js/` and not a temp dir: this project has already been burned by
 * a build product that drifted from its source (NOTES.md #40). Writing the tree
 * where it can be read and diffed keeps "what actually got bundled" inspectable.
 *
 * Usage:
 *   node tools/build-js.js             # lib/ + entries
 *   node tools/build-js.js --check     # report what would change, write nothing
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.build', 'js');
const TSCONFIG = path.join(ROOT, 'tsconfig.json');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * Files with no `.ts` source yet. Copied through verbatim so the build stays
 * runnable at every step of the migration. Entries are relative to ROOT and
 * keep their path shape in `.build/js/`.
 *
 * EMPTY as of the completion of the TypeScript migration: all 15 modules plus
 * both entries are written in `.ts` and emitted by tsc. The mechanism is kept
 * rather than deleted — it is the documented escape hatch for a future module
 * that has to land as plain `.js` before it can be converted, and its guard
 * below (refusing a `.js` that already has a `.ts` twin) is worth more than the
 * few lines it costs.
 *
 * Keep this list exact. A missing entry does not fail loudly — the bundler
 * simply cannot resolve the import and dies later with a confusing message
 * (this bit me once with `lib/server.js`). And nothing may be added here that
 * already has a `.ts` source: the compile step emits that instead, and copying
 * the `.js` twin too would put a stale file back in the release path.
 */
const COPY_THROUGH = [];

/** Locate the tsc entry point, preferring the local install. */
function resolveTsc() {
  if (fs.existsSync(TSC)) return TSC;
  throw new Error(
    'typescript not found. Install it first:\n' +
    '  npm install --save-dev typescript',
  );
}

function main() {
  const check = process.argv.includes('--check');
  const tsc = resolveTsc();

  // rootDir/outDir both live in tsconfig.emit.json, so the emitted tree keeps
  // the `lib/` prefix and lands exactly where the bundler expects it.
  const args = [tsc, '-p', TSCONFIG];
  if (check) args.push('--noEmit');

  console.log(`  tsc ${check ? '(check only)' : `-> ${path.relative(ROOT, OUT_DIR)}`}`);
  try {
    execFileSync(process.execPath, ['--no-warnings', ...args], {
      stdio: 'inherit',
      cwd: ROOT,
    });
  } catch {
    // tsc already printed the diagnostics; a bare non-zero exit is noise.
    console.error('\ncompile failed: see the errors above');
    process.exit(1);
  }

  if (check) {
    console.log('\ncheck complete: no files written');
    return;
  }

  let copied = 0;
  for (const rel of COPY_THROUGH) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) {
      console.error(`  missing copy-through file: ${rel}`);
      process.exit(1);
    }
    // A .ts source always wins. If one appears, this file is stale and the
    // build should stop copying it — surface it rather than shadow the source.
    const tsTwin = src.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsTwin)) {
      console.error(
        `  ${rel} has a .ts twin (${path.relative(ROOT, tsTwin)}); ` +
          'remove it from COPY_THROUGH in tools/build-js.js',
      );
      process.exit(1);
    }
    const dest = path.join(OUT_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied++;
    console.log(`  copy  ${rel} (no .ts yet)`);
  }

  const emitted = countJs(OUT_DIR);
  console.log(`\n.build/js: ${emitted} file(s), ${copied} copied through`);
}

/** Count .js files under a directory. */
function countJs(dir) {
  let n = 0;
  (function walk(cur) {
    if (!fs.existsSync(cur)) return;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && abs.endsWith('.js')) n++;
    }
  })(dir);
  return n;
}

main();
