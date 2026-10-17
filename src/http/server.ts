'use strict';
/**
 * HTTP API for the Tab agent: a Koa app.
 *
 * This file only assembles it — errors, caching, static files, the routes in
 * src/http/routes/, and the 404 — and owns the test seams `createServer` accepts.
 * What the server keeps between requests is src/http/app-state.ts.
 *
 * Why Koa, after a hand-rolled handler
 * ------------------------------------
 * The server began as zero dependencies: node:http, a regex per route, and a
 * focused multipart parser, on the grounds that a framework for one content
 * type was not worth the supply-chain surface. It grew to one 700-line
 * function where every route re-did its own body reading, matching and
 * decoding. Koa and its official router, body parser and multer binding take
 * that over, so each route reads as what it does. The dependencies are all
 * koajs-maintained, CommonJS, and bundle into the executable like the rest.
 *
 * Every endpoint answers JSON except the downloads and the UI's own files, so
 * the UI can render state without guessing.
 */

import http from 'node:http';
import path from 'node:path';
import Koa from 'koa';
import { AppState } from './app-state.ts';
import type { Extractor, PiModel } from './app-state.ts';
import { createRouter } from './routes/index.ts';
import { serveStatic } from './routes/static.ts';
import { fail, messageOf, safeFilename } from './respond.ts';
import type { Settings } from '../store/settings.ts';
import type { FetchOptions } from '../agent/tools/fetch-url.ts';

/**
 * What `createServer` accepts.
 *
 * `state` and `settingsOverride` are test seams: a caller can hand in a
 * pre-built state, or a whole settings object, so a test can run against a
 * scratch data directory without writing a real key anywhere. `model` is the
 * third, documented in full below.
 */
interface ServerOptions {
  state?: AppState;
  dataDir?: string;
  staticDir?: string;
  imageExtractor?: Extractor;
  textExtractor?: Extractor;
  model?: PiModel;
  settingsOverride?: Settings;
  /** Test seam for `fetch_url`; see `AppState.fetchOptions`. */
  fetchOptions?: FetchOptions;
  /** Test seams for opening attachments; see `AppState.openFile` / `openDir`. */
  openFile?: (file: string) => Promise<void>;
  openDir?: string;
}

/**
 * An http.Server that carries the state it serves with.
 *
 * `server.state` is how a caller reaches the live state after start-up (the
 * test suite constructs servers this way). Node's `Server` type has no such
 * property, so the intersection is what names it.
 */
type ServerWithState = http.Server & { state: AppState };

/** Errors become `{ ok: false, error }` with their status; 5xx is logged. */
const errors: Koa.Middleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    const e = err as { status?: number; statusCode?: number };
    const status = e.status || e.statusCode || 500;
    if (status >= 500) console.error('[tab-agent]', err);
    // The body parser's limit error is in English; the UI shows this text.
    fail(ctx, status, status === 413 ? '上传内容过大' : messageOf(err));
  }
};

/** API answers are state, never to be served from a cache. */
const noStore: Koa.Middleware = async (ctx, next) => {
  await next();
  if (ctx.path.startsWith('/api/')) ctx.set('Cache-Control', 'no-store');
};

/** Create the server. The caller listens. */
function createServer(opts: ServerOptions): ServerWithState {
  const state =
    opts.state ||
    new AppState({
      dataDir: opts.dataDir || path.join(process.cwd(), 'data'),
    });
  /**
   * Test seams for the agent model and settings.
   *
   * `model` replaces the model built from settings for the session endpoints.
   * A test passes a pi-ai faux model, so the REAL loop runs — tools, intent,
   * the guard, the replay — with only the provider scripted. Stubbing at the
   * module level does not work: src/agent/agent.ts reaches pi through `loadPi()`,
   * and a swapped module would never be seen by an import already resolved.
   *
   * `settingsOverride` is here for a related reason: a test needs a configured
   * model without writing a real key to a real data directory.
   */
  if (opts.model) state.agentModel = opts.model;
  if (opts.settingsOverride) state.settings = opts.settingsOverride;
  if (opts.fetchOptions) state.fetchOptions = opts.fetchOptions;
  if (opts.openFile) state.openFile = opts.openFile;
  if (opts.openDir) state.openDir = opts.openDir;

  const router = createRouter({ state, imageExtractor: opts.imageExtractor, textExtractor: opts.textExtractor });
  const app = new Koa();
  app.use(errors);
  app.use(noStore);
  app.use(serveStatic(opts.staticDir));
  app.use(router.routes());
  app.use(async (ctx) => {
    if (ctx.body === undefined) fail(ctx, 404, `未知接口：${ctx.method} ${ctx.path}`);
  });

  return Object.assign(http.createServer(app.callback()), { state });
}

export { createServer, AppState, safeFilename };
