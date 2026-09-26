'use strict';
/**
 * 对照 pristine node.exe 与注入后的 app.exe：
 *  1. fuse 的完整 48 字符（含状态位）
 *  2. 第一处字节差异
 *  3. 文件尾部/blob 区域发生了什么
 */

const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2] || path.join(process.env.TEMP, 'sea-verify');
const FUSE_LEN = 48;

function fuseInfo(file) {
  const buf = fs.readFileSync(file);
  const idx = buf.indexOf('NODE_SEA_FUSE', 0, 'ascii');
  const full = idx >= 0 ? buf.subarray(idx, idx + FUSE_LEN).toString('ascii') : null;
  return { size: buf.length, fuseAt: idx, fuse: full, buf };
}

const p = fuseInfo(path.join(dir, 'pristine.exe'));
const a = fuseInfo(path.join(dir, 'app.exe'));

console.log('===== fuse =====');
console.log('pristine: at=0x' + p.fuseAt.toString(16) + '  [' + p.fuse + ']');
console.log('injected: at=0x' + a.fuseAt.toString(16) + '  [' + a.fuse + ']');
console.log('fuse identical: ' + (p.fuse === a.fuse));

console.log('\n===== size =====');
console.log('pristine = ' + p.size + ' bytes');
console.log('injected = ' + a.size + ' bytes');
console.log('delta    = ' + (a.size - p.size) + ' bytes');

console.log('\n===== first differing byte =====');
const lim = Math.min(p.size, a.size);
let first = -1;
for (let i = 0; i < lim; i++) {
  if (p.buf[i] !== a.buf[i]) { first = i; break; }
}
if (first < 0) {
  console.log('no difference in first ' + lim + ' bytes');
} else {
  console.log('at 0x' + first.toString(16) + ' (' + first + ')');
  const hex = (b, o, n) => Array.from(b.subarray(o, o + n)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
  console.log('  pristine: ' + hex(p.buf, first, 24));
  console.log('  injected: ' + hex(a.buf, first, 24));
  const blobAt = p.buf.indexOf('NODE_SEA_BLOB', 0, 'ascii');
  console.log('  NODE_SEA_BLOB string sits at 0x' + blobAt.toString(16) + ', fuse at 0x' + p.fuseAt.toString(16));
}

console.log('\n===== what is at the very end of each file =====');
const tail = (b, n) => Array.from(b.subarray(b.length - n)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
console.log('pristine tail16: ' + tail(p.buf, 16));
console.log('injected tail16: ' + tail(a.buf, 16));

console.log('\n===== does the injected file carry the blob magic? =====');
for (const magic of ['MSBLOB', 'NODE_SEA_BLOB']) {
  const inP = p.buf.indexOf(magic, 0, 'ascii') >= 0;
  const inA = a.buf.indexOf(magic, 0, 'ascii') >= 0;
  console.log('  ' + magic.padEnd(16) + ' pristine=' + inP + '  injected=' + inA);
}
