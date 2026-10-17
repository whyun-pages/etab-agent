'use strict';
/**
 * Opening a ZIP into its members, within limits, skipping hidden entries and
 * archiver litter.
 */

import path from 'node:path';
import { readZip } from '../formats/xlsx.ts';
import { READABLE_EXT, ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_BYTES } from './kinds.ts';

/** Members actually read out of one archive; the rest are listed as skipped. */
export const ARCHIVE_MAX_READ = 100;

/** A file inside an archive, named by its path there. */
export interface ArchiveMember {
  path: string;
  data: Buffer;
}

/** Whether a path is hidden or archiver litter: `.git/…`, `__MACOSX/…`, `Thumbs.db`. */
export function isHiddenPath(p: string): boolean {
  return p
    .split(/[\\/]/)
    .some((seg) => seg.startsWith('.') || seg === '__MACOSX' || /^(thumbs\.db|desktop\.ini)$/i.test(seg));
}

/**
 * The readable members of a ZIP archive, in archive order.
 *
 * Bounded (see `ReadZipLimits`): a bomb or an archive of a whole disk throws
 * rather than taking the process with it. Nested archives are listed as
 * skipped, not opened — one level is what a person means by "this zip", and
 * recursion is how a bomb gets its multiplier.
 */
export function expandZip(buffer: Buffer): { members: ArchiveMember[]; skipped: string[] } {
  const zip = readZip(buffer, { maxEntries: ARCHIVE_MAX_ENTRIES, maxBytes: ARCHIVE_MAX_BYTES });
  const members: ArchiveMember[] = [];
  const skipped: string[] = [];
  for (const [p, entry] of zip) {
    if (isHiddenPath(p)) continue;
    const ext = path.extname(p).toLowerCase();
    if (!READABLE_EXT.has(ext) || members.length >= ARCHIVE_MAX_READ) {
      skipped.push(p);
      continue;
    }
    members.push({ path: p, data: entry.data });
  }
  return { members, skipped };
}
