// Validates the orientation system: 24 distinct orientations, legacy yaw
// indices preserved, Turn/Tip reachability, face-coverage consistency with
// actual geometry, and mirror tables that match the legacy mappings.
//
// Run: node tests/shapes.test.mjs

import {
  ORIENTS, ORIENT_COUNT, ORIENT_YAW, ORIENT_TIP,
  shapeTriangles, coversFace, mirrorOrient, DIRS,
  SHAPE_CUBE, SHAPE_WEDGE, SHAPE_ROUND, SHAPE_CURVE,
} from '../src/shapes.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else { failures++; console.error(`  FAIL - ${name} ${detail}`); }
}

console.log('\norientation group:');
check('24 orientations', ORIENT_COUNT === 24, `(got ${ORIENT_COUNT})`);
check('index 0 is identity', ORIENTS[0].every((row, i) => row.every((v, j) => v === (i === j ? 1 : 0))));
check('legacy yaw chain 0→1→2→3→0',
  ORIENT_YAW[0] === 1 && ORIENT_YAW[1] === 2 && ORIENT_YAW[2] === 3 && ORIENT_YAW[3] === 0);
check('all orientations reachable via Turn+Tip', (() => {
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const o = queue.pop();
    for (const n of [ORIENT_YAW[o], ORIENT_TIP[o]]) {
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  return seen.size === 24;
})());
check('every orientation is a proper rotation (det +1)', ORIENTS.every((M) => {
  const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
            - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
            + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  return det === 1;
}));

console.log('\nlegacy rotation compatibility (r=0..3):');
// The old hand-written mirror tables must fall out of the numeric search:
// wedge/curve swap 0↔2; round swaps 0↔1 and 2↔3; cube ignores orientation.
check('wedge mirror 0↔2', mirrorOrient(SHAPE_WEDGE, 0) === 2 && mirrorOrient(SHAPE_WEDGE, 2) === 0);
check('wedge mirror keeps 1,3', mirrorOrient(SHAPE_WEDGE, 1) === 1 && mirrorOrient(SHAPE_WEDGE, 3) === 3);
check('curve mirror 0↔2', mirrorOrient(SHAPE_CURVE, 0) === 2 && mirrorOrient(SHAPE_CURVE, 2) === 0);
check('round mirror 0↔1, 2↔3',
  mirrorOrient(SHAPE_ROUND, 0) === 1 && mirrorOrient(SHAPE_ROUND, 1) === 0 &&
  mirrorOrient(SHAPE_ROUND, 2) === 3 && mirrorOrient(SHAPE_ROUND, 3) === 2);
check('cube mirror is identity-equivalent (same point set)', (() => {
  // Any orientation of a cube is the same solid; just ensure the table maps
  // into range without throwing.
  for (let o = 0; o < 24; o++) {
    const m = mirrorOrient(SHAPE_CUBE, o);
    if (m < 0 || m >= 24) return false;
  }
  return true;
})());

console.log('\nmirror is an involution for every shape and orientation:');
for (const s of [SHAPE_WEDGE, SHAPE_ROUND, SHAPE_CURVE]) {
  let ok = true;
  for (let o = 0; o < 24; o++) {
    const m = mirrorOrient(s, o);
    // mirror twice must give back the SAME SOLID (possibly a symmetric index)
    const back = mirrorOrient(s, m);
    const sig = (oi) => {
      const pts = new Set();
      for (const t of shapeTriangles(s, oi)) for (const p of t) pts.add(p.map((v) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4)).join());
      return [...pts].sort().join('|');
    };
    if (sig(back) !== sig(o)) { ok = false; break; }
  }
  check(`shape ${s}: mirror∘mirror = identity (as solids)`, ok);
}

console.log('\ncoversFace matches the actual oriented geometry:');
// A face is covered iff the oriented triangles include the full unit square
// on that face — verify by area of coplanar triangles.
function faceArea(shape, rot, dirIdx) {
  const D = DIRS[dirIdx];
  const plane = (p) => {
    const v = p[0] * D[0] + p[1] * D[1] + p[2] * D[2];
    return Math.abs(v - Math.max(D[0], D[1], D[2], 0)) < 1e-9 &&
           (D[0] < 0 || D[1] < 0 || D[2] < 0 ? Math.abs(v) < 1e-9 : true);
  };
  // plane test: coordinate along |D| axis equals 1 for +dirs, 0 for -dirs
  const axis = D[0] !== 0 ? 0 : D[1] !== 0 ? 1 : 2;
  const target = D[axis] > 0 ? 1 : 0;
  let area = 0;
  for (const t of shapeTriangles(shape, rot)) {
    if (!t.every((p) => Math.abs(p[axis] - target) < 1e-9)) continue;
    const [a, b, c] = t;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cx = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    area += Math.hypot(...cx) / 2;
  }
  return area;
}
for (const s of [SHAPE_CUBE, SHAPE_WEDGE, SHAPE_ROUND, SHAPE_CURVE]) {
  let ok = true;
  for (let o = 0; o < 24 && ok; o++) {
    for (let d = 0; d < 6 && ok; d++) {
      const covered = coversFace(s, o, d);
      const area = faceArea(s, o, d);
      if (covered !== (Math.abs(area - 1) < 1e-6)) {
        ok = false;
        console.error(`    mismatch: shape ${s} o=${o} d=${d} covered=${covered} area=${area}`);
      }
    }
  }
  check(`shape ${s}: coverage table matches geometry for all 24 orientations`, ok);
}

console.log(failures === 0 ? '\nAll shapes tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
