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

// Rotate a unit-cell point by r quarter-turns about the vertical axis, about
// the cell center (0.5, *, 0.5). r=1 maps +X -> +Z (CCW seen from above).
function rotPoint([x, y, z], r) {
  let px = x - 0.5, pz = z - 0.5;
  for (let i = 0; i < r; i++) {
    const nx = -pz, nz = px;
    px = nx; pz = nz;
  }
  return [px + 0.5, y, pz + 0.5];
}

// Rotate a whole triangle. Rotation about +Y preserves winding/orientation.
function rotTri(tri, r) {
  return tri.map((p) => rotPoint(p, r));
}

/**
 * Triangles for a block, in unit-cell space, wound CCW from outside.
 * @returns {Array<[number[],number[],number[]]>}
 */
export function shapeTriangles(shape, rot = 0) {
  if (shape === SHAPE_WEDGE) return WEDGE0_TRIS.map((t) => rotTri(t, rot));
  if (shape === SHAPE_ROUND) return ROUND0_TRIS.map((t) => rotTri(t, rot));
  if (shape === SHAPE_CURVE) return CURVE0_TRIS.map((t) => rotTri(t, rot));
  // Cube: two tris per quad.
  const tris = [];
  for (const q of CUBE_QUADS) {
    tris.push([q[0], q[1], q[2]], [q[0], q[2], q[3]]);
  }
  return tris;
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

// How a face direction index maps under one CCW quarter-turn about +Y:
// +X(0) -> +Z(4) -> -X(1) -> -Z(5) -> +X(0); vertical faces unchanged.
const DIR_ROT = [4, 5, 2, 3, 1, 0]; // newDirIndex = DIR_ROT[oldDirIndex]

function rotFaceCoverage(base, rot) {
  let faces = base.slice();
  for (let i = 0; i < rot; i++) {
    const next = new Array(6);
    for (let d = 0; d < 6; d++) next[DIR_ROT[d]] = faces[d];
    faces = next;
  }
  return faces;
}

/**
 * Does this block fully cover the unit square on face-direction index `dirIdx`
 * (0..5, matching DIRS)? Only fully-covered faces are eligible for culling.
 */
export function coversFace(shape, rot, dirIdx) {
  const base = shape === SHAPE_WEDGE ? WEDGE0_FACES
    : shape === SHAPE_ROUND ? ROUND0_FACES
    : shape === SHAPE_CURVE ? CURVE0_FACES
    : CUBE_FACES;
  return rotFaceCoverage(base, rot)[dirIdx];
}
