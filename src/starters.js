// Demo / starter builds: ready-made models a kid can load, spin around, and
// pull apart to see how it was made. Also the fastest way for a teacher to
// show a class what the tools can do — between them these use every block
// size, both curved shapes, and tipped orientations.
//
// Each build() returns rows for world.loadArray(), emitted in QUARTER units
// as [qx, qy, qz, colour, shape, orientation, size]. The builder exposes
// three coordinate grids so detail can be placed precisely:
//   full(x, y, z)     — whole blocks (4 quarter units)
//   half(x, y, z)     — half blocks, so x is in half-block steps
//   quarter(x, y, z)  — quarter blocks, the finest grid
//
// Palette: 0 Cherry, 1 Tangerine, 2 Sunshine, 3 Lime, 4 Grass, 5 Seafoam,
// 6 Sky, 7 Ocean, 8 Grape, 9 Magenta, 10 Bubblegum, 11 Chocolate, 12 Snow,
// 13 Pebble, 14 Storm, 15 Night.
//
// Shapes: 0 cube, 1 wedge, 3 round (quarter-cylinder).
//
// ORIENTATIONS (derived from shapes.js; see coversFace):
//   Lying down — flat base, surface falls away from the high wall:
//     0 high at -X   2 high at +X   1 high at -Z   3 high at +Z
//   Standing up — rounds/bevels a vertical corner, curve bulging outward:
//     12 at a min-X/min-Z corner   17 at max-X/min-Z
//      4 at a max-X/max-Z corner    6 at min-X/max-Z
//   Upside down — flat top, curve tucked underneath (eaves, brackets):
//     9 under a -X wall   13 under a +X wall   5 under a -Z   11 under a +Z

import { SIZE } from './world.js';

const CX = Math.floor(SIZE / 2); // 16 — builds sit centred on the plate
const CZ = Math.floor(SIZE / 2);

// Standing-round orientation for each corner of a rectangle, so a footprint
// can be given rounded corners without thinking about it every time.
const CORNER = { minmin: 12, maxmin: 17, maxmax: 4, minmax: 6 };
// Lying-down orientation by which side is high.
const HIGH = { negX: 0, posX: 2, negZ: 1, posZ: 3 };
// Upside-down orientation by which wall the curve tucks under.
const UNDER = { negX: 9, posX: 13, negZ: 5, posZ: 11 };

// Deterministic 0..1 noise from a coordinate, for dappling foliage without
// Math.random (so a starter always loads identically).
function dapple(x, y, z) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

function maker() {
  const cells = [];
  const put = (qx, qy, qz, c, s, r, g) => {
    cells.push([qx, qy, qz, c, s || 0, r || 0, g]);
    return api;
  };
  const api = {
    cells,
    full: (x, y, z, c, s, r) => put(x * 4, y * 4, z * 4, c, s, r, 4),
    half: (x, y, z, c, s, r) => put(x * 2, y * 2, z * 2, c, s, r, 2),
    quarter: (x, y, z, c, s, r) => put(x, y, z, c, s, r, 1),

    // Filled box of whole blocks, inclusive.
    fbox(x0, y0, z0, x1, y1, z1, c) {
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) api.full(x, y, z, c);
      return api;
    },

    // One layer of whole blocks with rounded (standing-round) corners. Set
    // `solid` to fill the middle too, otherwise it's a wall ring.
    roundLayer(y, x0, z0, x1, z1, c, solid = false, shape = 3) {
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const edge = x === x0 || x === x1 || z === z0 || z === z1;
          if (!edge && !solid) continue;
          if (x === x0 && z === z0) api.full(x, y, z, c, shape, CORNER.minmin);
          else if (x === x1 && z === z0) api.full(x, y, z, c, shape, CORNER.maxmin);
          else if (x === x1 && z === z1) api.full(x, y, z, c, shape, CORNER.maxmax);
          else if (x === x0 && z === z1) api.full(x, y, z, c, shape, CORNER.minmax);
          else api.full(x, y, z, c);
        }
      }
      return api;
    },

    // Solid voxel ellipsoid — the shape you want for anything organic (a
    // tree crown, an animal's body). Stepped layers read as a wedding cake;
    // a distance test reads as a blob. `tint` picks the colour per block so
    // a crown can be dappled rather than banded.
    blob(cx, cy, cz, rx, ry, rz, tint) {
      const paint = typeof tint === 'function' ? tint : () => tint;
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
          for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
            const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry, dz = (z + 0.5 - cz) / rz;
            if (dx * dx + dy * dy + dz * dz <= 1) api.full(x, y, z, paint(x, y, z));
          }
        }
      }
      return api;
    },

    // A ring of lying-down rounds that curve inward as they rise: the dome
    // cap used on the rocket nose and tree crown.
    domeRing(y, x0, z0, x1, z1, c) {
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const onMinX = x === x0, onMaxX = x === x1;
          const onMinZ = z === z0, onMaxZ = z === z1;
          if (!onMinX && !onMaxX && !onMinZ && !onMaxZ) { api.full(x, y, z, c); continue; }
          // Corners get a standing round; edges curve toward the middle.
          if (onMinX && onMinZ) api.full(x, y, z, c, 3, CORNER.minmin);
          else if (onMaxX && onMinZ) api.full(x, y, z, c, 3, CORNER.maxmin);
          else if (onMaxX && onMaxZ) api.full(x, y, z, c, 3, CORNER.maxmax);
          else if (onMinX && onMaxZ) api.full(x, y, z, c, 3, CORNER.minmax);
          else if (onMinX) api.full(x, y, z, c, 3, HIGH.posX);
          else if (onMaxX) api.full(x, y, z, c, 3, HIGH.negX);
          else if (onMinZ) api.full(x, y, z, c, 3, HIGH.posZ);
          else api.full(x, y, z, c, 3, HIGH.negZ);
        }
      }
      return api;
    },
  };
  return api;
}

// --- Rocket ---------------------------------------------------------------
// Octagonal body (rounded corners all the way up), banded hull, flared
// engine bell, four swept fins, domed nose. ~7 x 18 blocks.
function rocket() {
  const m = maker();

  // Lower stage: 5 wide, dark engine section flaring out at the very base.
  m.roundLayer(0, CX - 2, CZ - 2, CX + 2, CZ + 2, 14, true);
  for (const [x, z, r] of [
    [CX - 3, CZ, UNDER.posX], [CX + 3, CZ, UNDER.negX],
    [CX, CZ - 3, UNDER.posZ], [CX, CZ + 3, UNDER.negZ],
  ]) m.full(x, 0, z, 14, 3, r);
  for (let y = 1; y <= 2; y++) m.roundLayer(y, CX - 2, CZ - 2, CX + 2, CZ + 2, 14, true);
  for (let y = 3; y <= 6; y++) {
    m.roundLayer(y, CX - 2, CZ - 2, CX + 2, CZ + 2, y === 6 ? 0 : 12, true);
  }

  // Upper stage: 3 wide, so the whole thing is tall and slim rather than
  // squat. A cherry band breaks up the white.
  for (let y = 7; y <= 15; y++) {
    m.roundLayer(y, CX - 1, CZ - 1, CX + 1, CZ + 1, y === 11 || y === 12 ? 0 : 12, true);
  }

  // Nose cone: dome in, capstone, tip — a continuous taper, not a knob.
  m.domeRing(16, CX - 1, CZ - 1, CX + 1, CZ + 1, 0);
  m.roundLayer(17, CX, CZ, CX, CZ, 0, true);
  for (const hx of [CX * 2, CX * 2 + 1]) {
    for (const hz of [CZ * 2, CZ * 2 + 1]) m.half(hx, 18 * 2, hz, 2);
  }
  m.quarter(CX * 4 + 1, 18 * 4 + 2, CZ * 4 + 1, 2).quarter(CX * 4 + 2, 18 * 4 + 2, CZ * 4 + 1, 2);

  // Porthole: one sky block let into the +Z face of the upper stage, ringed
  // with quarter blocks so it reads as a window rather than a smudge.
  m.full(CX, 9, CZ + 1, 6);
  for (let q = 0; q <= 3; q++) {
    m.quarter(CX * 4 + q, 8 * 4 + 3, (CZ + 2) * 4 - 1, 15);
    m.quarter(CX * 4 + q, 10 * 4, (CZ + 2) * 4 - 1, 15);
    m.quarter(CX * 4 - 1, 9 * 4 + q, (CZ + 2) * 4 - 1, 15);
    m.quarter((CX + 1) * 4, 9 * 4 + q, (CZ + 2) * 4 - 1, 15);
  }

  // Four fins in OCEAN blue, so they stand out against the red-and-white
  // hull instead of disappearing into it.
  for (const [dx, dz, high] of [
    [1, 0, HIGH.negX], [-1, 0, HIGH.posX], [0, 1, HIGH.negZ], [0, -1, HIGH.posZ],
  ]) {
    for (let y = 0; y <= 4; y++) m.full(CX + dx * 3, y, CZ + dz * 3, 7);
    m.full(CX + dx * 3, 5, CZ + dz * 3, 7, 1, high);
    for (let y = 0; y <= 2; y++) m.full(CX + dx * 4, y, CZ + dz * 4, 7);
    m.full(CX + dx * 4, 3, CZ + dz * 4, 7, 1, high);
  }
  return m.cells;
}

// --- Cottage --------------------------------------------------------------
// 11 x 9 footprint, stone plinth, framed windows, arched door, overhanging
// gable roof with curved eaves brackets, chimney with a rounded cap.
function house() {
  const m = maker();
  const x0 = CX - 5, x1 = CX + 5, z0 = CZ - 4, z1 = CZ + 4;

  m.fbox(x0, 0, z0, x1, 0, z1, 13);                 // stone plinth + floor
  for (let y = 1; y <= 5; y++) {                     // walls
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++)
        if (x === x0 || x === x1 || z === z0 || z === z1) m.full(x, y, z, 12);
  }
  // Corner posts in chocolate, so the timber frame reads.
  for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
    for (let y = 1; y <= 5; y++) m.full(x, y, z, 11);
  }

  // Arched front door: a narrow chocolate slab with a round arch head, so it
  // reads as a door rather than a hole in the wall.
  m.fbox(CX, 1, z1, CX, 3, z1, 11);
  m.full(CX - 1, 1, z1, 12).full(CX - 1, 2, z1, 12).full(CX - 1, 3, z1, 12);
  m.full(CX + 1, 1, z1, 12).full(CX + 1, 2, z1, 12).full(CX + 1, 3, z1, 12);
  m.full(CX, 4, z1, 11);
  m.full(CX - 1, 4, z1, 11, 3, CORNER.minmax);
  m.full(CX + 1, 4, z1, 11, 3, CORNER.maxmax);
  // Door handle and a step, both small enough to read at this scale.
  m.quarter(CX * 4 + 3, 2 * 4 + 2, z1 * 4 + 3, 2);
  for (const hx of [CX * 2, CX * 2 + 1]) m.half(hx, 0, (z1 + 1) * 2, 13);

  // Windows: sky glass with a chocolate glazing bar stuck PROUD of the glass
  // (a bar inside the glass cell would replace the glass block, leaving a
  // hole with a wobbly quarter column in it).
  for (const [wx, wz] of [[CX - 3, z1], [CX + 3, z1], [CX - 3, z0], [CX + 3, z0]]) {
    m.fbox(wx, 2, wz, wx, 3, wz, 6);
    const bz = wz === z1 ? (wz + 1) * 4 : wz * 4 - 1; // just outside the glass
    for (let q = 0; q <= 4; q++) m.quarter(wx * 4 + 2, 2 * 4 + q, bz, 11);
  }
  for (const wx of [x0, x1]) {                       // side windows
    m.fbox(wx, 2, CZ, wx, 3, CZ, 6);
    const bx = wx === x1 ? (wx + 1) * 4 : wx * 4 - 1;
    for (let q = 0; q <= 4; q++) m.quarter(bx, 2 * 4 + q, CZ * 4 + 2, 11);
  }

  // Overhanging gable roof: each course steps in by one, with wedges on the
  // outer edge, and it starts one block wider than the walls.
  const eaves = 6;
  for (let i = 0; i <= 4; i++) {
    const y = eaves + i;
    const inset = 5 - i;      // half-width of this course
    const rz0 = z0 - (i === 0 ? 1 : 0), rz1 = z1 + (i === 0 ? 1 : 0);
    const over = i === 0 ? 1 : 0; // the eaves course overhangs the walls
    for (let z = rz0; z <= rz1; z++) {
      m.full(CX - inset - over, y, z, 0, 1, HIGH.posX);
      m.full(CX + inset + over, y, z, 0, 1, HIGH.negX);
      for (let x = CX - inset - over + 1; x <= CX + inset + over - 1; x++) m.full(x, y, z, 0);
    }
  }
  // Ridge: a half-height red spine on the flat top course, capped in
  // chocolate half blocks. (Capping a wedge apex would only touch along its
  // top edge — a line, which snaps off a print.)
  for (let z = z0; z <= z1; z++) {
    for (const hz of [z * 2, z * 2 + 1]) {
      m.half(CX * 2, 22, hz, 0).half(CX * 2 + 1, 22, hz, 0);
      m.half(CX * 2, 23, hz, 11).half(CX * 2 + 1, 23, hz, 11);
    }
  }
  // Eaves brackets: curved corbels at y=5, backs against the wall and tops
  // carrying the overhanging eaves course above — attached on two full faces
  // (beside the wedge at the same height they only touched its bottom edge,
  // which is a line, not a joint).
  for (let z = z0 + 1; z <= z1 - 1; z += 3) {
    m.full(x0 - 1, 5, z, 11, 3, UNDER.posX);
    m.full(x1 + 1, 5, z, 11, 3, UNDER.negX);
  }

  // Chimney with a rounded cap.
  m.fbox(x1 - 2, 6, z0 + 1, x1 - 2, 10, z0 + 1, 13);
  m.roundLayer(11, x1 - 2, z0 + 1, x1 - 2, z0 + 1, 14, true);
  return m.cells;
}

// --- Puppy ---------------------------------------------------------------
// Barrel body and round head as blobs, standing on real legs, with ears
// that hang DOWN the sides of the head and a tail that curls.
function puppy() {
  const m = maker();

  // Legs: two blocks tall so the dog stands rather than sitting on a slab.
  for (const [lx, lz] of [[CX - 2, CZ - 1], [CX - 2, CZ + 1], [CX + 2, CZ - 1], [CX + 2, CZ + 1]]) {
    m.full(lx, 0, lz, 12);              // snow paw
    m.full(lx, 1, lz, 11);
    m.full(lx, 2, lz, 11);
  }

  // Barrel body, tapering toward the rump, with a pale chest and belly.
  m.blob(CX, 4, CZ, 3.6, 1.9, 1.9, 11);
  m.blob(CX + 2, 4, CZ, 2.2, 1.7, 1.7, 11);
  for (let x = CX - 2; x <= CX + 2; x++) m.full(x, 2, CZ, 12);   // belly
  m.full(CX + 3, 3, CZ, 12).full(CX + 3, 4, CZ, 12);             // chest blaze

  // Head: a rounded 3x3x3 block rather than a blob, so its faces are at
  // known planes and the face details can be attached to them reliably.
  const hx0 = CX + 5, hx1 = CX + 7, hz0 = CZ - 1, hz1 = CZ + 1;
  m.fbox(CX + 4, 4, CZ - 1, CX + 4, 5, CZ + 1, 11);            // neck
  for (let y = 5; y <= 7; y++) m.roundLayer(y, hx0, hz0, hx1, hz1, 11, true);

  // Snout: pale muzzle jutting from the head's front face, with a night nose
  // on its tip and a tongue underneath.
  m.fbox(hx1 + 1, 5, CZ, hx1 + 1, 6, CZ, 12);
  m.half((hx1 + 2) * 2, 6 * 2, CZ * 2, 15).half((hx1 + 2) * 2, 6 * 2, CZ * 2 + 1, 15);
  m.half((hx1 + 2) * 2, 5 * 2, CZ * 2, 10).half((hx1 + 2) * 2, 5 * 2, CZ * 2 + 1, 10);

  // Eyes: quarter blocks on the head's front face, just above the muzzle.
  // Only the middle column of the rounded head has a FLAT front face — the
  // outer columns are standing rounds, and an eye on a curved cheek only
  // touches along a line (it would fall off the print).
  for (const eq of [CZ * 4, CZ * 4 + 3]) {
    for (const q of [1, 2]) m.quarter((hx1 + 1) * 4, 7 * 4 + q, eq, 15);
  }

  // Floppy ears: a block on each side of the head with a round hanging below
  // it, so they droop rather than pointing up like a cat's.
  for (const [ez, curveOut] of [[hz0 - 1, HIGH.posZ], [hz1 + 1, HIGH.negZ]]) {
    m.full(CX + 6, 7, ez, 11);
    m.full(CX + 6, 6, ez, 11, 3, curveOut);
  }

  // Curled tail: each piece shares a face with the last, curling up and over.
  const tz = CZ * 2;
  m.half((CX - 4) * 2 + 1, 9, tz, 11);
  m.half((CX - 4) * 2 + 1, 10, tz, 11);
  m.half((CX - 4) * 2 + 1, 11, tz, 11);
  m.half((CX - 4) * 2 + 2, 11, tz, 11);
  m.half((CX - 4) * 2 + 2, 12, tz, 12);
  return m.cells;
}

// --- Race car ------------------------------------------------------------
// Low sleek single-seater: pointed nose that tapers in PLAN (not a pile of
// domes), open cockpit, rear wing, and four wheels standing clear of the
// body with rounded tyre tops.
function racecar() {
  const m = maker();
  const z0 = CZ - 1, z1 = CZ + 1;   // body is narrow; wheels sit outside it

  // Floor and main tub, full width at the back, tapering to the nose.
  m.fbox(CX - 5, 0, z0, CX + 3, 0, z1, 15);
  m.roundLayer(1, CX - 5, z0, CX + 3, z1, 0, true);
  // Nose: narrows to one block, then a wedge point — a taper in plan view.
  m.fbox(CX + 4, 0, CZ, CX + 6, 0, CZ, 15);
  m.roundLayer(1, CX + 4, CZ, CX + 6, CZ, 0, true);
  m.full(CX + 7, 1, CZ, 0, 1, HIGH.negX);
  m.full(CX + 7, 0, CZ, 0);
  // Small front wings, on the cube segment of the nose (the segment behind
  // the tip is a corner round — a wing on its curved side wouldn't hold).
  m.half((CX + 5) * 2, 1 * 2, CZ * 2 - 1, 0);
  m.half((CX + 5) * 2, 1 * 2, (CZ + 1) * 2, 0);

  // Sidepods, wider than the tub, to give it a racing profile.
  for (const sz of [z0 - 1, z1 + 1]) {
    m.roundLayer(1, CX - 3, sz, CX + 1, sz, 0, true);
  }

  // Cockpit: dark opening with a wedge windscreen leaning back, and a
  // headrest fairing behind the driver.
  m.fbox(CX - 2, 2, CZ, CX, 2, CZ, 15);
  for (const cz of [z0, z1]) m.fbox(CX - 2, 2, cz, CX, 2, cz, 0);
  m.full(CX + 1, 2, CZ, 6, 1, HIGH.negX);                  // windscreen
  m.full(CX + 1, 2, z0, 0).full(CX + 1, 2, z1, 0);
  m.roundLayer(2, CX - 4, z0, CX - 3, z1, 0, true);
  m.full(CX - 3, 3, CZ, 0, 3, HIGH.posX);                  // headrest

  // Wheels: 2x2 in profile with rounded tops, standing outside the body so
  // they read as tyres rather than skirts.
  for (const wz of [z0 - 2, z1 + 2]) {
    for (const wx of [CX - 4, CX + 2]) {
      m.full(wx, 0, wz, 15).full(wx + 1, 0, wz, 15);
      m.full(wx, 1, wz, 15, 3, HIGH.posX);                 // curve down to -X
      m.full(wx + 1, 1, wz, 15, 3, HIGH.negX);             // curve down to +X
      // Axle stub connecting the wheel to the body.
      const inward = wz < CZ ? wz + 1 : wz - 1;
      m.half(wx * 2 + 1, 1 * 2, inward * 2 + (wz < CZ ? 0 : 1), 13);
    }
  }

  // Rear wing on two pylons.
  for (const pz of [CZ - 1, CZ + 1]) {
    m.half((CX - 5) * 2 + 1, 4, pz * 2, 14);
    m.half((CX - 5) * 2 + 1, 5, pz * 2, 14);
  }
  for (let z = z0 - 1; z <= z1 + 1; z++) m.full(CX - 5, 3, z, 14);
  // Exhausts: on the flat back face of the tub's middle block (the tail
  // corners are standing rounds — nothing sticks to their curve).
  for (const eq of [CZ * 4, CZ * 4 + 3]) {
    m.quarter((CX - 5) * 4 - 1, 1 * 4 + 1, eq, 13);
  }
  return m.cells;
}

// --- Tree ----------------------------------------------------------------
// Tall trunk with a flared root, and a genuinely round dappled crown — a
// distance-tested blob rather than stacked layers, which read as a pagoda.
function tree() {
  const m = maker();
  const bx = CX - 1, bz = CZ - 1;   // trunk occupies bx..bx+1, bz..bz+1

  // Flared roots, then a tall 2x2 trunk so the crown sits high.
  m.fbox(bx, 0, bz, bx + 1, 0, bz + 1, 11);
  for (const [x, z, r] of [
    [bx - 1, bz, UNDER.posX], [bx - 1, bz + 1, UNDER.posX],
    [bx + 2, bz, UNDER.negX], [bx + 2, bz + 1, UNDER.negX],
    [bx, bz - 1, UNDER.posZ], [bx + 1, bz - 1, UNDER.posZ],
    [bx, bz + 2, UNDER.negZ], [bx + 1, bz + 2, UNDER.negZ],
  ]) m.full(x, 0, z, 11, 3, r);
  for (let y = 1; y <= 7; y++) m.fbox(bx, y, bz, bx + 1, y, bz + 1, 11);

  // Two branches reaching out, so the trunk isn't a bare post.
  m.full(bx - 1, 6, bz, 11).full(bx - 1, 7, bz, 11);
  m.full(bx + 2, 5, bz + 1, 11).full(bx + 2, 6, bz + 1, 11);

  // Crown: one big blob plus two smaller ones for a lumpy, natural outline.
  // Dappled between two greens instead of banded.
  const leaves = (x, y, z) => (dapple(x, y, z) < 0.34 ? 4 : 3);
  m.blob(CX, 11, CZ, 5.2, 4.2, 5.2, leaves);
  m.blob(CX - 3.5, 9.5, CZ + 1, 2.6, 2.2, 2.6, leaves);
  m.blob(CX + 3, 10, CZ - 2.5, 2.4, 2.1, 2.4, leaves);

  // Apples: recoloured leaf blocks on the crown surface, so they sit IN the
  // foliage instead of being cubes glued to the outside.
  for (const [ax, ay, az] of [
    [CX + 4, 10, CZ], [CX - 4, 11, CZ + 1], [CX, 9, CZ + 4],
    [CX + 1, 13, CZ - 1], [CX - 2, 9, CZ - 4],
  ]) m.full(ax, ay, az, 0);
  return m.cells;
}

// --- Castle --------------------------------------------------------------
// Square keep with a walkable roof, four fat corner towers with conical
// roofs, an arched gate with a portcullis, and a flag on one tower. The
// towers are deliberately only a little taller than the keep — tall thin
// ones read as chimneys.
function castle() {
  const m = maker();
  const x0 = CX - 4, x1 = CX + 4, z0 = CZ - 3, z1 = CZ + 3;
  const KEEP = 7;          // top of the keep walls
  const TOWER = 10;        // top of the tower walls

  m.roundLayer(0, x0 - 1, z0 - 1, x1 + 1, z1 + 1, 14, true);   // plinth
  for (let y = 1; y <= KEEP; y++) m.roundLayer(y, x0, z0, x1, z1, 13, y === 1);
  // Roof over the keep, so it isn't an open box from above.
  m.fbox(x0 + 1, KEEP + 1, z0 + 1, x1 - 1, KEEP + 1, z1 - 1, 14);

  // Crenellations around the keep rim, in half blocks for finer teeth.
  const tooth = (x, z, y) => {
    for (const hx of [x * 2, x * 2 + 1]) {
      m.half(hx, y * 2, z * 2, 13).half(hx, y * 2, z * 2 + 1, 13);
    }
  };
  for (let x = x0; x <= x1; x += 2) { tooth(x, z0, KEEP + 1); tooth(x, z1, KEEP + 1); }
  for (let z = z0 + 2; z <= z1 - 2; z += 2) { tooth(x0, z, KEEP + 1); tooth(x1, z, KEEP + 1); }

  // Arched gate with a portcullis of quarter-block bars.
  m.fbox(CX - 1, 1, z1, CX + 1, 3, z1, 15);
  m.full(CX, 4, z1, 15);
  m.full(CX - 1, 4, z1, 15, 3, CORNER.minmax);
  m.full(CX + 1, 4, z1, 15, 3, CORNER.maxmax);
  for (let q = 0; q <= 3; q++) m.quarter(CX * 4 + q, 5 * 4, (z1 + 1) * 4, 11);
  for (let bx = (CX - 1) * 4 + 1; bx <= (CX + 1) * 4 + 2; bx += 2) {
    for (let by = 1 * 4; by <= 3 * 4 + 3; by += 2) m.quarter(bx, by, (z1 + 1) * 4, 11);
  }

  // Arrow slits.
  for (const [sx, sz] of [[x0, CZ], [x1, CZ], [CX - 2, z0], [CX + 2, z0]]) {
    for (let q = 0; q <= 3; q++) {
      m.quarter(sx * 4 + (sx === x1 ? 3 : 0), 5 * 4 + q, sz * 4 + 2, 15);
    }
  }

  // Four fat (3x3) corner towers with cone roofs.
  const towers = [
    [x0 - 1, z0 - 1], [x1 - 1, z0 - 1], [x0 - 1, z1 - 1], [x1 - 1, z1 - 1],
  ];
  for (const [tx, tz] of towers) {
    for (let y = 0; y <= TOWER; y++) {
      m.roundLayer(y, tx, tz, tx + 2, tz + 2, 13, true);
    }
    // Cone: a domed ring, then a capstone, then a small tip.
    m.domeRing(TOWER + 1, tx, tz, tx + 2, tz + 2, 0);
    m.roundLayer(TOWER + 2, tx + 1, tz + 1, tx + 1, tz + 1, 0, true);
    m.half((tx + 1) * 2, (TOWER + 3) * 2, (tz + 1) * 2, 0);
    m.half((tx + 1) * 2 + 1, (TOWER + 3) * 2, (tz + 1) * 2, 0);
    m.half((tx + 1) * 2, (TOWER + 3) * 2, (tz + 1) * 2 + 1, 0);
    m.half((tx + 1) * 2 + 1, (TOWER + 3) * 2, (tz + 1) * 2 + 1, 0);
  }

  // Flag on the front-right tower: a SLIM half-block pole (a whole-block one
  // read as a chimney and dominated the whole castle) with a small pennant.
  const [fx, fz] = towers[3];
  const px = (fx + 1) * 2, pz = (fz + 1) * 2;
  for (const hy of [(TOWER + 3) * 2, (TOWER + 3) * 2 + 1, (TOWER + 4) * 2]) {
    m.half(px, hy, pz, 14);
  }
  for (const hy of [(TOWER + 3) * 2 + 1, (TOWER + 4) * 2]) {
    m.half(px - 1, hy, pz, 9).half(px - 2, hy, pz, 9);
  }
  return m.cells;
}

export const STARTERS = [
  { id: 'rocket',  emoji: '🚀', name: 'Rocket',    blurb: 'Domed nose, swept fins', build: rocket },
  { id: 'house',   emoji: '🏠', name: 'Cottage',   blurb: 'Arched door, big roof', build: house },
  { id: 'puppy',   emoji: '🐶', name: 'Puppy',     blurb: 'Round head, floppy ears', build: puppy },
  { id: 'racecar', emoji: '🏎️', name: 'Race car',  blurb: 'Nose cone and a wing', build: racecar },
  { id: 'tree',    emoji: '🌳', name: 'Big tree',  blurb: 'Two-tone leaves, apples', build: tree },
  { id: 'castle',  emoji: '🏰', name: 'Castle',    blurb: 'Round towers, arched gate', build: castle },
];

export const starterById = (id) => STARTERS.find((s) => s.id === id) || null;

// The build first-time players land in.
export const starterRocket = rocket;
