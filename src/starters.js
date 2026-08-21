// Demo / starter builds: ready-made models a kid can load, spin around, and
// pull apart to see how it was made. Also the fastest way for a teacher to
// show the class what "good" looks like before they start.
//
// Each build() returns rows for world.loadArray(). Rows are FULL-block units
// ([x, y, z, colour] or [x, y, z, colour, shape, orientation]); the `sub()`
// helper emits QUARTER-unit rows for half/quarter-size detailing.
//
// Palette indexes: 0 Cherry, 1 Tangerine, 2 Sunshine, 3 Lime, 4 Grass,
// 5 Seafoam, 6 Sky, 7 Ocean, 8 Grape, 9 Magenta, 10 Bubblegum,
// 11 Chocolate, 12 Snow, 13 Pebble, 14 Storm, 15 Night.
//
// Shapes: 0 cube, 1 wedge, 3 round. Orientation 0..3 are yaw turns; for a
// wedge/round the flat wall faces -X, -Z, +X, +Z respectively and the slope
// falls away from that wall. Higher indexes are tipped poses (see shapes.js).

import { SIZE, Q } from './world.js';

const CX = Math.floor(SIZE / 2) - 1; // 15 — keeps builds centred on the plate
const CZ = Math.floor(SIZE / 2) - 1;

// Small builder so each model reads like a description of itself.
function maker() {
  const cells = [];
  return {
    cells,
    // one full block
    at(x, y, z, c, s = 0, r = 0) { cells.push([x, y, z, c, s, r]); return this; },
    // filled box, inclusive bounds
    box(x0, y0, z0, x1, y1, z1, c) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
          for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
            cells.push([x, y, z, c]);
      return this;
    },
    // hollow box (walls only, open top and bottom)
    walls(x0, y0, z0, x1, y1, z1, c) {
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++)
            if (x === x0 || x === x1 || z === z0 || z === z1) cells.push([x, y, z, c]);
      return this;
    },
    // a smaller block, positioned in quarter units (g: 2 = half, 1 = quarter)
    sub(qx, qy, qz, c, g = 2, s = 0, r = 0) { cells.push([qx, qy, qz, c, s, r, g]); return this; },
  };
}

// --- the builds ------------------------------------------------------------

function rocket() {
  const m = maker();
  m.box(CX - 1, 0, CZ - 1, CX + 1, 5, CZ + 1, 12);      // white body
  m.at(CX, 3, CZ + 1, 6).at(CX, 4, CZ + 1, 6);          // porthole
  for (let y = 0; y <= 1; y++) {                         // four fins
    m.at(CX + 2, y, CZ, 1).at(CX - 2, y, CZ, 1);
    m.at(CX, y, CZ + 2, 1).at(CX, y, CZ - 2, 1);
  }
  m.box(CX - 1, 6, CZ - 1, CX + 1, 6, CZ + 1, 0);        // nose
  m.at(CX, 7, CZ, 0).at(CX + 1, 7, CZ, 0).at(CX - 1, 7, CZ, 0);
  m.at(CX, 7, CZ + 1, 0).at(CX, 7, CZ - 1, 0);
  m.at(CX, 8, CZ, 2);                                    // tip
  return m.cells;
}

function house() {
  const m = maker();
  const x0 = CX - 3, x1 = CX + 3, z0 = CZ - 3, z1 = CZ + 3;
  m.walls(x0, 0, z0, x1, 3, z1, 12);                     // snow walls
  m.box(x0, 0, z0, x1, 0, z1, 13);                       // pebble floor
  m.at(CX, 0, z1, 11).at(CX, 1, z1, 11);                 // door
  m.at(CX - 2, 2, z1, 6).at(CX + 2, 2, z1, 6);           // front windows
  m.at(x0, 2, CZ, 6).at(x1, 2, CZ, 6);                   // side windows
  // Pitched roof: wedges on each edge so the gable is a clean triangle.
  for (let z = z0; z <= z1; z++) {
    for (const [y, inset] of [[4, 3], [5, 2], [6, 1]]) {
      m.at(CX - inset, y, z, 0, 1, 2);                    // slope down to -X
      m.at(CX + inset, y, z, 0, 1, 0);                    // slope down to +X
      for (let x = CX - inset + 1; x <= CX + inset - 1; x++) m.at(x, y, z, 0);
    }
  }
  m.box(CX, 7, z0, CX, 7, z1, 0);                        // ridge
  m.box(CX + 2, 5, CZ - 2, CX + 2, 8, CZ - 2, 13);       // chimney
  return m.cells;
}

function puppy() {
  const m = maker();
  // Snow paws, a raised head on a short neck, and a pale muzzle — without
  // those the whole dog reads as one brown lump.
  for (const [x, z] of [[CX - 1, CZ - 1], [CX - 1, CZ + 1], [CX + 2, CZ - 1], [CX + 2, CZ + 1]]) {
    m.at(x, 0, z, 12);                                   // paws
  }
  m.box(CX - 1, 1, CZ - 1, CX + 2, 2, CZ + 1, 11);       // body
  m.box(CX + 3, 2, CZ - 1, CX + 3, 2, CZ + 1, 11);       // neck
  m.box(CX + 3, 3, CZ - 1, CX + 4, 4, CZ + 1, 11);       // head, a step higher
  m.at(CX + 3, 5, CZ - 1, 11).at(CX + 3, 5, CZ + 1, 11); // ears
  m.at(CX + 4, 4, CZ - 1, 15).at(CX + 4, 4, CZ + 1, 15); // eyes
  m.at(CX + 5, 3, CZ, 12);                               // muzzle
  m.at(CX + 5, 4, CZ, 15);                               // nose
  m.box(CX, 1, CZ, CX + 1, 1, CZ, 12);                   // pale chest/belly
  m.at(CX - 2, 2, CZ, 11).at(CX - 2, 3, CZ, 11);         // tail, wagging up
  return m.cells;
}

function racecar() {
  const m = maker();
  m.box(CX - 3, 1, CZ - 1, CX + 3, 1, CZ + 1, 0);        // chassis
  m.box(CX - 3, 0, CZ - 1, CX + 3, 0, CZ + 1, 0);
  for (let z = CZ - 1; z <= CZ + 1; z++) {
    m.at(CX + 4, 1, z, 0, 1, 0);                          // pointed nose
    m.at(CX + 4, 0, z, 0);
  }
  m.box(CX - 1, 2, CZ - 1, CX + 1, 2, CZ + 1, 0);        // cockpit sides
  for (let z = CZ - 1; z <= CZ + 1; z++) m.at(CX + 2, 2, z, 6, 1, 0); // windshield
  m.at(CX, 2, CZ, 15);                                   // seat
  for (const [x, z] of [[CX - 2, CZ - 2], [CX - 2, CZ + 2], [CX + 2, CZ - 2], [CX + 2, CZ + 2]]) {
    m.at(x, 0, z, 15);                                   // wheels
    m.at(x, 1, z, 14);
  }
  m.box(CX - 4, 2, CZ - 1, CX - 4, 2, CZ + 1, 14);       // spoiler
  m.at(CX - 4, 1, CZ, 14);
  return m.cells;
}

function tree() {
  const m = maker();
  m.box(CX, 0, CZ, CX, 3, CZ, 11);                       // trunk
  for (let dx = -2; dx <= 2; dx++) {                     // wide canopy layer
    for (let dz = -2; dz <= 2; dz++) {
      if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
      m.at(CX + dx, 4, CZ + dz, 4);
    }
  }
  m.box(CX - 1, 5, CZ - 1, CX + 1, 5, CZ + 1, 4);        // narrower layer
  m.at(CX, 6, CZ, 4);                                    // top
  m.at(CX + 2, 4, CZ, 0).at(CX - 1, 5, CZ + 1, 0);       // two apples
  // A couple of half-size leaves soften the silhouette.
  m.sub((CX + 1) * Q, 6 * Q, CZ * Q, 4);
  m.sub((CX - 1) * Q + 2, 6 * Q, CZ * Q + 2, 4);
  return m.cells;
}

function castle() {
  const m = maker();
  const x0 = CX - 2, x1 = CX + 2, z0 = CZ - 2, z1 = CZ + 2;
  m.walls(x0, 0, z0, x1, 6, z1, 13);                     // pebble keep
  m.box(x0, 0, z0, x1, 0, z1, 13);
  m.at(CX, 0, z1, 15).at(CX, 1, z1, 15);                 // gateway
  m.at(x0, 3, CZ, 15).at(x1, 3, CZ, 15);                 // arrow slits
  // Crenellations: alternating blocks around the rim.
  for (let x = x0; x <= x1; x += 2) { m.at(x, 7, z0, 13); m.at(x, 7, z1, 13); }
  for (let z = z0 + 2; z <= z1 - 2; z += 2) { m.at(x0, 7, z, 13); m.at(x1, 7, z, 13); }
  // Rounded corner accents, tipped upright so the curve faces outward.
  m.at(x0, 1, z0, 13, 3, 12).at(x1, 1, z1, 13, 3, 4);
  // Flag: the pole stands on a corner crenellation, not over the hollow
  // middle — otherwise it prints as loose pieces.
  m.box(x1, 8, z1, x1, 10, z1, 11);
  m.at(x1 - 1, 10, z1, 9).at(x1 - 1, 9, z1, 9);
  return m.cells;
}

export const STARTERS = [
  { id: 'rocket',  emoji: '🚀', name: 'Rocket',   blurb: 'Fins and a pointy nose', build: rocket },
  { id: 'house',   emoji: '🏠', name: 'House',    blurb: 'Wedge roof, real windows', build: house },
  { id: 'puppy',   emoji: '🐶', name: 'Puppy',    blurb: 'Floppy ears and a tail', build: puppy },
  { id: 'racecar', emoji: '🏎️', name: 'Race car', blurb: 'Wedge nose, fat wheels', build: racecar },
  { id: 'tree',    emoji: '🌳', name: 'Tree',     blurb: 'With apples to find', build: tree },
  { id: 'castle',  emoji: '🏰', name: 'Castle',   blurb: 'Battlements and a flag', build: castle },
];

export const starterById = (id) => STARTERS.find((s) => s.id === id) || null;

// The build first-time players land in.
export const starterRocket = rocket;
