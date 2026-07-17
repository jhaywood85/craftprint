// The little rocket that greets first-time builders.
// Palette indexes: 0 Cherry, 1 Tangerine, 2 Sunshine, 6 Sky, 12 Snow.

import { SIZE } from './world.js';

export function starterRocket() {
  const cells = [];
  const cx = Math.floor(SIZE / 2) - 1; // 15
  const cz = Math.floor(SIZE / 2) - 1;
  const add = (x, y, z, c) => cells.push([x, y, z, c]);

  // Body: 3x3 white column, y 0..5.
  for (let y = 0; y <= 5; y++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        add(cx + dx, y, cz + dz, 12);
      }
    }
  }
  // Porthole window: two sky-blue blocks on the front face column.
  add(cx, 3, cz + 1, 6);
  add(cx, 4, cz + 1, 6);

  // Fins: tangerine, sticking out on four sides at the base.
  for (let y = 0; y <= 1; y++) {
    add(cx + 2, y, cz, 1);
    add(cx - 2, y, cz, 1);
    add(cx, y, cz + 2, 1);
    add(cx, y, cz - 2, 1);
  }

  // Nose cone: cherry red, tapering, with a sunshine tip.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      add(cx + dx, 6, cz + dz, 0);
    }
  }
  add(cx, 7, cz, 0);
  add(cx + 1, 7, cz, 0);
  add(cx - 1, 7, cz, 0);
  add(cx, 7, cz + 1, 0);
  add(cx, 7, cz - 1, 0);
  add(cx, 8, cz, 2);

  return cells;
}
