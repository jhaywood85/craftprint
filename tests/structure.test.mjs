// Validates the real-contact structural analysis (src/structure.js):
// contact areas match geometry (corner/edge/slope-line contact counts as
// zero), analyze() finds loose pieces and skinny joints, gluePlan() actually
// fixes what it finds, and every starter model ships clean.
//
// Run: node tests/structure.test.mjs

import { VoxelWorld, Q, SHAPE_CUBE, SHAPE_WEDGE, SHAPE_CURVE } from '../src/world.js';
import { analyze, gluePlan, contactArea, groundArea, ATTACH_MIN } from '../src/structure.js';
import { STARTERS } from '../src/starters.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else { failures++; console.error(`  FAIL - ${name} ${detail}`); }
}

const blk = (x, y, z, { g = Q, s = SHAPE_CUBE, r = 0 } = {}) => ({ p: [x, y, z], g, s, r });
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;

// --- contactArea: pure geometry ---------------------------------------------
{
  console.log('\ncontact areas:');
  // Full cube faces.
  check('cube|cube full face = 16', contactArea(blk(0, 0, 0), blk(4, 0, 0)) === 16);
  check('half|half full face = 4', contactArea(blk(0, 0, 0, { g: 2 }), blk(2, 0, 0, { g: 2 })) === 4);
  check('quarter face = 1', contactArea(blk(0, 0, 0, { g: 1 }), blk(1, 0, 0, { g: 1 })) === 1);
  // Offset cubes overlapping partially.
  check('cube offset by half = 8', contactArea(blk(0, 0, 0), blk(4, 2, 0)) === 8);
  // Edge and corner contact: zero.
  check('cubes edge-to-edge = 0', contactArea(blk(0, 0, 0), blk(4, 4, 0)) === 0);
  check('cubes corner-to-corner = 0', contactArea(blk(0, 0, 0), blk(4, 4, 4)) === 0);
  check('cubes apart = 0', contactArea(blk(0, 0, 0), blk(8, 0, 0)) === 0);

  // Wedge r=0: wall on -X, base on -Y, slope down to +X.
  const wedge = blk(0, 0, 0, { s: SHAPE_WEDGE });
  check('cube against wedge wall = 16', contactArea(blk(-4, 0, 0), wedge) === 16);
  check('cube under wedge base = 16', contactArea(blk(0, -4, 0), wedge) === 16);
  check('cube ON TOP of wedge ≈ 0 (line contact)', contactArea(blk(0, 4, 0), wedge) < ATTACH_MIN,
    `got ${contactArea(blk(0, 4, 0), wedge)}`);
  check('cube on wedge open +X side ≈ 0', contactArea(blk(4, 0, 0), wedge) < ATTACH_MIN);
  // End caps are triangles: half the face.
  check('wedge end cap ≈ 8', near(contactArea(blk(0, 0, -4), wedge), 8, 1.2),
    `got ${contactArea(blk(0, 0, -4), wedge)}`);

  // Curve r=0: same wall/base as the wedge, quarter-disc caps (~π/4 · 16).
  const curve = blk(0, 0, 0, { s: SHAPE_CURVE });
  check('cube against curve wall = 16', contactArea(blk(-4, 0, 0), curve) === 16);
  check('cube on top of curve ≈ 0', contactArea(blk(0, 4, 0), curve) < ATTACH_MIN);
  const cap = contactArea(blk(0, 0, -4), curve);
  check('curve end cap ≈ quarter disc (~12.5)', near(cap, Math.PI / 4 * 16, 1.5), `got ${cap}`);

  // Ground contact.
  check('cube ground = 16', groundArea(blk(0, 0, 0)) === 16);
  check('raised cube ground = 0', groundArea(blk(0, 4, 0)) === 0);
  check('wedge ground = 16 (flat base)', near(groundArea(wedge), 16, 1.2));
  // Wedge tipped so its slope faces the plate: only an edge touches.
  let tipped = null;
  for (let r = 0; r < 24; r++) {
    const g = groundArea(blk(0, 0, 0, { s: SHAPE_WEDGE, r }));
    if (g < ATTACH_MIN) tipped = { r, g };
  }
  check('some tipped wedge orientation only edge-touches the plate', tipped !== null,
    JSON.stringify(tipped));
}

// --- analyze: loose detection -------------------------------------------------
{
  console.log('\nanalyze — loose pieces:');
  const w = new VoxelWorld();
  w.set(0, 0, 0, { c: 0 });
  w.set(0, 4, 0, { c: 0 });
  let res = analyze(w);
  check('stacked cubes attached', res.loose.length === 0);

  w.set(40, 8, 40, { c: 1 }); // floating cube
  res = analyze(w);
  check('floating cube is loose', res.loose.length === 1 && res.loose[0][0] === 40);

  // Diagonal (corner-touching) cubes: old floatingCells missed these only when
  // face cells overlapped; here corner contact must NOT attach.
  const w2 = new VoxelWorld();
  w2.set(0, 0, 0, { c: 0 });
  w2.set(4, 4, 4, { c: 0 }); // corner-to-corner with the grounded cube
  res = analyze(w2);
  check('corner-touching cube is loose', res.loose.length === 1);

  // Edge contact via half blocks.
  const w3 = new VoxelWorld();
  w3.set(0, 0, 0, { c: 0, g: 2 });
  w3.set(2, 2, 0, { c: 0, g: 2 }); // shares only a horizontal edge
  res = analyze(w3);
  check('edge-touching half block is loose', res.loose.length === 1);

  // THE classic kid mistake: a cube resting on a wedge's slope.
  const w4 = new VoxelWorld();
  w4.set(0, 0, 0, { c: 0, s: SHAPE_WEDGE, r: 0 });
  w4.set(0, 4, 0, { c: 1 }); // sits on the slope cell — line contact only
  res = analyze(w4);
  check('cube on wedge slope is loose', res.loose.length === 1,
    JSON.stringify(res.loose));

  // But a cube against the wedge's full wall IS attached.
  const w5 = new VoxelWorld();
  w5.set(4, 0, 0, { c: 0, s: SHAPE_WEDGE, r: 0 }); // wall faces -X (toward x=4 plane)
  w5.set(0, 0, 0, { c: 1 });                        // grounded cube against the wall
  res = analyze(w5);
  check('wedge against cube wall attached', res.loose.length === 0,
    JSON.stringify(res.loose));

  // Wedge-to-wedge end caps (triangle contact = 8) attach.
  const w6 = new VoxelWorld();
  w6.set(0, 0, 0, { c: 0, s: SHAPE_WEDGE, r: 0 });
  w6.set(0, 0, 4, { c: 0, s: SHAPE_WEDGE, r: 0 });
  res = analyze(w6);
  check('wedge prism run attached via end caps', res.loose.length === 0);

  // Mixed sizes: quarter block stuck on a full block's face.
  const w7 = new VoxelWorld();
  w7.set(0, 0, 0, { c: 0 });
  w7.set(1, 4, 1, { c: 1, g: 1 });
  res = analyze(w7);
  check('quarter block on cube top attached', res.loose.length === 0);
}

// --- analyze: skinny joints -----------------------------------------------------
{
  console.log('\nanalyze — skinny joints:');
  // A chunky body hanging off a quarter-block ankle: base cube, quarter
  // column, then a full cube on top.
  const w1 = new VoxelWorld();
  w1.set(0, 0, 0, { c: 0 });
  w1.set(0, 4, 0, { c: 0, g: 1 });
  w1.set(0, 5, 0, { c: 0, g: 1 });
  w1.set(0, 6, 0, { c: 0, g: 1 });
  w1.set(0, 7, 0, { c: 0, g: 1 });
  w1.set(0, 8, 0, { c: 0 });
  const res = analyze(w1);
  check('all attached', res.loose.length === 0);
  check('quarter ankle flagged skinny', res.skinny.length >= 2, JSON.stringify(res.skinny));

  // A solid full-block tower is NOT skinny.
  const w2 = new VoxelWorld();
  for (let y = 0; y < 5; y++) w2.set(0, y * 4, 0, { c: 0 });
  const res2 = analyze(w2);
  check('full-block tower not skinny', res2.skinny.length === 0, JSON.stringify(res2.skinny));

  // A half-block column (face 4 > SKINNY_MAX) is fine too.
  const w3 = new VoxelWorld();
  w3.set(0, 0, 0, { c: 0 });
  w3.set(0, 4, 0, { c: 0, g: 2 });
  w3.set(0, 6, 0, { c: 0, g: 2 });
  w3.set(0, 8, 0, { c: 0 });
  const res3 = analyze(w3);
  check('half-block joint not skinny', res3.skinny.length === 0, JSON.stringify(res3.skinny));

  // A lone quarter decoration on a face: not worth nagging about.
  const w4 = new VoxelWorld();
  w4.set(0, 0, 0, { c: 0 });
  w4.set(1, 4, 1, { c: 1, g: 1 });
  const res4 = analyze(w4);
  check('single decorative quarter not flagged', res4.skinny.length === 0);
}

// --- gluePlan -------------------------------------------------------------------
{
  console.log('\ngluePlan:');
  // Floating cube two blocks above the plate: glue must reach the ground.
  const w = new VoxelWorld();
  w.set(0, 0, 0, { c: 0 });
  w.set(20, 8, 20, { c: 2 });
  const plan = gluePlan(w);
  check('plan is non-empty', plan.length > 0);
  for (const { x, y, z, rec } of plan) w.set(x, y, z, rec);
  let res = analyze(w);
  check('glued world has no loose pieces', res.loose.length === 0, JSON.stringify(res.loose));
  check('glue blocks inherit the loose block color', plan.every((p) => p.rec.c === 2),
    JSON.stringify(plan.map((p) => p.rec.c)));

  // Cube on a wedge slope: glue must bridge around the slope.
  const w2 = new VoxelWorld();
  w2.set(0, 0, 0, { c: 0, s: SHAPE_WEDGE, r: 0 });
  w2.set(0, 4, 0, { c: 1 });
  const plan2 = gluePlan(w2);
  check('slope-sitter plan non-empty', plan2.length > 0);
  for (const { x, y, z, rec } of plan2) w2.set(x, y, z, rec);
  res = analyze(w2);
  check('slope-sitter glued', res.loose.length === 0, JSON.stringify(res.loose));

  // Two separate islands both get glued.
  const w3 = new VoxelWorld();
  w3.set(0, 0, 0, { c: 0 });
  w3.set(12, 8, 0, { c: 1 });
  w3.set(40, 12, 40, { c: 3 });
  const plan3 = gluePlan(w3);
  for (const { x, y, z, rec } of plan3) w3.set(x, y, z, rec);
  res = analyze(w3);
  check('both islands glued', res.loose.length === 0, JSON.stringify(res.loose));

  // Nothing loose -> empty plan.
  const w4 = new VoxelWorld();
  w4.set(0, 0, 0, { c: 0 });
  check('attached world needs no glue', gluePlan(w4).length === 0);
}

// --- Starters must ship structurally clean ---------------------------------------
{
  console.log('\nstarter models:');
  for (const s of STARTERS) {
    const w = new VoxelWorld();
    w.loadArray(s.build());
    const t0 = performance.now();
    const res = analyze(w);
    const ms = performance.now() - t0;
    check(`${s.id}: no loose pieces (${w.count} blocks, ${ms.toFixed(0)}ms)`,
      res.loose.length === 0, JSON.stringify(res.loose.slice(0, 8)));
    check(`${s.id}: no skinny joints`, res.skinny.length === 0,
      JSON.stringify(res.skinny.slice(0, 8)));
    check(`${s.id}: analyze under 250ms`, ms < 250, `${ms.toFixed(1)}ms`);
  }
}

console.log(failures === 0 ? '\nAll structure tests passed ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
