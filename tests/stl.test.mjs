// Validates the binary STL exporter: structure, watertightness (manifold,
// consistently oriented), correct volume, positive-octant placement, and
// correct y-up -> z-up axis mapping.
//
// Run: node tests/stl.test.mjs

import { blocksToSTL } from '../src/stl.js';
import { shapeUnitVolume } from '../src/shapes.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name} ${detail}`);
  }
}

function parseSTL(buffer) {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  const tris = [];
  let off = 84;
  for (let i = 0; i < count; i++) {
    const normal = [view.getFloat32(off, true), view.getFloat32(off + 4, true), view.getFloat32(off + 8, true)];
    off += 12;
    const verts = [];
    for (let v = 0; v < 3; v++) {
      verts.push([view.getFloat32(off, true), view.getFloat32(off + 4, true), view.getFloat32(off + 8, true)]);
      off += 12;
    }
    off += 2; // attribute byte count
    tris.push({ normal, verts });
  }
  return { count, tris, byteLength: buffer.byteLength };
}

function signedVolume(tris) {
  // Divergence theorem: V = sum( v0 . (v1 x v2) ) / 6, positive when
  // triangles are wound CCW viewed from outside.
  let vol = 0;
  for (const { verts: [a, b, c] } of tris) {
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1])
          + a[1] * (b[2] * c[0] - b[0] * c[2])
          + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return vol;
}

// Expected solid volume in mm^3 for a cell list, per shape (cube 1, wedge
// 0.5, round/curve the faceted quarter-cylinder area from shapeUnitVolume).
// 7-element rows are quarter-unit anchors with size g (4 = full block).
function expectedVolume(cells, mm) {
  const unit = mm ** 3;
  let v = 0;
  for (const row of cells) {
    const s = row[4] ?? 0;
    const g = row.length >= 7 ? row[6] : 4;
    v += shapeUnitVolume(s) * (g / 4) ** 3 * unit;
  }
  return v;
}

function manifoldReport(tris) {
  // Watertight + consistently oriented: every directed edge is balanced by
  // an equal number of reverse edges. (Voxels touching only along an edge
  // produce coincident-but-paired edges; the surface stays closed and
  // slicers treat it as solid, so we assert pairing, not strict manifold.)
  const edges = new Map();
  const ekey = (a, b) => `${a.join(',')}|${b.join(',')}`;
  for (const { verts: [a, b, c] } of tris) {
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = ekey(p, q);
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let unbalanced = 0, strictViolations = 0;
  for (const [k, n] of edges) {
    if (n !== 1) strictViolations++;
    const [p, q] = k.split('|');
    if ((edges.get(`${q}|${p}`) || 0) !== n) unbalanced++;
  }
  return { unbalanced, strictViolations };
}

function boundsOf(tris) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const { verts } of tris) {
    for (const v of verts) {
      for (let i = 0; i < 3; i++) {
        if (v[i] < min[i]) min[i] = v[i];
        if (v[i] > max[i]) max[i] = v[i];
      }
    }
  }
  return { min, max };
}

function run(name, cells, mm, expected) {
  console.log(`\n${name}:`);
  const { count, tris, byteLength } = parseSTL(blocksToSTL(cells, mm));
  check('byte length matches triangle count', byteLength === 84 + count * 50);
  if (expected.triangles != null) {
    check(`triangle count = ${expected.triangles}`, count === expected.triangles, `(got ${count})`);
  }
  const vol = signedVolume(tris);
  const expectedVol = expectedVolume(cells, mm);
  check(`volume = ${expectedVol} mm^3 (outward winding)`, Math.abs(vol - expectedVol) < 1e-3, `(got ${vol.toFixed(4)})`);
  const { unbalanced, strictViolations } = manifoldReport(tris);
  check('watertight (all directed edges paired)', unbalanced === 0, `(unbalanced=${unbalanced})`);
  if (expected.strictManifold) {
    check('strictly manifold', strictViolations === 0, `(violations=${strictViolations})`);
  }
  const { min, max } = boundsOf(tris);
  check('sits in positive octant, bottom on Z=0', min.every((v) => Math.abs(v) < 1e-6));
  if (expected.size) {
    const size = max.map((v, i) => v - min[i]);
    check(`printed size = ${expected.size} mm`, expected.size.every((s, i) => Math.abs(size[i] - s) < 1e-3), `(got ${size})`);
  }
  return { tris };
}

// 1. Single cube: 6 faces x 2 tris.
run('single cube (10mm)', [[0, 0, 0]], 10, { triangles: 12, size: [10, 10, 10], strictManifold: true });

// 2. Two cubes stacked in game-Y: shared face culled -> 20 tris. Game height
//    (y) must become STL Z (printer up-axis): footprint 5x5, height 10.
run('two stacked cubes (5mm, y-up -> z-up)', [[3, 0, 3], [3, 1, 3]], 5, { triangles: 20, size: [5, 5, 10], strictManifold: true });

// 3. A game-Z run must land flat on the bed (STL Z stays one block tall).
run('row of 3 along game z (4mm)', [[0, 0, 0], [0, 0, 1], [0, 0, 2]], 4, { triangles: 28, size: [4, 12, 4], strictManifold: true });

// 4. L-shape.
run('L-shape', [[0, 0, 0], [1, 0, 0], [0, 1, 0]], 5, { strictManifold: true });

// 5. Deterministic pseudo-random blob: many cells, still watertight with correct volume.
{
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const set = new Set();
  const cells = [[8, 0, 8]];
  set.add('8,0,8');
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  while (cells.length < 250) {
    const [x, y, z] = cells[Math.floor(rand() * cells.length)];
    const [dx, dy, dz] = dirs[Math.floor(rand() * 6)];
    const n = [x + dx, Math.max(0, y + dy), z + dz];
    const k = n.join(',');
    if (!set.has(k)) { set.add(k); cells.push(n); }
  }
  run('random 250-cell blob', cells, 3, {});
}

// --- Wedge shapes (shape id 1) --------------------------------------------
// Cell row layout: [x, y, z, color, shape, rot].

// 6. A single wedge in all four rotations: half the volume of a cube, still
//    watertight (the sloped face + triangular caps close the solid).
for (let rot = 0; rot < 4; rot++) {
  run(`single wedge rot=${rot} (10mm)`, [[0, 0, 0, 0, 1, rot]], 10, {
    strictManifold: true, // one lone wedge has no coincident-edge partners
  });
}

// 7. Wedge sitting on a cube (roof on a wall): shared full face between the
//    wedge base and the cube top is culled; result stays watertight and the
//    volume is cube + half-cube.
run('wedge roof on a cube (8mm)', [[5, 0, 5, 12], [5, 1, 5, 0, 1, 0]], 8, { strictManifold: true });

// 8. Two wedges in adjacent cells with walls facing each other: the touching
//    walls are full faces (culled); the mesh stays watertight.
run('two wedges wall-to-wall (6mm)', [[0, 0, 0, 3, 1, 0], [1, 0, 0, 3, 1, 2]], 6, {});

// 8b. A wedge beside a cube (slope against a wall): the wedge's sloped face is
//     exterior and always emitted; the mesh must remain watertight.
run('wedge beside a cube (5mm)', [[10, 0, 10, 6], [11, 0, 10, 1, 1, 2]], 5, {});

// 9. A little pitched roof: row of cubes with wedges capping each end,
//    mixing shapes and rotations.
run('pitched roof strip', [
  [0, 0, 0, 12], [1, 0, 0, 12], [2, 0, 0, 12],
  [0, 1, 0, 0, 1, 0], [1, 1, 0, 0, 1, 0], [2, 1, 0, 0, 1, 0],
], 4, {});

// 10. Deterministic blob of mixed cubes and wedges: watertight with correct
//     (cube + half-wedge) volume.
{
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const set = new Set();
  const cells = [[8, 0, 8, 0]];
  set.add('8,0,8');
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  while (cells.length < 180) {
    const base = cells[Math.floor(rand() * cells.length)];
    const [dx, dy, dz] = dirs[Math.floor(rand() * 6)];
    const n = [base[0] + dx, Math.max(0, base[1] + dy), base[2] + dz];
    const k = n.join(',');
    if (set.has(k)) continue;
    set.add(k);
    const isWedge = rand() < 0.4;
    cells.push(isWedge ? [...n, 0, 1, Math.floor(rand() * 4)] : [...n, 0]);
  }
  run('mixed cube+wedge 180-cell blob', cells, 3, {});
}

// --- Sized blocks (7-element rows: [qx, qy, qz, c, s, r, g], quarter units) --

// 11. A single half block: half the edge length, an eighth of the volume.
run('single half cube (10mm)', [[0, 0, 0, 0, 0, 0, 2]], 10, {
  triangles: 12, size: [5, 5, 5], strictManifold: true,
});

// 12. A single quarter wedge, rotated.
run('single quarter wedge rot=3 (8mm)', [[4, 0, 4, 2, 1, 3, 1]], 8, { strictManifold: true });

// 13. Two half blocks stacked: same size + aligned, so the shared face is
//     culled and the pair becomes one sealed solid.
run('two stacked half cubes (10mm)', [[0, 0, 0, 0, 0, 0, 2], [0, 2, 0, 1, 0, 0, 2]], 10, {
  triangles: 20, size: [5, 5, 10], strictManifold: true,
});

// 14. A half block on top of a full block (mixed sizes): both shells stay
//     closed (no culling across sizes), so edges balance and the volume is
//     exactly cube + eighth.
run('half cube on a full cube (10mm)', [[0, 0, 0, 0], [0, 4, 0, 1, 0, 0, 2]], 10, {
  size: [10, 10, 15],
});

// 15. Four quarter blocks in a 2x2 row pattern on the ground plus a legacy
//     full block beside them: mixed formats in one export.
run('quarter blocks beside a full block', [
  [0, 0, 0, 0, 0, 0, 1], [1, 0, 0, 1, 0, 0, 1], [0, 0, 1, 2, 0, 0, 1], [1, 0, 1, 3, 0, 0, 1],
  [1, 0, 0, 4],
], 8, {});

// --- Round shapes (2 = round corner, 3 = curve) ----------------------------

// 16. Round corner and curve blocks, every rotation: correct faceted
//     quarter-cylinder volume, watertight, strictly manifold when alone.
for (const shape of [2, 3]) {
  for (let rot = 0; rot < 4; rot++) {
    run(`shape ${shape} rot=${rot} (10mm)`, [[0, 0, 0, 0, shape, rot]], 10, { strictManifold: true });
  }
}

// 16b. Every shape in all 24 orientations (Turn + Tip): volume preserved,
//      watertight, still inside the unit cell.
for (const shape of [0, 1, 2, 3]) {
  for (let rot = 4; rot < 24; rot++) {
    run(`shape ${shape} orientation ${rot} (6mm)`, [[0, 0, 0, 0, shape, rot]], 6, {
      strictManifold: true,
    });
  }
}

// 17. Round corner on top of a cube (tower top): the round's flat walls and
//     the cube's faces stay sealed; no culling across the quarter-disc base.
run('round corner on a cube (8mm)', [[5, 0, 5, 12], [5, 1, 5, 0, 2, 1]], 8, {});

// 18. Curve capping a wall, like a rounded roof, plus a wedge neighbor.
run('curved roof strip', [
  [0, 0, 0, 12], [1, 0, 0, 12],
  [0, 1, 0, 0, 3, 0], [1, 1, 0, 0, 1, 0],
], 5, {});

// 19. Half-size round corner (7-element quarter-unit row).
run('half-size round corner (10mm)', [[0, 0, 0, 0, 2, 2, 2]], 10, { strictManifold: true });

// 20. Two round corners stacked: same size + shape, the flat walls cull where
//     they exactly face, everything else stays sealed.
run('stacked round corners (6mm)', [[3, 0, 3, 1, 2, 0], [3, 1, 3, 2, 2, 0]], 6, {});

// --- Soft edges (bevelMM option) --------------------------------------------

function runBeveled(name, cells, mm, bevelMM) {
  console.log(`\n${name}:`);
  const { count, tris } = parseSTL(blocksToSTL(cells, mm, { bevelMM }));
  const sharpVol = expectedVolume(cells, mm);
  const vol = signedVolume(tris);
  check('bevel removes a little volume (still positive winding)',
    vol > sharpVol * 0.8 && vol < sharpVol, `(got ${vol.toFixed(3)} of ${sharpVol})`);
  const { unbalanced, strictViolations } = manifoldReport(tris);
  check('watertight (all directed edges paired)', unbalanced === 0, `(unbalanced=${unbalanced})`);
  if (cells.length === 1) {
    check('strictly manifold', strictViolations === 0, `(violations=${strictViolations})`);
  }
  const { min, max } = boundsOf(tris);
  check('bevel never grows the model', min.every((v) => v > -1e-6) &&
    max.every((v, i) => v <= boundsOf(parseSTL(blocksToSTL(cells, mm)).tris).max[i] + 1e-6));
  return { count, vol };
}

// 21. Every shape, alone, beveled: closed, manifold, slightly smaller.
for (const shape of [0, 1, 2, 3]) {
  for (const rot of [0, 3]) {
    runBeveled(`beveled shape ${shape} rot=${rot} (10mm, 0.3mm bevel)`,
      [[0, 0, 0, 0, shape, rot]], 10, 0.3);
  }
}

// 22. Beveled stack: two independent closed shells, combined volume is
//     exactly twice a single beveled cube.
{
  const single = runBeveled('beveled single cube (8mm)', [[0, 0, 0]], 8, 0.3);
  const pair = runBeveled('beveled stacked cubes (8mm)', [[0, 0, 0], [0, 1, 0]], 8, 0.3);
  check('stacked beveled volume = 2x single', Math.abs(pair.vol - 2 * single.vol) < 1e-3,
    `(${pair.vol.toFixed(3)} vs 2x${single.vol.toFixed(3)})`);
}

// 23. Small blocks clamp the bevel instead of collapsing (quarter block at
//     3mm scale has 0.75mm edges — a 0.3mm bevel must shrink to fit).
runBeveled('beveled quarter block at small scale', [[0, 0, 0, 0, 0, 0, 1]], 3, 0.3);

// 24. Fully buried blocks are skipped: a 3x3x3 beveled solid emits shells for
//     26 outer blocks only, and stays watertight.
{
  const cells = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) {
    cells.push([x, y, z, 0]);
  }
  const solid = runBeveled('beveled 3x3x3 solid', cells, 5, 0.3);
  const one = parseSTL(blocksToSTL([[0, 0, 0]], 5, { bevelMM: 0.3 })).count;
  check('center block skipped', solid.count === 26 * one, `(got ${solid.count}, expected ${26 * one})`);
}

// 25. bevelMM: 0 (and omitted opts) keeps the sharp geometry byte-identical.
{
  console.log('\nbevel off matches sharp export:');
  const a = new Uint8Array(blocksToSTL([[0, 0, 0], [0, 1, 0, 3, 1, 2]], 5));
  const b = new Uint8Array(blocksToSTL([[0, 0, 0], [0, 1, 0, 3, 1, 2]], 5, { bevelMM: 0 }));
  check('identical bytes', a.length === b.length && a.every((v, i) => v === b[i]));
}

console.log(failures === 0 ? '\nAll STL tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
