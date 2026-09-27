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
 * `rewriteRelativeImportExtensions` (see lib/settings.ts for the long version).
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer } from './lib/server.ts';
import { isPackaged, embeddedKeys, readAsset, assetKeyFor } from './lib/assets.ts';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';

// Where a development run reads the UI from. Unpackaged, this file runs either
// as tsc output at `.build/js/desktop.js` (`public/` two levels up) or as source
// via tsx (`public/` alongside) — the same split as `root` in server.ts, and
// recognised the same way. Only meaningful unpackaged: a SEA build reads its
// assets from the executable, and `__dirname` there points inside the blob.
const DEV_STATIC_DIR = path.basename(__dirname) === 'js' && path.basename(path.dirname(__dirname)) === '.build'
  ? path.join(__dirname, '..', '..', 'public')
  : path.join(__dirname, 'public');

/** The flags this entry understands, after parsing. */
interface Args {
  headless: boolean;
  /** `null` = absent from the command line; a port of 0 is meaningful. */
  port: number | null;
  dataDir: string | null;
  host: string;
  debugAssets: boolean;
  newInstance: boolean;
}

/** Parse the handful of flags this entry understands. */
function parseArgs(argv: string[]): Args {
  const out: Args = {
    // null means "not given on the command line", so the environment variable
    // gets its turn. 0 is meaningful (let the OS choose) and must not be
    // confused with "unset".
    headless: false, port: null, dataDir: null, host: '127.0.0.1',
    debugAssets: false, newInstance: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headless') out.headless = true;
    else if (a === '--debug-assets') out.debugAssets = true;
    else if (a === '--new-instance') out.newInstance = true;
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--host') out.host = argv[++i];
    else if (a.startsWith('--host=')) out.host = a.slice(7);
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a.startsWith('--data-dir=')) out.dataDir = a.slice(11);
  }
  return out;
}

/**
 * Where user data lives.
 *
 * A packaged app is often installed somewhere read-only, so data cannot sit
 * beside the executable. Precedence: explicit flag, then the environment
 * variable, then the per-user application data directory.
 */
function resolveDataDir(args: Args): string {
  if (args.dataDir) return path.resolve(args.dataDir);
  if (process.env.TAB_AGENT_HOME) return path.resolve(process.env.TAB_AGENT_HOME);
  const base = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'share'));
  return path.join(base, 'TabAgent');
}

/**
 * Edge candidates, most specific first, per platform.
 *
 * Windows keeps the three install locations it has always used. On macOS the
 * browser binary lives inside the .app bundle rather than at a bare path, and
 * the per-user install under ~/Applications is real enough to check. On Linux
 * there is no single canonical location — a distro package and a snap/flatpak
 * install land in different places — so the list is the common ones, with
 * /usr/bin symlinked on most systems.
 *
 * A missing browser is not fatal: main() falls back to printing the address so
 * the page can be opened by hand. That is deliberate — the server is the
 * product, the window is a convenience.
 */
function findEdge(): string | null {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(os.homedir(), 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
    );
  } else {
    candidates.push(
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/opt/microsoft/msedge/microsoft-edge',
      '/snap/bin/microsoft-edge',
      '/var/lib/flatpak/exports/bin/com.microsoft.Edge',
    );
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Is this the Edge binary? The `--disable-features=msEdgeAutoLaunch` flag is
 * Edge-specific: passing it to another Chromium browser is harmless but
 * meaningless, so it goes on only when it applies.
 */
function isEdge(bin: string): boolean {
  return /msedge|microsoft.?edge/i.test(path.basename(bin));
}

/** Wait for the server to report a bound address. */
function listen(server: http.Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // The callback only runs once a socket is bound, so `address()` is an
    // AddressInfo here and never the string/null forms its type also allows.
    server.listen(port, host, () => resolve(server.address() as AddressInfo));
  });
}

/**
 * Resolve the listening port: flag, then environment, then 0 (OS picks).
 *
 * 0 stays meaningful throughout — it is how the app asks the OS for a free
 * port, and it must not be confused with "unset". A value that is present but
 * unusable is fatal rather than quietly ignored: binding a port nobody asked
 * for is indistinguishable from the variable not working.
 */
function resolvePort(args: Args): number {
  const fromEnv = process.env.TAB_AGENT_PORT;
  if (args.port !== null) return args.port;
  if (fromEnv === undefined || fromEnv === '') return 0;
  const n = Number(fromEnv);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`TAB_AGENT_PORT 不是可用端口：${fromEnv}（需要 0–65535 的整数）`);
    process.exit(1);
  }
  return n;
}

// ------------------------------------------------------------ single instance

/**
 * Why this exists
 * ---------------
 * Edge is single-instance per profile. When a window for the profile is already
 * open, the msedge.exe we spawn hands the request to the running instance and
 * exits within a few hundred milliseconds — which looks exactly like "the user
 * closed the window". Treating it as such shut the server down underneath a
 * window still on screen, and the user got ERR_CONNECTION_REFUSED.
 *
 * The fix is not to guess at the exit code but to not create the situation: a
 * second launch finds the first one's published port, opens a window at it, and
 * exits without ever starting a server of its own.
 *
 * The record lives in the data directory. It is only advisory: on a stale entry
 * (crash, power loss) the probe below fails and we start normally, overwriting
 * it.
 */
function instanceRecordPath(dataDir: string): string {
  return path.join(dataDir, 'instance.json');
}

/** The published record as it is read back. Advisory only, so its fields are. */
interface InstanceRecord {
  port: number;
  pid?: number;
}

/** Is something answering as this app on that port? */
function probeHealth(port: number, timeoutMs = 1200): Promise<{ port: number } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        // Require our own identity, not just any 200: some unrelated dev server
        // on that port must not be mistaken for a running instance.
        //
        // `app` is a fixed string rather than a field that can be removed. An
        // earlier version keyed on `templates`, which vanished when the template
        // concept was dropped — and single-instance detection then failed
        // silently, restarting a server on every launch. Identity that cannot be
        // deleted is the point.
        try {
          const j = JSON.parse(s);
          resolve(j && j.ok === true && j.app === 'tab-agent' ? { port } : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

/** Read the published port, if a live instance still answers on it. */
async function findRunningInstance(dataDir: string): Promise<{ port: number; pid: number | undefined } | null> {
  const file = instanceRecordPath(dataDir);
  let rec: InstanceRecord;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!rec || !Number.isInteger(rec.port)) return null;
  const alive = await probeHealth(rec.port);
  if (!alive) {
    // Stale record from a crash. Clear it so it cannot mislead a later launch.
    try { fs.unlinkSync(file); } catch {}
    return null;
  }
  return { port: rec.port, pid: rec.pid };
}

function publishInstance(dataDir: string, port: number): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(instanceRecordPath(dataDir), JSON.stringify({
      port, pid: process.pid, startedAt: new Date().toISOString(),
    }, null, 2));
  } catch { /* advisory only; never fatal */ }
}

function unpublishInstance(dataDir: string): void {
  try { fs.unlinkSync(instanceRecordPath(dataDir)); } catch {}
}

// ------------------------------------------------------------------- window

/**
 * An Edge launch that exits faster than this was a handoff to an existing
 * Edge instance, not a window the user closed. Short enough to catch the
 * handoff (measured at ~170ms), long enough not to swallow a real close.
 */
const EARLY_EXIT_MS = 1500;

/**
 * Open (or focus) the app window.
 *
 * `--app=` with our own profile gives the window its own taskbar identity and
 * keeps it off the user's normal browsing session.
 *
 * Detached on purpose. The handoff branch ("an instance is already running")
 * spawns the window and then returns, so the launcher exits milliseconds later.
 * A child in the caller's process group dies with it, and the window never
 * appears — measured: 0 surviving msedge.exe processes with detached:false
 * versus 16+ with detached:true. The normal path did not expose this only
 * because that parent stays alive to watch the window.
 *
 * @param {boolean} [detach] default true; false only for tests that want to
 *   own the child's lifetime.
 * @returns {import('node:child_process').ChildProcess}
 */
function openWindow(edge: string, url: string, profileDir: string, detach = true): ChildProcess {
  fs.mkdirSync(profileDir, { recursive: true });
  const flags = [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  // Edge-only flag; see isEdge().
  if (isEdge(edge)) flags.push('--disable-features=msEdgeAutoLaunch');
  return spawn(edge, flags, { stdio: 'ignore', detached: detach });
}

/**
 * The message shown when no Edge was found. The address is printed on its own
 * line so it can be copied or clicked; the wording names no platform, because
 * the reason we got here differs (not installed, installed somewhere unusual,
 * or a Linux distro we did not guess).
 */
function openInBrowserHint(url: string): void {
  console.log('未找到 Microsoft Edge，请手动在浏览器打开：');
  console.log('  ' + url);
  console.log('服务保持运行；关闭本进程即可退出。');
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
      // substitute, `createRequire(__filename)`, is worse than useless here:
      // the bundler that builds the executable defines `__filename` as the
      // VIRTUAL module id (`desktop.js`), not a path, and `createRequire`
      // rejects it. That broke the packaged build with a confusing
      // "filename must be ... an absolute path" error, traced to this line.
      // `getBuiltinModule` takes a specifier and no path at all.
      sea = process.getBuiltinModule('node:sea');
    } catch (e) { seaError = (e as Error).message; }
    console.log('isPackaged()        = ' + isPackaged());
    console.log('node:sea load error = ' + (seaError || 'none'));
    // Prints the real `isSea()` even when false — `n/a` is reserved for "the
    // module could not be loaded at all", which is a different diagnosis.
    console.log('sea.isSea()         = ' + (sea ? sea.isSea() : 'n/a'));
    console.log('embeddedKeys()      = ' + JSON.stringify(embeddedKeys()));
    console.log('staticDir           = ' + String(isPackaged() ? undefined : DEV_STATIC_DIR));
    for (const p of ['/', '/index.html', '/css/app.css', '/sample/contract.xlsx']) {
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
      openWindow(edge, url, profileDir).unref();
      console.log('已把窗口指向该实例；本进程退出，原服务继续运行。');
      return;
    }
  }

  // Packaged builds read assets from the executable itself; a development run
  // reads them from public/. Passing staticDir when packaged is harmless but
  // meaningless, so only pass it when assets are actually on disk.
  const staticDir = isPackaged() ? undefined : DEV_STATIC_DIR;

  const server = createServer({ dataDir, staticDir });
  const addr = await listen(server, resolvePort(args), args.host);
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

  const child = openWindow(edge, url, profileDir, false);

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
