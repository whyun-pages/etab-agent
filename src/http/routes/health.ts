'use strict';
/** GET /api/health — liveness, and who is answering. */

import type { Router } from '@koa/router';
import type { RouteDeps } from './index.ts';

export function healthRoutes(router: Router, { state }: RouteDeps): void {
  router.get('/api/health', async (ctx) => {
    // `app` is a stable identity, not a count: desktop.ts probes this endpoint
    // to tell "our own instance" from an unrelated server that happens to
    // answer on the same port. Keying that on a field that can be removed (as
    // `templates` once was) would break single-instance detection silently.
    ctx.body = {
      ok: true,
      app: 'tab-agent',
      uploads: [...state.uploads.values()].reduce((n, list) => n + list.length, 0),
      modelConfigured: await state.settings.isConfigured(),
    };
  });
}
