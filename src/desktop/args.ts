'use strict';
/**
 * The desktop entry's flags, and where its data lives (flag, then
 * TAB_AGENT_HOME, then the per-user application data folder).
 */

import path from 'node:path';
import os from 'node:os';
import { parseFlags } from '../entry.ts';

/** The flags this entry understands, after parsing. */
interface Args {
  headless: boolean;
  /** As given on the command line, or undefined; resolvePort checks it. */
  port: string | undefined;
  dataDir: string | null;
  host: string;
  debugAssets: boolean;
  newInstance: boolean;
  /** Load browser extensions in the app window. Off unless asked for. */
  extensions: boolean;
}

/** Parse the handful of flags this entry understands; anything else is an error. */
export function parseArgs(argv: string[]): Args {
  const f = parseFlags(argv, {
    headless: { type: 'boolean' },
    'debug-assets': { type: 'boolean' },
    'new-instance': { type: 'boolean' },
    extensions: { type: 'boolean' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    'data-dir': { type: 'string' },
  });
  return {
    headless: Boolean(f.headless),
    port: f.port,
    dataDir: f['data-dir'] ?? null,
    host: f.host ?? '127.0.0.1',
    debugAssets: Boolean(f['debug-assets']),
    newInstance: Boolean(f['new-instance']),
    extensions: Boolean(f.extensions) || process.env.TAB_AGENT_EXTENSIONS === '1',
  };
}

/**
 * Where user data lives.
 *
 * A packaged app is often installed somewhere read-only, so data cannot sit
 * beside the executable. Precedence: explicit flag, then the environment
 * variable, then the per-user application data directory.
 */
export function resolveDataDir(args: Args): string {
  if (args.dataDir) return path.resolve(args.dataDir);
  if (process.env.TAB_AGENT_HOME) return path.resolve(process.env.TAB_AGENT_HOME);
  const base =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'share'));
  // Renamed from 'TabAgent' to match the etab package name. No migration: an
  // existing %APPDATA%\TabAgent is left alone, and the user starts fresh here.
  return path.join(base, 'ETabAgent');
}
