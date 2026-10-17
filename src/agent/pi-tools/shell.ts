'use strict';
/**
 * pi's shell tools: bash, and powershell on Windows.
 *
 * Ported from @earendil-works/pi-coding-agent 1.3.0, dist/core/tools/bash.js,
 * powershell.js, output-accumulator.js and dist/utils/shell.js,
 * child-process.js (MIT, Copyright (c) 2025 Mario Zechner — see ./LICENSE).
 * The tool name, parameters, description, tail truncation, exit-code and
 * timeout reporting are pi's.
 *
 * These are NOT behind src/agent/file-access.ts. A command can read or write any
 * file this user can, and it runs the moment the model calls it — there is no
 * deferring a process to the end of the turn. src/agent/agent.ts offers them only
 * with read-write file access, and says so in the prompt.
 *
 * What changed on the way in
 * --------------------------
 * - Finding the shell is asynchronous. pi used `spawnSync('where'|'which')`,
 *   which blocks the server's one event loop (see AGENTS.md).
 * - Output is kept as a bounded tail in memory and NOT spilled to a temp file
 *   when long: pi's "Full output: <path>" pointed at a file under the temp
 *   directory that nothing here cleans up. The notice says how much was cut.
 * - No `PI_*` session variables, no pi bin directory on PATH, no streamed
 *   partial updates (nothing here renders them), no codemode output schema.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Pi } from '../pi.ts';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from './truncate.ts';
import type { TruncationResult } from './truncate.ts';

type TypeBuilder = Pi['ai']['Type'];

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ShellConfig {
  shell: string;
  args: string[];
  /** WSL's legacy bash.exe takes the command on stdin, not as an argument. */
  commandTransport?: 'stdin';
}

// ------------------------------------------------------------- shell lookup

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first match for `executable` on PATH, via `where` or `which`. */
function findExecutableOnPath(executable: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(finder, [executable], { encoding: 'utf-8', timeout: 5000, windowsHide: true }, async (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const first = stdout.trim().split(/\r?\n/)[0];
      // `where` can list paths that do not exist; `which` is trusted as pi does.
      if (!first || (process.platform === 'win32' && !(await exists(first)))) return resolve(null);
      resolve(first);
    });
  });
}

function isLegacyWslBashPath(p: string): boolean {
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(p.replace(/\//g, '\\').toLowerCase());
}

function bashShellConfig(shell: string): ShellConfig {
  return isLegacyWslBashPath(shell) ? { shell, args: ['-s'], commandTransport: 'stdin' } : { shell, args: ['-c'] };
}

/** Git Bash in its usual places, then bash on PATH; on Unix /bin/bash, PATH, then sh. */
export async function getShellConfig(): Promise<ShellConfig> {
  if (process.platform === 'win32') {
    const candidates = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter((d): d is string => Boolean(d))
      .map((d) => `${d}\\Git\\bin\\bash.exe`);
    for (const p of candidates) if (await exists(p)) return bashShellConfig(p);
    const onPath = await findExecutableOnPath('bash.exe');
    if (onPath) return bashShellConfig(onPath);
    throw new Error(`No bash shell found. Install Git for Windows (https://git-scm.com/download/win) or add bash to PATH.\n\nSearched Git Bash in:\n${candidates.map((p) => `  ${p}`).join('\n')}`);
  }
  if (await exists('/bin/bash')) return bashShellConfig('/bin/bash');
  const onPath = await findExecutableOnPath('bash');
  if (onPath) return bashShellConfig(onPath);
  return { shell: 'sh', args: ['-c'] };
}

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/** PowerShell 7 if installed, else Windows PowerShell. */
export async function getPowerShellConfig(): Promise<ShellConfig> {
  if (process.platform !== 'win32') throw new Error('The powershell tool is only available on Windows.');
  const shell = (await findExecutableOnPath('pwsh.exe')) ?? (await findExecutableOnPath('powershell.exe'));
  if (!shell) throw new Error('No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.');
  return { shell, args: [...POWERSHELL_ARGS] };
}

// ------------------------------------------------------------ process tree

/** Kill a process and everything it started. */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      // The System32 binary, so cleanup does not depend on PATH.
      const child = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      child.once('error', () => {});
    } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child to finish without hanging on stdio a detached descendant
 * still holds open. After `exit`, the pipes get a grace period that restarts
 * on every chunk: a descendant still writing keeps us reading, a quiet
 * inherited handle (Windows never fires `close` for it) releases us.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let timer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      child.stdout?.removeListener('end', onStdoutEnd);
      child.stderr?.removeListener('end', onStderrEnd);
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onData);
    };
    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const armIdleTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const maybeFinalize = () => {
      if (exited && !settled && stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const onData = () => { if (exited && !settled) armIdleTimer(); };
    const onStdoutEnd = () => { stdoutEnded = true; maybeFinalize(); };
    const onStderrEnd = () => { stderrEnded = true; maybeFinalize(); };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalize();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null) => finalize(code);

    child.stdout?.once('end', onStdoutEnd);
    child.stderr?.once('end', onStderrEnd);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('close', onClose);
  });
}

// ------------------------------------------------------------------ output

/**
 * Streamed output, kept as a bounded tail plus totals. pi's accumulator also
 * spilled the whole output to a temp file; see the header for why not here.
 */
class OutputTail {
  #decoder = new TextDecoder();
  #tail = '';
  #tailBytes = 0;
  #tailAtLineStart = true;
  #totalBytes = 0;
  #completedLines = 0;
  #openLine = false;
  #lastLineBytes = 0;
  #maxRollingBytes = DEFAULT_MAX_BYTES * 2;

  append(data: Buffer): void {
    this.#add(this.#decoder.decode(data, { stream: true }));
  }

  finish(): void {
    this.#add(this.#decoder.decode());
  }

  get lastLineBytes(): number {
    return this.#lastLineBytes;
  }

  snapshot(): TruncationResult {
    const visible = this.#tailAtLineStart ? this.#tail : this.#tail.slice(this.#tail.indexOf('\n') + 1);
    const t = truncateTail(visible);
    const totalLines = this.#completedLines + (this.#openLine ? 1 : 0);
    const truncated = totalLines > DEFAULT_MAX_LINES || this.#totalBytes > DEFAULT_MAX_BYTES;
    return {
      ...t,
      truncated,
      truncatedBy: truncated ? (t.truncatedBy ?? (this.#totalBytes > DEFAULT_MAX_BYTES ? 'bytes' : 'lines')) : null,
      totalLines,
      totalBytes: this.#totalBytes,
    };
  }

  #add(text: string): void {
    if (!text) return;
    const bytes = Buffer.byteLength(text, 'utf-8');
    this.#totalBytes += bytes;
    this.#tail += text;
    this.#tailBytes += bytes;
    if (this.#tailBytes > this.#maxRollingBytes * 2) this.#trim();
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) {
      this.#lastLineBytes += bytes;
      this.#openLine = true;
    } else {
      this.#completedLines += text.split('\n').length - 1;
      const rest = text.slice(lastNewline + 1);
      this.#lastLineBytes = Buffer.byteLength(rest, 'utf-8');
      this.#openLine = rest.length > 0;
    }
  }

  #trim(): void {
    const buf = Buffer.from(this.#tail, 'utf-8');
    let start = buf.length - this.#maxRollingBytes;
    if (start <= 0) return;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
    this.#tailAtLineStart = buf[start - 1] === 0x0a;
    this.#tail = buf.subarray(start).toString('utf-8');
    this.#tailBytes = Buffer.byteLength(this.#tail, 'utf-8');
  }
}

// -------------------------------------------------------------------- exec

/** Run `command` and stream its output to `onData`. Rejects with "aborted" or "timeout:<s>". */
async function exec(
  config: ShellConfig,
  command: string,
  cwd: string,
  { onData, signal, timeout }: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number },
): Promise<number> {
  let timeoutMs: number | undefined;
  if (timeout !== undefined) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid timeout: must be a finite number of seconds');
    timeoutMs = timeout * 1000;
    if (timeoutMs > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  }
  if (signal?.aborted) throw new Error('aborted');
  if (!(await exists(cwd))) throw new Error(`Working directory does not exist: ${cwd}`);

  const viaStdin = config.commandTransport === 'stdin';
  const child = spawn(config.shell, viaStdin ? config.args : [...config.args, command], {
    cwd,
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (viaStdin) {
    child.stdin?.on('error', () => {});
    child.stdin?.end(command);
  }

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const onAbort = () => { if (child.pid) killProcessTree(child.pid); };
  try {
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killProcessTree(child.pid);
      }, timeoutMs);
    }
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const code = await waitForChildProcess(child);
    if (signal?.aborted) throw new Error('aborted');
    if (timedOut) throw new Error(`timeout:${timeout}`);
    // A signal-killed shell has no exit code; use the shell convention so it
    // is not mistaken for success.
    const sig = child.signalCode;
    return code ?? (sig ? 128 + (osConstants.signals[sig] ?? 0) : 1);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// -------------------------------------------------------------------- tool

interface ShellToolConfig {
  name: string;
  shellName: string;
  resolve: () => Promise<ShellConfig>;
  /** Prepended to every command; PowerShell needs its output switched to UTF-8. */
  prefix?: string;
}

function createShellTool(Type: TypeBuilder, cwd: string, config: ShellToolConfig): AgentTool<any> {
  return {
    name: config.name,
    label: config.name,
    description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Optionally provide a timeout in seconds.`,
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute' }),
      timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<any>> {
      const { command, timeout } = params as { command: string; timeout?: number };
      const shell = await config.resolve();
      const output = new OutputTail();

      const format = (emptyText: string): { text: string; details?: { truncation: TruncationResult } } => {
        output.finish();
        const t = output.snapshot();
        let out = t.content || emptyText;
        if (!t.truncated) return { text: out };
        const startLine = t.totalLines - t.outputLines + 1;
        if (t.lastLinePartial) {
          out += `\n\n[Showing last ${formatSize(t.outputBytes)} of line ${t.totalLines} (line is ${formatSize(output.lastLineBytes)}).]`;
        } else if (t.truncatedBy === 'lines') {
          out += `\n\n[Showing lines ${startLine}-${t.totalLines} of ${t.totalLines}.]`;
        } else {
          out += `\n\n[Showing lines ${startLine}-${t.totalLines} of ${t.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).]`;
        }
        return { text: out, details: { truncation: t } };
      };
      const withStatus = (t: string, status: string) => `${t ? `${t}\n\n` : ''}${status}`;

      let exitCode: number;
      try {
        exitCode = await exec(shell, (config.prefix ?? '') + command, cwd, { onData: (d) => output.append(d), signal, timeout });
      } catch (err) {
        const { text } = format('');
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'aborted') throw new Error(withStatus(text, 'Command aborted'));
        if (msg.startsWith('timeout:')) throw new Error(withStatus(text, `Command timed out after ${msg.split(':')[1]} seconds`));
        throw err;
      }
      const { text, details } = format('(no output)');
      if (exitCode !== 0) {
        return { content: [{ type: 'text', text: withStatus(text, `Command exited with code ${exitCode}`) }], details, isError: true };
      }
      return { content: [{ type: 'text', text }], details };
    },
  };
}

export function createBashTool(Type: TypeBuilder, cwd: string): AgentTool<any> {
  return createShellTool(Type, cwd, { name: 'bash', shellName: 'bash', resolve: getShellConfig });
}

export function createPowerShellTool(Type: TypeBuilder, cwd: string): AgentTool<any> {
  return createShellTool(Type, cwd, {
    name: 'powershell',
    shellName: 'PowerShell',
    resolve: getPowerShellConfig,
    prefix: 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n',
  });
}
