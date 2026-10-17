'use strict';
/**
 * UI asset registry.
 *
 * Two ways to reach the UI assets, chosen at runtime:
 *
 *   1. Packaged single executable (`node --experimental-sea-config`): the
 *      `public/` tree is embedded as SEA assets and read through `node:sea`.
 *      Nothing touches the disk, which matters because a packaged app has no
 *      reliable directory to read from — `__dirname` points inside the blob.
 *   2. Development: assets are read from `public/` on disk as before.
 *
 * Both paths return the same Buffer, so the request handler does not branch on
 * which one is active.
 *
 * Asset keys are stored as POSIX-style relative paths (`css/app.css`), matching
 * how they are declared in the sea-config manifest.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * The subset of `node:sea` this module uses.
 *
 * `getAsset` returns `ArrayBuffer` rather than `string | Uint8Array`: assets in
 * the blob are always bytes, and naming that exactly is what lets `Buffer.from`
 * take the value without an overload pick.
 */
interface SeaModule {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
  getAssetKeys(): string[];
}

/** One asset, resolved and typed. */
interface Asset {
  body: Buffer;
  type: string;
  key: string;
}

interface ReadAssetOptions {
  /** directory to read from in development */
  dir?: string;
  pathname: string;
}

/** @returns the sea module when running packaged */
function loadSea(): SeaModule | null {
  try {
    // This `require` is UNCONVERTED ON PURPOSE — the one deliberate exception
    // to the ESM import style in this file.
    //
    // `node:sea` exists in all supported Node versions, but the whole point of
    // this function is that the lookup is allowed to FAIL: the try/catch is
    // what returns null in an environment where the module cannot be loaded.
    // A static `import sea from 'node:sea'` is hoisted to the top of the
    // module and throws at load time instead, taking down every consumer of
    // `assets.ts` — not just the packaged path that wanted it. There is no
    // `await` available either: `loadSea()`, `readAsset()` and `isPackaged()`
    // are all synchronous, and the callers are synchronous too.
    //
    // `createRequire` would keep it dynamic but adds a dependency on the
    // module system for no gain here: this file is emitted to CommonJS, so
    // `require` already exists and already is the thing being guarded.
    //
    // `isSea()` only returns true once a blob has been injected, so the guard
    // on the function below still applies.
    const sea: SeaModule = require('node:sea');
    return typeof sea.isSea === 'function' && sea.isSea() ? sea : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a request path into an asset key.
 * `/css/app.css` -> `css/app.css`; `/` -> `index.html`.
 * @returns null when the path escapes or is unusable
 */
export function assetKeyFor(pathname: string): string | null {
  const rel = pathname === '/' ? '/index.html' : pathname;
  // Reject traversal before normalizing so `..` cannot climb out.
  const raw = rel.split('?')[0].split('#')[0];
  if (raw.includes('\0')) return null;
  const stripped = raw.replace(/^[/\\]+/, '');
  if (stripped.split(/[/\\]/).some((seg) => seg === '..')) return null;
  const key = path.posix.normalize(stripped.replace(/\\/g, '/'));
  if (!key || key === '.' || key.startsWith('../')) return null;
  return key;
}

/**
 * Extension allowlist. `.json` is deliberately absent: the UI fetches no JSON
 * assets, and public/package.json exists only to mark the module directory for
 * Node, so it must never reach the wire.
 */
export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** @returns content type, or null when the extension is not served */
export function contentTypeFor(key: string): string | null {
  return CONTENT_TYPES[path.posix.extname(key).toLowerCase()] || null;
}

/**
 * Read a UI asset.
 *
 * @param opts.dir  directory to read from in development
 * @param opts.pathname  request path
 * @returns null when absent
 */
export function readAsset({ dir, pathname }: ReadAssetOptions): Asset | null {
  const key = assetKeyFor(pathname);
  if (!key) return null;
  const type = contentTypeFor(key);
  if (!type) return null;

  const sea = loadSea();
  if (sea) {
    // Packaged: assets live inside the executable. getAsset throws when the key
    // is unknown, which is the correct signal for a 404.
    try {
      const asset = sea.getAsset(key);
      if (!asset) return null;
      return { body: Buffer.from(asset), type, key };
    } catch {
      return null;
    }
  }

  if (!dir) return null;

  // Development: resolve inside the static directory only. Compare resolved
  // paths on both sides, otherwise a relative root never matches an absolute
  // target.
  const root = path.resolve(dir);
  const target = path.resolve(root, key);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  try {
    if (!fs.statSync(target).isFile()) return null;
  } catch {
    return null;
  }
  return { body: fs.readFileSync(target), type, key };
}

/** Every asset key embedded in the current executable (packaged builds only). */
export function embeddedKeys(): string[] {
  const sea = loadSea();
  if (!sea) return [];
  try {
    return sea.getAssetKeys().slice().sort();
  } catch {
    return [];
  }
}

/** True when the process is a packaged single executable. */
export function isPackaged(): boolean {
  return loadSea() !== null;
}
