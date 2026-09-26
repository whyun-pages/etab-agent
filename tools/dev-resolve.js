'use strict';
/**
 * Dev/test resolution: point `require('../lib/x')` at the BUILD TREE.
 *
 * Why this exists
 * ---------------
 * `lib/` is TypeScript source only. There are no `.js` twins any more — they
 * were deleted on purpose, because a stale build product sitting next to its
 * source is exactly how a `.js` file survives a rename (NOTES.md #40). The
 * runtime tree is `.build/js/`, produced by `tools/build-js.js`.
 *
 * The test suite and the `.verify/` scripts all say `require('../lib/xlsx')`,
 * which is the right thing for them to say: `lib/` IS the module, conceptually.
 * Rather than rewrite 24+ require sites (and every future one) into
 * `require('../.build/js/lib/xlsx')` — which would hard-code the build layout
 * into the tests and break the moment the layout moves — this hook translates
 * at resolve time. Tests stay verbatim; the layout stays an implementation
 * detail of the build.
 *
 * How
 * ---
 * Node 24's synchronous `module.registerHooks` lets us intercept CJS
 * resolution. A specifier that lands inside `<root>/lib/` or is one of the root
 * entries is re-resolved against `<root>/.build/js/`. Anything else is left
 * alone, so `node_modules`, `public/`, and Node itself are untouched.
 *
 * Usage:
 *   node --require ./tools/dev-resolve.js --test "tests/*.test.js"
 *
 * The `test` script in package.json wires this up. It is registered with
 * `--require` rather than imported from a test helper so that it also applies
 * to files the test runner loads before any test body runs.
 */

const fs = require('node:fs');
const path = require('node:path');
const module_ = require('node:module');

const ROOT = path.join(__dirname, '..');
const BUILT = path.join(ROOT, '.build', 'js');

// Root-level entry files that also live in the build tree.
const ENTRY_FILES = new Set(['server.js', 'desktop.js']);

/** True when `abs` is a file we should reroute into the build tree. */
function isRedirectable(abs) {
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  // lib/*  or a root entry.
  if (rel.startsWith('lib' + path.sep)) return true;
  return ENTRY_FILES.has(rel);
}

/** Map a source-tree path to its build-tree counterpart. */
function toBuilt(abs) {
  return path.join(BUILT, path.relative(ROOT, abs));
}

if (!fs.existsSync(path.join(BUILT, 'desktop.js'))) {
  // Fail loudly and early: silently falling through would let the suite run
  // against nothing and report a misleading green.
  console.error(
    'tools/dev-resolve.js: .build/js/ is missing.\n' +
      'Run `npm run build:js` (or `node tools/build-js.js`) first.',
  );
  process.exit(1);
}

module_.registerHooks({
  resolve(specifier, context, nextResolve) {
    // Bare builtins and third-party packages: never reroute.
    if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) {
      return nextResolve(specifier, context);
    }
    const parent = context.parentURL ? fileURLToPathSafe(context.parentURL) : process.cwd();
    const target = path.resolve(path.dirname(parent), specifier);

    // Try the extensionless/`.js` forms a CJS require would accept.
    const candidates = [target, target + '.js', path.join(target, 'index.js')];
    let redirectable = false;
    for (const cand of candidates) {
      if (!isRedirectable(cand)) continue;
      redirectable = true;
      const built = toBuilt(cand);
      const builtCand = built.endsWith('.js') ? built : built + '.js';
      for (const bc of [built, builtCand, path.join(built, 'index.js')]) {
        if (fs.existsSync(bc) && fs.statSync(bc).isFile()) {
          return { url: pathToFileURLSafe(bc).href, shortCircuit: true };
        }
      }
    }
    // This is a source-tree module we were supposed to reroute, but the build
    // tree does not have it. Falling through here would silently load the
    // UNBUILT source — which "works" for an un-migrated .js and hides a missing
    // entry in tools/build-js.js's COPY_THROUGH. Fail instead.
    if (redirectable) {
      throw new Error(
        `tools/dev-resolve.js: ${specifier} (from ${parent}) is a source module of this ` +
          `project but is missing from the build tree (${path.relative(ROOT, BUILT)}).\n` +
          'Run `npm run build:js` — if it is still absent, add it to COPY_THROUGH in tools/build-js.js.',
      );
    }
    return nextResolve(specifier, context);
  },
});

function pathToFileURLSafe(p) {
  return require('node:url').pathToFileURL(p);
}
function fileURLToPathSafe(u) {
  return require('node:url').fileURLToPath(u);
}
