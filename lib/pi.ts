'use strict';
/**
 * The one place pi-agent is loaded.
 *
 * Why a dynamic `import()` and not an `import` statement
 * ------------------------------------------------------
 * `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` are ESM-only, and
 * their `exports` maps carry only an `import` condition. This project emits
 * CommonJS, and a CommonJS `require` of them fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` before Node ever gets to its require(esm)
 * support — there is no `require` or `default` entry to resolve. So a static
 * `import { ... } from '@mariozechner/pi-ai'` here would compile to a `require`
 * that cannot work.
 *
 * `import()` can. It is preserved verbatim in the emitted CommonJS because
 * tsconfig uses `module: nodenext`; under the old `module: commonjs`, tsc
 * rewrote `import()` into `require()` and this file would fail the same way.
 * In the packaged executable esbuild resolves the call at build time and
 * inlines the module, so nothing is imported from disk at runtime.
 *
 * Everything else in `lib/` reaches pi through `loadPi()` and uses
 * `import type` for its types — those are erased, so they emit no `require`.
 * Do not add a value import of either package anywhere else.
 */

import type * as PiAi from '@mariozechner/pi-ai';
import type * as PiAgent from '@mariozechner/pi-agent-core';

/** Both pi packages, as loaded. */
export interface Pi {
  ai: typeof PiAi;
  agent: typeof PiAgent;
}

let loading: Promise<Pi> | null = null;

/**
 * Load pi once per process. The promise is cached, not the result, so two
 * callers racing on the first turn share one import instead of starting two.
 * A failed load is not cached: the next caller retries rather than inheriting
 * an error forever.
 */
export function loadPi(): Promise<Pi> {
  if (!loading) {
    loading = Promise.all([
      import('@mariozechner/pi-ai'),
      import('@mariozechner/pi-agent-core'),
    ]).then(([ai, agent]) => ({ ai, agent }));
    loading.catch(() => { loading = null; });
  }
  return loading;
}
