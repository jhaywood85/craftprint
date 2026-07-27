// Voxel world: a sparse map of grid cells -> block record { c, s, r, g }.
//
// The grid is stored in QUARTER units so blocks can be full, half, or quarter
// size: a full block spans 4 quarter-units per edge, a half block 2, a
// quarter block 1. A block record's anchor is its minimum corner (x, y, z)
// in quarter units, and it occupies [x, x+g) x [y, y+g) x [z, z+g).
// Anchors are always aligned to their own size (x % g === 0, etc.), so half
// blocks sit on the half grid and quarter blocks on the quarter grid.
//
// Each block holds:
//   c: palette color index
//   s: shape id (0 = full cube, 1 = wedge — a cube with one vertical edge
//      sliced off at 45°)
//   r: orientation index, 0..23 (see shapes.js ORIENTS). 0..3 are the legacy
//      quarter-turns about the vertical (y) axis; higher values are tipped
//      orientations. Only meaningful for shapes that aren't symmetric.
//   g: edge length in quarter units — 4 (full), 2 (half), or 1 (quarter).
//
// Alongside the anchor map we keep an occupancy map (every quarter cell a
// block covers -> its anchor key) so point queries — collision, placement
// overlap, erase picking — stay O(1) whatever the block sizes are.

export const SIZE = 32;   // footprint in full blocks (x and z)
export const HEIGHT = 32; // max build height in full blocks (y)
export const Q = 4;       // quarter units per full block edge
export const QSIZE = SIZE * Q;
export const QHEIGHT = HEIGHT * Q;

export const SHAPE_CUBE = 0;
export const SHAPE_WEDGE = 1;
export const SHAPE_ROUND = 2; // vertical quarter-cylinder: rounds a corner in plan view
export const SHAPE_CURVE = 3; // horizontal quarter-cylinder: a wedge with a curved slope

export const GRID_SIZES = [4, 2, 1]; // full, half, quarter (in quarter units)

const key = (x, y, z) => `${x},${y},${z}`;

// Normalize whatever set() is given into a block record. Accepts a bare color
// number (legacy call) or a partial/full record.
function toRecord(value) {
  if (typeof value === 'number') return { c: value, s: SHAPE_CUBE, r: 0, g: Q };
  const g = value.g === 1 || value.g === 2 ? value.g : Q;
  return {
    c: value.c ?? 0,
    s: value.s ?? SHAPE_CUBE,
    r: ((value.r ?? 0) % 24 + 24) % 24,
    g,
  };
}

export class VoxelWorld {
  constructor() {
    this.cells = new Map(); // anchor "x,y,z" (quarter units) -> { c, s, r, g }
    this.occ = new Map();   // every covered quarter cell "x,y,z" -> anchor key
  }

  // Region [x,x+g) etc. fully inside the build volume? Coordinates in quarter
  // units. g defaults to a single quarter cell (point query).
  inBounds(x, y, z, g = 1) {
    return x >= 0 && x + g <= QSIZE && y >= 0 && y + g <= QHEIGHT && z >= 0 && z + g <= QSIZE;
  }

  // Is this quarter cell inside any block?
  has(x, y, z) {
    return this.occ.has(key(x, y, z));
  }

  // The block covering this quarter cell: { x, y, z, rec } (anchor) or null.
  blockAt(x, y, z) {
    const a = this.occ.get(key(x, y, z));
    if (a === undefined) return null;
    const [ax, ay, az] = a.split(',').map(Number);
    return { x: ax, y: ay, z: az, rec: this.cells.get(a) };
  }

  // Is the whole g-sized region free of blocks?
  regionFree(x, y, z, g) {
    for (let i = 0; i < g; i++)
      for (let j = 0; j < g; j++)
        for (let k = 0; k < g; k++)
          if (this.occ.has(key(x + i, y + j, z + k))) return false;
    return true;
  }

  // Color index of the block anchored at this cell (or undefined). Kept
  // returning the color so callers that treat a cell as "its color" work.
  get(x, y, z) {
    return this.cells.get(key(x, y, z))?.c;
  }

  // Full block record { c, s, r, g } anchored exactly here (or undefined).
  getCell(x, y, z) {
    return this.cells.get(key(x, y, z));
  }

  set(x, y, z, value) {
    const rec = toRecord(value);
    // Snap the anchor to the block's own grid.
    x -= x % rec.g; y -= y % rec.g; z -= z % rec.g;
    if (!this.inBounds(x, y, z, rec.g)) return false;
    const k = key(x, y, z);
    // Clear whatever the new block would overlap (normally just a same-anchor
    // replace; overlapping strangers are removed defensively so the occupancy
    // map can never disagree with the anchor map).
    this.remove(x, y, z);
    for (let i = 0; i < rec.g; i++)
      for (let j = 0; j < rec.g; j++)
        for (let kk = 0; kk < rec.g; kk++) {
          const ck = key(x + i, y + j, z + kk);
          const other = this.occ.get(ck);
          if (other !== undefined && other !== k) this._removeByKey(other);
          this.occ.set(ck, k);
        }
    this.cells.set(k, rec);
    return true;
  }

  remove(x, y, z) {
    return this._removeByKey(key(x, y, z));
  }

  _removeByKey(k) {
    const rec = this.cells.get(k);
    if (!rec) return false;
    const [x, y, z] = k.split(',').map(Number);
    for (let i = 0; i < rec.g; i++)
      for (let j = 0; j < rec.g; j++)
        for (let kk = 0; kk < rec.g; kk++)
          this.occ.delete(key(x + i, y + j, z + kk));
    this.cells.delete(k);
    return true;
  }

  clear() {
    this.cells.clear();
    this.occ.clear();
  }

  get count() {
    return this.cells.size;
  }

  // fn(x, y, z, record) — anchor in quarter units, record is { c, s, r, g }.
  forEach(fn) {
    for (const [k, rec] of this.cells) {
      const [x, y, z] = k.split(',').map(Number);
      fn(x, y, z, rec);
    }
  }

  // Compact rows. Full-size blocks on the whole-block grid keep the legacy
  // block-unit format ([x, y, z, c] or [x, y, z, c, s, r], coordinates in
  // FULL blocks) so old saves round-trip unchanged. Anything smaller is
  // written as 7 elements in QUARTER units: [qx, qy, qz, c, s, r, g].
  toArray() {
    const out = [];
    this.forEach((x, y, z, rec) => {
      if (rec.g === Q && x % Q === 0 && y % Q === 0 && z % Q === 0) {
        if (rec.s === SHAPE_CUBE && rec.r === 0) out.push([x / Q, y / Q, z / Q, rec.c]);
        else out.push([x / Q, y / Q, z / Q, rec.c, rec.s, rec.r]);
      } else {
        out.push([x, y, z, rec.c, rec.s, rec.r, rec.g]);
      }
    });
    return out;
  }

  loadArray(arr) {
    this.clear();
    for (const row of arr) {
      if (row.length >= 7) {
        const [x, y, z, c, s, r, g] = row;
        this.set(x, y, z, { c, s, r, g });
      } else {
        const [x, y, z, c, s, r] = row;
        this.set(x * Q, y * Q, z * Q, { c, s, r, g: Q });
      }
    }
  }

  // Bounding box of placed blocks in QUARTER units, or null when empty.
  // max is EXCLUSIVE (anchor + size), so (max - min) / 4 is the size in
  // full-block units.
  bounds() {
    if (this.cells.size === 0) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    this.forEach((x, y, z, rec) => {
      const p = [x, y, z];
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] + rec.g > max[i]) max[i] = p[i] + rec.g;
      }
    });
    return { min, max };
  }

  // All quarter cells face-adjacent to the block anchored at (x,y,z): used to
  // walk block-to-block connectivity whatever the sizes involved.
  _neighborAnchors(x, y, z, g, out) {
    const probe = (qx, qy, qz) => {
      const a = this.occ.get(key(qx, qy, qz));
      if (a !== undefined) out.add(a);
    };
    for (let i = 0; i < g; i++) {
      for (let j = 0; j < g; j++) {
        probe(x - 1, y + i, z + j); probe(x + g, y + i, z + j); // ±X faces
        probe(x + i, y - 1, z + j); probe(x + i, y + g, z + j); // ±Y faces
        probe(x + i, y + j, z - 1); probe(x + i, y + j, z + g); // ±Z faces
      }
    }
  }

  // Blocks not face-connected to the ground (y = 0). These would print as
  // separate loose pieces, so we warn about them before export.
  // Returns rows [x, y, z, g] in quarter units.
  floatingCells() {
    const visited = new Set();
    const queue = [];
    for (const [k] of this.cells) {
      const [x, y, z] = k.split(',').map(Number);
      if (y === 0) { visited.add(k); queue.push([x, y, z]); }
    }
    while (queue.length) {
      const [x, y, z] = queue.pop();
      const rec = this.cells.get(key(x, y, z));
      const near = new Set();
      this._neighborAnchors(x, y, z, rec.g, near);
      for (const a of near) {
        if (!visited.has(a)) {
          visited.add(a);
          queue.push(a.split(',').map(Number));
        }
      }
    }
    const floating = [];
    this.forEach((x, y, z, rec) => {
      if (!visited.has(key(x, y, z))) floating.push([x, y, z, rec.g]);
    });
    return floating;
  }
}
