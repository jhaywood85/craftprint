// Binary STL export for a set of voxel cells (cubes and wedges).
// Pure module (no three.js) so it can be unit-tested in Node.
//
// Game space is y-up (three.js); printers are z-up. We rotate
// (x, y, z) -> (x, -z, y), which is a proper rotation (det +1), so face
// winding and outward normals are preserved. The model is then translated
// so it sits in the positive octant with its bottom on Z = 0 (the print bed).
//
// Face culling: a block face is dropped only when this block fully covers its
// unit face AND the neighbor fully covers the touching face. Any partial or
// sloped face is always emitted, so the surface stays closed and watertight.

import { shapeTriangles, coversFace, DIRS } from './shapes.js';
import { SHAPE_CUBE } from './world.js';

const OPPOSITE = [1, 0, 3, 2, 5, 4]; // opposite DIRS index

/**
 * @param {Array} cells - rows [x, y, z, color, shape?, rot?]; color unused here
 * @param {number} mm - edge length of one block, in millimeters
 * @returns {ArrayBuffer} binary STL file contents
 */
export function blocksToSTL(cells, mm) {
  // Index cells by position, keeping shape/rot for neighbor tests.
  const at = new Map();
  for (const [x, y, z, , s = SHAPE_CUBE, r = 0] of cells) {
    at.set(`${x},${y},${z}`, { s, r });
  }

  // Collect triangles in game space (still y-up, unscaled).
  const gameTris = [];
  for (const [x, y, z, , s = SHAPE_CUBE, r = 0] of cells) {
    // Which whole faces of this block are hidden by a covering neighbor?
    const hidden = [false, false, false, false, false, false];
    for (let d = 0; d < 6; d++) {
      if (!coversFace(s, r, d)) continue; // partial/sloped faces never cull
      const [dx, dy, dz] = DIRS[d];
      const nb = at.get(`${x + dx},${y + dy},${z + dz}`);
      if (nb && coversFace(nb.s, nb.r, OPPOSITE[d])) hidden[d] = true;
    }

    for (const tri of shapeTriangles(s, r)) {
      // Skip a triangle only if it lies flat on a fully-hidden face.
      const d = faceOfTriangle(tri);
      if (d >= 0 && hidden[d]) continue;
      gameTris.push(tri.map(([cx, cy, cz]) => [x + cx, y + cy, z + cz]));
    }
  }

  // Rotate to z-up and find bounds for the positive-octant translation.
  const min = [Infinity, Infinity, Infinity];
  const rotated = gameTris.map((tri) =>
    tri.map(([gx, gy, gz]) => {
      const p = [gx, -gz, gy];
      for (let i = 0; i < 3; i++) if (p[i] < min[i]) min[i] = p[i];
      return p;
    })
  );

  const triCount = rotated.length;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);

  // 80-byte header (must not start with "solid" or some parsers assume ASCII).
  const header = 'CraftPrint binary STL - built with love by a kid';
  for (let i = 0; i < Math.min(header.length, 80); i++) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(80, triCount, true);

  let offset = 84;
  for (const [a, b, c] of rotated) {
    // Face normal from the (CCW) triangle itself.
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = u[1] * v[2] - u[2] * v[1];
    let ny = u[2] * v[0] - u[0] * v[2];
    let nz = u[0] * v[1] - u[1] * v[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(offset, nx / len, true);
    view.setFloat32(offset + 4, ny / len, true);
    view.setFloat32(offset + 8, nz / len, true);
    offset += 12;
    for (const p of [a, b, c]) {
      view.setFloat32(offset, (p[0] - min[0]) * mm, true);
      view.setFloat32(offset + 4, (p[1] - min[1]) * mm, true);
      view.setFloat32(offset + 8, (p[2] - min[2]) * mm, true);
      offset += 12;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }

  return buffer;
}

// If all three vertices of a unit-cell triangle lie on a single axis-aligned
// cell face, return that face's DIRS index; else -1. Used to test a triangle
// against the hidden-face list.
function faceOfTriangle(tri) {
  const [a, b, c] = tri;
  if (a[0] === 1 && b[0] === 1 && c[0] === 1) return 0; // +X
  if (a[0] === 0 && b[0] === 0 && c[0] === 0) return 1; // -X
  if (a[1] === 1 && b[1] === 1 && c[1] === 1) return 2; // +Y
  if (a[1] === 0 && b[1] === 0 && c[1] === 0) return 3; // -Y
  if (a[2] === 1 && b[2] === 1 && c[2] === 1) return 4; // +Z
  if (a[2] === 0 && b[2] === 0 && c[2] === 0) return 5; // -Z
  return -1;
}
