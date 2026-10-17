'use strict';
/**
 * Finding Microsoft Edge, per platform. A missing Edge is not fatal: the
 * server is the product, the window is a convenience.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * Edge candidates, most specific first, per platform.
 *
 * Windows keeps the three install locations it has always used. On macOS the
 * browser binary lives inside the .app bundle rather than at a bare path, and
 * the per-user install under ~/Applications is real enough to check. On Linux
 * there is no single canonical location — a distro package and a snap/flatpak
 * install land in different places — so the list is the common ones, with
 * /usr/bin symlinked on most systems.
 *
 * A missing browser is not fatal: main() falls back to printing the address so
 * the page can be opened by hand. That is deliberate — the server is the
 * product, the window is a convenience.
 */
export function findEdge(): string | null {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'Microsoft',
        'Edge',
        'Application',
        'msedge.exe',
      ),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(os.homedir(), 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
    );
  } else {
    candidates.push(
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/opt/microsoft/msedge/microsoft-edge',
      '/snap/bin/microsoft-edge',
      '/var/lib/flatpak/exports/bin/com.microsoft.Edge',
    );
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Is this the Edge binary? The `--disable-features=msEdgeAutoLaunch` flag is
 * Edge-specific: passing it to another Chromium browser is harmless but
 * meaningless, so it goes on only when it applies.
 */
export function isEdge(bin: string): boolean {
  return /msedge|microsoft.?edge/i.test(path.basename(bin));
}
