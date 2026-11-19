// news-image-20261118 entry (Node 22, standard library only).
//
// The entry is a single picture: entry.png beside this file, a newspaper
// front page that sums up Wednesday 18 November 2026. This program checks
// the picture against the competition gate (PNG or JPEG, at most 1 MiB,
// at most 1024 x 1024 pixels) and then publishes it to the output
// directory as entry.png, so the judge sees exactly those bytes.
//
// Run locally with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// In the grader's container the output directory is /output.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT_BYTES = 1024 * 1024;
const LIMIT_SIDE = 1024;

function die(message: string): never {
  console.error(`news-image-20261118: ${message}`);
  process.exit(1);
}

// The two formats the gate takes, told apart by their first bytes.
function formatOf(bytes: Buffer): 'png' | 'jpeg' {
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (png) return 'png';
  if (jpeg) return 'jpeg';
  return die('entry.png starts with neither the PNG nor the JPEG magic bytes');
}

// CRC-32 (the PNG chunk checksum, polynomial 0xedb88320), table-driven.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Dimensions and wholeness for a PNG: the full signature, then chunks that
// each fit in the file and pass their checksum, IHDR first, and the file
// ending exactly at IEND. The gate takes only a whole image ("every PNG
// chunk with its checksum and the image data its header describes"), so a
// file that is truncated or corrupt is refused here with the place named,
// instead of reaching the grader with its header alone looking fine.
function inspectPng(bytes: Buffer): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < signature.length || signature.some((b, i) => bytes[i] !== b)) {
    return die('entry.png has a truncated or corrupt PNG signature');
  }
  let at = signature.length;
  let first = true;
  let dims: { width: number; height: number } | null = null;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) {
      return die(`entry.png ends inside a PNG chunk header at offset ${at} (truncated)`);
    }
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const dataEnd = at + 8 + length;
    if (dataEnd + 4 > bytes.length) {
      return die(`entry.png ends inside the PNG ${type} chunk at offset ${at} (truncated)`);
    }
    if (bytes.readUInt32BE(dataEnd) !== crc32(bytes.subarray(at + 4, dataEnd))) {
      return die(`entry.png PNG ${type} chunk at offset ${at} fails its checksum`);
    }
    if (first) {
      if (type !== 'IHDR' || length !== 13) {
        return die(`entry.png PNG starts with a ${type} chunk, not the IHDR header`);
      }
      dims = { width: bytes.readUInt32BE(at + 8), height: bytes.readUInt32BE(at + 12) };
      first = false;
    }
    at = dataEnd + 4;
    if (type === 'IEND') {
      if (at !== bytes.length) return die('entry.png has trailing bytes after the PNG IEND chunk');
      return dims!;
    }
  }
  return die('entry.png has no PNG IEND chunk (truncated)');
}

// Dimensions and wholeness for a JPEG: walk the segments from the SOI
// marker to the end-of-image marker the gate asks for ("every JPEG
// segment through to its end marker"). Standalone markers (TEM, restarts,
// SOI again) carry no length field and are stepped over; 0xff padding
// before a marker is skipped; every length-prefixed segment must fit in
// the file; and the entropy-coded data after a start of scan is scanned
// for the next real marker, stepping over stuffed 0xff00 bytes and
// restart markers. A file that runs out mid-segment or never reaches the
// end marker is truncated, and the error says where.
function inspectJpeg(bytes: Buffer): { width: number; height: number } {
  let dims: { width: number; height: number } | null = null;
  let at = 2; // past the SOI marker formatOf already matched
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) {
      return die(`entry.png has a corrupt JPEG segment walk at offset ${at}`);
    }
    let pos = at + 1;
    while (pos < bytes.length && bytes[pos] === 0xff) pos++; // padding
    if (pos >= bytes.length) break;
    const marker = bytes[pos];
    if (marker === 0x00) {
      return die(`entry.png has a stray stuffed byte outside JPEG scan data at offset ${at}`);
    }
    if (marker === 0xd9) { // EOI, the end marker
      if (!dims) return die('entry.png reaches the JPEG end marker with no start of frame');
      return dims;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at = pos + 1; // standalone marker: no length field to step over
      continue;
    }
    if (pos + 3 > bytes.length) {
      return die(`entry.png ends inside the JPEG segment at offset ${at} (truncated)`);
    }
    const length = bytes.readUInt16BE(pos + 1);
    if (length < 2) {
      return die(`entry.png has an invalid JPEG segment length ${length} at offset ${at}`);
    }
    const segEnd = pos + 1 + length;
    if (segEnd > bytes.length) {
      return die(
        `entry.png ends inside the JPEG segment 0xff${marker.toString(16)} at offset ${at}: ` +
        `it declares ${length} bytes and only ${bytes.length - pos - 1} remain (truncated)`);
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (length < 7) return die(`entry.png has a short JPEG frame segment at offset ${at}`);
      dims = { height: bytes.readUInt16BE(pos + 4), width: bytes.readUInt16BE(pos + 6) };
    }
    at = segEnd;
    if (marker === 0xda) { // start of scan: entropy data runs to the next real marker
      let scan = at;
      at = -1;
      while (scan + 1 < bytes.length) {
        if (bytes[scan] !== 0xff) { scan++; continue; }
        const next = bytes[scan + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { scan += 2; continue; }
        if (next === 0xff) { scan++; continue; }
        at = scan;
        break;
      }
      if (at < 0) break; // no further marker anywhere: the file is truncated
    }
  }
  return die('entry.png has no JPEG end-of-image marker (truncated)');
}

// Pixel dimensions, read from the image itself, with the whole file
// checked on the way: PNG stores them in the IHDR chunk right after the
// signature; JPEG stores them in a start of frame segment.
function dimensionsOf(bytes: Buffer, format: 'png' | 'jpeg'): { width: number; height: number } {
  return format === 'png' ? inspectPng(bytes) : inspectJpeg(bytes);
}

const picture = readFileSync(new URL('./entry.png', import.meta.url));
if (picture.length > LIMIT_BYTES) {
  die(`entry.png is ${picture.length} bytes, over the ${LIMIT_BYTES} byte limit`);
}
const format = formatOf(picture);
const { width, height } = dimensionsOf(picture, format);
if (width > LIMIT_SIDE || height > LIMIT_SIDE) {
  die(`entry.png is ${width}x${height}, over the ${LIMIT_SIDE}x${LIMIT_SIDE} limit`);
}

// Publish through a temp file in the same directory and rename it over the
// target, so a grader never reads a half-written entry.png.
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
const target = join(outDir, 'entry.png');
const staging = join(outDir, `.entry.png.staging-${process.pid}`);
try {
  const fd = openSync(staging, 'w');
  try {
    writeSync(fd, picture);
    fsyncSync(fd); // the bytes are on disk before the rename makes them the entry
  } finally {
    closeSync(fd);
  }
  renameSync(staging, target);
  // Best effort: flush the directory too, so the rename itself survives a
  // crash. Some filesystems refuse a directory fsync; the rename is
  // already atomic there, so a refusal is not a failure.
  try {
    const dirFd = openSync(outDir, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* directory fsync unsupported: the file fsync above still holds */ }
} catch (err) {
  rmSync(staging, { force: true });
  throw err;
}
console.log(`published ${format} ${width}x${height}, ${picture.length} bytes, to ${target}`);
