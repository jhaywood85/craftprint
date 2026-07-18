// Validates the quarter-unit VoxelWorld: anchors + occupancy stay in sync,
// sized placement/overlap rules, legacy save round-trips, bounds, and
// floating-block detection across mixed sizes.
//
// Run: node tests/world.test.mjs

import { VoxelWorld, Q, QSIZE, QHEIGHT } from '../src/world.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else { failures++; console.error(`  FAIL - ${name} ${detail}`); }
}

// --- Placement + occupancy --------------------------------------------------
{
  console.log('\nplacement + occupancy:');
  const w = new VoxelWorld();
  check('set full block', w.set(0, 0, 0, { c: 1, g: 4 }));
  check('count = 1', w.count === 1);
  check('anchor cell occupied', w.has(0, 0, 0));
  check('far corner of block occupied', w.has(3, 3, 3));
  check('outside block not occupied', !w.has(4, 0, 0));
  check('blockAt resolves interior to anchor', w.blockAt(2, 1, 3)?.x === 0);
  check('regionFree rejects overlap', !w.regionFree(2, 2, 2, 4));
  check('regionFree accepts adjacent', w.regionFree(4, 0, 0, 4));

  check('half block beside it', w.set(4, 0, 0, { c: 2, g: 2 }));
  check('half block occupies its 2^3', w.has(5, 1, 1));
  check('half block stops at its edge', !w.has(6, 0, 0));

  w.remove(0, 0, 0);
  check('remove clears occupancy', !w.has(3, 3, 3) && w.count === 1);

  // set() snaps misaligned anchors to the block's own grid
  w.set(9, 0, 9, { c: 0, g: 2 });
  check('anchor snapped to half grid', w.getCell(8, 0, 8) !== undefined);
}

// --- Bounds ------------------------------------------------------------------
{
  console.log('\nbounds:');
  const w = new VoxelWorld();
  check('inBounds rejects region past the rim', !w.inBounds(QSIZE - 2, 0, 0, 4));
  check('inBounds accepts a quarter block at the rim', w.inBounds(QSIZE - 1, 0, 0, 1));
  check('inBounds rejects above the sky', !w.inBounds(0, QHEIGHT - 1, 0, 2));

  w.set(4, 0, 4, { c: 0, g: 4 });
  w.set(8, 4, 4, { c: 0, g: 1 });
  const b = w.bounds();
  check('bounds min in quarter units', b.min.join() === '4,0,4');
  check('bounds max is exclusive (anchor + g)', b.max.join() === '9,5,8');
}

// --- Save / load -------------------------------------------------------------
{
  console.log('\nsave / load:');
  const w = new VoxelWorld();
  w.set(4, 0, 8, { c: 3, s: 1, r: 2, g: 4 });   // full wedge on block grid
  w.set(0, 0, 0, { c: 5, g: 2 });                // half cube
  const rows = w.toArray();
  const legacyRow = rows.find((r) => r.length < 7);
  const sizedRow = rows.find((r) => r.length === 7);
  check('full block saved in legacy block units', legacyRow?.join() === '1,0,2,3,1,2');
  check('half block saved in quarter units with g', sizedRow?.join() === '0,0,0,5,0,0,2');

  const w2 = new VoxelWorld();
  w2.loadArray(rows);
  check('round-trip keeps both blocks', w2.count === 2);
  check('round-trip keeps the wedge record',
    JSON.stringify(w2.getCell(4, 0, 8)) === JSON.stringify({ c: 3, s: 1, r: 2, g: 4 }));
  check('round-trip keeps the half block',
    JSON.stringify(w2.getCell(0, 0, 0)) === JSON.stringify({ c: 5, s: 0, r: 0, g: 2 }));

  // Legacy save (block units) loads onto the quarter grid.
  const w3 = new VoxelWorld();
  w3.loadArray([[2, 0, 2, 7], [2, 1, 2, 8, 1, 1]]);
  check('legacy rows land at x4 anchors', w3.getCell(8, 0, 8)?.c === 7);
  check('legacy wedge keeps shape/rot', w3.getCell(8, 4, 8)?.r === 1);
}

// --- Floating detection ------------------------------------------------------
{
  console.log('\nfloating cells:');
  const w = new VoxelWorld();
  w.set(0, 0, 0, { c: 0, g: 4 });          // grounded full block
  w.set(0, 4, 0, { c: 0, g: 2 });          // half block resting on it
  w.set(20, 8, 20, { c: 0, g: 1 });        // floating quarter block
  const f = w.floatingCells();
  check('one floating block found', f.length === 1);
  check('it is the quarter block', f[0].join() === '20,8,20,1');

  // A quarter block bridging via a face keeps things connected.
  w.set(20, 0, 20, { c: 0, g: 4 });
  w.set(20, 4, 20, { c: 0, g: 1 });
  w.set(20, 5, 20, { c: 0, g: 1 });
  w.set(20, 6, 20, { c: 0, g: 1 });
  w.set(20, 7, 20, { c: 0, g: 1 });
  check('quarter-block tower grounds the top block', w.floatingCells().length === 0);
}

console.log(failures === 0 ? '\nAll world tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
