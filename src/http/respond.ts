'use strict';
/**
 * The small HTTP pieces every route shares: the error answer, JSON bodies with
 * a per-route size cap, the "is this request from this machine" check, and the
 * two header helpers for files.
 */

import { bodyParser } from '@koa/bodyparser';
import type { Context, Middleware } from 'koa';
import type { Session } from '../store/session-store.ts';

/** Every failure answers this shape, so the UI reads one field for the reason. */
export function fail(ctx: Context, status: number, message: string, extra?: Record<string, unknown>): void {
  ctx.status = status;
  ctx.body = { ok: false, error: message, ...(extra || {}) };
}

/** The answer for a session id that names nothing — gone, or never there. */
export function noSession(ctx: Context): void {
  fail(ctx, 404, '会话不存在');
}

/**
 * The session `:id` names, or null after answering 404. For the routes whose
 * first step is "load it, or stop":
 *
 *   const session = await sessionOr404(ctx, state.sessions);
 *   if (!session) return;
 */
export async function sessionOr404(
  ctx: Context & { params: Record<string, string> },
  sessions: { load(id: string): Promise<Session | null> },
): Promise<Session | null> {
  const session = await sessions.load(ctx.params.id);
  if (!session) noSession(ctx);
  return session;
}

/**
 * A JSON body, at most `limit` (e.g. '64kb'). Each route names its own cap:
 * a settings save is a few hundred bytes, a turn can carry a long message.
 * Anything that is not JSON reads as `{}`, as an empty body always has.
 */
export function jsonBody(limit: string): Middleware {
  return bodyParser({ enableTypes: ['json'], jsonLimit: limit });
}

/** The parsed JSON body, or `{}`. */
export function bodyOf(ctx: Context): Record<string, unknown> {
  const body = ctx.request.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** Loopback hosts, as the Host header and the socket report them. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * From this machine, to a loopback name, from our own page.
 *
 * Guards what only the user at this computer may do: open a file with a
 * program, read or write files here, change those switches. `--host` can
 * expose the server to a LAN; any web page can fire a form POST at 127.0.0.1,
 * and its Origin gives it away; the Host must be a loopback name, which stops
 * DNS rebinding — a hostile name resolving to 127.0.0.1 would otherwise pass
 * the Origin check by matching itself.
 */
export function isLocalRequest(ctx: Context): boolean {
  if (!LOOPBACK_ADDRS.has(ctx.req.socket.remoteAddress || '')) return false;
  const host = ctx.get('host');
  if (!LOOPBACK_HOSTS.has(host.replace(/:\d+$/, '').toLowerCase())) return false;
  // No Origin is a non-browser client (curl, the tests); a browser always sends
  // one on a POST, and it must be this server's own.
  const origin = ctx.get('origin');
  return !origin || origin === `http://${host}`;
}

/** Strip any path component a browser or attacker might include. */
export function safeFilename(name: unknown): string {
  let out = String(name).replace(/\\/g, '/').split('/').pop() || 'file';
  out = out.replace(/[\x00-\x1f<>:"|?*]/g, '_').trim();
  // Guard against traversal and reserved device names.
  if (!out || out === '.' || out === '..') out = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(out)) out = '_' + out;
  return out.slice(0, 180);
}

/** RFC 5987 filename for a download, safe with CJK names. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** The message of whatever was thrown. */
export function messageOf(err: unknown): string {
  return String((err as Error)?.message || err);
}
