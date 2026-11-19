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

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

// Pixel dimensions, read from the image header itself: PNG stores them in
// the IHDR chunk right after the signature; JPEG stores them in a start of
// frame segment, found by walking the segment lengths from the SOI marker.
function dimensionsOf(bytes: Buffer, format: 'png' | 'jpeg'): { width: number; height: number } {
  if (format === 'png') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return die('entry.png has a corrupt JPEG segment walk');
    const marker = bytes[at + 1];
    const length = bytes.readUInt16BE(at + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return die('entry.png has no JPEG start of frame segment');
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
  writeFileSync(staging, picture);
  renameSync(staging, target);
} catch (err) {
  rmSync(staging, { force: true });
  throw err;
}
console.log(`published ${format} ${width}x${height}, ${picture.length} bytes, to ${target}`);
