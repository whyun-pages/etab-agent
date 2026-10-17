'use strict';
/**
 * The disk operations pi's file tools run through, for one turn.
 *
 * pi lets a caller supply each tool's disk operations (src/agent/tools/pi-tools/);
 * this is where the checks and the deferred writes go in. Every path goes
 * through `checkPath` (src/access/file-access.ts), and `write` and `edit`
 * record their content in the turn's list instead of writing it — the server
 * writes it with `performWrite` once the turn's changes have landed.
 *
 * Here and not in src/access/: it is shaped by pi's operation interfaces, and
 * what it says back on a write is said to the model. Not in pi-tools/ either:
 * that folder is a port kept close to upstream, and this is our code.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  checkPath,
  blockRules,
  blockedBy,
  FileAccessError,
  READ_MAX_FILE,
  WRITE_MAX_BYTES,
  WALK_MAX_ENTRIES,
} from '../../access/file-access.ts';
import type { FileAccessOptions, FileWrite } from '../../access/file-access.ts';
import { COLLATOR } from '../../workbook/table-query.ts';
import { GREP_MAX_FILE_BYTES } from './pi-tools/fs-tools.ts';
import type {
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from './pi-tools/fs-tools.ts';

/** Said with every recorded write, so the model does not claim the file is on disk. */
const DEFERRED_NOTE = '（尚未写入磁盘：本轮结束、修改落定之后才真正写入，结果会自动附在你的回复后面。）';

/** The disk operations pi's file tools run through. */
export interface FileOperations {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  ls: LsOperations;
  find: FindOperations;
  grep: GrepOperations;
}

/**
 * The operations for one turn: every path through `checkPath`, writes into
 * `writes` (the turn's own list, which the server performs later).
 *
 * `writes` holds one entry per file — a second write or an edit to the same
 * file replaces the first — and reads of a file in it see its recorded
 * content, so a write followed by an edit edits what was written.
 */
export function fileOperations(opts: FileAccessOptions, writes: FileWrite[]): FileOperations {
  const recorded = (real: string) => writes.find((w) => w.path === real);
  // Compiled once for every walk and listing these operations do.
  const rules = blockRules(opts);
  const blocked = (p: string) => blockedBy(p, rules) !== null;

  /**
   * A path to read: vetted, and its recorded content if the turn wrote it.
   * A file written this turn may not exist on disk yet, so a failed plain
   * check falls back to the write check before giving up.
   */
  const vetRead = async (p: string): Promise<{ real: string; pending?: FileWrite }> => {
    try {
      const real = await checkPath(p, opts);
      return { real, pending: recorded(real) };
    } catch (err) {
      const real = await checkPath(p, opts, { forWrite: true }).catch(() => null);
      const pending = real ? recorded(real) : undefined;
      if (real && pending) return { real, pending };
      throw err;
    }
  };

  const readBytes = async (p: string, cap: number): Promise<Buffer> => {
    const { real, pending } = await vetRead(p);
    if (pending) return Buffer.from(pending.content, 'utf8');
    const stat = await fs.promises.stat(real);
    if (!stat.isFile()) throw new FileAccessError(`「${real}」不是文件。`);
    if (stat.size > cap) throw new FileAccessError(`「${real}」超过 ${cap / 1024 / 1024}MB。`);
    return fs.promises.readFile(real);
  };

  const record = async (p: string, content: string): Promise<string> => {
    const real = await checkPath(p, opts, { forWrite: true });
    if (Buffer.byteLength(content, 'utf8') > WRITE_MAX_BYTES)
      throw new FileAccessError(`内容超过 ${WRITE_MAX_BYTES / 1024 / 1024}MB。`);
    const at = writes.findIndex((w) => w.path === real);
    if (at >= 0) writes.splice(at, 1, { path: real, content });
    else writes.push({ path: real, content });
    return DEFERRED_NOTE;
  };

  /** A path that exists and may be read, or the reason it may not. */
  const exists = async (p: string) => {
    await vetRead(p);
    return true;
  };

  /**
   * Walk `root` for `glob` (fd's rules: a pattern with no `/` matches the name
   * at any depth), blocked and ignored entries pruned, at most
   * WALK_MAX_ENTRIES visited. Sorted, so the same tree lists the same way.
   */
  const walk = async (
    root: string,
    pattern: string,
    ignoreNames: Set<string>,
  ): Promise<{ path: string; dir: boolean }[]> => {
    const real = await checkPath(root, opts);
    const skip = (full: string, name: string) => ignoreNames.has(name) || blocked(full);
    const found: { path: string; dir: boolean }[] = [];
    const glob = pattern.includes('/') ? pattern : `**/${pattern}`;
    for await (const d of fs.promises.glob(glob, {
      cwd: real,
      withFileTypes: true,
      exclude: (e) => skip(path.join(e.parentPath, e.name), e.name),
    })) {
      const full = path.join(d.parentPath, d.name);
      // `exclude` stops the walk going INTO an entry but can still yield the
      // entry itself, so it is filtered again here.
      if (skip(full, d.name)) continue;
      found.push({ path: full, dir: d.isDirectory() });
      if (found.length >= WALK_MAX_ENTRIES) break;
    }
    return found.sort((a, b) => COLLATOR.compare(a.path, b.path));
  };

  /** The bare names in pi's `**\/name/**` ignore globs. */
  const ignoreNames = (ignore: string[]) => new Set(ignore.map((g) => g.replace(/^\*\*\//, '').replace(/\/\*\*$/, '')));

  return {
    read: {
      access: async (p) => {
        await vetRead(p);
      },
      readFile: (p) => readBytes(p, READ_MAX_FILE),
    },
    write: {
      // Nothing to create yet: performWrite makes the folders when it writes.
      mkdir: async () => {},
      writeFile: record,
    },
    edit: {
      access: async (p) => {
        await vetRead(p);
        await checkPath(p, opts, { forWrite: true });
      },
      readFile: (p) => readBytes(p, WRITE_MAX_BYTES),
      writeFile: record,
    },
    ls: {
      exists,
      stat: async (p) => fs.promises.stat((await vetRead(p)).real),
      readdir: async (p) => {
        const { real } = await vetRead(p);
        return (await fs.promises.readdir(real)).filter((name) => !blocked(path.join(real, name)));
      },
    },
    find: {
      exists,
      glob: async (pattern, cwd, { ignore, limit }) => {
        const hits = await walk(cwd, pattern, ignoreNames(ignore));
        // fd marks folders with a trailing separator; pi keeps it.
        return hits.slice(0, limit).map((h) => (h.dir ? h.path + path.sep : h.path));
      },
    },
    grep: {
      isDirectory: async (p) => (await fs.promises.stat((await vetRead(p)).real)).isDirectory(),
      readFile: async (p) => (await readBytes(p, GREP_MAX_FILE_BYTES)).toString('utf8'),
      files: async function* (dir, { ignore }) {
        for (const h of await walk(dir, '**/*', ignoreNames(ignore))) if (!h.dir) yield h.path;
      },
    },
  };
}
