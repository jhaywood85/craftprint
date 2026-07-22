// Shared block geometry, used by BOTH the STL exporter and the 3D renderer so
// a block looks identical on screen and in the printed model.
//
// A block occupies the unit cell [0,1]^3 in game space (y up). Geometry is
// returned as a list of triangles; each vertex is [x,y,z] in [0,1], wound
// counter-clockwise when viewed from OUTSIDE the solid (so face normals point
// out and the STL volume is positive).
//
// Shapes:
//   CUBE  (s=0): the full cell.
//   WEDGE (s=1): a triangular prism. Flat square base on the floor (y=0),
//     one full-height vertical wall, and a sloped face falling from the top
//     of that wall to the opposite bottom edge. Rotating r=0..3 turns the
//     wall to face -X, -Z, +X, +Z respectively (quarter turns about +Y).
//   ROUND (s=2): a vertical quarter-cylinder that rounds a corner as seen
//     from above (rounded tower corners). At r=0 its two flat walls face -X
//     and -Z and the curved surface bulges toward +X/+Z.
//   CURVE (s=3): the wedge's curved cousin — same footprint and wall as the
//     wedge at each rotation, but the slope is a convex quarter-circle arc
//     (rounded roof edges, bullnoses).
//
// Neighbor-face culling: `coversFace(shape, rot, dir)` reports whether the
// block completely covers the unit square on the given face (dir is one of
// the 6 axis directions). A covered exterior face touching another block's
// covered face can be culled; anything else (including every sloped or
// curved face) is always emitted, which keeps the surface closed and
// watertight.

import { SHAPE_CUBE, SHAPE_WEDGE, SHAPE_ROUND, SHAPE_CURVE } from './world.js';

export { SHAPE_CUBE, SHAPE_WEDGE, SHAPE_ROUND, SHAPE_CURVE };

// Facets per 90° of arc for the round shapes. Shared by the renderer and the
// exporters, so the print matches the screen exactly.
export const ROUND_SEGS = 12;

// Face direction indices.
export const DIRS = [
  [ 1, 0, 0], // 0 +X
  [-1, 0, 0], // 1 -X
  [ 0, 1, 0], // 2 +Y (top)
  [ 0,-1, 0], // 3 -Y (bottom)
  [ 0, 0, 1], // 4 +Z
  [ 0, 0,-1], // 5 -Z
];

// --- Cube -----------------------------------------------------------------

// Six quads, each wound CCW from outside. Split into triangles below.
const CUBE_QUADS = [
  [[1,0,0],[1,1,0],[1,1,1],[1,0,1]], // +X
  [[0,0,0],[0,0,1],[0,1,1],[0,1,0]], // -X
  [[0,1,0],[0,1,1],[1,1,1],[1,1,0]], // +Y
  [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], // -Y
  [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], // +Z
  [[0,0,0],[0,1,0],[1,1,0],[1,0,0]], // -Z
];

// --- Wedge (rotation 0) ---------------------------------------------------
//
// Full vertical wall on the -X face (x=0). The top edge of that wall is the
// high edge; the slope descends to the bottom edge at +X (x=1, y=0). Two
// triangular end-caps at z=0 and z=1. It is a prism along Z.
//
// Cross-section (X right, Y up): right triangle (0,0)-(1,0)-(0,1).
//
//   y=1  *(0,1)
//        |\
//        | \  <- sloped top face
//        |  \
//   y=0  *---* (1,0)
//      (0,0)
//
// Winding derived and verified by outward-normal + edge-balance test
// (volume +0.5, zero unbalanced edges). Vertex shorthand:
//   A=(0,0,*) B=(1,0,*) C=(0,1,*); suffix 0 => z=0, 1 => z=1.
const WEDGE0_TRIS = [
  // -X wall (full square x=0), outward normal -X:
  [[0,0,0],[0,1,1],[0,1,0]], [[0,0,0],[0,0,1],[0,1,1]],
  // -Y base (full square y=0), outward normal -Y:
  [[0,0,0],[1,0,0],[1,0,1]], [[0,0,0],[1,0,1],[0,0,1]],
  // sloped face (top edge of -X wall down to +X bottom edge), normal +X/+Y:
  [[0,1,0],[1,0,1],[1,0,0]], [[0,1,0],[0,1,1],[1,0,1]],
  // triangular end cap z=0, outward normal -Z:
  [[0,0,0],[0,1,0],[1,0,0]],
  // triangular end cap z=1, outward normal +Z:
  [[0,0,1],[1,0,1],[0,1,1]],
];

// --- Round shapes (rotation 0) ---------------------------------------------
//
// Both are quarter-cylinders of radius 1 built from ROUND_SEGS facets.
// Windings verified by the exporters' outward-normal + edge-balance tests.

// Arc sample points: P(i) = (cos, sin) from 0..90°, i = 0..ROUND_SEGS.
// The endpoints are snapped exactly onto the cell edges (cos 90° in floating
// point is ~6e-17, which would leave hairline cracks in the mesh).
function arc(i) {
  if (i === 0) return [1, 0];
  if (i === ROUND_SEGS) return [0, 1];
  const t = (i * Math.PI) / (2 * ROUND_SEGS);
  return [Math.cos(t), Math.sin(t)];
}

// ROUND0: vertical quarter-cylinder (prism along Y). Flat full-square walls
// on -X (x=0) and -Z (z=0); quarter-disc top and bottom caps; curved surface
// bulging toward +X/+Z. Cross-section (X right, Z "up" on paper): quarter
// disc with the right angle at (0,0).
function buildRound0() {
  const tris = [];
  // -X wall (full square x=0), outward normal -X (same as the cube's).
  tris.push([[0,0,0],[0,0,1],[0,1,1]], [[0,0,0],[0,1,1],[0,1,0]]);
  // -Z wall (full square z=0), outward normal -Z.
  tris.push([[0,0,0],[0,1,0],[1,1,0]], [[0,0,0],[1,1,0],[1,0,0]]);
  for (let i = 0; i < ROUND_SEGS; i++) {
    const [xa, za] = arc(i);
    const [xb, zb] = arc(i + 1);
    // Bottom cap fan (y=0, normal -Y) and top cap fan (y=1, normal +Y).
    tris.push([[0,0,0],[xa,0,za],[xb,0,zb]]);
    tris.push([[0,1,0],[xb,1,zb],[xa,1,za]]);
    // Curved surface, outward radial normal.
    tris.push([[xa,0,za],[xa,1,za],[xb,1,zb]], [[xa,0,za],[xb,1,zb],[xb,0,zb]]);
  }
  return tris;
}

// CURVE0: horizontal quarter-cylinder (prism along Z), the wedge's rounded
// cousin. Full wall on -X (x=0), full base on -Y (y=0), quarter-disc end
// caps at z=0/z=1, and a convex arc from the top of the wall (0,1) down to
// the far bottom edge (1,0). Cross-section (X right, Y up): quarter disc
// with the right angle at (0,0).
function buildCurve0() {
  const tris = [];
  // -X wall and -Y base, same as the wedge's.
  tris.push([[0,0,0],[0,1,1],[0,1,0]], [[0,0,0],[0,0,1],[0,1,1]]);
  tris.push([[0,0,0],[1,0,0],[1,0,1]], [[0,0,0],[1,0,1],[0,0,1]]);
  for (let i = 0; i < ROUND_SEGS; i++) {
    const [xa, ya] = arc(i);
    const [xb, yb] = arc(i + 1);
    // End cap fans: z=0 (normal -Z) and z=1 (normal +Z).
    tris.push([[0,0,0],[xb,yb,0],[xa,ya,0]]);
    tris.push([[0,0,1],[xa,ya,1],[xb,yb,1]]);
    // Curved surface, outward radial normal.
    tris.push([[xa,ya,0],[xb,yb,0],[xb,yb,1]], [[xa,ya,0],[xb,yb,1],[xa,ya,1]]);
  }
  return tris;
}

const ROUND0_TRIS = buildRound0();
const CURVE0_TRIS = buildCurve0();

// Exact solid volume of each shape's unit-cell version (used by tests). The
// round shapes use the faceted polygon area, not π/4, so it matches the
// exported mesh precisely.
export function shapeUnitVolume(shape) {
  if (shape === SHAPE_WEDGE) return 0.5;
  if (shape === SHAPE_ROUND || shape === SHAPE_CURVE) {
    return 0.5 * ROUND_SEGS * Math.sin(Math.PI / (2 * ROUND_SEGS));
  }
  return 1;
}

// --- Orientations -----------------------------------------------------------
//
// Blocks can face any of the 24 axis-aligned orientations. The orientation
// index o (stored in a block's `r` field) selects a rotation matrix; indices
// 0..3 are the legacy quarter-turns about +Y, so old saves keep their exact
// meaning. ORIENT_YAW[o] / ORIENT_TIP[o] give the orientation reached by one
// more GLOBAL quarter-turn about +Y (the Turn button) or +X (the Tip
// button) — two generators that reach all 24 orientations.

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const YAW3 = [[0, 0, -1], [0, 1, 0], [1, 0, 0]];  // +X -> +Z (legacy r=1)
const TIP3 = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];  // +Y -> +Z (tips the top toward +Z)

const mul3 = (A, B) => A.map((row) =>
  [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
const eq3 = (A, B) => A.every((row, i) => row.every((v, j) => v === B[i][j]));

export const ORIENTS = (() => {
  const list = [I3];
  for (let k = 1; k < 4; k++) list.push(mul3(YAW3, list[k - 1])); // legacy 0..3
  for (let i = 0; i < list.length; i++) {
    for (const G of [YAW3, TIP3]) {
      const N = mul3(G, list[i]);
      if (!list.some((M) => eq3(M, N))) list.push(N);
    }
  }
  return list; // exactly 24
})();
export const ORIENT_COUNT = ORIENTS.length;

const orientIndex = (N) => ORIENTS.findIndex((M) => eq3(M, N));
export const ORIENT_YAW = ORIENTS.map((M) => orientIndex(mul3(YAW3, M)));
export const ORIENT_TIP = ORIENTS.map((M) => orientIndex(mul3(TIP3, M)));

// Is the block the right way up (a pure yaw)? Only o = 0..3 keep +Y at +Y.
export const orientUpright = (o) => o < 4;

// Apply orientation o to a unit-cell point, rotating about the cell center.
function orientPoint(M, [x, y, z]) {
  const px = x - 0.5, py = y - 0.5, pz = z - 0.5;
  return [
    M[0][0] * px + M[0][1] * py + M[0][2] * pz + 0.5,
    M[1][0] * px + M[1][1] * py + M[1][2] * pz + 0.5,
    M[2][0] * px + M[2][1] * py + M[2][2] * pz + 0.5,
  ];
}

const BASE_TRIS = {
  [SHAPE_WEDGE]: WEDGE0_TRIS,
  [SHAPE_ROUND]: ROUND0_TRIS,
  [SHAPE_CURVE]: CURVE0_TRIS,
  [SHAPE_CUBE]: (() => {
    const tris = [];
    for (const q of CUBE_QUADS) tris.push([q[0], q[1], q[2]], [q[0], q[2], q[3]]);
    return tris;
  })(),
};

/**
 * Triangles for a block, in unit-cell space, wound CCW from outside.
 * @param {number} rot - orientation index 0..23 (0..3 = legacy yaw turns)
 * @returns {Array<[number[],number[],number[]]>}
 */
export function shapeTriangles(shape, rot = 0) {
  const base = BASE_TRIS[shape] || BASE_TRIS[SHAPE_CUBE];
  if (!rot) return base;
  const M = ORIENTS[rot] || I3;
  // Proper rotations (det +1) preserve winding.
  return base.map((t) => t.map((p) => orientPoint(M, p)));
}

/**
 * Orientation of a block's mirror twin: mirroring across X maps an oriented
 * shape onto (some) orientation of the same shape — every CraftPrint shape
 * has a mirror symmetry. Found numerically by comparing vertex sets, once
 * per shape.
 */
const MIRROR_TABLES = new Map();
export function mirrorOrient(shape, o) {
  let table = MIRROR_TABLES.get(shape);
  if (!table) {
    const fix = (v) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4);
    const sig = (oi, mirrored) => {
      const pts = new Set();
      for (const t of shapeTriangles(shape, oi)) {
        for (const p of t) {
          pts.add(`${fix(mirrored ? 1 - p[0] : p[0])},${fix(p[1])},${fix(p[2])}`);
        }
      }
      return [...pts].sort().join('|');
    };
    const plain = [];
    for (let i = 0; i < ORIENT_COUNT; i++) plain.push(sig(i, false));
    table = [];
    for (let i = 0; i < ORIENT_COUNT; i++) {
      const j = plain.indexOf(sig(i, true));
      table.push(j >= 0 ? j : i);
    }
    MIRROR_TABLES.set(shape, table);
  }
  return table[((o % ORIENT_COUNT) + ORIENT_COUNT) % ORIENT_COUNT];
}

// --- Face coverage (for neighbor culling) ---------------------------------
//
// Which of the 6 unit faces a shape fully covers, at rotation 0. Index order
// matches DIRS: [+X, -X, +Y, -Y, +Z, -Z].
const CUBE_FACES = [true, true, true, true, true, true];
// Wedge0 fully covers: -X (the wall), -Y (the base), and both Z end faces are
// only half-covered (triangles) so they are NOT full. +X and +Y are open
// (the slope cuts them). So: +X no, -X yes, +Y no, -Y yes, +Z no, -Z no.
const WEDGE0_FACES = [false, true, false, true, false, false];
// Round0 (vertical): full walls on -X and -Z; the ±Y caps are quarter discs.
const ROUND0_FACES = [false, true, false, false, false, true];
// Curve0 (horizontal): same coverage as the wedge — full -X wall, full -Y base.
const CURVE0_FACES = [false, true, false, true, false, false];

const BASE_FACES = {
  [SHAPE_CUBE]: CUBE_FACES,
  [SHAPE_WEDGE]: WEDGE0_FACES,
  [SHAPE_ROUND]: ROUND0_FACES,
  [SHAPE_CURVE]: CURVE0_FACES,
};

/**
 * Does this block fully cover the unit square on face-direction index `dirIdx`
 * (0..5, matching DIRS)? Only fully-covered faces are eligible for culling.
 * The oriented block's face in world direction D is the base shape's face in
 * direction M⁻¹·D (= Mᵀ·D, since rotations are orthogonal).
 */
export function coversFace(shape, rot, dirIdx) {
  const base = BASE_FACES[shape] || CUBE_FACES;
  if (!rot) return base[dirIdx];
  const M = ORIENTS[rot] || I3;
  const D = DIRS[dirIdx];
  const b = [
    M[0][0] * D[0] + M[1][0] * D[1] + M[2][0] * D[2],
    M[0][1] * D[0] + M[1][1] * D[1] + M[2][1] * D[2],
    M[0][2] * D[0] + M[1][2] * D[1] + M[2][2] * D[2],
  ];
  const baseIdx = DIRS.findIndex((d) => d[0] === b[0] && d[1] === b[1] && d[2] === b[2]);
  return base[baseIdx];
}
