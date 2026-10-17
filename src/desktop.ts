'use strict';
/**
 * Desktop entry point for the packaged build.
 *
 * Responsibilities, in order:
 *   1. resolve a writable data directory
 *   2. if an instance is already serving, just open a window at it and exit
 *   3. otherwise start the HTTP server on a free port
 *   4. open an Edge app-mode window pointed at it
 *   5. shut down when the window closes
 *
 * Kept separate from server.js, which stays the development entry. This file is
 * the SEA `main`, so it must not depend on __dirname resolving to anything real.
 *
 * Flags:
 *   --headless        start the server and print the URL without opening a window
 *   --port <n>        bind a fixed port instead of letting the OS choose
 *   --data-dir <p>    override the data directory
 *   --debug-assets    print asset resolution diagnostics and exit
 *   --new-instance    ignore a running instance and start a second one anyway
 *
 * The port can also come from `TAB_AGENT_PORT`. Precedence: flag, then
 * environment, then 0 (let the OS pick). A fixed port only applies when this
 * process is the one that starts the server — handing a window to an already
 * running instance never rebinds. Without `--new-instance` that is the normal
 * path, so the variable matters on a first launch, not a second.
 *
 * Module style: ESM `import`/`export`, compiled to CommonJS by `tsc`. Relative
 * specifiers carry the `.ts` extension and are rewritten to `.js` at emit by
 * `rewriteRelativeImportExtensions` (see src/store/settings.ts for the long version).
 */

import path from 'node:path';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from './http/server.ts';
import { isPackaged, embeddedKeys, readAsset, assetKeyFor } from './platform/assets.ts';
import { repoRoot, resolvePort } from './entry.ts';
import { parseArgs, resolveDataDir } from './desktop/args.ts';
import { findEdge } from './desktop/edge.ts';
import { findRunningInstance, publishInstance, unpublishInstance } from './desktop/instance.ts';
import { EARLY_EXIT_MS, openWindow, openInBrowserHint } from './desktop/window.ts';

// Where a development run reads the UI from. Only meaningful unpackaged: a
// SEA build reads its assets from the executable, and `__dirname` there
// points inside the blob.
const DEV_STATIC_DIR = path.join(repoRoot(__dirname), 'public');

/** Wait for the server to report a bound address. */
function listen(server: http.Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // The callback only runs once a socket is bound, so `address()` is an
    // AddressInfo here and never the string/null forms its type also allows.
    server.listen(port, host, () => resolve(server.address() as AddressInfo));
  });
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.debugAssets) {
    // Diagnostic for packaged builds: a clean injection can still serve nothing
    // if the asset registry is not reachable from inside the executable.
    let sea: SeaModule | null = null;
    let seaError: string | null = null;
    try {
      // Lazy on purpose, and NOT `await import('node:sea')` or a top-level
      // import: the whole point of this branch is that the lookup is allowed to
      // fail on a Node build without SEA, and a static import is hoisted above
      // the try/catch that is meant to absorb exactly that failure.
      //
      // `process.getBuiltinModule` is what makes that laziness work now that
      // this file is an ES module with no `require` of its own. The obvious
      // substitute, `createRequire(__filename)`, depends on what the bundler
      // makes of `__filename`: the hand-rolled bundler the executable used to
      // be built with defined it as the VIRTUAL module id (`desktop.js`), not
      // a path, and `createRequire` rejected it with a confusing "filename
      // must be ... an absolute path" error, traced to this line. esbuild now
      // leaves the real one in place, but `getBuiltinModule` takes a specifier
      // and no path at all, so no bundler can break it again.
      sea = process.getBuiltinModule('node:sea');
    } catch (e) {
      seaError = (e as Error).message;
    }
    console.log('isPackaged()        = ' + isPackaged());
    console.log('node:sea load error = ' + (seaError || 'none'));
    // Prints the real `isSea()` even when false — `n/a` is reserved for "the
    // module could not be loaded at all", which is a different diagnosis.
    console.log('sea.isSea()         = ' + (sea ? sea.isSea() : 'n/a'));
    console.log('embeddedKeys()      = ' + JSON.stringify(embeddedKeys()));
    console.log('staticDir           = ' + String(isPackaged() ? undefined : DEV_STATIC_DIR));
    for (const p of ['/', '/index.html', '/css/app.css', '/js/app.js']) {
      console.log(`assetKeyFor(${p.padEnd(22)}) = ${JSON.stringify(assetKeyFor(p))}`);
      const a = readAsset({ dir: isPackaged() ? undefined : DEV_STATIC_DIR, pathname: p });
      console.log(`   readAsset -> ${a ? a.body.length + ' bytes (' + a.type + ')' : 'null'}`);
    }
    return;
  }

  const dataDir = resolveDataDir(args);
  const profileDir = path.join(dataDir, 'window-profile');

  fs.mkdirSync(dataDir, { recursive: true });

  const edge = findEdge();

  // A second launch must not start a second server. Find the first one and hand
  // the window to it instead — this is what makes the ERR_CONNECTION_REFUSED
  // failure impossible rather than merely unlikely.
  if (!args.newInstance) {
    const running = await findRunningInstance(dataDir);
    if (running) {
      const url = `http://127.0.0.1:${running.port}`;
      console.log(`已在运行的实例  ${url}`);
      if (args.headless) {
        console.log('（--headless：直接退出，未开窗）');
        return;
      }
      if (!edge) {
        openInBrowserHint(url);
        return;
      }
      // Fire and forget: this process is only a launcher and should exit
      // immediately, leaving the already-running server untouched. The window
      // is detached, so it outlives us — without that it died with the exit
      // below and no window ever appeared.
      openWindow(edge, url, profileDir, args.extensions).unref();
      console.log('已把窗口指向该实例；本进程退出，原服务继续运行。');
      return;
    }
  }

  // Packaged builds read assets from the executable itself; a development run
  // reads them from public/. Passing staticDir when packaged is harmless but
  // meaningless, so only pass it when assets are actually on disk.
  const staticDir = isPackaged() ? undefined : DEV_STATIC_DIR;

  const server = createServer({ dataDir, staticDir });
  // Flag, then TAB_AGENT_PORT, then 0: the OS picks a free port.
  const addr = await listen(server, resolvePort(args.port, 0), args.host);
  const url = `http://${addr.address === '::' ? '127.0.0.1' : addr.address}:${addr.port}`;

  publishInstance(dataDir, addr.port);

  console.log(`Tab Agent  ${url}`);
  console.log(`数据目录     ${dataDir}`);
  if (isPackaged()) console.log(`内嵌资源     ${embeddedKeys().length} 个文件`);

  const shutdown = () => {
    unpublishInstance(dataDir);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  if (args.headless) {
    // Long-lived: the caller drives it over HTTP and kills the process.
    await new Promise(() => {});
    return;
  }

  if (!edge) {
    console.log('');
    openInBrowserHint(url);
    await new Promise(() => {});
    return;
  }

  const child = openWindow(edge, url, profileDir, args.extensions, false);

  const startedAt = Date.now();

  child.on('exit', () => {
    const lived = Date.now() - startedAt;

    // Edge reuses an existing instance for the same profile: the process we
    // spawned exits almost at once because another window took the request.
    // That window is still pointed at this server, so keep serving. A later
    // exit means a window we opened was actually closed, which is the only
    // exit that should stop the server.
    //
    // The single-instance check above handles the common case; this covers the
    // residue — a window left open from a previous run whose server has since
    // gone, so the lock file looked stale and we started a fresh server.
    if (lived < EARLY_EXIT_MS) {
      console.log('');
      console.log('已有窗口接管了本次启动；服务继续在下列地址运行：');
      console.log('  ' + url);
      console.log('（若没有窗口显示，请手动打开该地址；关闭本进程即可退出。）');
      return;
    }

    shutdown();
  });

  child.on('error', (err) => {
    // Could not spawn a browser at all. Do not take the server down: print the
    // address so the page is still reachable by hand.
    console.error('无法启动 Edge：' + err.message);
    console.log('服务仍在运行：' + url);
  });

  // Ctrl+C in a console, or a task-manager kill, should clear the record too.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, shutdown);
  }
}

/**
 * The subset of `node:sea` the `--debug-assets` branch reports on.
 *
 * Declared locally rather than imported so the diagnostic still type-checks on
 * a Node whose `node:sea` typings are absent — this branch is the one that has
 * to keep working exactly when that module is unavailable.
 */
interface SeaModule {
  isSea(): boolean;
}

main().catch((err) => {
  console.error('启动失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});
