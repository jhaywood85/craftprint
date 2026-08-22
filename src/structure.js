// Structural analysis: does this build hold together as a PHYSICAL PRINT?
//
// The world's floatingCells() knows which blocks share a grid face, but a
// shared grid face is not the same as actually touching: a cube sitting on a
// wedge's slope shares a face cell yet only touches along a line, and two
// diagonal blocks meet at a corner point. Line and point contacts snap off a
// real print. This module measures the REAL contact area between blocks.
//
// How: every CraftPrint shape is convex, so "inside the solid" is simply
// "behind all of its face planes". Two blocks can only touch on the shared
// boundary plane between their bounding boxes; we sample a fine grid of
// points on that plane, nudge each sample a hair into either block, and ask
// both solids whether they contain it. The counted samples give the contact
// area in quarter-units² (a full block face = 16, a quarter-block face = 1).
//
// analyze(world) then walks the contact graph from the ground up:
//   loose  — blocks with no real-contact path to the ground (corner/edge/
//            slope-line contact does NOT count). These print as loose bits.
//   skinny — a joint (graph bridge) whose whole connection is a tiny patch:
//            snap-hazard ankles and pylons worth thickening.
// gluePlan(world) proposes the smallest set of bridging cubes that welds
// every loose piece onto the grounded body (applied via undo-able changes).

import { VoxelWorld, SHAPE_CUBE, Q, QSIZE, QHEIGHT } from './world.js';
import { shapeTriangles } from './shapes.js';

// Contact below this many quarter-units² doesn't count as attached. A quarter
// block's full face is exactly 1; line/point contacts measure ~0.
export const ATTACH_MIN = 0.45;

// A bridge joint at or below this area is "skinny" (a single quarter-block
// face is 1; a half-block face is 4 and passes).
export const SKINNY_MAX = 1.75;

// Sampling: SAMPLES² points per quarter-unit cell of shared plane, each
// nudged EPS quarter units into the solid on either side. EPS must stay well
// below sampleSpacing × (flattest facet slope of the round shapes, ~0.066),
// or a tangent line contact (cube resting on the crown of a curve) would
// measure as a strip of real area.
const SAMPLES = 4;
const EPS = 0.004;

// --- Convex point-in-shape ---------------------------------------------------

// Face planes of a shape at a given orientation, in unit-cell space:
// [{ n: [x,y,z], d }] with the solid on the n·p <= d side. Derived from the
// shared triangle mesh, so the analysis matches the exported geometry exactly.
const PLANES = new Map();
function planesFor(shape, rot) {
  const key = `${shape}:${rot}`;
  let planes = PLANES.get(key);
  if (planes) return planes;
  planes = [];
  const seen = new Set();
  for (const [a, b, c] of shapeTriangles(shape, rot)) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n);
    if (len < 1e-9) continue;
    n = n.map((x) => x / len);
    const d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
    const k = n.map((x) => x.toFixed(5)).join(',') + '|' + d.toFixed(5);
    if (!seen.has(k)) { seen.add(k); planes.push({ n, d }); }
  }
  PLANES.set(key, planes);
  return planes;
}

// Is the world-space point (quarter units) inside this block's solid?
// blk: { p: [x,y,z] anchor, g, s, r }. Assumes the point is already within
// the block's bounding box (contact sampling guarantees that).
function insideBlock(blk, px, py, pz) {
  if (blk.s === SHAPE_CUBE) return true;
  const ux = (px - blk.p[0]) / blk.g;
  const uy = (py - blk.p[1]) / blk.g;
  const uz = (pz - blk.p[2]) / blk.g;
  for (const { n, d } of planesFor(blk.s, blk.r)) {
    if (n[0] * ux + n[1] * uy + n[2] * uz > d + 1e-6) return false;
  }
  return true;
}

// --- Contact measurement -----------------------------------------------------

/**
 * Real contact area between two non-overlapping blocks, in quarter-units².
 * Blocks touch only where their bounding boxes share a boundary plane; the
 * overlap rectangle on that plane is sampled on both sides.
 */
export function contactArea(A, B) {
  for (let axis = 0; axis < 3; axis++) {
    const aLo = A.p[axis], aHi = aLo + A.g;
    const bLo = B.p[axis], bHi = bLo + B.g;
    let plane, dir; // dir: +1 => A below the plane, B above
    if (aHi === bLo) { plane = aHi; dir = 1; }
    else if (bHi === aLo) { plane = aLo; dir = -1; }
    else continue;

    const ax1 = (axis + 1) % 3, ax2 = (axis + 2) % 3;
    const lo1 = Math.max(A.p[ax1], B.p[ax1]);
    const hi1 = Math.min(A.p[ax1] + A.g, B.p[ax1] + B.g);
    const lo2 = Math.max(A.p[ax2], B.p[ax2]);
    const hi2 = Math.min(A.p[ax2] + A.g, B.p[ax2] + B.g);
    if (hi1 <= lo1 || hi2 <= lo2) continue; // edge/corner touch only

    // Two cubes: the whole overlap rectangle is solid on both sides.
    if (A.s === SHAPE_CUBE && B.s === SHAPE_CUBE) return (hi1 - lo1) * (hi2 - lo2);

    const pA = [0, 0, 0], pB = [0, 0, 0];
    pA[axis] = plane - dir * EPS;
    pB[axis] = plane + dir * EPS;
    let hits = 0;
    for (let u = lo1 * SAMPLES; u < hi1 * SAMPLES; u++) {
      const c1 = (u + 0.5) / SAMPLES;
      for (let v = lo2 * SAMPLES; v < hi2 * SAMPLES; v++) {
        const c2 = (v + 0.5) / SAMPLES;
        pA[ax1] = c1; pA[ax2] = c2;
        pB[ax1] = c1; pB[ax2] = c2;
        if (insideBlock(A, pA[0], pA[1], pA[2]) && insideBlock(B, pB[0], pB[1], pB[2])) hits++;
      }
    }
    return hits / (SAMPLES * SAMPLES);
  }
  return 0;
}

/** Real contact area between a block and the build plate (y = 0). */
export function groundArea(A) {
  if (A.p[1] !== 0) return 0;
  if (A.s === SHAPE_CUBE) return A.g * A.g;
  const p = [0, EPS, 0];
  let hits = 0;
  for (let u = A.p[0] * SAMPLES; u < (A.p[0] + A.g) * SAMPLES; u++) {
    p[0] = (u + 0.5) / SAMPLES;
    for (let v = A.p[2] * SAMPLES; v < (A.p[2] + A.g) * SAMPLES; v++) {
      p[2] = (v + 0.5) / SAMPLES;
      if (insideBlock(A, p[0], p[1], p[2])) hits++;
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

// --- Whole-build analysis ----------------------------------------------------

function collectBlocks(world) {
  const blocks = [];
  world.forEach((x, y, z, rec) => {
    blocks.push({ p: [x, y, z], g: rec.g, s: rec.s, r: rec.r, c: rec.c, i: blocks.length });
  });
  return blocks;
}

// Candidate touching pairs: blocks whose boxes share at least one grid face
// cell (found via the occupancy map). Contact is then measured for real.
function touchingPairs(world, blocks) {
  const index = new Map(); // anchor key -> block index
  for (const b of blocks) index.set(b.p.join(','), b.i);
  const pairs = [];
  const seen = new Set();
  for (const b of blocks) {
    const near = new Set();
    world._neighborAnchors(b.p[0], b.p[1], b.p[2], b.g, near);
    for (const a of near) {
      const j = index.get(a);
      if (j === undefined || j === b.i) continue;
      const key = b.i < j ? `${b.i},${j}` : `${j},${b.i}`;
      if (!seen.has(key)) { seen.add(key); pairs.push([Math.min(b.i, j), Math.max(b.i, j)]); }
    }
  }
  return pairs;
}

/**
 * Full structural check. Returns:
 *   loose:  [[x, y, z, g], ...] blocks with no real-contact path to ground
 *   skinny: [[x, y, z, g], ...] blocks on either side of a skinny bridge joint
 *   attachedKeys: Set of "x,y,z" anchors that ARE properly attached
 */
export function analyze(world) {
  const blocks = collectBlocks(world);
  const n = blocks.length;
  if (n === 0) return { loose: [], skinny: [], attachedKeys: new Set() };

  const pairs = touchingPairs(world, blocks);
  const adj = Array.from({ length: n + 1 }, () => []); // node n = the ground
  const addEdge = (a, b, area) => {
    adj[a].push({ to: b, area });
    adj[b].push({ to: a, area });
  };
  for (const [i, j] of pairs) {
    const area = contactArea(blocks[i], blocks[j]);
    if (area >= ATTACH_MIN) addEdge(i, j, area);
  }
  for (const b of blocks) {
    const area = groundArea(b);
    if (area >= ATTACH_MIN) addEdge(b.i, n, area);
  }

  // Attached = reachable from the ground node through real contacts.
  const attached = new Array(n + 1).fill(false);
  attached[n] = true;
  const stack = [n];
  while (stack.length) {
    for (const { to } of adj[stack.pop()]) {
      if (!attached[to]) { attached[to] = true; stack.push(to); }
    }
  }

  const loose = [];
  const attachedKeys = new Set();
  for (const b of blocks) {
    if (attached[b.i]) attachedKeys.add(b.p.join(','));
    else loose.push([b.p[0], b.p[1], b.p[2], b.g]);
  }

  // Skinny joints: bridge edges of the attached graph whose contact area is
  // tiny and whose weaker side carries at least a couple of blocks — the
  // classic "thin ankle" that snaps in a backpack.
  const skinny = [];
  const skinnySeen = new Set();
  if (loose.length < n) {
    const disc = new Array(n + 1).fill(-1);
    const low = new Array(n + 1).fill(0);
    const size = new Array(n + 1).fill(0); // blocks (not ground) in DFS subtree
    let timer = 0;
    // Iterative DFS from the ground node over the attached subgraph.
    const frames = [{ u: n, parentEdge: -1, ei: 0 }];
    disc[n] = low[n] = timer++;
    const flag = (idx) => {
      if (idx === n) return;
      const b = blocks[idx];
      const k = b.p.join(',');
      if (!skinnySeen.has(k)) { skinnySeen.add(k); skinny.push([b.p[0], b.p[1], b.p[2], b.g]); }
    };
    while (frames.length) {
      const f = frames[frames.length - 1];
      if (f.ei < adj[f.u].length) {
        const edge = adj[f.u][f.ei++];
        const v = edge.to;
        if (!attached[v]) continue;
        if (disc[v] === -1) {
          disc[v] = low[v] = timer++;
          size[v] = v === n ? 0 : 1;
          frames.push({ u: v, parentEdge: f.u, ei: 0, viaArea: edge.area });
        } else if (v !== f.parentEdge) {
          if (disc[v] < low[f.u]) low[f.u] = disc[v];
        }
      } else {
        frames.pop();
        if (frames.length) {
          const parent = frames[frames.length - 1];
          if (low[f.u] < low[parent.u]) low[parent.u] = low[f.u];
          size[parent.u] += size[f.u];
          // Bridge: nothing below f.u reaches back above parent.u. The DFS
          // is rooted at the ground, so the subtree under the bridge is the
          // hanging piece — only worth flagging when it's more than a lone
          // decorative block (those are fine on any joint).
          if (low[f.u] > disc[parent.u] && f.viaArea <= SKINNY_MAX && size[f.u] >= 2) {
            flag(f.u);
            flag(parent.u);
          }
        }
      }
    }
  }

  return { loose, skinny, attachedKeys };
}

// --- Auto-fix ("Glue it") ------------------------------------------------------

const ckey = (x, y, z) => `${x},${y},${z}`;
const cubeAt = (x, y, z) => ({ p: [x, y, z], g: 1, s: SHAPE_CUBE, r: 0 });

// Blocks whose boxes touch the quarter cell at (x,y,z): used to test what a
// glue cube placed there would really touch.
function blocksAround(world, x, y, z) {
  const out = [];
  const seen = new Set();
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = world.blockAt(x + dx, y + dy, z + dz);
    if (b && !seen.has(ckey(b.x, b.y, b.z))) {
      seen.add(ckey(b.x, b.y, b.z));
      out.push({ p: [b.x, b.y, b.z], g: b.rec.g, s: b.rec.s, r: b.rec.r, c: b.rec.c });
    }
  }
  return out;
}

/**
 * Plan the bridging blocks that attach every loose piece to the grounded
 * body: shortest paths of empty cells (BFS), filled with cubes (half-size
 * where there's room, quarter where it's tight). Returns
 * [{ x, y, z, rec: { c, s, r, g } }] ready for app.applyChanges — or [] when
 * there is nothing to fix (and null entries never appear).
 */
export function gluePlan(world) {
  const w = new VoxelWorld();
  w.loadArray(world.toArray());
  const additions = [];

  for (let round = 0; round < 32; round++) {
    const res = analyze(w);
    if (res.loose.length === 0) break;
    const path = findGluePath(w, res);
    if (!path) break; // unfixable island (shouldn't happen in practice)

    // Fill the path: prefer half-size cubes when the aligned half-cell has
    // room — chunkier joints print stronger than a chain of quarter cubes.
    for (const [x, y, z, color] of path.cells) {
      if (w.has(x, y, z)) continue; // already covered by a bigger glue cube
      const hx = x - (x % 2), hy = y - (y % 2), hz = z - (z % 2);
      if (w.inBounds(hx, hy, hz, 2) && w.regionFree(hx, hy, hz, 2)) {
        w.set(hx, hy, hz, { c: color, s: SHAPE_CUBE, r: 0, g: 2 });
        additions.push({ x: hx, y: hy, z: hz, rec: { c: color, s: SHAPE_CUBE, r: 0, g: 2 } });
      } else {
        w.set(x, y, z, { c: color, s: SHAPE_CUBE, r: 0, g: 1 });
        additions.push({ x, y, z, rec: { c: color, s: SHAPE_CUBE, r: 0, g: 1 } });
      }
    }
  }
  return additions;
}

// Multi-source BFS through EMPTY quarter cells, from every loose block toward
// the grounded body (or the build plate). A cell qualifies as a start/goal
// only if a cube placed there would REALLY touch the loose/attached block —
// measured with contactArea, so glue never "attaches" to a slope by a line.
function findGluePath(w, res) {
  const looseKeys = new Set(res.loose.map(([x, y, z]) => ckey(x, y, z)));
  const isLooseBlock = (b) => looseKeys.has(ckey(b.p[0], b.p[1], b.p[2]));
  const isAttachedBlock = (b) => res.attachedKeys.has(ckey(b.p[0], b.p[1], b.p[2]));

  const queue = [];
  const from = new Map(); // cell key -> previous cell key (or 'start')
  const colorOf = new Map();

  for (const [lx, ly, lz, g] of res.loose) {
    const rec = w.getCell(lx, ly, lz);
    const blk = { p: [lx, ly, lz], g, s: rec.s, r: rec.r };
    // Empty cells hugging this block's bounding box.
    for (let i = 0; i < g; i++) {
      for (let j = 0; j < g; j++) {
        const cand = [
          [lx - 1, ly + i, lz + j], [lx + g, ly + i, lz + j],
          [lx + i, ly - 1, lz + j], [lx + i, ly + g, lz + j],
          [lx + i, ly + j, lz - 1], [lx + i, ly + j, lz + g],
        ];
        for (const [cx, cy, cz] of cand) {
          const k = ckey(cx, cy, cz);
          if (from.has(k) || !w.inBounds(cx, cy, cz, 1) || w.has(cx, cy, cz)) continue;
          if (contactArea(cubeAt(cx, cy, cz), blk) < ATTACH_MIN) continue;
          from.set(k, 'start');
          colorOf.set(k, rec.c);
          queue.push([cx, cy, cz]);
        }
      }
    }
  }

  const goalReached = (x, y, z) => {
    if (y === 0) return true; // a cube here stands on the plate
    const me = cubeAt(x, y, z);
    return blocksAround(w, x, y, z).some((b) => isAttachedBlock(b) && contactArea(me, b) >= ATTACH_MIN);
  };

  let head = 0;
  let goal = null;
  const LIMIT = 300000; // safety net for pathological worlds
  while (head < queue.length && queue.length < LIMIT) {
    const [x, y, z] = queue[head++];
    if (goalReached(x, y, z)) { goal = [x, y, z]; break; }
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const k = ckey(nx, ny, nz);
      if (from.has(k) || !w.inBounds(nx, ny, nz, 1) || w.has(nx, ny, nz)) continue;
      // Don't tunnel diagonally past a loose block into free space that only
      // corner-touches it — every step is face-adjacent, so the chain of
      // cubes is always solidly connected to itself.
      from.set(k, ckey(x, y, z));
      colorOf.set(k, colorOf.get(ckey(x, y, z)));
      queue.push([nx, ny, nz]);
    }
  }
  if (!goal) return null;

  const cells = [];
  let k = ckey(goal[0], goal[1], goal[2]);
  while (k && k !== 'start') {
    const [x, y, z] = k.split(',').map(Number);
    cells.push([x, y, z, colorOf.get(k) ?? 0]);
    k = from.get(k);
  }
  return { cells };
}

// Coordinate limits re-exported for callers sizing UI around the analysis.
export { QSIZE, QHEIGHT, Q };
