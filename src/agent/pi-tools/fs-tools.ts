'use strict';
/**
 * pi's file tools: read, write, edit, ls, find, grep.
 *
 * Ported from @earendil-works/pi-coding-agent 1.3.0, dist/core/tools/*.js and
 * dist/utils/paths.js (MIT, Copyright (c) 2025 Mario Zechner — see ./LICENSE).
 * Names, parameters, descriptions, truncation and output text are pi's, so a
 * model that knows pi's tools knows these.
 *
 * Why ported rather than imported
 * -------------------------------
 * The package exposes these only through its root entry, which loads the whole
 * coding-agent CLI: terminal UI, MCP, a QuickJS sandbox, every provider. That
 * is ~10 MB more in the executable, ~1.5 s at first load, and it reads its own
 * package.json and a .wasm through `import.meta.url` at load time, which does
 * not survive bundling into the single-file executable.
 *
 * What changed on the way in
 * --------------------------
 * - Every disk access goes through the `operations` a caller passes, and there
 *   is NO default that touches the disk directly. pi's operations are an
 *   optional override; here they are where src/agent/file-access.ts puts its checks
 *   and the deferred writes, and a tool built without them could skip both.
 * - pi's `resolveReadPath` retried macOS screenshot-name variants by probing
 *   the disk with `access` BEFORE any operation ran. Dropped: a probe of
 *   `\\host\x` is itself the NTLM leak the checks exist to stop.
 * - `find` and `grep` ran `fd` and `ripgrep`, downloading them from GitHub
 *   when missing, and those walk the tree on their own, past any check. Here
 *   `find` always takes the caller's `glob`, and `grep` searches in-process
 *   over the files the caller's `files` yields. Neither claims to honour
 *   .gitignore any more, because neither does.
 * - `grep` matches with RE2 (re2js), which is linear-time like ripgrep's
 *   engine. In-process, a backtracking RegExp would let one model-chosen
 *   pattern block the event loop for the whole server.
 * - `write` and `edit` may return a note from `writeFile`, appended to the
 *   result. A write that is only recorded, to land after the turn, must not
 *   tell the model "Successfully wrote".
 * - No terminal renderers, image resizing (photon) or codemode output schema.
 *   Images are passed through as they are, up to `IMAGE_MAX_BYTES`.
 * - pi's per-file mutation queue is gone: tools here run one at a time, and
 *   writes land in memory first.
 */

import nodePath from 'node:path';
import os from 'node:os';
import { RE2JS } from 're2js';
import { fileURLToPath } from 'node:url';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { Pi } from '../pi.ts';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  formatSize,
  truncateHead,
  truncateLine,
} from './truncate.ts';
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  splitBom,
} from './edit-diff.ts';
import type { Edit } from './edit-diff.ts';

type TypeBuilder = Pi['ai']['Type'];
type Result = AgentToolResult<any>;

// --------------------------------------------------------------- operations

export interface ReadOperations {
  /** Throws when the file may not be read or does not exist. */
  access(absolutePath: string): Promise<void>;
  readFile(absolutePath: string): Promise<Buffer>;
}

export interface WriteOperations {
  /** Returns an optional note for the model, appended to the result. */
  writeFile(absolutePath: string, content: string): Promise<string | void>;
  mkdir(dir: string): Promise<void>;
}

export interface EditOperations {
  /** Throws when the file may not be edited or does not exist. */
  access(absolutePath: string): Promise<void>;
  readFile(absolutePath: string): Promise<Buffer>;
  /** Returns an optional note for the model, appended to the result. */
  writeFile(absolutePath: string, content: string): Promise<string | void>;
}

export interface LsOperations {
  exists(absolutePath: string): Promise<boolean>;
  stat(absolutePath: string): Promise<{ isDirectory(): boolean }>;
  /** Entry names; anything the caller may not show is already left out. */
  readdir(absolutePath: string): Promise<string[]>;
}

export interface FindOperations {
  exists(absolutePath: string): Promise<boolean>;
  /** Absolute paths matching `pattern` under `cwd`, at most `limit`. */
  glob(pattern: string, cwd: string, options: { ignore: string[]; limit: number }): Promise<string[]>;
}

export interface GrepOperations {
  isDirectory(absolutePath: string): Promise<boolean>;
  readFile(absolutePath: string): Promise<string>;
  /** Absolute paths of the files under `dir` that may be searched. */
  files(dir: string, options: { ignore: string[] }): AsyncIterable<string>;
}

// -------------------------------------------------------------------- paths

const UNICODE_SPACES = /[  -   　]/g;

/** Git Bash / MSYS / Cygwin / WSL drive paths (`/c/x`, `/mnt/c/x`) as Windows paths. */
function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) return filePath;
  const m = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!m) return filePath;
  return `${m[1].toUpperCase()}:\\${m[2]?.replaceAll('/', '\\') ?? ''}`;
}

/**
 * A path the model gave, made absolute against `cwd`: Unicode spaces made
 * plain, a leading `@` dropped, `~` expanded, `file://` URLs converted, and
 * shell-style drive paths read as Windows ones. Purely lexical.
 *
 * `home` is what `~` means. pi always used `os.homedir()`; it is a parameter
 * so that `~` and the checks' idea of home (`FileAccessOptions.home`) cannot
 * disagree — when they did, in a test, `~/.ssh` resolved to the real one
 * while the blocklist guarded a fake.
 */
export function resolveToCwd(filePath: string, cwd: string, home: string = os.homedir()): string {
  let p = filePath.replace(UNICODE_SPACES, ' ');
  if (p.startsWith('@')) p = p.slice(1);
  if (process.platform === 'win32') p = normalizeWindowsShellPath(p);
  if (p === '~') p = home;
  else if (p.startsWith('~/') || (process.platform === 'win32' && p.startsWith('~\\')))
    p = nodePath.join(home, p.slice(2));
  else if (/^file:\/\//.test(p)) p = fileURLToPath(p);
  return nodePath.isAbsolute(p) ? nodePath.resolve(p) : nodePath.resolve(cwd, p);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}

const text = (t: string): TextContent => ({ type: 'text', text: t });

// --------------------------------------------------------------------- read

/** Largest image passed to the model; pi resized instead, which needs photon. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** The image type of a file's first bytes, for the formats pi's read accepts. */
function imageMimeType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

export function createReadTool(Type: TypeBuilder, cwd: string, ops: ReadOperations, home?: string): AgentTool<any> {
  return {
    name: 'read',
    label: 'read',
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
      offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed)' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
    }),
    async execute(_id, params, signal): Promise<Result> {
      const { path, offset, limit } = params as { path: string; offset?: number; limit?: number };
      throwIfAborted(signal);
      const absolutePath = resolveToCwd(path, cwd, home);
      await ops.access(absolutePath);
      throwIfAborted(signal);
      const buffer = await ops.readFile(absolutePath);
      throwIfAborted(signal);

      const mimeType = imageMimeType(buffer);
      if (mimeType) {
        if (buffer.length > IMAGE_MAX_BYTES) {
          return {
            content: [
              text(
                `Read image file [${mimeType}]\nImage is ${formatSize(buffer.length)}, over the ${formatSize(IMAGE_MAX_BYTES)} limit; not sent.`,
              ),
            ],
            details: undefined,
          };
        }
        const image: ImageContent = { type: 'image', data: buffer.toString('base64'), mimeType };
        return { content: [text(`Read image file [${mimeType}]`), image], details: undefined };
      }

      const allLines = buffer.toString('utf-8').split('\n');
      const totalFileLines = allLines.length;
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length)
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);

      let selected: string;
      let userLimitedLines: number | undefined;
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selected = allLines.slice(startLine, endLine).join('\n');
        userLimitedLines = endLine - startLine;
      } else {
        selected = allLines.slice(startLine).join('\n');
      }

      const truncation = truncateHead(selected);
      let output: string;
      let details: unknown;
      if (truncation.firstLineExceedsLimit) {
        // pi points at a bash fallback here; with no shell guaranteed, offset/limit
        // cannot split a line either, so the model is told plainly.
        const size = formatSize(Buffer.byteLength(allLines[startLine], 'utf-8'));
        output = `[Line ${startLineDisplay} is ${size}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit and cannot be shown.]`;
        details = { truncation };
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const next = endLineDisplay + 1;
        output =
          truncation.content +
          (truncation.truncatedBy === 'lines'
            ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${next} to continue.]`
            : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${next} to continue.]`);
        details = { truncation };
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        output = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${startLine + userLimitedLines + 1} to continue.]`;
      } else {
        output = truncation.content;
      }
      return { content: [text(output)], details };
    },
  };
}

// -------------------------------------------------------------------- write

export function createWriteTool(Type: TypeBuilder, cwd: string, ops: WriteOperations, home?: string): AgentTool<any> {
  return {
    name: 'write',
    label: 'write',
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
      content: Type.String({ description: 'Content to write to the file' }),
    }),
    async execute(_id, params, signal): Promise<Result> {
      const { path, content } = params as { path: string; content: string };
      const absolutePath = resolveToCwd(path, cwd, home);
      throwIfAborted(signal);
      await ops.mkdir(nodePath.dirname(absolutePath));
      throwIfAborted(signal);
      const note = await ops.writeFile(absolutePath, content);
      throwIfAborted(signal);
      return { content: [text(`Successfully wrote to ${path}${note ? `\n${note}` : ''}`)], details: undefined };
    },
  };
}

// --------------------------------------------------------------------- edit

function isSingleEdit(value: unknown): value is Edit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return typeof e.oldText === 'string' && typeof e.newText === 'string';
}

/**
 * Accept the shapes models actually send: `edits` as a JSON string, a single
 * edit object instead of an array, or a legacy top-level oldText/newText.
 */
function prepareEditArguments(input: unknown): any {
  if (!input || typeof input !== 'object') return input;
  const args = input as Record<string, unknown>;
  if (typeof args.edits === 'string') {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (isSingleEdit(parsed)) args.edits = [parsed];
    } catch {
      /* left for validation to report */
    }
  } else if (isSingleEdit(args.edits)) {
    args.edits = [args.edits];
  }
  if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') return args;
  const edits = Array.isArray(args.edits) ? [...args.edits] : [];
  edits.push({ oldText: args.oldText, newText: args.newText });
  const { oldText: _o, newText: _n, ...rest } = args;
  return { ...rest, edits };
}

export function createEditTool(Type: TypeBuilder, cwd: string, ops: EditOperations, home?: string): AgentTool<any> {
  return {
    name: 'edit',
    label: 'edit',
    description:
      'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({
            description:
              'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
          }),
          newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
        }),
        {
          description:
            'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
        },
      ),
    }),
    prepareArguments: prepareEditArguments,
    async execute(_id, params, signal): Promise<Result> {
      const { path, edits } = params as { path: string; edits: Edit[] };
      if (!Array.isArray(edits) || edits.length === 0)
        throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
      const absolutePath = resolveToCwd(path, cwd, home);
      throwIfAborted(signal);
      try {
        await ops.access(absolutePath);
      } catch (error) {
        throwIfAborted(signal);
        // pi reports only an errno here; a refusal from the checks carries its
        // reason in the message, so that goes through as well.
        const why =
          error instanceof Error
            ? 'code' in error
              ? `Error code: ${(error as NodeJS.ErrnoException).code}`
              : error.message
            : String(error);
        throw new Error(`Could not edit file: ${path}. ${why}`);
      }
      throwIfAborted(signal);
      const raw = (await ops.readFile(absolutePath)).toString('utf-8');
      throwIfAborted(signal);
      // The model will not include an invisible BOM in oldText.
      const { bom, text: content } = splitBom(raw);
      const ending = detectLineEnding(content);
      const { newContent } = applyEditsToNormalizedContent(normalizeToLF(content), edits, path);
      throwIfAborted(signal);
      const note = await ops.writeFile(absolutePath, bom + restoreLineEndings(newContent, ending));
      throwIfAborted(signal);
      return {
        content: [text(`Successfully replaced ${edits.length} block(s) in ${path}.${note ? `\n${note}` : ''}`)],
        details: undefined,
      };
    },
  };
}

// ----------------------------------------------------------------------- ls

const LS_DEFAULT_LIMIT = 500;

export function createLsTool(Type: TypeBuilder, cwd: string, ops: LsOperations, home?: string): AgentTool<any> {
  return {
    name: 'ls',
    label: 'ls',
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${LS_DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Directory to list (default: current directory)' })),
      limit: Type.Optional(
        Type.Number({ description: `Maximum number of entries to return (default: ${LS_DEFAULT_LIMIT})` }),
      ),
    }),
    async execute(_id, params, signal): Promise<Result> {
      const { path, limit } = params as { path?: string; limit?: number };
      throwIfAborted(signal);
      const dirPath = resolveToCwd(path || '.', cwd, home);
      const effectiveLimit = limit ?? LS_DEFAULT_LIMIT;
      if (!(await ops.exists(dirPath))) throw new Error(`Path not found: ${dirPath}`);
      if (!(await ops.stat(dirPath)).isDirectory()) throw new Error(`Not a directory: ${dirPath}`);
      let entries: string[];
      try {
        entries = await ops.readdir(dirPath);
      } catch (e) {
        throw new Error(`Cannot read directory: ${(e as Error).message}`);
      }
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      const results: string[] = [];
      let entryLimitReached = false;
      for (const entry of entries) {
        throwIfAborted(signal);
        if (results.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        let suffix = '';
        try {
          if ((await ops.stat(nodePath.join(dirPath, entry))).isDirectory()) suffix = '/';
        } catch {
          continue; // cannot stat: skipped, as pi does
        }
        results.push(entry + suffix);
      }
      if (results.length === 0) return { content: [text('(empty directory)')], details: undefined };

      // No separate line limit: the entry count is already capped.
      const truncation = truncateHead(results.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
      const notices: string[] = [];
      const details: Record<string, unknown> = {};
      if (entryLimitReached) {
        notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
        details.entryLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      const output = truncation.content + (notices.length ? `\n\n[${notices.join('. ')}]` : '');
      return { content: [text(output)], details: Object.keys(details).length ? details : undefined };
    },
  };
}

// --------------------------------------------------------------------- find

const FIND_DEFAULT_LIMIT = 1000;
/** Never searched: dependency and VCS trees, the same two pi passes to a custom glob. */
const IGNORED = ['**/node_modules/**', '**/.git/**'];

/** A result relative to the search root, with `/` separators. */
function relativizeFindResultPath(resultPath: string, searchPath: string): string {
  const hadTrailingSeparator = resultPath.endsWith(nodePath.sep) || (nodePath.sep === '\\' && resultPath.endsWith('/'));
  const relative = nodePath.isAbsolute(resultPath) ? nodePath.relative(searchPath, resultPath) : resultPath;
  const posix = relative.split(nodePath.sep).join('/');
  return hadTrailingSeparator && !posix.endsWith('/') ? `${posix}/` : posix;
}

export function createFindTool(Type: TypeBuilder, cwd: string, ops: FindOperations, home?: string): AgentTool<any> {
  return {
    name: 'find',
    label: 'find',
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Output is truncated to ${FIND_DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: Type.Object({
      pattern: Type.String({
        description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
      }),
      path: Type.Optional(Type.String({ description: 'Directory to search in (default: current directory)' })),
      limit: Type.Optional(Type.Number({ description: `Maximum number of results (default: ${FIND_DEFAULT_LIMIT})` })),
    }),
    async execute(_id, params, signal): Promise<Result> {
      const { pattern, path, limit } = params as { pattern: string; path?: string; limit?: number };
      throwIfAborted(signal);
      const searchPath = resolveToCwd(path || '.', cwd, home);
      const effectiveLimit = limit ?? FIND_DEFAULT_LIMIT;
      if (!(await ops.exists(searchPath))) throw new Error(`Path not found: ${searchPath}`);
      throwIfAborted(signal);
      const results = await ops.glob(pattern, searchPath, { ignore: IGNORED, limit: effectiveLimit });
      throwIfAborted(signal);
      if (results.length === 0) return { content: [text('No files found matching pattern')], details: undefined };

      const relativized = results.map((p) => relativizeFindResultPath(p, searchPath));
      const truncation = truncateHead(relativized.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
      const notices: string[] = [];
      const details: Record<string, unknown> = {};
      if (relativized.length >= effectiveLimit) {
        notices.push(
          `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        );
        details.resultLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      const output = truncation.content + (notices.length ? `\n\n[${notices.join('. ')}]` : '');
      return { content: [text(output)], details: Object.keys(details).length ? details : undefined };
    },
  };
}

// --------------------------------------------------------------------- grep

const GREP_DEFAULT_LIMIT = 100;
/** Files larger than this are not searched; ripgrep had no such cap, but it did not read into memory. */
export const GREP_MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Does `relative` (posix separators) pass the `glob` filter? As with ripgrep,
 * a pattern without a slash matches the file name at any depth.
 */
function globAccepts(glob: string, relative: string): boolean {
  if (nodePath.posix.matchesGlob(relative, glob)) return true;
  return !glob.includes('/') && nodePath.posix.matchesGlob(nodePath.posix.basename(relative), glob);
}

export function createGrepTool(Type: TypeBuilder, cwd: string, ops: GrepOperations, home?: string): AgentTool<any> {
  return {
    name: 'grep',
    label: 'grep',
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is truncated to ${GREP_DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    parameters: Type.Object({
      pattern: Type.String({ description: 'Search pattern (regex or literal string)' }),
      path: Type.Optional(Type.String({ description: 'Directory or file to search (default: current directory)' })),
      glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search (default: false)' })),
      literal: Type.Optional(
        Type.Boolean({ description: 'Treat pattern as literal string instead of regex (default: false)' }),
      ),
      context: Type.Optional(
        Type.Number({ description: 'Number of lines to show before and after each match (default: 0)' }),
      ),
      limit: Type.Optional(
        Type.Number({ description: `Maximum number of matches to return (default: ${GREP_DEFAULT_LIMIT})` }),
      ),
    }),
    async execute(_id, params, signal): Promise<Result> {
      const p = params as {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        limit?: number;
      };
      throwIfAborted(signal);
      const searchPath = resolveToCwd(p.path || '.', cwd, home);
      let isDirectory: boolean;
      try {
        isDirectory = await ops.isDirectory(searchPath);
      } catch (e) {
        // pi says only "Path not found"; a refusal keeps its reason.
        throw new Error(`Path not found: ${searchPath}${e instanceof Error && e.message ? ` (${e.message})` : ''}`);
      }
      const contextValue = p.context && p.context > 0 ? p.context : 0;
      const effectiveLimit = Math.max(1, p.limit ?? GREP_DEFAULT_LIMIT);
      // RE2, not RegExp: the pattern is the model's, and a backtracking engine
      // on the main thread lets one pattern like (a+)+$ freeze the server for
      // every request. RE2 runs in linear time. Like ripgrep, which pi used, it
      // has no lookaround or backreferences, and says so.
      const source = p.literal ? RE2JS.quote(p.pattern) : p.pattern;
      let re: RE2JS;
      try {
        re = RE2JS.compile(source, p.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
      } catch (e) {
        throw new Error(`Invalid regex: ${(e as Error).message}`);
      }

      const formatPath = (filePath: string) => {
        if (isDirectory) {
          const rel = nodePath.relative(searchPath, filePath);
          if (rel && !rel.startsWith('..')) return rel.replace(/\\/g, '/');
        }
        return nodePath.basename(filePath);
      };

      const outputLines: string[] = [];
      let matchCount = 0;
      let linesTruncated = false;
      const push = (line: string) => {
        const { text: t, wasTruncated } = truncateLine(line);
        if (wasTruncated) linesTruncated = true;
        return t;
      };

      const searchFile = async (filePath: string) => {
        let content: string;
        try {
          content = await ops.readFile(filePath);
        } catch {
          return; // unreadable or refused: skipped, as ripgrep skips what it cannot open
        }
        if (content.includes('\0')) return; // binary
        const lines = normalizeToLF(content).split('\n');
        const shown = formatPath(filePath);
        for (let i = 0; i < lines.length && matchCount < effectiveLimit; i++) {
          if (!re.test(lines[i])) continue;
          matchCount++;
          const lineNumber = i + 1;
          if (contextValue === 0) {
            outputLines.push(`${shown}:${lineNumber}: ${push(lines[i])}`);
            continue;
          }
          const start = Math.max(1, lineNumber - contextValue);
          const end = Math.min(lines.length, lineNumber + contextValue);
          for (let cur = start; cur <= end; cur++) {
            const t = push(lines[cur - 1] ?? '');
            outputLines.push(cur === lineNumber ? `${shown}:${cur}: ${t}` : `${shown}-${cur}- ${t}`);
          }
        }
      };

      if (isDirectory) {
        for await (const filePath of ops.files(searchPath, { ignore: IGNORED })) {
          throwIfAborted(signal);
          if (matchCount >= effectiveLimit) break;
          if (p.glob && !globAccepts(p.glob, nodePath.relative(searchPath, filePath).split(nodePath.sep).join('/')))
            continue;
          await searchFile(filePath);
        }
      } else {
        await searchFile(searchPath);
      }
      throwIfAborted(signal);
      if (matchCount === 0) return { content: [text('No matches found')], details: undefined };

      // No line limit: the match limit already capped rows.
      const truncation = truncateHead(outputLines.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
      const notices: string[] = [];
      const details: Record<string, unknown> = {};
      if (matchCount >= effectiveLimit) {
        notices.push(
          `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        );
        details.matchLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
      }
      const output = truncation.content + (notices.length ? `\n\n[${notices.join('. ')}]` : '');
      return { content: [text(output)], details: Object.keys(details).length ? details : undefined };
    },
  };
}
