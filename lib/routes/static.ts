'use strict';
/**
 * The UI's files.
 *
 * Not koa-static: a packaged build serves its assets from inside the
 * executable, where there is no directory to point a static server at.
 * `readAsset` decides between embedded assets and disk (see lib/assets.ts),
 * and refuses anything outside the UI root.
 */

import type { Middleware } from 'koa';
import { readAsset } from '../assets.ts';

export function serveStatic(dir: string | undefined): Middleware {
  return async (ctx, next) => {
    if (ctx.method !== 'GET') return next();
    const asset = readAsset({ dir, pathname: ctx.path });
    if (!asset) return next();
    ctx.type = asset.type;
    ctx.set('Cache-Control', 'no-cache');
    ctx.body = asset.body;
  };
}
