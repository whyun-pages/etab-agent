'use strict';
/**
 * The one place pi-agent is loaded.
 *
 * Why a dynamic `import()` and not an `import` statement
 * ------------------------------------------------------
 * `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` are ESM-only, and
 * their `exports` maps carry only an `import` condition. This project emits
 * CommonJS, and a CommonJS `require` of them fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` before Node ever gets to its require(esm)
 * support — there is no `require` or `default` entry to resolve. So a static
 * `import { ... } from '@earendil-works/pi-ai'` here would compile to a `require`
 * that cannot work.
 *
 * `import()` can. It is preserved verbatim in the emitted CommonJS because
 * tsconfig uses `module: nodenext`; under the old `module: commonjs`, tsc
 * rewrote `import()` into `require()` and this file would fail the same way.
 * In the packaged executable esbuild resolves the call at build time and
 * inlines the module, so nothing is imported from disk at runtime.
 *
 * Everything else in `src/` reaches pi through `loadPi()` and uses
 * `import type` for its types — those are erased, so they emit no `require`.
 * Do not add a value import of either package anywhere else.
 */

import type * as PiAi from '@earendil-works/pi-ai';
import type * as PiAgent from '@earendil-works/pi-agent-core';
import type {
  AssistantMessageEventStream,
  Model,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai';

/**
 * Who streams a request, by protocol
 * ----------------------------------
 * pi-ai 1.x dropped the global `stream()` that dispatched on `model.api`
 * through a process-wide registry. What replaced it is a `Models` collection
 * of providers, each owning a model catalogue and its auth — machinery for an
 * app that picks models from a list. This app never does (src/agent/model.ts builds
 * the `Model` by hand from the user's settings and passes the key itself), so
 * it uses the other documented route: each protocol's API implementation,
 * called directly.
 *
 * The `.lazy` wrappers are what is imported, not the implementations: they
 * load the provider SDK on the first request, so loading pi stays cheap. They
 * are also the whole list of what gets bundled — esbuild follows only these
 * three, so no other provider SDK reaches the executable.
 *
 * `/compat` would have kept the old global API with a one-line change, but it
 * is marked for removal and drags in every built-in catalogue.
 *
 * The table is a plain map, not a closed switch, because the tests register
 * their faux provider in it — the same role the global registry played.
 */

/** Both pi packages, as loaded, and the streams for each offered protocol. */
export interface Pi {
  ai: typeof PiAi;
  agent: typeof PiAgent;
  /** Stream implementations by `Model.api`. Tests add their faux provider here. */
  apis: Map<string, ProviderStreams>;
  /** Stream one request with the implementation for `model.api`. */
  stream(model: Model<any>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream;
  /** As `stream`, with pi's unified options — what the agent loop calls. */
  streamSimple(
    model: Model<any>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
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
      import('@earendil-works/pi-ai'),
      import('@earendil-works/pi-agent-core'),
      import('@earendil-works/pi-ai/api/openai-completions.lazy'),
      import('@earendil-works/pi-ai/api/anthropic-messages.lazy'),
      import('@earendil-works/pi-ai/api/google-generative-ai.lazy'),
    ]).then(([ai, agent, openai, anthropic, google]) => {
      // Keys are the ids in MODEL_APIS (src/agent/model.ts); keep the two in step.
      const apis = new Map<string, ProviderStreams>([
        ['openai-completions', openai.openAICompletionsApi()],
        ['anthropic-messages', anthropic.anthropicMessagesApi()],
        ['google-generative-ai', google.googleGenerativeAIApi()],
      ]);
      const streamsFor = (model: Model<any>): ProviderStreams => {
        const streams = apis.get(model.api);
        if (!streams) throw new Error(`no stream implementation for api: ${model.api}`);
        return streams;
      };
      return {
        ai,
        agent,
        apis,
        stream: (model, context, options) => streamsFor(model).stream(model, context, options),
        streamSimple: (model, context, options) => streamsFor(model).streamSimple(model, context, options),
      };
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
