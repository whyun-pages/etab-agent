'use strict';
/**
 * Minimal CommonJS bundler for the SEA build.
 *
 * Why hand-rolled: the dependency graph is a small acyclic DAG of eleven
 * modules whose only external requires are `node:` builtins (see
 * tools/build-exe.js for the graph check). Pulling in esbuild or rollup to join
 * them would put a third-party toolchain in the release path of a project that
 * keeps its runtime dependency-free on purpose.
 *
 * How it works: every module is wrapped in a function, registered in a table
 * keyed by its path relative to the root, and `require('./x')` is rewritten to
 * `__require('x')`. Output is a single script the SEA blob can embed — required
 * because a packaged executable's own `require` only resolves builtins.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Match require('...') / require("..."). */
const REQUIRE_RE = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;

/**
 * Collect the module graph starting at an entry file.
 *
 * @param {string} entry absolute path to the entry module
 * @returns {{modules: Array<{id:string, file:string, source:string, deps:string[]}>}}
 */
function collectModules(entry) {
  const root = path.dirname(entry);
  const modules = [];
  const seen = new Map(); // absolute file -> id

  function idFor(file) {
    let rel = path.relative(root, file).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = './' + rel;
    // Registries use bare keys without the leading ./ for readability.
    return rel.replace(/^\.\//, '');
  }

  function visit(file) {
    const abs = path.resolve(file);
    if (seen.has(abs)) return seen.get(abs);
    if (!fs.existsSync(abs)) throw new Error(`module not found: ${file}`);

    const id = idFor(abs);
    seen.set(abs, id);

    const source = fs.readFileSync(abs, 'utf8');
    const deps = [];
    // Fresh regex per module; see externalSpecs for why this is not shared.
    const re = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
    let m;
    while ((m = re.exec(source)) !== null) {
      const spec = m[2];
      if (!spec.startsWith('.')) continue; // node: builtins stay untouched
      const depFile = path.resolve(path.dirname(abs), spec);
      const resolved = fs.existsSync(depFile)
        ? depFile
        : fs.existsSync(depFile + '.js')
          ? depFile + '.js'
          : null;
      if (!resolved) throw new Error(`cannot resolve "${spec}" from ${abs}`);
      deps.push({ spec, id: visit(resolved) });
    }

    modules.push({ id, file: abs, source, deps: deps.map((d) => d.id) });
    // Rewrite relative requires to registry lookups. Builtins are left alone —
    // they are not in the registry, and rewriting them would break the bundle.
    let rewritten = source;
    for (const d of deps) {
      const quoted = new RegExp(
        `require\\(\\s*['"]${d.spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\)`,
        'g',
      );
      rewritten = rewritten.replace(quoted, `__require(${JSON.stringify(d.id)})`);
    }
    modules[modules.length - 1].rewritten = rewritten;
    return id;
  }

  visit(entry);
  return { modules, entryId: idFor(path.resolve(entry)) };
}

/** External (node:) specifiers referenced anywhere in the graph. */
function externalSpecs(modules) {
  const out = new Set();
  for (const mod of modules) {
    // Fresh regex per module: REQUIRE_RE is stateful (global flag) and sharing
    // one instance across passes corrupts lastIndex.
    const re = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
    let m;
    while ((m = re.exec(mod.source)) !== null) {
      if (!m[2].startsWith('.')) out.add(m[2]);
    }
  }
  return out;
}

/** Render the registry into one script. */
function renderBundle(modules, { entryId, banner = '' }) {
  const parts = [];
  parts.push("'use strict';");
  if (banner) parts.push(banner.trim());
  parts.push('');
  parts.push('// --- module registry -------------------------------------------------');
  parts.push('var __modules = {};');
  parts.push('var __cache = {};');
  // Fall through to Node's own loader for builtins. Injected executables only
  // resolve builtins through the real require, and third-party packages are
  // absent by design, so anything that is not a bundled module must be a
  // builtin or a hard error.
  parts.push('var __nodeRequire = require;');
  parts.push('');
  parts.push('function __require(id) {');
  parts.push("  if (Object.prototype.hasOwnProperty.call(__cache, id)) return __cache[id].exports;");
  parts.push('  var mod = __modules[id];');
  parts.push('  if (!mod) {');
  parts.push("    if (id.charAt(0) !== '.') return __nodeRequire(id);");
  parts.push("    throw new Error('module not bundled: ' + id);");
  parts.push('  }');
  parts.push('  var entry = { exports: {} };');
  parts.push('  __cache[id] = entry;');
  parts.push("  var dir = id.indexOf('/') < 0 ? '' : id.slice(0, id.lastIndexOf('/'));");
  parts.push('  mod.call(entry.exports, entry.exports, __require, entry, id, dir);');
  parts.push('  return entry.exports;');
  parts.push('}');
  parts.push('');

  for (const mod of modules) {
    // __dirname/__filename are virtual: a packaged executable has no path that
    // maps to the source tree, so these exist only to keep modules that mention
    // them from throwing. Never derive a filesystem path from them in a build.
    const vdir = path.posix.dirname(mod.id);
    parts.push(`// --- ${mod.id} ---`);
    parts.push(
      `__modules[${JSON.stringify(mod.id)}] = function (exports, require, module, __filename, __dirname) {`,
    );
    parts.push(mod.rewritten.trimEnd());
    parts.push('};');
    parts.push('');
  }

  parts.push(`__require(${JSON.stringify(entryId)});`);
  parts.push('');
  return parts.join('\n');
}

module.exports = { collectModules, renderBundle, externalSpecs, REQUIRE_RE };
