'use strict';
/**
 * Bundle the compiled app into one CommonJS script for the SEA build.
 *
 * A packaged executable's own `require` resolves builtins only, so the whole
 * module graph — this project's modules AND, since the move to pi-agent, its
 * npm dependencies — has to be joined into a single script before it is
 * embedded.
 *
 * Why esbuild now, after a hand-rolled bundler
 * --------------------------------------------
 * The bundler this replaced joined eleven first-party CommonJS modules and
 * refused anything else, on purpose: the runtime had no dependencies. pi-ai and
 * pi-agent-core changed that. They are ESM-only, reached through a dynamic
 * `import()` (src/agent/pi.ts), and they pull in the provider SDKs — a graph of
 * mixed ESM and CommonJS that a regex over `require(...)` cannot follow.
 * esbuild resolves it, converts the ESM to CommonJS, and inlines the dynamic
 * imports, so the result still loads nothing from disk at runtime.
 *
 * Providers that are not shipped
 * ------------------------------
 * Up to pi-ai 0.x, a global registry loaded every provider with a literal
 * `import('./x.js')`, so esbuild bundled all of them, SDKs included, and a
 * plugin here swapped the unused ones for a stub. Since 1.x, src/agent/pi.ts imports
 * the three protocols the settings panel offers by name, and nothing else is
 * reachable — the graph itself leaves the other SDKs out, so the stub is gone.
 */

const path = require('node:path');
const esbuild = require('esbuild');
const { isBuiltin } = require('node:module');

/**
 * Bundle `entry` into `outfile`.
 *
 * @returns {Promise<{ bytes: number, inputs: number, externals: string[], thirdParty: string[], warnings: string[] }>}
 *   `externals` is every import left for runtime resolution; `thirdParty` the
 *   ones that are not builtins, which a packaged executable cannot load.
 */
async function bundle({ entry, outfile, banner = '' }) {
  const result = await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    metafile: true,
    // Same input, same bytes: no timestamps, and esbuild's output order is
    // deterministic for a given graph.
    banner: banner ? { js: banner } : undefined,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const out =
    result.metafile.outputs[path.relative(process.cwd(), outfile).replace(/\\/g, '/')] ||
    Object.values(result.metafile.outputs)[0];
  const externals = [...new Set(out.imports.filter((i) => i.external).map((i) => i.path))].sort();
  return {
    bytes: out.bytes,
    inputs: Object.keys(result.metafile.inputs).length,
    externals,
    thirdParty: externals.filter((s) => !isBuiltin(s)),
    warnings: result.warnings.map((w) => `${w.location ? `${w.location.file}:${w.location.line}: ` : ''}${w.text}`),
  };
}

module.exports = { bundle };
