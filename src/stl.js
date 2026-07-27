// Binary STL export. Uses the shared buildMesh() so its geometry is identical
// to the 3MF export. Pure module (no three.js) so it can be unit-tested.
//
// STL carries geometry only (no color) — a single solid, watertight, Z-up,
// sitting on the print bed at the origin.

import { buildMesh } from './geometry.js';

/**
 * @param {Array} cells - rows [x, y, z, color, shape?, rot?]
 * @param {number} mm - edge length of one block, in millimeters
 * @param {{bevelMM?: number}} [opts] - soft-edges bevel width (see buildMesh)
 * @returns {ArrayBuffer} binary STL file contents
 */
export function blocksToSTL(cells, mm, opts) {
  const { triangles } = buildMesh(cells, mm, opts);

  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);

  // 80-byte header (must not start with "solid" or some parsers assume ASCII).
  const header = 'CraftPrint binary STL - built with love by a kid';
  for (let i = 0; i < Math.min(header.length, 80); i++) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(80, triangles.length, true);

  let offset = 84;
  for (const { v: [a, b, c] } of triangles) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = u[1] * w[2] - u[2] * w[1];
    let ny = u[2] * w[0] - u[0] * w[2];
    let nz = u[0] * w[1] - u[1] * w[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(offset, nx / len, true);
    view.setFloat32(offset + 4, ny / len, true);
    view.setFloat32(offset + 8, nz / len, true);
    offset += 12;
    for (const p of [a, b, c]) {
      view.setFloat32(offset, p[0], true);
      view.setFloat32(offset + 4, p[1], true);
      view.setFloat32(offset + 8, p[2], true);
      offset += 12;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }

  return buffer;
}
