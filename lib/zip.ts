'use strict';
/**
 * Minimal ZIP reader/writer — zero dependencies.
 *
 * XLSX is an OPC (Open Packaging Convention) container: a plain ZIP archive of
 * XML parts. Node ships zlib, so we only need to implement the ZIP container
 * ourselves. Read side parses the central directory (authoritative entry list);
 * write side emits local headers + central directory with deflate.
 *
 * TypeScript notes (this module is the migration pilot, so it sets the house
 * style for the rest):
 *   - Erasable syntax only. No `enum`, no `namespace`, no parameter
 *     properties, no `export =`. `tsconfig` enforces this via
 *     `erasableSyntaxOnly`; Node's stripper rejects it at runtime otherwise.
 *   - Source is ESM `import`/`export`, emitted to CommonJS by `tsc`. The
 *     reason it is written this way rather than as `module.exports`: the build
 *     is a real emit, not a strip, and `rewriteRelativeImportExtensions` only
 *     rewrites `import`/`export` specifiers — a bare `require` call keeps the
 *     literal specifier, so it would ship the `.ts` extension into the output.
 *   - `import x = require('node:zlib')` is NOT erasable, despite being the
 *     canonical way to type a CJS import in TypeScript. It fails with
 *     "TypeScript import equals declaration is not supported in strip-only
 *     mode". A plain default import carries the same type and erases cleanly.
 *   - Buffer/`Uint8Array` boundaries are typed explicitly: the reader accepts
 *     anything buffer-like, the writer always returns a Buffer.
 *
 * Why this file exists at all (asked often — "doesn't Node have ZIP?"):
 *   Node ships `node:zlib`, which is DEFLATE *compression* — a byte stream
 *   transform. It does not ship ZIP, which is a *container format*: a
 *   directory of named entries, each with its own local header, CRC-32,
 *   timestamp, compression method and offsets, followed by a central directory
 *   that is the authoritative entry list. `deflateRawSync` supplies only the
 *   compressed payload; everything that makes it a `.xlsx` we have to lay out
 *   ourselves. zlib also has `unzipSync`, but that reads *gzip* members, not
 *   ZIP archives — a genuinely confusing name, not a ZIP implementation.
 *   Node has no `node:zip`, no `node:tar`, and no builtin archive reader.
 *
 *   The alternatives were rejected on purpose: shelling out to PowerShell's
 *   Expand-Archive/Compress-Archive drags in a process spawn and differs by OS
 *   and version; pulling in a package would put a third-party dependency in
 *   the release path of a project that keeps its runtime dependency-free.
 *   The fixed `DEFAULT_MTIME` below is the payoff — same input, same bytes.
 */

import zlib from 'node:zlib';

// ---------------------------------------------------------------- CRC32 table
const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ------------------------------------------------------------- little endians
const u16 = (b: Buffer, o: number): number => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number): number => b.readUInt32LE(o);

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;

/** One entry as read back out of an archive. */
export interface ZipEntry {
  name: string;
  data: Buffer;
  method: number;
  modTime: number;
  modDate: number;
}

/** One entry as handed to the writer. */
export interface ZipInput {
  name: string;
  data: Buffer | Uint8Array | string;
  mtime?: number;
}

export interface WriteOptions {
  level?: number;
}

/**
 * Locate End Of Central Directory. Normally the last 22 bytes, but a trailing
 * ZIP comment (up to 64KB) can push it back, so scan backwards.
 */
function findEOCD(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) === SIG_EOCD) return i;
  }
  return -1;
}

/** Decode a filename: CP437-ish ASCII fast path, else UTF-8. */
function decodeName(bytes: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return bytes.toString('utf8');
  return bytes.toString('latin1');
}

/**
 * Read a ZIP archive into a Map<name, ZipEntry>.
 * Entries are decompressed eagerly; XLSX parts are small.
 */
export function readZip(buf: Buffer): Map<string, ZipEntry> {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('not a zip: EOCD signature not found');

  let entryCount = u16(buf, eocd + 10);
  let cdOffset = u32(buf, eocd + 16);
  let cdSize = u32(buf, eocd + 12);

  // ZIP64: the 32-bit fields saturate at 0xffffffff; real values live in the
  // ZIP64 EOCD record, pointer stored just before EOCD.
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff) {
    const loc64 = eocd - 20;
    if (loc64 >= 0 && u32(buf, loc64) === SIG_LOC64) {
      const z64 = Number(buf.readBigUInt64LE(loc64 + 8));
      if (u32(buf, z64) === SIG_EOCD64) {
        entryCount = Number(buf.readBigUInt64LE(z64 + 32));
        cdSize = Number(buf.readBigUInt64LE(z64 + 40));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let i = 0; i < entryCount && p + 46 <= buf.length; i++) {
    if (u32(buf, p) !== SIG_CEN) break;
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const modTime = u16(buf, p + 12);
    const modDate = u16(buf, p + 14);
    const compSize = u32(buf, p + 20);
    const uncompSize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    let localOffset = u32(buf, p + 42);
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), !!(flags & 0x800));

    // ZIP64 extra field (0x0001) carries the saturated values, in field order.
    if (localOffset === 0xffffffff || compSize === 0xffffffff || uncompSize === 0xffffffff) {
      let ep = p + 46 + nameLen;
      const extraEnd = ep + extraLen;
      while (ep + 4 <= extraEnd) {
        const id = u16(buf, ep);
        const len = u16(buf, ep + 2);
        if (id === 0x0001) {
          let q = ep + 4;
          if (uncompSize === 0xffffffff) { q += 8; }
          if (compSize === 0xffffffff) { q += 8; }
          if (localOffset === 0xffffffff) localOffset = Number(buf.readBigUInt64LE(q));
          break;
        }
        ep += 4 + len;
      }
    }

    // Directory entries have trailing '/'; skip them but keep the count in sync.
    if (!name.endsWith('/')) {
      const data = readLocalEntry(buf, localOffset, method, compSize);
      entries.set(normalize(name), { name, data, method, modTime, modDate });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Resolve one entry's payload from its local header. */
function readLocalEntry(buf: Buffer, localOffset: number, cdMethod: number, cdCompSize: number): Buffer {
  if (u32(buf, localOffset) !== SIG_LOC) throw new Error('bad local header at ' + localOffset);
  const nameLen = u16(buf, localOffset + 26);
  const extraLen = u16(buf, localOffset + 28);
  const method = u16(buf, localOffset + 8) || cdMethod;
  const dataStart = localOffset + 30 + nameLen + extraLen;

  // Bit 3 (data descriptor): sizes are zero in the local header and follow the
  // data. Trust the central directory size, which is always correct.
  const compSize = cdCompSize;
  const raw = buf.subarray(dataStart, dataStart + compSize);

  if (method === 0) return Buffer.from(raw);
  if (method === 8) return zlib.inflateRawSync(raw);
  throw new Error('unsupported compression method: ' + method);
}

/** ZIP names are case-sensitive but XLSX tooling is sloppy; match loosely. */
function normalize(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Narrow a writer input to bytes without guessing at an encoding. */
function toRawBuffer(data: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  // A Uint8Array view may be a window onto a larger buffer, so copy the
  // window's own bytes rather than the whole backing store.
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Build a ZIP archive from [{name, data}].
 * `mtime` is fixed for the DOS fields unless provided, keeping output stable.
 */
export function writeZip(files: ZipInput[], { level = 6 }: WriteOptions = {}): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = toRawBuffer(file.data);
    const crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw, { level });
    // Storing is cheaper when deflate does not shrink the payload.
    const useStore = deflated.length >= raw.length;
    const body = useStore ? raw : deflated;
    const method = useStore ? 0 : 8;
    const { time, date } = dosStamp(file.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOC, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x800, 6);       // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0);
    cen.writeUInt16LE(20, 4);            // version made by
    cen.writeUInt16LE(20, 6);            // version needed
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(0, 38);            // external attrs
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdStart = offset;
  const cdSize = central.reduce((n, c) => n + c.length, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);

  return Buffer.concat([...chunks, ...central, eocd]);
}

/**
 * DOS timestamp. Excel is indifferent, but a fixed default keeps generated
 * archives byte-identical across runs, which makes diffing outputs possible.
 */
export const DEFAULT_MTIME = Date.UTC(2026, 0, 1, 0, 0, 0);

interface DosStamp { date: number; time: number }

function dosStamp(ms?: number): DosStamp {
  const d = new Date(ms == null ? DEFAULT_MTIME : ms);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date: date & 0xffff, time: time & 0xffff };
}
