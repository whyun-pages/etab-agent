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
 * `import()` (lib/pi.ts), and they pull in the provider SDKs — a graph of
 * mixed ESM and CommonJS that a regex over `require(...)` cannot follow.
 * esbuild resolves it, converts the ESM to CommonJS, and inlines the dynamic
 * imports, so the result still loads nothing from disk at runtime.
 *
 * Providers that are not shipped
 * ------------------------------
 * pi-ai loads each provider with a literal `import('./x.js')`, so esbuild
 * would bundle every one of them, SDKs included — Mistral's even needs an
 * optional OpenTelemetry package that is not installed. The settings panel
 * offers three protocols (lib/model.ts); the others are replaced with a stub
 * that throws when called. Nothing can call them: an unknown protocol in the
 * settings reads as the default.
 */

const path = require('node:path');
const esbuild = require('esbuild');
const { isBuiltin } = require('node:module');

/**
 * Provider modules pi-ai can load that this app never routes to. Keep in step
 * with MODEL_APIS in lib/model.ts: a protocol added there must come off this
 * list, or its first request fails with the stub's error.
 */
const UNSHIPPED_PROVIDERS = [
  'amazon-bedrock',
  'azure-openai-responses',
  'google-vertex',
  'mistral',
  'openai-codex-responses',
  'openai-responses',
];

const UNSHIPPED_RE = new RegExp(`^\\./(${UNSHIPPED_PROVIDERS.join('|')})\\.js$`);

/** Swap the unshipped providers for a stub, only where pi-ai registers them. */
const unshippedProviders = {
  name: 'unshipped-providers',
  setup(build) {
    build.onResolve({ filter: UNSHIPPED_RE }, (args) => {
      if (!/[\\/]pi-ai[\\/]dist[\\/]providers[\\/]register-builtins\.js$/.test(args.importer)) return undefined;
      return { path: path.basename(args.path, '.js'), namespace: 'unshipped' };
    });
    build.onLoad({ filter: /.*/, namespace: 'unshipped' }, (args) => ({
      loader: 'js',
      contents: `throw new Error(${JSON.stringify(`provider not included in this build: ${args.path}`)});`,
    }));
  },
};

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
    plugins: [unshippedProviders],
  });
  const out = result.metafile.outputs[path.relative(process.cwd(), outfile).replace(/\\/g, '/')]
    || Object.values(result.metafile.outputs)[0];
  const externals = [...new Set(out.imports.filter((i) => i.external).map((i) => i.path))].sort();
  return {
    bytes: out.bytes,
    inputs: Object.keys(result.metafile.inputs).length,
    externals,
    thirdParty: externals.filter((s) => !isBuiltin(s)),
    warnings: result.warnings.map((w) => `${w.location ? `${w.location.file}:${w.location.line}: ` : ''}${w.text}`),
  };
}

module.exports = { bundle, UNSHIPPED_PROVIDERS };
