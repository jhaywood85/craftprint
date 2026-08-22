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
import { SHAPE_CUBE, SHAPE_ROUND, SHAPE_CURVE, ROUND_TO_CURVE, Q } from './world.js';

const OPPOSITE = [1, 0, 3, 2, 5, 4]; // opposite DIRS index

// Soft-edges bevel width in millimeters (a hair over one print layer). Small
// enough that a flat 45° chamfer prints identically to a true fillet.
export const SOFT_EDGE_MM = 0.3;

// --- Soft edges (tiny bevel along every exposed block edge) -----------------
//
// Rounds a convex shape by "erode then dilate": every face plane is offset
// inward by r (vertices re-solved from their three planes), then each face is
// pushed back out along its own normal. Faces keep their original planes but
// shrink by ~r; the gaps become 45° bevel strips along edges and small
// triangular facets at corners. Exact for convex solids — and every CraftPrint
// shape is convex. Each beveled block is an independent closed shell, so the
// export stays watertight.
//
// WELDING: a shell that merely touches its neighbor is structurally weak —
// slicers don't reliably bond coincident surfaces, and the groove would cut a
// snap line along every seam. So any face that is fully backed by solid
// neighbors is pushed PAST the block boundary by the bevel width: the shells
// genuinely interpenetrate and the slicer fuses them into one strong solid,
// while the grooves stay purely cosmetic on the outside surface.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// Solve n1·x = d1, n2·x = d2, n3·x = d3 (Cramer's rule); null if degenerate.
function solvePlanes(n1, d1, n2, d2, n3, d3) {
  const det = dot(n1, cross(n2, n3));
  if (Math.abs(det) < 1e-9) return null;
  const x = add(
    add(scl(cross(n2, n3), d1), scl(cross(n3, n1), d2)),
    scl(cross(n1, n2), d3)
  );
  return scl(x, 1 / det);
}

/**
 * Beveled triangles for a shape in unit-cell space. r is the bevel width in
 * unit-cell units (already scaled for the block's size by the caller).
 * welded is a 6-element boolean array (DIRS order): faces lying on those
 * cell boundaries are offset an extra r OUTWARD so they bury themselves in
 * the solid neighbor and the slicer fuses the blocks together.
 */
function bevelTriangles(shape, rot, r, welded = null) {
  const tris = shapeTriangles(shape, rot);

  // Offset magnitude for a face: bevel width, doubled for welded boundary
  // faces. A face belongs to welded direction i when its unit normal equals
  // DIRS[i] and its plane sits exactly on that cell boundary (n·p is 1 for
  // +axis faces, 0 for -axis faces).
  function faceOffset(n, d) {
    if (!welded) return r;
    for (let i = 0; i < 6; i++) {
      if (!welded[i]) continue;
      const D = DIRS[i];
      const dp = n[0] * D[0] + n[1] * D[1] + n[2] * D[2];
      const boundary = D[0] + D[1] + D[2] > 0 ? 1 : 0;
      if (dp > 0.9999 && Math.abs(d - boundary) < 1e-6) return r * 2;
    }
    return r;
  }
  const pk = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`;

  // Group triangles into planar faces.
  const faces = []; // { n, d, tris }
  const faceIds = new Map();
  for (const t of tris) {
    let n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
    const len = Math.hypot(...n) || 1;
    n = scl(n, 1 / len);
    const d = dot(n, t[0]);
    const k = `${n.map((v) => v.toFixed(4)).join()},${d.toFixed(4)}`;
    let fi = faceIds.get(k);
    if (fi === undefined) {
      fi = faces.length;
      faces.push({ n, d, tris: [] });
      faceIds.set(k, fi);
    }
    faces[fi].tris.push(t);
  }

  // Each vertex belongs to exactly three faces in every CraftPrint shape.
  const verts = new Map(); // pk -> { p, fs: Set<faceId> }
  faces.forEach((f, fi) => {
    for (const t of f.tris) {
      for (const p of t) {
        const k = pk(p);
        let v = verts.get(k);
        if (!v) { v = { p, fs: new Set() }; verts.set(k, v); }
        v.fs.add(fi);
      }
    }
  });

  // Eroded vertex = intersection of its three planes, each moved inward by r.
  const eroded = new Map();
  for (const [k, { p, fs }] of verts) {
    const [a, b, c] = [...fs];
    const x = c !== undefined
      ? solvePlanes(faces[a].n, faces[a].d - r, faces[b].n, faces[b].d - r, faces[c].n, faces[c].d - r)
      : null;
    eroded.set(k, x || p);
  }

  // Per-face offset vector: r along the normal for exposed faces, 2r for
  // welded boundary faces (which lands them r past the boundary, buried in
  // the neighbor). Using one consistent vector per face everywhere below
  // keeps the shell closed regardless of the mix.
  for (const f of faces) f.o = scl(f.n, faceOffset(f.n, f.d));

  const out = [];
  // Shrunken faces, pushed out along their normals.
  for (const f of faces) {
    for (const t of f.tris) {
      out.push(t.map((p) => add(eroded.get(pk(p)), f.o)));
    }
  }
  // Bevel strip per shape edge (a directed edge whose reverse lives on a
  // different face). Winding follows the face that owns the forward edge.
  const edgeFace = new Map();
  faces.forEach((f, fi) => {
    for (const t of f.tris) {
      for (let i = 0; i < 3; i++) {
        edgeFace.set(`${pk(t[i])}|${pk(t[(i + 1) % 3])}`, fi);
      }
    }
  });
  const done = new Set();
  for (const [k, f1] of edgeFace) {
    if (done.has(k)) continue;
    const [a, b] = k.split('|');
    const rk = `${b}|${a}`;
    const f2 = edgeFace.get(rk);
    if (f2 === undefined || f2 === f1) continue; // interior diagonal of a face
    done.add(k); done.add(rk);
    const A = eroded.get(a), B = eroded.get(b);
    // F1 owns the forward edge a→b and lies to its left (CCW from outside),
    // so the outward-facing strip runs F1-side → F2-side along A first.
    const o1 = faces[f1].o, o2 = faces[f2].o;
    out.push(
      [add(A, o1), add(A, o2), add(B, o2)],
      [add(A, o1), add(B, o2), add(B, o1)]
    );
  }
  // Corner facet per vertex, wound outward (positive triple product).
  for (const [k, { fs }] of verts) {
    if (fs.size < 3) continue;
    let [a, b, c] = [...fs];
    if (dot(faces[a].n, cross(faces[b].n, faces[c].n)) < 0) { const t = b; b = c; c = t; }
    const A = eroded.get(k);
    out.push([add(A, faces[a].o), add(A, faces[b].o), add(A, faces[c].o)]);
  }
  return out;
}

// Accept both row formats (see world.toArray): legacy rows in FULL-block
// units ([x, y, z, c] / [x, y, z, c, s, r]) and 7-element rows in QUARTER
// units [qx, qy, qz, c, s, r, g]. Returns blocks in quarter units.
function normalizeCells(cells) {
  const out = [];
  for (const row of cells) {
    let b;
    if (row.length >= 7) {
      const [x, y, z, c = 0, s = SHAPE_CUBE, r = 0, g] = row;
      b = { x, y, z, c, s, r, g: g === 1 || g === 2 ? g : Q };
    } else {
      const [x, y, z, c = 0, s = SHAPE_CUBE, r = 0] = row;
      b = { x: x * Q, y: y * Q, z: z * Q, c, s, r, g: Q };
    }
    // Legacy vertical-round blocks are the curve in a tipped orientation.
    if (b.s === SHAPE_ROUND) { b.r = ROUND_TO_CURVE[((b.r % 24) + 24) % 24]; b.s = SHAPE_CURVE; }
    out.push(b);
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
 * @param {{bevelMM?: number}} [opts] - bevelMM > 0 softens every exposed
 *   block edge with a bevel that wide (clamped per block so small blocks
 *   keep their shape). 0 = sharp edges (default).
 * @returns {{ triangles: Array<{v:number[][], color:number}>, min:number[] }}
 *   triangles: each has 3 z-up vertices (already scaled to mm, positive octant)
 *              and the palette color index of the block it came from.
 *   min: the pre-translation minimum corner (already applied to vertices).
 */
export function buildMesh(cells, mm, { bevelMM = 0 } = {}) {
  const blocks = normalizeCells(cells);
  const at = new Map();
  for (const b of blocks) {
    at.set(`${b.x},${b.y},${b.z}`, b);
  }

  const bevelCache = new Map(); // "s,r,rUnit,weldmask" -> triangles

  // Occupancy at quarter resolution (bevel mode only): used to find faces
  // fully backed by solid neighbors — those faces get welded into them.
  let occ = null;
  if (bevelMM > 0) {
    occ = new Map();
    for (const b of blocks) {
      for (let i = 0; i < b.g; i++) {
        for (let j = 0; j < b.g; j++) {
          for (let k = 0; k < b.g; k++) {
            occ.set(`${b.x + i},${b.y + j},${b.z + k}`, b);
          }
        }
      }
    }
  }

  // Is face direction d of this block fully backed by solid material at the
  // shared plane? True only when every adjacent quarter cell is filled by a
  // cube (solid throughout) or by a block whose own full face sits exactly
  // on our plane — so a welded face pushed past the boundary stays buried.
  function fullyBacked(blk, d) {
    const { x, y, z, g } = blk;
    const [dx, dy, dz] = DIRS[d];
    const axis = dx !== 0 ? 0 : dy !== 0 ? 1 : 2;
    const positive = dx + dy + dz > 0;
    const anchor = [x, y, z];
    const plane = positive ? anchor[axis] + g : anchor[axis];
    const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    for (let i = 0; i < g; i++) {
      for (let j = 0; j < g; j++) {
        const cell = [0, 0, 0];
        cell[axis] = positive ? plane : plane - 1;
        cell[u] = anchor[u] + i;
        cell[v] = anchor[v] + j;
        const nb = occ.get(cell.join(','));
        if (!nb) return false;
        if (nb.s === SHAPE_CUBE) continue;
        const nbAnchor = [nb.x, nb.y, nb.z][axis];
        const nbBoundary = positive ? nbAnchor : nbAnchor + nb.g;
        if (nbBoundary !== plane) return false;
        if (!coversFace(nb.s, nb.r, OPPOSITE[d])) return false;
      }
    }
    return true;
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

    let tris;
    if (bevelMM > 0) {
      // Beveled blocks are independent closed shells, so faces can't be
      // culled — and a block hidden on all six sides must STILL be emitted:
      // nothing else fills its cell, so skipping it hollows the model out
      // from the inside (interior voids, and anything welded toward the
      // missing block ends up hanging in air — the seam prints as a gap).
      // Fully-hidden cubes weld on all six faces, so they cost one cached
      // expanded-cube shell each.
      const edgeMM = scale * mm;
      const rUnit = Math.min(bevelMM, edgeMM * 0.12) / edgeMM; // unit-cell units
      const blk = { x, y, z, g, s, r };
      const welded = [0, 1, 2, 3, 4, 5].map((d) => fullyBacked(blk, d));
      const mask = welded.reduce((m, w, i) => m | (w ? 1 << i : 0), 0);
      const key = `${s},${r},${rUnit.toFixed(5)},${mask}`;
      tris = bevelCache.get(key);
      if (!tris) {
        tris = bevelTriangles(s, r, rUnit, welded);
        bevelCache.set(key, tris);
      }
    } else {
      tris = shapeTriangles(s, r);
    }

    for (const tri of tris) {
      if (bevelMM <= 0) {
        const d = faceOfTriangle(tri);
        if (d >= 0 && hidden[d]) continue;
      }
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
