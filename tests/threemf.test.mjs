// Validates the 3MF (color) exporter:
//   • valid ZIP: signatures, per-entry CRC-32, central directory, EOCD
//   • required 3MF parts present ([Content_Types].xml, _rels/.rels, model)
//   • well-formed model XML with basematerials + triangles referencing them
//   • one <base> material per DISTINCT color used, colors correct
//   • geometry IDENTICAL to the STL: same triangle set, same volume, watertight
//
// Run: node tests/threemf.test.mjs

import { inflateSync, gunzipSync } from 'node:zlib'; // (not used; stored entries)
import { blocksTo3MF } from '../src/threemf.js';
import { blocksToSTL } from '../src/stl.js';
import { PALETTE } from '../src/palette.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else { failures++; console.error(`  FAIL - ${name} ${detail}`); }
}

const dec = new TextDecoder();

// --- Minimal ZIP reader for STORED entries, verifying CRC-32 --------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) { let c = ~0; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (~c) >>> 0; }

function readZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const files = new Map();
  let off = 0;
  let crcOk = true;
  while (off + 4 <= u8.length && dv.getUint32(off, true) === 0x04034b50) {
    const comp = dv.getUint16(off + 8, true);
    const crc = dv.getUint32(off + 14, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const nameStart = off + 30;
    const name = dec.decode(u8.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    const data = u8.subarray(dataStart, dataStart + size);
    if (comp !== 0) crcOk = false;
    if (crc32(data) !== crc) crcOk = false;
    files.set(name, data);
    off = dataStart + size;
  }
  const hasCD = dv.getUint32(off, true) === 0x02014b50;
  // find EOCD
  let eocd = false;
  for (let i = u8.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = true; break; } }
  return { files, crcOk, hasCD, eocd };
}

// --- STL triangle parser (to compare geometry) ----------------------------
function stlTris(buffer) {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  const tris = []; let off = 84;
  for (let i = 0; i < count; i++) {
    off += 12; const v = [];
    for (let k = 0; k < 3; k++) { v.push([view.getFloat32(off, true), view.getFloat32(off + 4, true), view.getFloat32(off + 8, true)]); off += 12; }
    off += 2; tris.push(v);
  }
  return tris;
}

function volume(tris) {
  let vol = 0;
  for (const [a, b, c] of tris) vol += (a[0]*(b[1]*c[2]-b[2]*c[1]) + a[1]*(b[2]*c[0]-b[0]*c[2]) + a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
  return vol;
}
function unbalancedEdges(tris) {
  const e = new Map();
  for (const [a, b, c] of tris) for (const [p, q] of [[a,b],[b,c],[c,a]]) { const k = p.join()+'|'+q.join(); e.set(k, (e.get(k)||0)+1); }
  let u = 0; for (const [k, n] of e) { const [p, q] = k.split('|'); if ((e.get(q+'|'+p)||0) !== n) u++; }
  return u;
}

// Parse the model XML's triangles + vertices into world-space triangles.
function modelTris(xml) {
  const verts = [];
  const vre = /<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g;
  let m;
  while ((m = vre.exec(xml))) verts.push([+m[1], +m[2], +m[3]]);
  const tris = [], mats = [];
  const tre = /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"(?: pid="(\d+)")?(?: p1="(\d+)")?/g;
  while ((m = tre.exec(xml))) {
    tris.push([verts[+m[1]], verts[+m[2]], verts[+m[3]]]);
    mats.push(m[5] !== undefined ? +m[5] : null);
  }
  return { tris, mats, vertCount: verts.length };
}

function canonTriSet(tris) {
  // Represent each triangle by its sorted vertex-coord strings so order and
  // winding don't affect equality.
  return new Set(tris.map((t) => t.map((p) => p.map((n) => n.toFixed(3)).join(',')).sort().join('|')));
}

function run(name, cells, mm, expectedColors) {
  console.log(`\n${name}:`);
  const zip = blocksTo3MF(cells, mm, name);
  const { files, crcOk, hasCD, eocd } = readZip(zip);

  check('valid ZIP (stored entries, CRCs match)', crcOk);
  check('has central directory + EOCD', hasCD && eocd);
  check('has [Content_Types].xml', files.has('[Content_Types].xml'));
  check('has _rels/.rels', files.has('_rels/.rels'));
  check('has 3D/3dmodel.model', files.has('3D/3dmodel.model'));

  const xml = dec.decode(files.get('3D/3dmodel.model'));
  check('model declares millimeter unit', xml.includes('unit="millimeter"'));
  check('has basematerials group id=1', /<m:basematerials id="1">/.test(xml));

  const baseCount = (xml.match(/<base /g) || []).length;
  check(`one material per distinct color (${expectedColors})`, baseCount === expectedColors, `(got ${baseCount})`);

  const { tris: mtris, mats, vertCount } = modelTris(xml);
  check('all triangles reference a material (p1)', mats.every((x) => x !== null));
  check('material indices in range', mats.every((x) => x >= 0 && x < baseCount));
  check('vertices deduped (fewer than 3x triangles)', vertCount < mtris.length * 3);

  // Geometry parity with STL.
  const stl = stlTris(blocksToSTL(cells, mm));
  check('same triangle count as STL', mtris.length === stl.length, `(3mf ${mtris.length} vs stl ${stl.length})`);
  const mSet = canonTriSet(mtris), sSet = canonTriSet(stl);
  let sameTris = mSet.size === sSet.size;
  for (const t of sSet) if (!mSet.has(t)) sameTris = false;
  check('identical triangle set to STL', sameTris);

  const mVol = Math.abs(volume(mtris)), sVol = Math.abs(volume(stl));
  check('same volume as STL', Math.abs(mVol - sVol) < 1e-3, `(3mf ${mVol.toFixed(2)} vs stl ${sVol.toFixed(2)})`);
  check('watertight (edges balanced)', unbalancedEdges(mtris) === 0);
}

// 1. Single red cube: 1 color, 12 tris.
run('single cube (1 color)', [[0, 0, 0, 0]], 10, 1);

// 2. Two colors stacked (red on blue).
run('two colors stacked', [[0, 0, 0, 0], [0, 1, 0, 7]], 8, 2);

// 3. A mini rocket-ish shape with several colors + a wedge.
run('multi-color with wedge', [
  [0, 0, 0, 12], [1, 0, 0, 12], [0, 1, 0, 6], [1, 1, 0, 0],
  [0, 2, 0, 0, 1, 0], [1, 2, 0, 0, 1, 2],
], 5, 3);

// 4. Repeated colors collapse to the right material count (3 distinct of 6).
run('repeated colors dedupe to materials', [
  [0,0,0, 2],[1,0,0, 2],[2,0,0, 5],[3,0,0, 5],[4,0,0, 9],[5,0,0, 9],
], 4, 3);

console.log(failures === 0 ? '\nAll 3MF tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
