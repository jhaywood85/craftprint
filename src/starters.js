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

  // Engine bell: flares outward at the bottom using upside-down rounds.
  m.roundLayer(0, CX - 3, CZ - 3, CX + 3, CZ + 3, 14, true);
  for (const [x, z, r] of [
    [CX - 3, CZ, UNDER.posX], [CX + 3, CZ, UNDER.negX],
    [CX, CZ - 3, UNDER.posZ], [CX, CZ + 3, UNDER.negZ],
  ]) m.full(x, 1, z, 14, 3, r);
  m.roundLayer(1, CX - 2, CZ - 2, CX + 2, CZ + 2, 14, true);

  // Hull: white with cherry bands, rounded corners every layer.
  for (let y = 2; y <= 12; y++) {
    const band = y === 5 || y === 6 || y === 10;
    m.roundLayer(y, CX - 2, CZ - 2, CX + 2, CZ + 2, band ? 0 : 12, true);
  }

  // Porthole on the +Z face: sky half-blocks in a night frame, standing
  // slightly proud of the hull.
  for (const [hx, hy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    m.half(CX * 2 + hx, 8 * 2 + hy, (CZ + 3) * 2, 6);
  }
  for (let q = -1; q <= 4; q++) {
    m.quarter(CX * 4 + q, 8 * 4 - 1, (CZ + 3) * 4, 15);
    m.quarter(CX * 4 + q, 10 * 4, (CZ + 3) * 4, 15);
  }

  // Nose: taper 5 wide -> 3 wide -> dome -> tip.
  m.roundLayer(13, CX - 1, CZ - 1, CX + 1, CZ + 1, 0, true);
  m.domeRing(14, CX - 1, CZ - 1, CX + 1, CZ + 1, 0);
  m.full(CX, 15, CZ, 0);
  m.half(CX * 2, 16 * 2, CZ * 2, 2).half(CX * 2 + 1, 16 * 2, CZ * 2, 2);
  m.half(CX * 2, 16 * 2, CZ * 2 + 1, 2).half(CX * 2 + 1, 16 * 2, CZ * 2 + 1, 2);
  // Tip sits directly on the half blocks below (block y 16.5), not a whole
  // block up — otherwise it floats.
  m.quarter(CX * 4 + 1, 16 * 4 + 2, CZ * 4 + 1, 2).quarter(CX * 4 + 2, 16 * 4 + 2, CZ * 4 + 1, 2);

  // Four big swept fins: a tall inner root, a shorter outer step, and wedges
  // sweeping down and out from each, so they read against the tall hull.
  for (const [dx, dz, high] of [
    [1, 0, HIGH.negX], [-1, 0, HIGH.posX], [0, 1, HIGH.negZ], [0, -1, HIGH.posZ],
  ]) {
    for (let y = 2; y <= 6; y++) m.full(CX + dx * 3, y, CZ + dz * 3, 0);
    m.full(CX + dx * 3, 7, CZ + dz * 3, 0, 1, high);
    for (let y = 2; y <= 3; y++) m.full(CX + dx * 4, y, CZ + dz * 4, 0);
    m.full(CX + dx * 4, 4, CZ + dz * 4, 0, 1, high);
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

  // Arched front door: chocolate frame, rounds forming the arch head.
  m.fbox(CX - 1, 1, z1, CX + 1, 3, z1, 11);
  m.full(CX, 4, z1, 11);
  m.full(CX - 1, 4, z1, 11, 3, CORNER.minmax);
  m.full(CX + 1, 4, z1, 11, 3, CORNER.maxmax);
  m.half((CX + 1) * 2, 2 * 2 + 1, z1 * 2 + 1, 2);    // door handle

  // Windows: sky glass with chocolate quarter-block mullions.
  for (const [wx, wz] of [[CX - 3, z1], [CX + 3, z1], [CX - 3, z0], [CX + 3, z0]]) {
    m.fbox(wx, 2, wz, wx, 3, wz, 6);
    for (let q = 0; q <= 4; q++) m.quarter(wx * 4 + 2, 2 * 4 + q, wz * 4 + (wz === z1 ? 3 : 0), 11);
  }
  for (const wx of [x0, x1]) {                       // side windows
    m.fbox(wx, 2, CZ, wx, 3, CZ, 6);
    for (let q = 0; q <= 4; q++) m.quarter(wx * 4 + (wx === x1 ? 3 : 0), 2 * 4 + q, CZ * 4 + 2, 11);
  }

  // Overhanging gable roof: each course steps in by one, with wedges on the
  // outer edge, and it starts one block wider than the walls.
  const eaves = 6;
  for (let i = 0; i <= 5; i++) {
    const y = eaves + i;
    const inset = 5 - i;      // half-width of this course
    const rz0 = z0 - (i === 0 ? 1 : 0), rz1 = z1 + (i === 0 ? 1 : 0);
    for (let z = rz0; z <= rz1; z++) {
      m.full(CX - inset, y, z, 0, 1, HIGH.posX);
      m.full(CX + inset, y, z, 0, 1, HIGH.negX);
      for (let x = CX - inset + 1; x <= CX + inset - 1; x++) m.full(x, y, z, 0);
    }
  }
  // Ridge cap in half blocks, and curved brackets under the eaves.
  for (let z = z0; z <= z1; z++) {
    m.half(CX * 2, 12 * 2, z * 2, 11).half(CX * 2 + 1, 12 * 2, z * 2, 11);
    m.half(CX * 2, 12 * 2, z * 2 + 1, 11).half(CX * 2 + 1, 12 * 2, z * 2 + 1, 11);
  }
  for (let z = z0; z <= z1; z += 2) {
    m.full(x0 - 1, 5, z, 11, 3, UNDER.posX);
    m.full(x1 + 1, 5, z, 11, 3, UNDER.negX);
  }

  // Chimney with a rounded cap.
  m.fbox(x1 - 2, 6, z0 + 1, x1 - 2, 10, z0 + 1, 13);
  m.roundLayer(11, x1 - 2, z0 + 1, x1 - 2, z0 + 1, 14, true);
  return m.cells;
}

// --- Puppy ---------------------------------------------------------------
// Rounded head and snout, floppy wedge ears, half-block paws, curled tail.
function puppy() {
  const m = maker();
  const bz0 = CZ - 1, bz1 = CZ + 1;

  // Legs on snow feet, with half-block toes poking forward. The foot is a
  // whole block: half-block paws left a gap under the leg.
  for (const [lx, lz] of [[CX - 2, bz0], [CX - 2, bz1], [CX + 2, bz0], [CX + 2, bz1]]) {
    m.full(lx, 0, lz, 12);
    m.full(lx, 1, lz, 11);
    m.half(lx * 2 + 2, 0, lz * 2, 12).half(lx * 2 + 2, 0, lz * 2 + 1, 12);
  }

  // Body: rounded along its length, with a paler belly.
  for (let y = 2; y <= 4; y++) {
    m.roundLayer(y, CX - 3, bz0, CX + 3, bz1, 11, true);
  }
  for (let x = CX - 2; x <= CX + 2; x++) m.full(x, 2, CZ, 12);

  // Neck and rounded head.
  m.fbox(CX + 4, 3, bz0, CX + 4, 4, bz1, 11);
  for (let y = 4; y <= 6; y++) m.roundLayer(y, CX + 4, bz0 - 1, CX + 6, bz1 + 1, 11, true);

  // Snout: rounded, pale, with a night nose and a bubblegum tongue.
  m.roundLayer(5, CX + 7, CZ - 1, CX + 7, CZ + 1, 12, true);
  m.half((CX + 8) * 2, 5 * 2 + 1, CZ * 2, 15).half((CX + 8) * 2, 5 * 2 + 1, CZ * 2 + 1, 15);
  m.half((CX + 8) * 2, 5 * 2, CZ * 2, 10).half((CX + 8) * 2, 5 * 2, CZ * 2 + 1, 10);

  // Eyes: quarter blocks so they're the right size for a face.
  for (const ez of [CZ - 1, CZ + 1]) {
    m.quarter((CX + 7) * 4, 6 * 4 + 2, ez * 4 + 1, 15);
    m.quarter((CX + 7) * 4, 6 * 4 + 2, ez * 4 + 2, 15);
  }
  // Floppy ears: wedges sloping down the sides of the head. (No half-block
  // detail here — placing one inside the head's own cell would delete the
  // block holding the ear up.)
  for (const [ez, high] of [[bz0 - 1, HIGH.negZ], [bz1 + 1, HIGH.posZ]]) {
    m.full(CX + 5, 7, ez, 11, 1, high);
  }
  // Curled tail: each half block shares a FACE with the last, so the curl
  // holds together (a diagonal staircase only touches at edges).
  const tz = CZ * 2;
  m.half((CX - 4) * 2 + 1, 8, tz, 11);   // against the body's -X face
  m.half((CX - 4) * 2 + 1, 9, tz, 11);
  m.half((CX - 4) * 2 + 1, 10, tz, 11);
  m.half((CX - 4) * 2, 10, tz, 11);      // curls outward
  m.half((CX - 4) * 2, 11, tz, 12);      // white tip
  return m.cells;
}

// --- Race car ------------------------------------------------------------
// Long low body with a rounded nose cone, wedge windshield, rounded wheel
// arches, mirrors and exhausts in small blocks.
function racecar() {
  const m = maker();
  const z0 = CZ - 2, z1 = CZ + 2;

  // The tub reaches down to y=1 so it meets the wheels, which sit on the
  // ground at y=0 — otherwise the whole car hovers.
  m.fbox(CX - 5, 1, z0, CX + 4, 1, z1, 15);                 // floor pan
  m.roundLayer(2, CX - 5, z0, CX + 4, z1, 0, true);         // main tub
  // Nose: three courses narrowing to a rounded point.
  m.roundLayer(2, CX + 5, CZ - 1, CX + 6, CZ + 1, 0, true);
  m.domeRing(3, CX + 4, CZ - 1, CX + 5, CZ + 1, 0);
  m.half((CX + 7) * 2, 2 * 2, CZ * 2, 0).half((CX + 7) * 2, 2 * 2, CZ * 2 + 1, 0);
  m.half((CX + 7) * 2, 2 * 2 + 1, CZ * 2, 2).half((CX + 7) * 2, 2 * 2 + 1, CZ * 2 + 1, 2);

  // Cockpit: raised sides, wedge windshield, dark seat.
  for (const cz of [z0, z1]) m.fbox(CX - 2, 3, cz, CX + 1, 3, cz, 0);
  m.fbox(CX - 2, 3, CZ, CX - 1, 3, CZ, 15);
  for (let z = z0; z <= z1; z++) m.full(CX + 2, 3, z, 6, 1, HIGH.posX);
  m.roundLayer(4, CX - 3, z0, CX - 2, z1, 0, true);         // headrest fairing

  // Wheels: dark, on the ground, with rounded arches over them.
  for (const [wx, wz] of [[CX - 4, z0 - 1], [CX - 4, z1 + 1], [CX + 3, z0 - 1], [CX + 3, z1 + 1]]) {
    m.roundLayer(0, wx, wz, wx + 1, wz, 15, true);
    m.roundLayer(1, wx, wz, wx + 1, wz, 15, true);
    // Arch sits straight on top of the wheel (y=2), not a block clear of it.
    const side = wz < CZ ? HIGH.posZ : HIGH.negZ;
    m.full(wx, 2, wz, 0, 3, side);
    m.full(wx + 1, 2, wz, 0, 3, side);
  }

  // Rear wing on two pylons, each two half blocks tall so they actually
  // reach the wing above.
  for (const pz of [CZ - 1, CZ + 1]) {
    m.half((CX - 5) * 2 + 1, 6, pz * 2, 14);
    m.half((CX - 5) * 2 + 1, 7, pz * 2, 14);
  }
  for (let z = z0; z <= z1; z++) m.full(CX - 5, 4, z, 14);
  for (const ez of [CZ - 1, CZ + 1]) {
    m.quarter((CX - 6) * 4 + 3, 2 * 4 + 1, ez * 4 + 2, 13);   // exhausts
  }
  // Mirrors, sat on the cockpit sides and overlapping their footprint.
  for (const mz of [z0, z1]) m.half((CX + 1) * 2, 4 * 2, mz * 2, 12);
  return m.cells;
}

// --- Tree ----------------------------------------------------------------
// Tapered trunk with root flare, a big rounded two-tone canopy, apples.
function tree() {
  const m = maker();

  // Root flare using upside-down rounds, then a tapering trunk.
  m.fbox(CX - 1, 0, CZ - 1, CX, 0, CZ, 11);
  for (const [x, z, r] of [
    [CX - 2, CZ - 1, UNDER.posX], [CX - 2, CZ, UNDER.posX],
    [CX + 1, CZ - 1, UNDER.negX], [CX + 1, CZ, UNDER.negX],
    [CX - 1, CZ - 2, UNDER.posZ], [CX, CZ - 2, UNDER.posZ],
    [CX - 1, CZ + 1, UNDER.negZ], [CX, CZ + 1, UNDER.negZ],
  ]) m.full(x, 0, z, 11, 3, r);
  for (let y = 1; y <= 4; y++) m.fbox(CX - 1, y, CZ - 1, CX, y, CZ, 11);
  // A branch stub, so it isn't just a post.
  m.half((CX + 1) * 2, 4 * 2, CZ * 2, 11).half((CX + 1) * 2 + 1, 4 * 2 + 1, CZ * 2, 11);

  // Canopy: rounded layers, darker at the bottom, lighter on top.
  m.roundLayer(5, CX - 3, CZ - 3, CX + 2, CZ + 2, 4, true);
  m.roundLayer(6, CX - 4, CZ - 4, CX + 3, CZ + 3, 4, true);
  m.roundLayer(7, CX - 4, CZ - 4, CX + 3, CZ + 3, 3, true);
  m.roundLayer(8, CX - 3, CZ - 3, CX + 2, CZ + 2, 3, true);
  m.domeRing(9, CX - 2, CZ - 2, CX + 1, CZ + 1, 3);
  m.domeRing(10, CX - 1, CZ - 1, CX, CZ, 3);
  // Half-block crown so the top is domed rather than cut flat.
  for (const hx of [CX * 2 - 1, CX * 2]) {
    for (const hz of [CZ * 2 - 1, CZ * 2]) m.half(hx, 22, hz, 3);
  }

  // Apples: half blocks pressed against a canopy face, so each one is
  // genuinely touching a leaf block rather than hanging in the air.
  // (Canopy at y=6 and y=7 spans x CX-4..CX+3, z CZ-4..CZ+3.)
  m.half((CX + 4) * 2, 6 * 2, CZ * 2, 0);          // on the +X face
  m.half((CX - 4) * 2 - 1, 7 * 2, (CZ - 1) * 2, 0); // on the -X face
  m.half(CX * 2, 7 * 2, (CZ + 4) * 2, 0);           // on the +Z face
  m.half((CX + 1) * 2, 6 * 2, (CZ - 4) * 2 - 1, 0); // on the -Z face
  return m.cells;
}

// --- Castle --------------------------------------------------------------
// Keep with two proper round towers, arched gate, crenellated walls, and a
// flag. Uses standing rounds all the way up the towers.
function castle() {
  const m = maker();
  const x0 = CX - 4, x1 = CX + 4, z0 = CZ - 3, z1 = CZ + 3;

  // Keep: rounded-corner walls on a wider plinth.
  m.roundLayer(0, x0 - 1, z0 - 1, x1 + 1, z1 + 1, 14, true);
  for (let y = 1; y <= 8; y++) m.roundLayer(y, x0, z0, x1, z1, 13, y === 1);

  // Arched gate on the +Z face.
  m.fbox(CX - 1, 1, z1, CX + 1, 3, z1, 15);
  m.full(CX, 4, z1, 15);
  m.full(CX - 1, 4, z1, 15, 3, CORNER.minmax);
  m.full(CX + 1, 4, z1, 15, 3, CORNER.maxmax);
  for (let q = 0; q <= 3; q++) m.quarter(CX * 4 + q, 5 * 4, z1 * 4 + 3, 11); // lintel

  // Arrow slits in quarter blocks.
  for (const [sx, sz] of [[x0, CZ], [x1, CZ], [CX - 3, z0], [CX + 3, z0]]) {
    for (let q = 0; q <= 3; q++) {
      m.quarter(sx * 4 + (sx === x1 ? 3 : 0), 5 * 4 + q, sz * 4 + 2, 15);
    }
  }

  // Crenellations in half blocks — finer teeth than whole blocks allow.
  for (let x = x0; x <= x1; x++) {
    for (const z of [z0, z1]) {
      if ((x - x0) % 2 === 0) {
        m.half(x * 2, 9 * 2, z * 2, 13).half(x * 2, 9 * 2, z * 2 + 1, 13);
        m.half(x * 2 + 1, 9 * 2, z * 2, 13).half(x * 2 + 1, 9 * 2, z * 2 + 1, 13);
      }
    }
  }
  for (let z = z0 + 1; z <= z1 - 1; z++) {
    for (const x of [x0, x1]) {
      if ((z - z0) % 2 === 0) {
        m.half(x * 2, 9 * 2, z * 2, 13).half(x * 2 + 1, 9 * 2, z * 2, 13);
        m.half(x * 2, 9 * 2, z * 2 + 1, 13).half(x * 2 + 1, 9 * 2, z * 2 + 1, 13);
      }
    }
  }

  // Two round towers on the front corners, taller than the keep, each with
  // a conical wedge roof.
  for (const tx of [x0 - 1, x1 - 1]) {
    for (let y = 0; y <= 11; y++) {
      m.roundLayer(y, tx, z1, tx + 1, z1 + 1, y % 4 === 3 ? 14 : 13, true);
    }
    // Battlement ring, then a cone.
    m.roundLayer(12, tx, z1, tx + 1, z1 + 1, 13, true);
    m.full(tx, 13, z1, 0, 3, CORNER.minmin);
    m.full(tx + 1, 13, z1, 0, 3, CORNER.maxmin);
    m.full(tx + 1, 13, z1 + 1, 0, 3, CORNER.maxmax);
    m.full(tx, 13, z1 + 1, 0, 3, CORNER.minmax);
    m.half(tx * 2 + 1, 14 * 2, z1 * 2 + 1, 0);
  }

  // Flag on a pole, standing on the keep's rear wall. The pole starts with a
  // whole block at y=9 (replacing that crenellation) so it isn't left half a
  // block clear of the half-block teeth, and the flag overlaps the pole's own
  // height range so the two actually share a face.
  m.full(x1, 9, z0, 13);
  for (let y = 10; y <= 13; y++) m.full(x1, y, z0, 11);
  for (const hy of [24, 25]) {
    for (const hx of [x1 * 2 - 2, x1 * 2 - 1]) {
      m.half(hx, hy, z0 * 2, 9).half(hx, hy, z0 * 2 + 1, 9);
    }
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
