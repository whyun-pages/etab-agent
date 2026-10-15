'use strict';
/**
 * Open a file with the operating system's default program.
 *
 * Used to open an attachment on the user's own computer: the chip in the
 * composer is a file the user dropped in, and "show me that file" should land
 * in Excel, the image viewer or the PDF reader, not in a browser tab.
 *
 * The file opened is a COPY written to the temp directory: the server holds
 * attachments as bytes, not as paths (a browser upload never tells us where
 * the original lives). Edits made in the opened program therefore do not come
 * back into the conversation; the UI says so.
 *
 * Why an extension allowlist, not a blocklist: "open with the default program"
 * is "run" for an .exe, .bat, .ps1, .lnk, .hta, .js (Windows Script Host) and
 * a long tail of others, and a blocklist only has to miss one. The allowlist
 * is the formats the paperclip offers plus their close relatives — documents,
 * tables and images whose default handlers are viewers. Macro-enabled Office
 * formats (.xlsm, .docm) and HTML (script on a file:// origin) stay out.
 */

import { spawn } from 'node:child_process';

export const OPENABLE_EXT = new Set([
  '.csv', '.tsv', '.txt', '.md', '.log', '.json', '.jsonl', '.ndjson',
  '.xlsx', '.xls', '.docx', '.doc', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff',
  '.m3u', '.m3u8',
]);

/** True when `filename`'s extension is one we are willing to hand to the OS. */
export function isOpenable(filename: string): boolean {
  const m = /\.[^.\\/]+$/.exec(filename || '');
  return Boolean(m && OPENABLE_EXT.has(m[0].toLowerCase()));
}

/** How long to wait for the opener before assuming it handed off and moved on. */
const OPENER_TIMEOUT_MS = 15_000;

/**
 * The opener command for this platform.
 *
 * Windows: `Invoke-Item` through PowerShell, with the path passed in an
 * environment variable. The obvious alternatives each mis-handle some file
 * name: `cmd /c start` re-parses `%VAR%` and `^` inside quotes; `explorer.exe`
 * splits its argument on commas; `rundll32 url.dll,FileProtocolHandler` takes
 * an ANSI path and mangles Chinese names. An environment variable is never
 * parsed as a command at all. PowerShell also exits non-zero when no program
 * is associated with the type, which is the error worth reporting.
 */
function command(file: string): { cmd: string; args: string[]; env?: NodeJS.ProcessEnv } {
  if (process.platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Item -LiteralPath $env:ETAB_OPEN_FILE'],
      env: { ...process.env, ETAB_OPEN_FILE: file },
    };
  }
  if (process.platform === 'darwin') return { cmd: 'open', args: [file] };
  return { cmd: 'xdg-open', args: [file] };
}

/**
 * Open `file` with the default program. Resolves once the opener has handed
 * the file off; rejects with a user-facing message when it could not.
 */
export function openWithSystem(file: string): Promise<void> {
  const { cmd, args, env } = command(file);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const child = spawn(cmd, args, { env, stdio: 'ignore', windowsHide: true });
    // An opener that is still running after the timeout has, in practice,
    // launched the program and is waiting on it (some xdg-open backends do).
    // Not an error; stop waiting and let it run.
    const timer = setTimeout(() => { child.unref(); done(); }, OPENER_TIMEOUT_MS);
    child.on('error', (err) => done(new Error(`无法调用系统打开程序：${err.message}`)));
    child.on('exit', (code) => done(code === 0 ? undefined : new Error('系统没能打开这个文件，可能没有能打开这类文件的程序')));
  });
}
