'use strict';
/**
 * Every API route, one module per area. Each module receives the shared
 * dependencies and adds its routes to one router.
 */

import { Router } from '@koa/router';
import type { AppState, Extractor } from '../app-state.ts';
import { healthRoutes } from './health.ts';
import { settingsRoutes } from './settings.ts';
import { sessionRoutes } from './sessions.ts';
import { turnRoutes } from './turn.ts';
import { attachmentRoutes } from './attachments.ts';

/** What the routes need from the server that built them. */
export interface RouteDeps {
  state: AppState;
  /** Vision hook for images; a test or a local OCR may supply one. */
  imageExtractor?: Extractor;
  textExtractor?: Extractor;
}

export function createRouter(deps: RouteDeps): Router {
  const router = new Router();
  healthRoutes(router, deps);
  settingsRoutes(router, deps);
  sessionRoutes(router, deps);
  turnRoutes(router, deps);
  attachmentRoutes(router, deps);
  return router;
}
