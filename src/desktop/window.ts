'use strict';
/**
 * The app window: Edge in app mode on its own profile, or, without Edge, the
 * address printed for a browser.
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { isEdge } from './edge.ts';

// ------------------------------------------------------------------- window

/**
 * An Edge launch that exits faster than this was a handoff to an existing
 * Edge instance, not a window the user closed. Short enough to catch the
 * handoff (measured at ~170ms), long enough not to swallow a real close.
 */
export const EARLY_EXIT_MS = 1500;

/**
 * Open (or focus) the app window.
 *
 * `--app=` with our own profile gives the window its own taskbar identity and
 * keeps it off the user's normal browsing session.
 *
 * Extensions are off by default (`--disable-extensions`). "Our own profile"
 * does not mean an empty one: signing in to Edge inside the window turns on
 * sync, and sync installs the user's extensions here too — one real profile had
 * 21, including a CORS rewriter and several that inject UI into every page.
 * This window only ever shows our page, which needs none of them. The flag only
 * stops them loading in this browser process; nothing is uninstalled, and
 * `--extensions` / `TAB_AGENT_EXTENSIONS=1` brings them back (for devtools).
 *
 * Edge reads flags only when the browser process for a profile starts. While
 * an app window is open, a second launch is handed to that process and its
 * flags are ignored — so a change here takes effect after every window closes.
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
export function openWindow(
  edge: string,
  url: string,
  profileDir: string,
  extensions: boolean,
  detach = true,
): ChildProcess {
  fs.mkdirSync(profileDir, { recursive: true });
  const flags = [`--app=${url}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'];
  if (!extensions) flags.push('--disable-extensions');
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
export function openInBrowserHint(url: string): void {
  console.log('未找到 Microsoft Edge，请手动在浏览器打开：');
  console.log('  ' + url);
  console.log('服务保持运行；关闭本进程即可退出。');
}
