'use strict';
/**
 * Legacy .xls (Excel 97-2003, BIFF8) reader — zero dependencies, read only.
 *
 * An .xls is two formats stacked:
 *   1. a Compound File Binary (CFB / OLE2) container — a little FAT file system
 *      inside one file, with a directory of named streams;
 *   2. a "Workbook" stream in that container, which is a flat sequence of BIFF
 *      records (`u16 type, u16 length, payload`).
 *
 * We read only what turning a sheet into rows needs: sheet names, the shared
 * string table and the cell records. Styles, merges, formulas' token streams
 * and charts are skipped. A formula cell yields its cached result, the same as
 * `sheetToMatrix` does for .xlsx.
 *
 * Why not convert through a package: the project ships with no runtime
 * dependency for any file format (see the note at the top of `src/formats/zip.ts`),
 * and the subset of BIFF8 a template or a member export uses is small. Why not
 * just tell the user to re-save as .xlsx: that was the old behaviour, and the
 * old format is still what many back-office systems export.
 *
 * Synchronous, like `readWorkbook`: everything here is CPU over an in-memory
 * Buffer, there is no file descriptor and nothing to overlap.
 *
 * Out of scope, reported as errors rather than misread: BIFF5 and older
 * (Excel 95, 8-bit codepage strings) and encrypted workbooks (FILEPASS).
 */

import type { ParsedCell, ParsedSheet } from './xlsx.ts';
import { cellRef } from './xlsx.ts';

// ------------------------------------------------------------------- CFB

export const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

export function isCfb(buf: Buffer): boolean {
  return buf.length >= 512 && CFB_MAGIC.every((b, i) => buf[i] === b);
}

/**
 * Read the streams of a compound file, keyed by their directory name: those
 * named in `only`, or every one.
 *
 * Names are flattened (the storage tree is not walked): an .xls keeps its
 * `Workbook` stream at the root and nothing else by that name, so a flat map
 * is enough. When two streams do share a name, the first in directory order
 * wins.
 *
 * Every count the header gives is checked against the file it came in. They
 * were trusted: numFatSectors and numDifat are 32-bit, and a DIFAT sector
 * pointing at itself kept adding FAT ids until the process ran out of memory.
 * And streams are read only when asked for — several directory entries can
 * name one long chain, and reading them all multiplied the file's size by the
 * number of entries, on every upload that was sniffed.
 */
export function readCfb(buf: Buffer, only?: readonly string[]): Map<string, Buffer> {
  const cfb = openCfb(buf);
  const streams = new Map<string, Buffer>();
  for (const name of cfb.names) if (!only || only.includes(name)) streams.set(name, cfb.read(name));
  return streams;
}

/** The stream names of a compound file, without reading any stream. */
export function cfbStreamNames(buf: Buffer): Set<string> {
  return openCfb(buf).names;
}

function openCfb(buf: Buffer): { names: Set<string>; read: (name: string) => Buffer } {
  if (!isCfb(buf)) throw new Error('not a compound file');
  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const miniSectorSize = 1 << buf.readUInt16LE(0x20);
  const numFatSectors = buf.readUInt32LE(0x2c);
  const firstDirSector = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const firstMiniFat = buf.readUInt32LE(0x3c);
  const firstDifat = buf.readUInt32LE(0x44);
  const numDifat = buf.readUInt32LE(0x48);
  if (sectorSize !== 512 && sectorSize !== 4096) throw new Error('bad compound file sector size');
  // The header takes the first sector's worth of bytes; the rest is sectors.
  // No list of sector ids, and no chain, can be longer than that.
  const sectorCount = Math.floor(buf.length / sectorSize) - 1;
  if (numFatSectors > sectorCount || numDifat > sectorCount) throw new Error('bad compound file header');

  const sectorOffset = (id: number): number => (id + 1) * sectorSize;
  const sector = (id: number): Buffer => {
    const off = sectorOffset(id);
    if (off + sectorSize > buf.length) throw new Error('compound file truncated');
    return buf.subarray(off, off + sectorSize);
  };

  // DIFAT: the first 109 FAT sector ids live in the header, the rest in a
  // chain of DIFAT sectors whose last slot points at the next one.
  const fatIds: number[] = [];
  for (let i = 0; i < 109 && fatIds.length < numFatSectors; i++) {
    const id = buf.readUInt32LE(0x4c + i * 4);
    if (id !== FREESECT) fatIds.push(id);
  }
  let difat = firstDifat;
  const perDifat = sectorSize / 4 - 1;
  const seenDifat = new Set<number>();
  for (let n = 0; n < numDifat && difat !== ENDOFCHAIN && difat !== FREESECT; n++) {
    if (seenDifat.has(difat)) throw new Error('bad compound file chain');
    seenDifat.add(difat);
    const s = sector(difat);
    for (let i = 0; i < perDifat && fatIds.length < numFatSectors; i++) {
      const id = s.readUInt32LE(i * 4);
      if (id !== FREESECT) fatIds.push(id);
    }
    difat = s.readUInt32LE(perDifat * 4);
  }

  const fat: number[] = [];
  for (const id of fatIds) {
    const s = sector(id);
    for (let i = 0; i < sectorSize; i += 4) fat.push(s.readUInt32LE(i));
  }

  // A corrupt table can loop. A chain visits each of its sectors once, so it
  // can be no longer than the number of sectors there are: `limit`.
  const chain = (start: number, table: number[], limit: number): number[] => {
    const ids: number[] = [];
    for (let id = start; id !== ENDOFCHAIN && id !== FREESECT; id = table[id]) {
      if (id >= table.length || ids.length >= limit) throw new Error('bad compound file chain');
      ids.push(id);
    }
    return ids;
  };
  const readChain = (start: number): Buffer => Buffer.concat(chain(start, fat, sectorCount).map(sector));

  const dir = readChain(firstDirSector);
  interface Entry {
    name: string;
    type: number;
    start: number;
    size: number;
  }
  const entries: Entry[] = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 64);
    const type = dir[off + 66];
    if (type === 0 || nameLen < 2) continue;
    entries.push({
      name: dir.toString('utf16le', off, off + Math.min(nameLen, 64) - 2),
      type,
      start: dir.readUInt32LE(off + 116),
      // The high dword is only meaningful for 4096-byte sectors; streams over
      // 4 GB are not a concern for a spreadsheet upload.
      size: dir.readUInt32LE(off + 120),
    });
  }
  const root = entries.find((e) => e.type === 5);

  // Streams under the cutoff live in the mini stream (the root entry's data),
  // addressed in 64-byte mini sectors through the mini FAT.
  let miniStream: Buffer | null = null;
  let miniFat: number[] = [];
  const loadMini = (): void => {
    if (miniStream) return;
    miniStream = root ? readChain(root.start) : Buffer.alloc(0);
    const mf = firstMiniFat === ENDOFCHAIN ? Buffer.alloc(0) : readChain(firstMiniFat);
    miniFat = [];
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mf.readUInt32LE(i));
  };

  // First entry of each name, in directory order.
  const byName = new Map<string, Entry>();
  for (const e of entries) if (e.type === 2 && !byName.has(e.name)) byName.set(e.name, e);

  const read = (name: string): Buffer => {
    const e = byName.get(name);
    if (!e) throw new Error(`no stream named ${name}`);
    let data: Buffer;
    if (e.size < miniCutoff) {
      loadMini();
      const ms = miniStream as unknown as Buffer;
      const miniCount = Math.floor(ms.length / miniSectorSize);
      data = Buffer.concat(
        chain(e.start, miniFat, miniCount).map((id) => ms.subarray(id * miniSectorSize, (id + 1) * miniSectorSize)),
      );
    } else {
      data = readChain(e.start);
    }
    return data.subarray(0, e.size);
  };
  return { names: new Set(byName.keys()), read };
}

// ------------------------------------------------------------------ BIFF8

const R = {
  BOF: 0x0809,
  EOF: 0x000a,
  FILEPASS: 0x002f,
  CONTINUE: 0x003c,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
  DIMENSION: 0x0200,
} as const;

const ERRORS: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
};

interface BiffRecord {
  type: number;
  data: Buffer;
  /** CONTINUE payloads that followed this record, in order. */
  cont: Buffer[];
  offset: number;
}

/**
 * Read one substream (BOF ... EOF) starting at `from`, folding CONTINUE into
 * the record before it.
 *
 * Substreams nest — a worksheet with an embedded chart carries the chart's own
 * BOF/EOF pair in the middle — so the end is the EOF that balances the first
 * BOF, not the first EOF seen. Stopping at the first one would drop every cell
 * after the chart.
 */
function substream(stream: Buffer, from: number): BiffRecord[] {
  const out: BiffRecord[] = [];
  let off = from;
  let depth = 0;
  while (off + 4 <= stream.length) {
    const type = stream.readUInt16LE(off);
    const len = stream.readUInt16LE(off + 2);
    const data = stream.subarray(off + 4, Math.min(off + 4 + len, stream.length));
    if (type === R.CONTINUE && out.length) out[out.length - 1].cont.push(data);
    else out.push({ type, data, cont: [], offset: off });
    off += 4 + len;
    if (type === R.BOF) depth++;
    else if (type === R.EOF && --depth <= 0) break;
  }
  return out;
}

/**
 * A cursor over a record and its CONTINUE chunks.
 *
 * BIFF8 splits a long string across a CONTINUE boundary in a particular way:
 * the next chunk restarts with a fresh option byte saying whether the rest of
 * the characters are 8- or 16-bit. Everything else (counts, run arrays) just
 * flows on. This cursor hides the boundary for the latter and exposes it for
 * the former.
 */
class Cursor {
  chunks: Buffer[];
  i = 0;
  pos = 0;
  constructor(chunks: Buffer[]) {
    this.chunks = chunks;
  }

  get buf(): Buffer {
    return this.chunks[this.i];
  }
  atChunkEnd(): boolean {
    return this.pos >= this.buf.length;
  }
  next(): boolean {
    if (this.i + 1 >= this.chunks.length) return false;
    this.i++;
    this.pos = 0;
    return true;
  }
  u8(): number {
    while (this.atChunkEnd()) if (!this.next()) throw new Error('xls record truncated');
    return this.buf[this.pos++];
  }
  u16(): number {
    const a = this.u8();
    return a | (this.u8() << 8);
  }
  u32(): number {
    return (this.u16() + this.u16() * 0x10000) >>> 0;
  }
  skip(n: number): void {
    while (n > 0) {
      while (this.atChunkEnd()) if (!this.next()) return;
      const k = Math.min(n, this.buf.length - this.pos);
      this.pos += k;
      n -= k;
    }
  }

  /** XLUnicodeRichExtendedString (SST entries) or XLUnicodeString (the rest). */
  unicodeString(cch: number): string {
    let flags = this.u8();
    let runs = 0,
      ext = 0;
    if (flags & 0x08) runs = this.u16();
    if (flags & 0x04) ext = this.u32();
    let s = '';
    let left = cch;
    while (left > 0) {
      if (this.atChunkEnd()) {
        if (!this.next()) break;
        // The continuation's own option byte: only bit 0 (16-bit chars) counts.
        flags = (flags & ~1) | (this.u8() & 1);
      }
      const wide = flags & 1;
      const avail = Math.floor((this.buf.length - this.pos) / (wide ? 2 : 1));
      const k = Math.min(left, avail);
      if (k <= 0) {
        this.pos = this.buf.length;
        continue;
      }
      const end = this.pos + k * (wide ? 2 : 1);
      // An 8-bit char here is a UTF-16 code unit with its high byte dropped,
      // which is exactly latin1 — not the workbook's codepage.
      s += this.buf.toString(wide ? 'utf16le' : 'latin1', this.pos, end);
      this.pos = end;
      left -= k;
    }
    this.skip(runs * 4 + ext);
    return s;
  }
}

/** RkNumber: a 30-bit int or the top 30 bits of a double, optionally ×100. */
export function decodeRk(rk: number): number {
  let v: number;
  if (rk & 0x02) {
    v = rk >> 2;
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = b.readDoubleLE(0);
  }
  return rk & 0x01 ? v / 100 : v;
}

function readSst(rec: BiffRecord): string[] {
  const c = new Cursor([rec.data, ...rec.cont]);
  c.u32(); // total references, not needed
  const unique = c.u32();
  const out: string[] = [];
  for (let n = 0; n < unique; n++) {
    if (c.atChunkEnd() && !c.next()) break;
    out.push(c.unicodeString(c.u16()));
  }
  return out;
}

export interface XlsWorkbook {
  sheets: ParsedSheet[];
}

/**
 * Parse an .xls Buffer into the same sheet model `readWorkbook` returns, so
 * `sheetToMatrix` and everything downstream need no second code path.
 */
export function readXls(buf: Buffer): XlsWorkbook {
  const cfb = openCfb(buf);
  const name = ['Workbook', 'WORKBOOK'].find((n) => cfb.names.has(n));
  if (!name) {
    if (cfb.names.has('Book')) throw new Error('不支持 Excel 95 及更早的 .xls（BIFF5），请另存为 .xlsx');
    throw new Error('not an xls: no Workbook stream');
  }
  const stream = cfb.read(name);

  const globals = substream(stream, 0);
  const bof = globals[0];
  if (!bof || bof.type !== R.BOF || bof.data.readUInt16LE(0) !== 0x0600) {
    throw new Error('不支持 Excel 95 及更早的 .xls（BIFF5），请另存为 .xlsx');
  }

  let sst: string[] = [];
  const bound: Array<{ name: string; pos: number; state: string }> = [];
  for (const rec of globals) {
    if (rec.type === R.FILEPASS) throw new Error('.xls 已加密，无法读取；请去掉密码后再上传');
    if (rec.type === R.SST) sst = readSst(rec);
    else if (rec.type === R.BOUNDSHEET) {
      const d = rec.data;
      // Only worksheets carry cells; chart and macro sheets are skipped.
      if (d[5] !== 0x00) continue;
      const c = new Cursor([d]);
      c.pos = 6;
      const cch = c.u8();
      bound.push({
        name: c.unicodeString(cch),
        pos: d.readUInt32LE(0),
        state: ['visible', 'hidden', 'veryHidden'][d[4] & 3] || 'visible',
      });
    }
  }

  const sheets: ParsedSheet[] = bound.map((b, idx) => {
    const cells: ParsedCell[] = [];
    let maxRow = 0,
      maxCol = 0;
    const put = (
      row0: number,
      col0: number,
      xf: number,
      value: ParsedCell['value'],
      type: string,
      hasFormula = false,
    ): void => {
      const row = row0 + 1,
        col = col0 + 1;
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
      cells.push({ ref: cellRef(col, row), col, row, type, value, formula: null, styleIndex: xf, hasFormula });
    };

    const recs = substream(stream, b.pos);
    for (let i = 0; i < recs.length; i++) {
      const { type, data: d } = recs[i];
      if (d.length < 6) continue;
      switch (type) {
        case R.LABELSST:
          put(d.readUInt16LE(0), d.readUInt16LE(2), d.readUInt16LE(4), sst[d.readUInt32LE(6)] ?? '', 's');
          break;
        case R.LABEL: {
          const c = new Cursor([d, ...recs[i].cont]);
          c.pos = 6;
          put(d.readUInt16LE(0), d.readUInt16LE(2), d.readUInt16LE(4), c.unicodeString(c.u16()), 's');
          break;
        }
        case R.NUMBER:
          put(d.readUInt16LE(0), d.readUInt16LE(2), d.readUInt16LE(4), d.readDoubleLE(6), 'n');
          break;
        case R.RK:
          put(d.readUInt16LE(0), d.readUInt16LE(2), d.readUInt16LE(4), decodeRk(d.readUInt32LE(6)), 'n');
          break;
        case R.MULRK: {
          const row = d.readUInt16LE(0);
          const first = d.readUInt16LE(2);
          const n = (d.length - 6) / 6;
          for (let k = 0; k < n; k++) {
            const o = 4 + k * 6;
            put(row, first + k, d.readUInt16LE(o), decodeRk(d.readUInt32LE(o + 2)), 'n');
          }
          break;
        }
        case R.BOOLERR: {
          const v = d[6],
            isErr = d[7];
          if (isErr) put(d.readUInt16LE(0), d.readUInt16LE(2), d.readUInt16LE(4), { error: ERRORS[v] || '#N/A' }, 'e');
          else put(d.readUInt16LE(0), d.readUInt16LE(2), d.readUInt16LE(4), v !== 0, 'b');
          break;
        }
        case R.FORMULA: {
          const row = d.readUInt16LE(0),
            col = d.readUInt16LE(2),
            xf = d.readUInt16LE(4);
          if (d.readUInt16LE(12) !== 0xffff) {
            put(row, col, xf, d.readDoubleLE(6), 'n', true);
            break;
          }
          const kind = d[6];
          if (kind === 0) {
            // A string result lives in the STRING record that follows.
            const s = recs[i + 1];
            if (s && s.type === R.STRING) {
              const c = new Cursor([s.data, ...s.cont]);
              put(row, col, xf, c.unicodeString(c.u16()), 's', true);
              i++;
            }
          } else if (kind === 1) put(row, col, xf, d[8] !== 0, 'b', true);
          else if (kind === 2) put(row, col, xf, { error: ERRORS[d[8]] || '#N/A' }, 'e', true);
          else put(row, col, xf, '', 's', true);
          break;
        }
        default:
          break;
      }
    }

    return {
      name: b.name || `Sheet${idx + 1}`,
      sheetId: String(idx + 1),
      state: b.state,
      rId: null,
      path: null,
      cells,
      merges: [],
      cols: [],
      dimensions: null,
      maxRow,
      maxCol,
    };
  });

  return { sheets };
}
