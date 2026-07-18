// Shared export geometry: turns voxel cells into the printable triangle mesh
// used by BOTH the STL and 3MF exporters, so they can never drift apart.
//
// Faces shared between two SAME-SIZE, exactly-facing blocks are culled, so a
// stack of blocks becomes one sealed hollow-able solid (no per-block internal
// walls). Where different sizes touch (a half block on a full block), both
// blocks keep their full closed shells — the two coincident walls overlap,
// which slicers treat as a union of solids, and every individual shell stays
// watertight.
//
// Coordinates: game space is y-up (three.js); printers are z-up. We rotate
// (x, y, z) -> (x, -z, y) (a proper rotation, det +1, so winding/normals are
// preserved) and translate into the positive octant sitting on Z = 0.

import { shapeTriangles, coversFace, DIRS } from './shapes.js';
import { SHAPE_CUBE, Q } from './world.js';

const OPPOSITE = [1, 0, 3, 2, 5, 4]; // opposite DIRS index

// Accept both row formats (see world.toArray): legacy rows in FULL-block
// units ([x, y, z, c] / [x, y, z, c, s, r]) and 7-element rows in QUARTER
// units [qx, qy, qz, c, s, r, g]. Returns blocks in quarter units.
function normalizeCells(cells) {
  const out = [];
  for (const row of cells) {
    if (row.length >= 7) {
      const [x, y, z, c = 0, s = SHAPE_CUBE, r = 0, g] = row;
      out.push({ x, y, z, c, s, r, g: g === 1 || g === 2 ? g : Q });
    } else {
      const [x, y, z, c = 0, s = SHAPE_CUBE, r = 0] = row;
      out.push({ x: x * Q, y: y * Q, z: z * Q, c, s, r, g: Q });
    }
  }
  return out;
}

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
 * @param {Array} cells - rows [x, y, z, color, shape?, rot?] (block units) or
 *                        [qx, qy, qz, color, shape, rot, g] (quarter units)
 * @param {number} mm - edge length of one FULL block in millimeters
 * @returns {{ triangles: Array<{v:number[][], color:number}>, min:number[] }}
 *   triangles: each has 3 z-up vertices (already scaled to mm, positive octant)
 *              and the palette color index of the block it came from.
 *   min: the pre-translation minimum corner (already applied to vertices).
 */
export function buildMesh(cells, mm) {
  const blocks = normalizeCells(cells);
  const at = new Map();
  for (const b of blocks) {
    at.set(`${b.x},${b.y},${b.z}`, b);
  }

  // Collect exterior triangles in game space (block units) with their color.
  const gameTris = [];
  for (const { x, y, z, c: color, s, r, g } of blocks) {
    // A face is hidden only when a SAME-SIZE block sits exactly across it
    // with a full face of its own — the two faces coincide precisely, so
    // culling both leaves a sealed seam. (Mismatched sizes keep both shells.)
    const hidden = [false, false, false, false, false, false];
    for (let d = 0; d < 6; d++) {
      if (!coversFace(s, r, d)) continue;
      const [dx, dy, dz] = DIRS[d];
      const nb = at.get(`${x + dx * g},${y + dy * g},${z + dz * g}`);
      if (nb && nb.g === g && coversFace(nb.s, nb.r, OPPOSITE[d])) hidden[d] = true;
    }
    const scale = g / Q; // block units
    for (const tri of shapeTriangles(s, r)) {
      const d = faceOfTriangle(tri);
      if (d >= 0 && hidden[d]) continue;
      gameTris.push({
        v: tri.map(([cx, cy, cz]) => [x / Q + cx * scale, y / Q + cy * scale, z / Q + cz * scale]),
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
