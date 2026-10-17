'use strict';
/**
 * An image's pixel size, read from its header. Nothing else is decoded.
 */

/** Pixel dimensions, when the header could be read. */
interface ImageDimensions {
  width?: number;
  height?: number;
}

/** Read pixel dimensions from image headers — enough to describe an image. */
export function imageDimensions(buffer: Buffer, kind: string): ImageDimensions {
  try {
    if (kind === 'png' && buffer.length > 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if ((kind === 'jpeg' || kind === 'jpg') && buffer.length > 4) {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buffer[i + 1];
        const len = buffer.readUInt16BE(i + 2);
        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry dimensions.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
    if (kind === 'gif' && buffer.length > 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (kind === 'bmp' && buffer.length > 26) {
      return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
    }
  } catch {
    /* dimensions are best-effort */
  }
  return {};
}
