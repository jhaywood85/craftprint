// Generates the PWA / iOS app icons as PNG files with no external deps.
// Draws a friendly stack of colored blocks on a sky background, plus a
// maskable-safe padded variant. Run: node tools/make-icons.mjs
//
// PNG is written by hand (zlib is in Node core) so we don't pull in a canvas
// library. Icons are simple flat art, which encodes tiny.

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });

// --- minimal PNG encoder (truecolor + alpha) ------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- tiny drawing helpers --------------------------------------------------

function makeCanvas(size) {
  return { size, px: Buffer.alloc(size * size * 4) };
}
function set(cv, x, y, [r, g, b, a = 255]) {
  if (x < 0 || y < 0 || x >= cv.size || y >= cv.size) return;
  const i = (y * cv.size + x) * 4;
  // alpha over
  const na = a / 255, ia = 1 - na;
  cv.px[i]   = Math.round(r * na + cv.px[i] * ia);
  cv.px[i+1] = Math.round(g * na + cv.px[i+1] * ia);
  cv.px[i+2] = Math.round(b * na + cv.px[i+2] * ia);
  cv.px[i+3] = Math.max(cv.px[i+3], a);
}
function fillBg(cv, top, bottom) {
  for (let y = 0; y < cv.size; y++) {
    const t = y / (cv.size - 1);
    const c = top.map((v, i) => Math.round(v + (bottom[i] - v) * t));
    for (let x = 0; x < cv.size; x++) set(cv, x, y, [...c, 255]);
  }
}
function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
// A pseudo-3D block (top face + two sides) drawn in isometric-ish style.
function block(cv, cx, cy, s, color) {
  const [r, g, b] = hex(color);
  const top = [Math.min(255, r + 40), Math.min(255, g + 40), Math.min(255, b + 40)];
  const left = [r, g, b];
  const right = [Math.round(r * 0.72), Math.round(g * 0.72), Math.round(b * 0.72)];
  const h = s * 0.5;   // half width
  const dz = s * 0.28; // vertical offset for the "3D" faces
  // Top face: a diamond.
  for (let y = -h; y <= h; y++) {
    const w = h - Math.abs(y);
    for (let x = -w; x <= w; x++) set(cv, Math.round(cx + x), Math.round(cy + y * 0.5), [...top, 255]);
  }
  // Left and right side faces (parallelograms) below the diamond's lower edges.
  for (let x = 0; x <= h; x++) {
    const topY = cy + (h - x) * 0.5;
    for (let d = 0; d < dz + (h - x) * 0.0; d++) set(cv, Math.round(cx - x), Math.round(topY + d), [...left, 255]);
    for (let d = 0; d < dz; d++) set(cv, Math.round(cx - x), Math.round(topY + d), [...left, 255]);
  }
  for (let x = 0; x <= h; x++) {
    const topY = cy + (h - x) * 0.5;
    for (let d = 0; d < dz; d++) set(cv, Math.round(cx + x), Math.round(topY + d), [...right, 255]);
  }
}

function draw(size, pad) {
  const cv = makeCanvas(size);
  fillBg(cv, hex('#9fdcff'), hex('#4fc3f7'));
  // Rounded-ish vignette corners for non-maskable niceness handled by iOS mask;
  // we just draw art centered with `pad` breathing room.
  const inner = size * (1 - pad * 2);
  const u = inner / 2.3;           // block unit
  const cx = size / 2;
  const baseY = size * 0.56;
  // A little pyramid of three blocks: two on the bottom, one on top.
  block(cv, cx - u * 0.52, baseY, u, '#ff5252');
  block(cv, cx + u * 0.52, baseY, u, '#37c871');
  block(cv, cx, baseY - u * 0.62, u, '#ffd93d');
  return encodePNG(size, size, cv.px);
}

const OUT = new URL('../icons/', import.meta.url);
// Standard PWA icons (some breathing room), plus maskable (more padding),
// plus the iOS apple-touch-icon (no transparency, modest padding).
const jobs = [
  ['icon-192.png', 192, 0.12],
  ['icon-512.png', 512, 0.12],
  ['icon-maskable-512.png', 512, 0.22],
  ['apple-touch-icon.png', 180, 0.1],
];
for (const [name, size, pad] of jobs) {
  writeFileSync(new URL(name, OUT), draw(size, pad));
  console.log('wrote icons/' + name);
}
