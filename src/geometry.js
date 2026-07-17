// Shared export geometry: turns voxel cells into the printable triangle mesh
// used by BOTH the STL and 3MF exporters, so they can never drift apart.
//
// Produces the OUTER SKIN only — faces shared between two blocks are culled,
// so a stack of blocks becomes one sealed hollow-able solid (no per-block
// internal walls), exactly what a slicer expects. Any partial/sloped face is
// always kept, so the surface stays watertight.
//
// Coordinates: game space is y-up (three.js); printers are z-up. We rotate
// (x, y, z) -> (x, -z, y) (a proper rotation, det +1, so winding/normals are
// preserved) and translate into the positive octant sitting on Z = 0.

import { shapeTriangles, coversFace, DIRS } from './shapes.js';
import { SHAPE_CUBE } from './world.js';

const OPPOSITE = [1, 0, 3, 2, 5, 4]; // opposite DIRS index

// If all three vertices of a unit-cell triangle lie on one axis-aligned cell
// face, return that face's DIRS index; else -1.
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

/**
 * Build the exterior triangle mesh for a set of voxel cells.
 * @param {Array} cells - rows [x, y, z, color, shape?, rot?]
 * @param {number} mm - edge length of one block in millimeters
 * @returns {{ triangles: Array<{v:number[][], color:number}>, min:number[] }}
 *   triangles: each has 3 z-up vertices (already scaled to mm, positive octant)
 *              and the palette color index of the block it came from.
 *   min: the pre-translation minimum corner (already applied to vertices).
 */
export function buildMesh(cells, mm) {
  const at = new Map();
  for (const [x, y, z, , s = SHAPE_CUBE, r = 0] of cells) {
    at.set(`${x},${y},${z}`, { s, r });
  }

  // Collect exterior triangles in game space with their source color.
  const gameTris = [];
  for (const [x, y, z, color = 0, s = SHAPE_CUBE, r = 0] of cells) {
    const hidden = [false, false, false, false, false, false];
    for (let d = 0; d < 6; d++) {
      if (!coversFace(s, r, d)) continue;
      const [dx, dy, dz] = DIRS[d];
      const nb = at.get(`${x + dx},${y + dy},${z + dz}`);
      if (nb && coversFace(nb.s, nb.r, OPPOSITE[d])) hidden[d] = true;
    }
    for (const tri of shapeTriangles(s, r)) {
      const d = faceOfTriangle(tri);
      if (d >= 0 && hidden[d]) continue;
      gameTris.push({
        v: tri.map(([cx, cy, cz]) => [x + cx, y + cy, z + cz]),
        color,
      });
    }
  }

  // Rotate to z-up, track bounds.
  const min = [Infinity, Infinity, Infinity];
  const rotated = gameTris.map(({ v, color }) => {
    const rv = v.map(([gx, gy, gz]) => {
      const p = [gx, -gz, gy];
      for (let i = 0; i < 3; i++) if (p[i] < min[i]) min[i] = p[i];
      return p;
    });
    return { v: rv, color };
  });
  if (!isFinite(min[0])) { min[0] = min[1] = min[2] = 0; }

  // Translate to positive octant and scale to mm.
  const triangles = rotated.map(({ v, color }) => ({
    v: v.map((p) => [(p[0] - min[0]) * mm, (p[1] - min[1]) * mm, (p[2] - min[2]) * mm]),
    color,
  }));

  return { triangles, min };
}
