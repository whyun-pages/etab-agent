'use strict';
/**
 * Entry point.
 *
 * Usage:
 *   node .build/js/server.js [--port 3179] [--static public] [--data-dir <path>]
 *   (or `pnpm start`, which compiles first; `pnpm start:dev` runs this source via tsx)
 *
 * The listening port can also come from `TAB_AGENT_PORT`. Precedence is
 * explicit flag, then the environment variable, then the built-in default —
 * the same order `--data-dir` / `TAB_AGENT_HOME` already uses, so there is
 * one rule to remember rather than two.
 *
 * A malformed value is a hard error rather than a silent fallback: binding a
 * port the user did not ask for looks like the setting was ignored.
 *
 * Serves the UI from public/ and the JSON API under /api/.
 *
 * `--data-dir` exists for parity with the desktop entry and for tests: the
 * packaged app resolves its data directory from APPDATA / TAB_AGENT_HOME,
 * while this dev entry used to hard-code `<repo>/data`. That difference meant a
 * test could point the environment at a scratch directory, watch the server
 * ignore it, and read the DEFAULT settings — which looks exactly like a
 * misconfigured model and sends you debugging the wrong thing.
 *
 * Module style: ESM `import`/`export`, compiled to CommonJS by `tsc`. The
 * relative specifier carries the `.ts` extension and is rewritten to `.js` at
 * emit by `rewriteRelativeImportExtensions` (see src/store/settings.ts for the long
 * version). This file has no exports — its side effect is starting a server —
 * so it stays a module by virtue of its `import`s.
 */

import path from 'node:path';
import { createServer } from './http/server.ts';
import { parseFlags, repoRoot, resolvePort } from './entry.ts';
import type { AddressInfo } from 'node:net';

const args = parseFlags(process.argv.slice(2), {
  port: { type: 'string', short: 'p' },
  host: { type: 'string' },
  static: { type: 'string' },
  'data-dir': { type: 'string' },
});
const host = args.host ?? '127.0.0.1';
const root = repoRoot(__dirname);

// Flag, then TAB_AGENT_PORT, then 3179. A value that is present but not a
// port is fatal: silently binding 3179 because `TAB_AGENT_PORT=abc` was set
// would look like the variable does not work at all.
const port = resolvePort(args.port, 3179);

// Precedence mirrors desktop.js: explicit flag, then the environment variable,
// then the in-repo default.
const dataDir = args['data-dir']
  ? path.resolve(args['data-dir'])
  : process.env.TAB_AGENT_HOME
    ? path.resolve(process.env.TAB_AGENT_HOME)
    : path.join(root, 'data');

const server = createServer({
  dataDir,
  staticDir: args.static ? path.resolve(args.static) : path.join(root, 'public'),
});

server.listen(port, host, () => {
  // The callback runs only once the socket is bound, so `address()` is an
  // AddressInfo and never the string/null forms its type also allows.
  const addr = server.address() as AddressInfo;
  console.log(`Tab Agent 已启动: http://${addr.address}:${addr.port}`);
  console.log(`数据目录: ${dataDir}`);
});

// Close cleanly so the port is released during development.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
