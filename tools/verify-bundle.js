'use strict';
/**
 * Verify the bundler before it is trusted in the release path.
 *
 * Checks:
 *   1. the module graph has no external (non-builtin) requires
 *   2. the graph is acyclic
 *   3. the rendered bundle actually runs and exposes createServer
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { collectModules, renderBundle, externalSpecs } = require('./bundle');

const ROOT = path.join(__dirname, '..');
// Which entry to bundle. The desktop entry is what ships; server.js stays the
// development entry and is useful for checking the graph in isolation.
const ENTRY_NAME = process.argv[2] || 'desktop.js';
// Bundle from the BUILD TREE, not the source tree. `lib/` holds both .ts sources
// and pre-migration .js twins, and Node resolves an extensionless require to the
// .ts — so collecting from the source tree would pull raw TypeScript into the
// bundle and fail to parse. `.build/js/` is the tree that actually ships; the
// bundler should be checked against it (NOTES.md #40).
const BUILT = path.join(ROOT, '.build', 'js');
const ENTRY = fs.existsSync(path.join(BUILT, ENTRY_NAME))
  ? path.join(BUILT, ENTRY_NAME)
  : path.join(ROOT, ENTRY_NAME);

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || !detail ? '' : '  -> ' + detail));
  if (!ok) failures++;
}

console.log('===== 1) collect graph =====');
const { modules, entryId } = collectModules(ENTRY);
check(`entry id is ${ENTRY_NAME}`, entryId === ENTRY_NAME, entryId);
check('module count > 1', modules.length > 1, String(modules.length));
console.log('     modules: ' + modules.map((m) => m.id).join(', '));

console.log('\n===== 2) external requires must be node: builtins only =====');
const externals = [...externalSpecs(modules)].sort();
console.log('     externals: ' + externals.join(', '));
const badExternal = externals.filter((s) => !s.startsWith('node:'));
check('no third-party requires', badExternal.length === 0, badExternal.join(', '));

console.log('\n===== 3) acyclic =====');
// collectModules would recurse forever on a cycle; it completed, so the graph
// is a DAG. Assert directly for a clearer signal.
const byId = new Map(modules.map((m) => [m.id, m]));
let cycle = null;
const state = new Map();
function walk(id, stack) {
  if (state.get(id) === 'done') return;
  if (state.get(id) === 'open') { cycle = stack.concat(id).join(' -> '); return; }
  state.set(id, 'open');
  for (const dep of byId.get(id).deps) walk(dep, stack.concat(id));
  state.set(id, 'done');
}
walk(entryId, []);
check('no circular dependency', cycle === null, cycle || '');

console.log('\n===== 4) rendered bundle runs in a bare context =====');
const code = renderBundle(modules, { entryId });
check('bundle is non-trivial', code.length > 20000, String(code.length) + ' bytes');

// A packaged executable receives only builtins for its own require, so give the
// sandbox a require that can reach builtins and nothing else.
const sandboxRequire = (spec) => {
  if (!spec.startsWith('node:')) throw new Error('third-party module in SEA: ' + spec);
  return require(spec);
};
const sandbox = { require: sandboxRequire, console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextDecoder, TextEncoder };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(code, ctx, { filename: 'bundle.js' });
  check('bundle executed', true);
} catch (e) {
  check('bundle executed', false, e.message);
}

// The bundle's modules register via __require; expose the entry's exports to
// the sandbox by re-running with a probe appended. Registry keys carry the .js
// suffix — `lib/server`, not `lib/server.js`, is a miss.
const probe = code + '\n;globalThis.__probe = __require("lib/server.js");\n';
try {
  vm.runInContext(probe, ctx, { filename: 'bundle-probe.js' });
  const api = ctx.__probe;
  check('lib/server exports createServer', typeof api.createServer === 'function');
  check('lib/server exports AppState', typeof api.AppState === 'function');
} catch (e) {
  check('entry exports reachable', false, e.message);
}

console.log('\n' + (failures === 0 ? 'BUNDLER CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
