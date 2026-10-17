'use strict';
/**
 * What the two entries (server.ts, desktop.ts) share before they start:
 * reading their flags, settling the port, and finding the repository root
 * when run unpackaged.
 *
 * Flags go through node:util's parseArgs in strict mode. The hand-written
 * parsers before it ignored what they did not know, so `--prot 4000` or
 * `--data-dri x` started the app on the defaults and said nothing; and each
 * entry carried its own copy of the port check, one of which checked nothing.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

type FlagSpec = Record<string, { type: 'string' | 'boolean'; short?: string }>;
type Flags<T extends FlagSpec> = {
  [K in keyof T]?: T[K]['type'] extends 'boolean' ? boolean : string;
};

/**
 * Parse `argv` against `spec`. An unknown flag, a missing value or a stray
 * argument exits with a message naming it and the flags that do exist.
 */
export function parseFlags<T extends FlagSpec>(argv: string[], spec: T): Flags<T> {
  try {
    return parseArgs({ args: argv, options: spec, strict: true, allowPositionals: false }).values as Flags<T>;
  } catch (err) {
    const known = Object.entries(spec)
      .map(([name, o]) => `--${name}${o.type === 'string' ? ' <值>' : ''}`)
      .join('  ');
    console.error(`参数有误：${(err as Error).message}\n可用的参数：${known}`);
    process.exit(1);
  }
}

/**
 * The port to listen on: the flag, else TAB_AGENT_PORT, else `fallback`.
 * Whichever one is used must be an integer 0–65535 (0 = any free port), or
 * the process exits naming the setting and the value it was given.
 */
export function resolvePort(flag: string | undefined, fallback: number): number {
  const fromEnv = process.env.TAB_AGENT_PORT;
  const [source, text] =
    flag !== undefined
      ? ['--port', flag]
      : fromEnv !== undefined && fromEnv !== ''
        ? ['TAB_AGENT_PORT', fromEnv]
        : [null, ''];
  if (source === null) return fallback;
  const n = text.trim() === '' ? Number.NaN : Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`${source} 不是可用端口：${text}（需要 0–65535 的整数）`);
    process.exit(1);
  }
  return n;
}

/**
 * The repository root for an entry at `dirname`. It runs either as tsc
 * output in `.build/js/` (two levels below the root) or as source in `src/`
 * via tsx (one level below), and is told apart by name: taking `__dirname`
 * as-is served no `public/`, and hard-coding one depth put `data/` outside
 * the repository for the other.
 */
export function repoRoot(dirname: string): string {
  const fromBuild = path.basename(dirname) === 'js' && path.basename(path.dirname(dirname)) === '.build';
  return path.join(dirname, fromBuild ? '../..' : '..');
}
