'use strict';
/**
 * Entry point.
 *
 * Usage:
 *   node server.js [--port 3179] [--static public] [--data-dir <path>]
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
 * emit by `rewriteRelativeImportExtensions` (see lib/settings.ts for the long
 * version). This file has no exports — its side effect is starting a server —
 * so it stays a module by virtue of its `import`s.
 */

import path from 'node:path';
import { createServer } from './lib/server.ts';
import type { AddressInfo } from 'node:net';

/** The flags this entry understands, after parsing. */
interface Args {
  /** `null` = absent from the command line; a port of 0 is meaningful. */
  port: number | null;
  host: string;
  staticDir: string | null;
  dataDir: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    // null means "not given on the command line", so the environment variable
    // gets its turn. 0 is a legitimate value (bind any free port), which is why
    // this cannot use a truthiness test.
    port: null,
    host: '127.0.0.1',
    staticDir: null,
    dataDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--host') out.host = argv[++i];
    else if (a.startsWith('--host=')) out.host = a.slice(7);
    else if (a === '--static') out.staticDir = argv[++i];
    else if (a.startsWith('--static=')) out.staticDir = a.slice(9);
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a.startsWith('--data-dir=')) out.dataDir = a.slice(11);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = __dirname;

/**
 * Resolve the listening port.
 *
 * Explicit flag beats the environment, which beats the default. `0` is kept as
 * "let the OS choose" rather than being treated as unset, so a port of 0 from
 * any source still means the same thing.
 *
 * A value that is present but not a usable port number is fatal. Silently
 * binding 3179 because `TAB_AGENT_PORT=abc` was set would look like the
 * variable does not work at all.
 */
function resolvePort(): number {
  const fromEnv = process.env.TAB_AGENT_PORT;
  const raw = args.port !== null ? args.port : (fromEnv === undefined || fromEnv === '' ? 3179 : Number(fromEnv));
  const source = args.port !== null ? '--port' : (fromEnv ? 'TAB_AGENT_PORT' : '默认值');
  if (!Number.isInteger(raw) || raw < 0 || raw > 65535) {
    console.error(`${source} 不是可用端口：${args.port !== null ? args.port : fromEnv}（需要 0–65535 的整数）`);
    process.exit(1);
  }
  return raw;
}

const port = resolvePort();

// Precedence mirrors desktop.js: explicit flag, then the environment variable,
// then the in-repo default.
const dataDir = args.dataDir
  ? path.resolve(args.dataDir)
  : (process.env.TAB_AGENT_HOME ? path.resolve(process.env.TAB_AGENT_HOME) : path.join(root, 'data'));

const server = createServer({
  dataDir,
  staticDir: args.staticDir ? path.resolve(args.staticDir) : path.join(root, 'public'),
});

server.listen(port, args.host, () => {
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
