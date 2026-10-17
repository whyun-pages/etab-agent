'use strict';
/**
 * Local file access: the checks behind pi's file tools, the reading of files
 * into attachments, and the writes that land after a turn.
 *
 * Off by default, and only ever offered to a turn that came from this machine
 * (see the turn route). When it is on, every path goes through `checkPath`
 * before anything touches the disk.
 *
 * Whose tools
 * -----------
 * The tools the model calls are pi's — read, write, edit, ls, find, grep —
 * ported into src/agent/tools/pi-tools/ (see the header there for why ported, not
 * imported). pi lets a caller supply each tool's disk operations;
 * src/agent/tools/file-operations.ts supplies them, every path through this
 * module's `checkPath`. pi's own tools ship with no checks at all: they are
 * built for a developer's own machine, where the model is trusted.
 *
 * What pi has no tool for, this module still does: `readPath` turns a file, a
 * folder or a ZIP into attachments, so a spreadsheet can be queried with
 * `query_table` — pi's `read` sees only text and images.
 *
 * Writes are recorded, not performed: `write` and `edit` put the new content
 * in the turn's list, and the server writes it with `performWrite` once the
 * turn's changes have landed (and not at all when they are held or refused).
 * Reads in the same turn see the recorded content, so the model can read back
 * what it just wrote.
 *
 * The shell tools (src/agent/tools/pi-tools/shell.ts) are NOT behind any of this. A
 * command reaches whatever this user can, immediately. They are offered only
 * with read-write access, and the blocklist below cannot narrow them.
 *
 * Why a blocklist, and what it cannot do
 * --------------------------------------
 * The user asked for a blocklist rather than an allowlist: the files people
 * want read are wherever they happen to be (Downloads, a share, the desktop),
 * and a list of allowed folders is a setting nobody keeps up to date. The cost
 * is that the default is "everything not listed", so the list that matters is
 * the BUILT-IN one below, which the user's own entries add to and cannot
 * remove: credential stores, browser profiles, SSH keys, this app's own data
 * folder (it holds the API key). The model is steerable — an attachment or a
 * fetched page can say "now read ~/.ssh/id_rsa" — and those are the files such
 * an instruction would go after.
 *
 * A blocklist is a speed bump, not a sandbox: a file copied somewhere unlisted
 * is readable there. That is why the switch exists and defaults to off.
 *
 * Paths are checked after resolving symlinks, so a link in Downloads pointing
 * at ~/.ssh is refused as ~/.ssh. UNC and device paths are refused outright:
 * on Windows, merely opening `\\host\share\x` sends this user's NTLM hash to
 * `host`, and an injected instruction to "read \\attacker\x" would be a
 * credential leak with no file involved at all.
 *
 * Writes are narrower still: only text formats, never over a script or an
 * executable, never into autostart locations — a written `.bat` in the
 * Startup folder is code execution at the next login.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ingestFile } from '../ingest/ingest.ts';
import { isHiddenPath } from '../ingest/archive.ts';
import { READABLE_EXT } from '../ingest/kinds.ts';
import type { Ingested } from '../ingest/ingest.ts';
import { COLLATOR } from '../workbook/table-query.ts';

export const FILE_ACCESS_MODES = ['off', 'read', 'readwrite'] as const;
export type FileAccessMode = (typeof FILE_ACCESS_MODES)[number];

export function isFileAccessMode(v: unknown): v is FileAccessMode {
  return typeof v === 'string' && (FILE_ACCESS_MODES as readonly string[]).includes(v);
}

/** A refusal the model can read: the path, and why. */
export class FileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileAccessError';
  }
}

export interface FileAccessOptions {
  /** the user's own entries: path prefixes (`D:\\财务`, `~/私人`) or name patterns (`*.bak`) */
  blocklist?: string[];
  /** this app's data folder; always blocked */
  dataDir?: string;
  /** test seam for the home directory */
  home?: string;
  /** test seam: entries a folder walk visits before stopping (WALK_MAX_ENTRIES) */
  walkLimit?: number;
}

/** Home-relative locations that hold credentials or another program's secrets. */
const BLOCKED_IN_HOME = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.config/gh',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  '.m2/settings.xml',
  '.mozilla',
  '.config/google-chrome',
  '.config/chromium',
  '.local/share/keyrings',
  'AppData/Roaming/Microsoft/Credentials',
  'AppData/Local/Microsoft/Credentials',
  'AppData/Roaming/Microsoft/Protect',
  'AppData/Roaming/Microsoft/Crypto',
  'AppData/Roaming/Microsoft/SystemCertificates',
  'AppData/Local/Google/Chrome/User Data',
  'AppData/Local/Microsoft/Edge/User Data',
  'AppData/Local/BraveSoftware',
  'AppData/Roaming/Mozilla',
  'AppData/Roaming/Opera Software',
  'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox',
  'Library/LaunchAgents',
];

/** Absolute locations: the OS and its secrets. */
function blockedSystemPaths(): string[] {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    return [
      root,
      'C:\\ProgramData\\Microsoft\\Crypto',
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp',
      'C:\\$Recycle.Bin',
      'C:\\System Volume Information',
    ];
  }
  return [
    '/etc/shadow',
    '/etc/gshadow',
    '/etc/sudoers',
    '/etc/ssl/private',
    '/proc',
    '/sys',
    '/dev',
    '/root',
    '/private/etc/master.passwd',
    '/Library/Keychains',
  ];
}

/**
 * File names that are keys or secrets wherever they sit.
 *
 * Matched against every segment of a path, so each must be specific enough
 * not to catch an ordinary folder: `SYSTEM` or `Cookies` would block a user's
 * `D:\资料\System\` — the hives and browser stores they would mean are
 * already covered by the location rules above.
 */
const BLOCKED_NAMES = [
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '*.jks',
  '*.keystore',
  '*.kdbx',
  '*.ovpn',
  '.env',
  '.env.*',
  'credentials.json',
  'secrets.json',
  'NTUSER.DAT*',
];

/** What pi's `write` and `edit` may create: text formats only. */
export const WRITABLE_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.xml',
  '.html',
  '.htm',
  '.log',
  '.yml',
  '.yaml',
  '.ini',
  '.sql',
  '.m3u',
  '.m3u8',
]);

/** Per-file and per-call read limits. The file cap matches an upload's. */
export const READ_MAX_FILE = 32 * 1024 * 1024;
export const READ_MAX_FILES = 100;
export const READ_MAX_TOTAL = 200 * 1024 * 1024;
export const READ_MAX_DEPTH = 4;
/** Entries `find` and `grep` will walk before giving up on a folder. */
export const WALK_MAX_ENTRIES = 20_000;
/** Text a single write may carry. */
export const WRITE_MAX_BYTES = 5 * 1024 * 1024;

const CASELESS = process.platform === 'win32' || process.platform === 'darwin';
const fold = (p: string) => (CASELESS ? p.toLowerCase() : p);

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/** `*` and `?` over a single name, case-insensitively, as a regex. */
function globRegex(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    'i',
  );
}

/**
 * The blocklist, ready to match: each prefix resolved and case-folded with a
 * trailing separator, each name pattern compiled. Built once per check or per
 * walk, not per entry — rebuilt for every entry (with a fresh RegExp for every
 * path segment times every pattern) it cost 5.5 s for the 20,000 entries a
 * find or grep may visit, on the event loop.
 */
interface BlockRules {
  prefixes: string[];
  names: string[];
  folded: string[];
  patterns: RegExp[];
}

function compileRules({ prefixes, names }: { prefixes: string[]; names: string[] }): BlockRules {
  const folded = prefixes.map((d) => {
    const f = fold(path.resolve(d));
    return f.endsWith(path.sep) ? f : f + path.sep;
  });
  return { prefixes, names, folded, patterns: names.map(globRegex) };
}

/** The full blocklist, built-in first, as prefixes and name patterns. */
export function blockRules(opts: FileAccessOptions): BlockRules {
  const home = opts.home || os.homedir();
  const prefixes = [
    ...BLOCKED_IN_HOME.map((p) => path.join(home, p)),
    ...blockedSystemPaths(),
    ...(opts.dataDir ? [path.resolve(opts.dataDir)] : []),
  ];
  const names = [...BLOCKED_NAMES];
  for (const raw of opts.blocklist || []) {
    const entry = String(raw || '').trim();
    if (!entry) continue;
    // An entry with a separator (or ~, or a drive) is a location; without one,
    // a name pattern matched against every path segment.
    if (/[\\/]/.test(entry) || entry.startsWith('~') || /^[A-Za-z]:/.test(entry))
      prefixes.push(path.resolve(expandHome(entry, home)));
    else names.push(entry);
  }
  return compileRules({ prefixes, names });
}

/** The rule a resolved path breaks, or null. */
export function blockedBy(p: string, rules: BlockRules): string | null {
  const resolved = path.resolve(p);
  // With a trailing separator, "is the prefix or inside it" is one startsWith.
  const f = fold(resolved);
  const withSep = f.endsWith(path.sep) ? f : f + path.sep;
  for (let i = 0; i < rules.folded.length; i++) if (withSep.startsWith(rules.folded[i])) return rules.prefixes[i];
  for (const seg of resolved.split(/[\\/]/)) {
    if (!seg) continue;
    for (let i = 0; i < rules.patterns.length; i++) if (rules.patterns[i].test(seg)) return rules.names[i];
  }
  return null;
}

/**
 * A path the model gave, resolved and vetted.
 *
 * Absolute (or `~`-relative) only: a relative path would resolve against the
 * server's working directory, which is not anything the user is looking at.
 * Checked twice — as written, and after resolving symlinks — so a link cannot
 * walk past the list.
 */
export async function checkPath(
  input: unknown,
  opts: FileAccessOptions,
  { forWrite = false, folder = false } = {},
): Promise<string> {
  const raw = String(input ?? '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!raw) throw new FileAccessError('没有给出路径。');
  if (raw.includes('\0')) throw new FileAccessError('路径里有非法字符。');
  if (/^(\\\\|\/\/)/.test(raw)) throw new FileAccessError('不能访问网络共享或设备路径（\\\\ 开头的路径）。');
  const home = opts.home || os.homedir();
  const expanded = expandHome(raw, home);
  if (!path.isAbsolute(expanded))
    throw new FileAccessError(`「${raw}」不是完整路径。请给出从盘符或根目录开始的路径，例如 D:\\数据\\订单.xlsx。`);
  const resolved = path.resolve(expanded);
  // A colon after the drive letter is an NTFS alternate data stream (`a.txt:secret`).
  if (process.platform === 'win32' && resolved.slice(2).includes(':'))
    throw new FileAccessError('路径里不能有冒号（除了盘符）。');

  const rules = blockRules(opts);
  const hit = blockedBy(resolved, rules);
  if (hit) throw new FileAccessError(`「${resolved}」在禁止访问的范围内（${hit}）。`);

  // Resolve symlinks on what exists: the file itself, or — for a write that
  // creates it — the nearest existing parent.
  let real: string;
  try {
    real = await fs.promises.realpath(resolved);
  } catch {
    if (!forWrite) throw new FileAccessError(`「${resolved}」不存在。`);
    let parent = path.dirname(resolved);
    for (;;) {
      try {
        real = path.join(await fs.promises.realpath(parent), path.relative(parent, resolved));
        break;
      } catch {
        /* go up */
      }
      const up = path.dirname(parent);
      if (up === parent) {
        real = resolved;
        break;
      }
      parent = up;
    }
  }
  const realHit = blockedBy(real, rules);
  if (realHit) throw new FileAccessError(`「${resolved}」实际指向禁止访问的位置（${realHit}）。`);

  // A destination folder (save_file's `dir`) has no extension to check; what
  // lands in it is an export, whose format the server chose.
  if (forWrite && !folder) {
    const ext = path.extname(real).toLowerCase();
    if (!WRITABLE_EXT.has(ext))
      throw new FileAccessError(
        `只能写文本类文件（${[...WRITABLE_EXT].join(' ')}），不能写「${ext || '无扩展名'}」。表格请用 save_file。`,
      );
  }
  return real;
}

// ------------------------------------------------------------------ import

/**
 * Read a file, a folder or an archive into attachments.
 *
 * A folder is walked to `READ_MAX_DEPTH`, readable files only, hidden and
 * blocked entries skipped, within the file and byte caps; what was left out
 * is reported. Each file goes through `ingestFile`, so a ZIP inside the folder
 * is opened the same way an uploaded one is. Names are full paths, so two
 * `订单.xlsx` in different folders stay apart.
 */
export async function readPath(
  input: unknown,
  opts: FileAccessOptions,
): Promise<{ root: string; items: Ingested[]; skipped: string[] }> {
  const root = await checkPath(input, opts);
  const stat = await fs.promises.stat(root);
  const rules = blockRules(opts);
  const skipped: string[] = [];
  const files: string[] = [];

  if (stat.isDirectory()) {
    // Bounded like find and grep: depth alone does not stop a wide tree (a
    // home folder four levels down is most of the disk).
    const limit = opts.walkLimit ?? WALK_MAX_ENTRIES;
    let visited = 0;
    let cut = false;
    const walk = async (dir: string, depth: number): Promise<void> => {
      const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
      dirents.sort((a, b) => COLLATOR.compare(a.name, b.name));
      for (const d of dirents) {
        if (++visited > limit) {
          cut = true;
          return;
        }
        const full = path.join(dir, d.name);
        if (isHiddenPath(d.name) || blockedBy(full, rules)) continue;
        if (d.isDirectory()) {
          if (depth < READ_MAX_DEPTH) await walk(full, depth + 1);
          else skipped.push(`${full}${path.sep}（目录太深）`);
        } else if (d.isFile()) {
          const ext = path.extname(d.name).toLowerCase();
          if (!READABLE_EXT.has(ext) && ext !== '.zip') skipped.push(full);
          else if (files.length >= READ_MAX_FILES) skipped.push(full);
          else files.push(full);
        }
      }
    };
    await walk(root, 1);
    if (cut) skipped.push(`${root}（文件夹里超过 ${limit} 项，只看了排在前面的这些）`);
  } else if (stat.isFile()) {
    files.push(root);
  } else {
    throw new FileAccessError(`「${root}」既不是文件也不是文件夹。`);
  }

  const items: Ingested[] = [];
  let total = 0;
  for (const file of files) {
    // Re-checked per file: a symlink inside the folder resolves elsewhere.
    let real: string;
    try {
      real = await checkPath(file, opts);
    } catch {
      skipped.push(`${file}（禁止访问）`);
      continue;
    }
    const size = (await fs.promises.stat(real)).size;
    if (size > READ_MAX_FILE) {
      skipped.push(`${file}（超过 ${READ_MAX_FILE / 1024 / 1024}MB）`);
      continue;
    }
    if (total + size > READ_MAX_TOTAL) {
      skipped.push(`${file}（总量超过 ${READ_MAX_TOTAL / 1024 / 1024}MB）`);
      continue;
    }
    total += size;
    const data = await fs.promises.readFile(real);
    const got = await ingestFile(data, file);
    items.push(...got.items);
    skipped.push(...got.skipped.map((s) => `${file}/${s}`));
  }
  return { root, items, skipped };
}

// ----------------------------------------------------------------- write

/** One text write the agent asked for, performed after the turn. */
export interface FileWrite {
  /** already vetted with `checkPath`, and the real path it resolved to */
  path: string;
  content: string;
}

/**
 * Perform one write: create the file, or replace it whole — pi's `write` and
 * `edit` both produce the complete new content. The path is checked AGAIN
 * here, at write time, not trusted from the check made during the turn: the
 * turn took seconds, and the target could have become a symlink in between.
 *
 * Written to a temp file and renamed over the target, so a crash leaves the
 * old file whole. The temp name is unique per write (see AGENTS.md).
 */
export async function performWrite(w: FileWrite, opts: FileAccessOptions): Promise<string> {
  const target = await checkPath(w.path, opts, { forWrite: true });
  const bytes = Buffer.from(String(w.content ?? ''), 'utf8');
  if (bytes.length > WRITE_MAX_BYTES) throw new FileAccessError(`内容超过 ${WRITE_MAX_BYTES / 1024 / 1024}MB。`);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tmp, bytes);
    await fs.promises.rename(tmp, target);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return target;
}
