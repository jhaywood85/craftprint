// Voxel world: a sparse map of grid cells -> block record { c, s, r }.
// Grid is SIZE x HEIGHT x SIZE, cells addressed by integer (x, y, z), y is up.
//
// Each cell holds:
//   c: palette color index
//   s: shape id (0 = full cube, 1 = wedge — a cube with one vertical edge
//      sliced off at 45°)
//   r: rotation, 0..3, a quarter-turn count about the vertical (y) axis.
//      Only meaningful for shapes that aren't rotationally symmetric.

export const SIZE = 32;   // footprint (x and z)
export const HEIGHT = 32; // max build height (y)

export const SHAPE_CUBE = 0;
export const SHAPE_WEDGE = 1;

const key = (x, y, z) => `${x},${y},${z}`;

// Normalize whatever set() is given into a block record. Accepts a bare color
// number (legacy call) or a partial/full record.
function toRecord(value) {
  if (typeof value === 'number') return { c: value, s: SHAPE_CUBE, r: 0 };
  return {
    c: value.c ?? 0,
    s: value.s ?? SHAPE_CUBE,
    r: ((value.r ?? 0) % 4 + 4) % 4,
  };
}

export class VoxelWorld {
  constructor() {
    this.cells = new Map(); // "x,y,z" -> { c, s, r }
  }

  inBounds(x, y, z) {
    return x >= 0 && x < SIZE && y >= 0 && y < HEIGHT && z >= 0 && z < SIZE;
  }

  // Color index of the cell (or undefined). Kept returning the color so the
  // many existing callers that treat a cell as "its color" still work.
  get(x, y, z) {
    return this.cells.get(key(x, y, z))?.c;
  }

  // Full block record { c, s, r } (or undefined).
  getCell(x, y, z) {
    return this.cells.get(key(x, y, z));
  }

  has(x, y, z) {
    return this.cells.has(key(x, y, z));
  }

  set(x, y, z, value) {
    if (!this.inBounds(x, y, z)) return false;
    this.cells.set(key(x, y, z), toRecord(value));
    return true;
  }

  remove(x, y, z) {
    return this.cells.delete(key(x, y, z));
  }

  clear() {
    this.cells.clear();
  }

  get count() {
    return this.cells.size;
  }

  // fn(x, y, z, record) — record is the full { c, s, r }.
  forEach(fn) {
    for (const [k, rec] of this.cells) {
      const [x, y, z] = k.split(',').map(Number);
      fn(x, y, z, rec);
    }
  }

  // Compact rows: [x, y, z, c, s, r]. Cubes omit trailing s/r (both 0) so
  // old 4-element saves round-trip unchanged.
  toArray() {
    const out = [];
    this.forEach((x, y, z, rec) => {
      if (rec.s === SHAPE_CUBE && rec.r === 0) out.push([x, y, z, rec.c]);
      else out.push([x, y, z, rec.c, rec.s, rec.r]);
    });
    return out;
  }

  loadArray(arr) {
    this.cells.clear();
    for (const [x, y, z, c, s, r] of arr) {
      if (this.inBounds(x, y, z)) this.cells.set(key(x, y, z), toRecord({ c, s, r }));
    }
  }

  // Bounding box of placed blocks, or null when empty.
  // Returned as { min: [x,y,z], max: [x,y,z] } inclusive cell coords.
  bounds() {
    if (this.cells.size === 0) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    this.forEach((x, y, z) => {
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    });
    return { min, max };
  }

  // Cells not face-connected to the ground (y = 0). These would print as
  // separate loose pieces, so we warn about them before export.
  floatingCells() {
    const visited = new Set();
    const queue = [];
    this.forEach((x, y, z) => {
      if (y === 0) {
        const k = key(x, y, z);
        visited.add(k);
        queue.push([x, y, z]);
      }
    });
    const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    while (queue.length) {
      const [x, y, z] = queue.pop();
      for (const [dx, dy, dz] of dirs) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        const k = key(nx, ny, nz);
        if (this.cells.has(k) && !visited.has(k)) {
          visited.add(k);
          queue.push([nx, ny, nz]);
        }
      }
    }
    const floating = [];
    this.forEach((x, y, z) => {
      if (!visited.has(key(x, y, z))) floating.push([x, y, z]);
    });
    return floating;
  }
}
