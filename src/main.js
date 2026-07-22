import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VoxelWorld, SIZE, HEIGHT, Q, QSIZE, QHEIGHT, SHAPE_CUBE, SHAPE_WEDGE, SHAPE_ROUND, SHAPE_CURVE } from './world.js';
import { WorldRenderer, addBed, addBuildVolume, OFF, ORIENT_QUATS } from './meshing.js';
import { shapeTriangles, mirrorOrient, ORIENT_YAW, ORIENT_TIP } from './shapes.js';
import { PALETTE } from './palette.js';
import { Sounds } from './sounds.js';
import { UndoStack } from './undo.js';
import { blocksToSTL } from './stl.js';
import { blocksTo3MF } from './threemf.js';
import * as storage from './storage.js';
import { starterRocket } from './starter.js';
import { setupUI } from './ui.js';
import { Player } from './player.js';
import { setupTouchControls } from './touchcontrols.js';

// Touch device (no keyboard/mouse): drives whether walk mode uses on-screen
// controls instead of pointer lock + WASD.
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches
  || ('ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches);

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const container = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
container.appendChild(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(30, 26, 38);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 5, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 8;
controls.maxDistance = 110;
controls.maxPolarAngle = Math.PI / 2 - 0.04; // stay above the bed
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

// Lights
scene.add(new THREE.HemisphereLight('#dbeeff', '#ffe9cf', 1.15));
const sun = new THREE.DirectionalLight('#ffffff', 1.6);
sun.position.set(24, 42, 16);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -30;
sun.shadow.camera.right = 30;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -30;
sun.shadow.bias = -0.0004;
scene.add(sun);

addBed(scene);
const volumeFrame = addBuildVolume(scene);

const world = new VoxelWorld();
const worldRenderer = new WorldRenderer(scene, PALETTE);
const undoStack = new UndoStack();
const sounds = new Sounds(storage.loadSettings().sound !== false);
const player = new Player();

// Ghost previews (main + mirror twin)
// Ghost geometries per shape, centered on the cell origin and slightly puffed
// so they hover just outside the real blocks.
function ghostGeometry(shape) {
  const positions = [];
  for (const tri of shapeTriangles(shape, 0)) {
    for (const p of tri) positions.push((p[0] - 0.5) * 1.02, (p[1] - 0.5) * 1.02, (p[2] - 0.5) * 1.02);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}
const GHOST_GEO = {};
for (const s of [SHAPE_CUBE, SHAPE_WEDGE, SHAPE_ROUND, SHAPE_CURVE]) GHOST_GEO[s] = ghostGeometry(s);

function makeGhost() {
  const ghost = new THREE.Mesh(
    GHOST_GEO[SHAPE_CUBE],
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false })
  );
  ghost.visible = false;
  scene.add(ghost);
  return ghost;
}
const ghost = makeGhost();
const ghostMirror = makeGhost();

// Minecraft-style wireframe on the block you're aiming at (walk mode).
// Unit-sized; scaled per frame to the aimed block's size.
const selBox = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
  new THREE.LineBasicMaterial({ color: '#241d3d', transparent: true, opacity: 0.9 })
);
selBox.visible = false;
scene.add(selBox);

// ---------------------------------------------------------------------------
// App state + operations
// ---------------------------------------------------------------------------

const app = {
  world,
  undoStack,
  sounds,
  player,
  mode: 'walk',       // 'walk' (first person) | 'orbit' (spin-around camera)
  tool: 'build',      // orbit-mode tool: 'build' | 'erase' | 'paint'
  colorIndex: 0,
  shape: SHAPE_CUBE,  // 0 = cube, 1 = wedge, 2 = round corner, 3 = curve
  rot: 0,             // orientation index 0..23 for the block being placed
  gsize: Q,           // placement size in quarter units: 4 full, 2 half, 1 quarter
  mirror: false,
  name: 'My Creation',
  onChange: [],       // subscribers, called after any world change
  ui: null,           // filled by setupUI

  setTool(tool) { this.tool = tool; updateGhostFromLast(); },
  setColor(i) { this.colorIndex = i; updateGhostFromLast(); },
  setShape(s) { this.shape = s; updateGhostFromLast(); },
  setGsize(g) { this.gsize = g; updateGhostFromLast(); },
  rotate() { // Turn: global quarter-turn about the vertical axis
    this.rot = ORIENT_YAW[this.rot];
    this.ui?.reflectShape(); // spins the shape direction indicators
    updateGhostFromLast();
  },
  tip() { // Tip: global quarter-turn about the horizontal (X) axis
    this.rot = ORIENT_TIP[this.rot];
    this.ui?.reflectShape();
    updateGhostFromLast();
  },

  notify() { for (const fn of this.onChange) fn(); },

  refresh() {
    worldRenderer.update(world);
    this.notify();
    scheduleAutosave();
  },

  // changes: [{x, y, z, prev, next}] where prev/next are block records or null
  applyChanges(changes, sound) {
    const real = changes.filter((c) => !sameRecord(c.prev, c.next));
    if (real.length === 0) return false;
    for (const { x, y, z, next } of real) {
      if (next == null) world.remove(x, y, z);
      else world.set(x, y, z, next);
    }
    undoStack.push(real);
    if (sound) sound();
    this.refresh();
    return true;
  },

  undo() {
    if (undoStack.undo(world)) { sounds.undo(); this.refresh(); }
  },

  redo() {
    if (undoStack.redo(world)) { sounds.undo(); this.refresh(); }
  },

  clearAll() {
    const changes = [];
    world.forEach((x, y, z, c) => changes.push({ x, y, z, prev: c, next: null }));
    this.applyChanges(changes, () => sounds.erase());
  },

  loadCells(cells, name) {
    world.loadArray(cells);
    undoStack.clear();
    if (name) this.name = name;
    player.ensureFree(world);
    this.refresh();
  },

  exportSTL(mm, opts) {
    return blocksToSTL(world.toArray(), mm, opts);
  },

  export3MF(mm, opts) {
    return blocksTo3MF(world.toArray(), mm, this.name, opts);
  },

  captureThumbnail() {
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const w = 240;
    const h = Math.max(1, Math.round((w * src.height) / src.width));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#cfeeff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.72);
  },

  // Flash a set of blocks red (used for the "floating blocks" warning).
  // Rows are [x, y, z, g] anchors in quarter units (world.floatingCells()).
  highlightCells(cells) {
    if (cells.length === 0) return;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.1, 1.1, 1.1),
      new THREE.MeshBasicMaterial({ color: '#ff3030', transparent: true, opacity: 0.6, depthWrite: false }),
      cells.length
    );
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    cells.forEach(([x, y, z, g = Q], i) => {
      pos.set((x + g / 2) / Q - OFF, (y + g / 2) / Q, (z + g / 2) / Q - OFF);
      scl.setScalar(g / Q);
      m.compose(pos, new THREE.Quaternion(), scl);
      mesh.setMatrixAt(i, m);
    });
    scene.add(mesh);
    let blinks = 0;
    const timer = setInterval(() => {
      mesh.visible = !mesh.visible;
      if (++blinks >= 6) {
        clearInterval(timer);
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    }, 300);
  },

  flashBounds() {
    volumeFrame.material.opacity = 0.8;
    setTimeout(() => { volumeFrame.material.opacity = 0.22; }, 350);
  },

  isLocked() { return document.pointerLockElement === canvas; },

  // Is first-person input live right now? On desktop that means pointer lock;
  // on touch, walk mode runs continuously via the on-screen controls.
  walkActive() {
    return this.mode === 'walk' && (IS_TOUCH || this.isLocked());
  },

  lockPointer() {
    // Touch devices walk via on-screen controls, not pointer lock.
    if (this.mode !== 'walk' || IS_TOUCH || this.isLocked()) return;
    try { canvas.requestPointerLock(); } catch { /* not available */ }
  },

  // Wire up everything a mode needs. Safe to call at boot (no pointer lock,
  // no sound — browsers require a user gesture for those).
  applyMode(mode) {
    this.mode = mode;
    document.body.classList.toggle('walk-mode', mode === 'walk');
    controls.enabled = mode === 'orbit';
    camera.fov = mode === 'walk' ? 70 : 45;
    camera.updateProjectionMatrix();
    hideGhosts();
    selBox.visible = false;
    if (mode === 'orbit') {
      if (this.isLocked()) document.exitPointerLock();
      touch?.hide();
      document.body.classList.remove('touch-walk');
      // Pull the camera back for a nice overview of the whole plate.
      camera.position.set(30, 26, 38);
      controls.target.set(0, 5, 0);
    } else {
      player.ensureFree(world);
      if (IS_TOUCH) {
        touch?.show();
        touch?.syncFly();
        document.body.classList.add('touch-walk');
      }
    }
    this.ui?.onModeChange?.(mode);
  },

  // User-initiated mode switch (button click / shortcut — a real gesture).
  setMode(mode) {
    if (mode === this.mode) return;
    this.applyMode(mode);
    if (mode === 'walk') this.lockPointer();
    const settings = storage.loadSettings();
    settings.mode = mode;
    storage.saveSettings(settings);
    sounds.click();
  },
};

let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    storage.saveCurrent({ name: app.name, blocks: world.toArray() });
  }, 400);
}
app.scheduleAutosave = scheduleAutosave;

// ---------------------------------------------------------------------------
// Picking and tool actions
// ---------------------------------------------------------------------------

const REACH = 6; // walk-mode arm length, in blocks

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planeHit = new THREE.Vector3();

function pickNDC(nx, ny, far) {
  ndc.set(nx, ny);
  raycaster.far = far;
  raycaster.setFromCamera(ndc, camera);

  const hits = raycaster.intersectObjects(worldRenderer.meshes);
  if (hits.length > 0 && hits[0].instanceId != null) {
    const hit = hits[0];
    const block = worldRenderer.blockForHit(hit); // { q: [x,y,z], g }
    if (block) {
      // Placement direction: which face did the ray cross? Derive it from
      // the world-space hit point relative to the block center, picking the
      // axis where the point sits closest to a boundary. This is robust for
      // wedges' sloped faces, where the raw triangle normal is diagonal and
      // would point into an ambiguous place.
      const { q, g } = block;
      const p = hit.point;
      const lx = p.x + OFF - (q[0] + g / 2) / Q;
      const ly = p.y - (q[1] + g / 2) / Q;
      const lz = p.z + OFF - (q[2] + g / 2) / Q;
      const ax = Math.abs(lx), ay = Math.abs(ly), az = Math.abs(lz);
      let normal;
      if (ax >= ay && ax >= az) normal = [Math.sign(lx) || 1, 0, 0];
      else if (ay >= az) normal = [0, Math.sign(ly) || 1, 0];
      else normal = [0, 0, Math.sign(lz) || 1];
      return { type: 'block', block, normal, point: p.clone() };
    }
  }

  if (raycaster.ray.intersectPlane(groundPlane, planeHit) &&
      raycaster.ray.origin.distanceTo(planeHit) <= far) {
    if (Math.abs(planeHit.x) <= OFF && Math.abs(planeHit.z) <= OFF) {
      return { type: 'ground', point: planeHit.clone() };
    }
  }
  return null;
}

function pickAtPointer(clientX, clientY, far = Infinity) {
  const rect = canvas.getBoundingClientRect();
  return pickNDC(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
    far
  );
}

const pickCenter = () => pickNDC(0, 0, REACH);

// Touch reach: a bit longer than the crosshair reach so a kid can comfortably
// tap a block across the plate, but still bounded so a tap at the horizon
// doesn't place something absurdly far away.
const TOUCH_REACH = 40;

// Mirror an anchor across the plate's X center. Anchors stay aligned to
// their own grid because QSIZE is a multiple of every block size.
const mirrorOf = ([x, y, z], g) => [QSIZE - x - g, y, z];
const sameCell = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

function sameRecord(a, b) {
  if (a == null || b == null) return a === b;
  return a.c === b.c && a.s === b.s && a.r === b.r && a.g === b.g;
}

// A shape's orientation when its cell is mirrored across the X axis —
// computed per shape from the geometry itself (shapes.js), covering all 24
// orientations.
const mirrorRot = (shape, rot) => mirrorOrient(shape, rot);

// Anchor (quarter units) for a new g-sized block placed against a hit face.
// Along the face normal the block sits just past the face plane, snapped to
// the global g-grid (so half blocks live on the half grid, etc.). Across the
// face it follows the tap point, hugging the tapped block's footprint when
// the new block is the smaller one.
function anchorAgainstFace(hit, g) {
  const { q, g: hg } = hit.block;
  const n = hit.normal;
  const hq = [(hit.point.x + OFF) * Q, hit.point.y * Q, (hit.point.z + OFF) * Q];
  const lim = [QSIZE, QHEIGHT, QSIZE];
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (n[i] > 0) out[i] = Math.ceil((q[i] + hg) / g) * g;
    else if (n[i] < 0) out[i] = Math.floor(q[i] / g) * g - g;
    else {
      let v = Math.floor(hq[i] / g) * g;
      if (g <= hg) v = Math.min(Math.max(v, q[i]), q[i] + hg - g);
      out[i] = Math.min(Math.max(v, 0), lim[i] - g);
    }
  }
  return out;
}

// Where would the given tool act, for a pick result?
// Returns regions [{ q: [x, y, z], g }] (anchor + size, quarter units).
function targetRegions(hit, tool) {
  if (!hit) return [];
  let base = null;
  if (tool === 'build') {
    const g = app.gsize;
    let q;
    if (hit.type === 'block') {
      q = anchorAgainstFace(hit, g);
    } else { // ground plane: snap the tap point to the g-grid
      q = [
        Math.min(Math.max(Math.floor((hit.point.x + OFF) * Q / g) * g, 0), QSIZE - g),
        0,
        Math.min(Math.max(Math.floor((hit.point.z + OFF) * Q / g) * g, 0), QSIZE - g),
      ];
    }
    if (world.inBounds(...q, g) && world.regionFree(...q, g)) base = { q, g };
  } else if (hit.type === 'block') {
    base = { q: hit.block.q, g: hit.block.g };
  }
  if (!base) return [];
  const regions = [base];
  if (app.mirror) {
    const mq = mirrorOf(base.q, base.g);
    if (!sameCell(mq, base.q)) {
      if (tool === 'build') {
        if (world.inBounds(...mq, base.g) && world.regionFree(...mq, base.g)) {
          regions.push({ q: mq, g: base.g });
        }
      } else if (world.getCell(...mq)?.g === base.g) {
        regions.push({ q: mq, g: base.g });
      }
    }
  }
  return regions;
}

function doActionFromHit(hit, tool) {
  if (!hit) return;

  if (tool === 'build' && hit.type === 'block') {
    const t = anchorAgainstFace(hit, app.gsize);
    if (!world.inBounds(...t, app.gsize)) { sounds.no(); app.flashBounds(); return; }
  }

  let regions = targetRegions(hit, tool);
  if (tool === 'build' && app.mode === 'walk') {
    regions = regions.filter((r) => !player.overlapsRegion(r.q, r.g)); // don't build inside yourself
  }
  if (regions.length === 0) {
    if (tool === 'build') sounds.no();
    return;
  }

  const changes = regions.map(({ q: [x, y, z], g }, idx) => {
    const prev = world.getCell(x, y, z) ?? null;
    let next;
    if (tool === 'erase') {
      next = null;
    } else if (tool === 'paint') {
      // Keep the block's shape/rotation/size, just change its color.
      next = { c: app.colorIndex, s: prev?.s ?? SHAPE_CUBE, r: prev?.r ?? 0, g: prev?.g ?? Q };
    } else { // build
      // The mirror twin (idx 1) flips a wedge's facing so it mirrors visually.
      const r = idx === 1 ? mirrorRot(app.shape, app.rot) : app.rot;
      next = { c: app.colorIndex, s: app.shape, r, g };
    }
    return { x, y, z, prev, next };
  });
  const soundFn = { build: () => sounds.place(), erase: () => sounds.erase(), paint: () => sounds.paint() }[tool];
  app.applyChanges(changes, soundFn);
  updateGhostFromLast();
}

// Walk-mode actions (crosshair-targeted, Minecraft controls).
const walkBreak = () => doActionFromHit(pickCenter(), 'erase');
const walkPlace = () => doActionFromHit(pickCenter(), 'build');
const walkPaint = () => doActionFromHit(pickCenter(), 'paint');

// Touch-mode actions: act where the FINGER tapped, not at the crosshair.
const touchPlaceAt = (x, y) => doActionFromHit(pickAtPointer(x, y, TOUCH_REACH), 'build');
const touchBreakAt = (x, y) => doActionFromHit(pickAtPointer(x, y, TOUCH_REACH), 'erase');
function walkPickColor() {
  const hit = pickCenter();
  if (hit?.type === 'block') {
    const rec = world.getCell(...hit.block.q);
    if (rec) {
      app.ui?.selectColor(rec.c);
      app.shape = rec.s;
      app.rot = rec.r;
      app.gsize = rec.g;
      app.ui?.reflectShape();
      app.ui?.reflectSize();
      sounds.click();
    }
  }
}

// ---------------------------------------------------------------------------
// Ghost preview
// ---------------------------------------------------------------------------

let lastPointer = null;

function showGhosts(regions, tool) {
  const color = tool === 'erase' ? '#ff4040' : PALETTE[app.colorIndex].hex;
  // Building shows the shape/rotation you'll place; erase/paint just outline
  // the target block as a cube.
  const shape = tool === 'build' ? app.shape : SHAPE_CUBE;
  const ghosts = [[ghost, regions[0], app.rot], [ghostMirror, regions[1], mirrorRot(shape, app.rot)]];
  for (const [gh, region, rot] of ghosts) {
    if (region) {
      const [x, y, z] = region.q;
      const g = region.g;
      gh.visible = true;
      gh.geometry = GHOST_GEO[shape];
      gh.material.color.set(color);
      gh.scale.setScalar(g / Q);
      gh.position.set((x + g / 2) / Q - OFF, (y + g / 2) / Q, (z + g / 2) / Q - OFF);
      gh.quaternion.copy(ORIENT_QUATS[rot] || ORIENT_QUATS[0]);
    } else {
      gh.visible = false;
    }
  }
}

function updateGhost(clientX, clientY) {
  lastPointer = [clientX, clientY];
  showGhosts(targetRegions(pickAtPointer(clientX, clientY), app.tool), app.tool);
}

function updateGhostFromLast() {
  if (app.mode === 'orbit' && lastPointer) updateGhost(lastPointer[0], lastPointer[1]);
}
app.updateGhostFromLast = updateGhostFromLast;

function hideGhosts() {
  ghost.visible = false;
  ghostMirror.visible = false;
}

// Per-frame aim update for walk mode: wireframe on the aimed block, colored
// ghost where a right-click would place.
function updateWalkAim() {
  const hit = pickCenter();
  if (hit?.type === 'block') {
    const { q, g } = hit.block;
    selBox.visible = true;
    selBox.scale.setScalar(g / Q);
    selBox.position.set((q[0] + g / 2) / Q - OFF, (q[1] + g / 2) / Q, (q[2] + g / 2) / Q - OFF);
  } else {
    selBox.visible = false;
  }
  const regions = targetRegions(hit, 'build').filter((r) => !player.overlapsRegion(r.q, r.g));
  showGhosts(regions, 'build');
}

// ---------------------------------------------------------------------------
// Orbit-mode pointer input: quick click = use tool, drag = orbit.
// Quick right-click always erases.
// ---------------------------------------------------------------------------

// Fingers wobble more than a mouse, so give touch a looser tap tolerance.
const CLICK_TIME = 600; // ms
const tapDist = (type) => (type === 'touch' ? 14 : 7); // px
let pressStart = null;
let activePointers = 0;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  if (app.mode !== 'orbit') return;
  activePointers++;
  // A second finger (pinch-to-zoom / two-finger pan) cancels any pending tap
  // so we don't drop a stray block when the child zooms.
  if (activePointers > 1) { pressStart = null; return; }
  pressStart = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, type: e.pointerType };
});

canvas.addEventListener('pointermove', (e) => {
  if (app.mode !== 'orbit') return;
  if (pressStart) {
    const moved = Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y);
    if (moved > tapDist(pressStart.type)) hideGhosts(); // orbiting, not tapping
  } else if (e.pointerType === 'mouse') {
    updateGhost(e.clientX, e.clientY);
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (app.mode !== 'orbit') { activePointers = Math.max(0, activePointers - 1); return; }
  const wasMulti = activePointers > 1;
  activePointers = Math.max(0, activePointers - 1);
  if (!pressStart || wasMulti) { pressStart = null; if (e.pointerType === 'mouse') updateGhost(e.clientX, e.clientY); return; }
  const moved = Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y);
  const dt = performance.now() - pressStart.t;
  const { button } = pressStart;
  pressStart = null;
  if (moved <= tapDist(e.pointerType) && dt <= CLICK_TIME) {
    if (button === 0) doActionFromHit(pickAtPointer(e.clientX, e.clientY), app.tool);
    else if (button === 2) doActionFromHit(pickAtPointer(e.clientX, e.clientY), 'erase');
  }
  if (e.pointerType === 'mouse') updateGhost(e.clientX, e.clientY);
});

canvas.addEventListener('pointercancel', () => { activePointers = Math.max(0, activePointers - 1); pressStart = null; });
canvas.addEventListener('pointerleave', () => { if (app.mode === 'orbit') hideGhosts(); });

// Block iOS pinch-zoom and double-tap-zoom so those gestures reach the canvas
// (OrbitControls) instead of scaling the whole page.
document.addEventListener('gesturestart', (e) => e.preventDefault());
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = performance.now();
  if (now - lastTouchEnd < 300) e.preventDefault(); // double-tap zoom
  lastTouchEnd = now;
}, { passive: false });

// ---------------------------------------------------------------------------
// Walk-mode input: pointer lock, mouse look, WASD, hold-to-repeat clicks.
// ---------------------------------------------------------------------------

const input = { forward: false, back: false, left: false, right: false, jump: false, down: false };

canvas.addEventListener('click', () => {
  if (app.mode === 'walk' && !app.isLocked()) app.lockPointer();
});

document.addEventListener('pointerlockchange', () => {
  const locked = app.isLocked();
  document.body.classList.toggle('locked', locked);
  if (!locked) {
    stopAllHolds();
    for (const k of Object.keys(input)) input[k] = false;
    hideGhosts();
    selBox.visible = false;
  }
});
document.addEventListener('pointerlockerror', () => {
  app.ui?.toast('🖱️ Could not grab the mouse — click the world again!');
});

document.addEventListener('mousemove', (e) => {
  if (app.mode === 'walk' && app.isLocked()) player.look(e.movementX, e.movementY);
});

// Hold-to-repeat break/place, like holding the mouse in Minecraft.
const holdTimers = new Map();
function startHold(button, fn) {
  fn();
  holdTimers.set(button, setInterval(fn, 240));
}
function stopHold(button) {
  clearInterval(holdTimers.get(button));
  holdTimers.delete(button);
}
function stopAllHolds() {
  for (const t of holdTimers.values()) clearInterval(t);
  holdTimers.clear();
}

document.addEventListener('mousedown', (e) => {
  if (app.mode !== 'walk' || !app.isLocked()) return;
  e.preventDefault();
  if (e.button === 0) startHold(0, walkPlace);
  else if (e.button === 2) startHold(2, walkBreak);
  else if (e.button === 1) walkPickColor();
});
document.addEventListener('mouseup', (e) => stopHold(e.button));

// Scroll cycles the color, like Minecraft's hotbar.
window.addEventListener('wheel', (e) => {
  if (app.mode !== 'walk' || !app.isLocked()) return;
  const dir = e.deltaY > 0 ? 1 : -1;
  app.ui?.selectColor((app.colorIndex + dir + PALETTE.length) % PALETTE.length);
}, { passive: true });

const KEYMAP = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'down', ShiftRight: 'down',
};

let lastSpaceTap = 0;

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (app.mode !== 'walk' || !app.isLocked()) return;
  const action = KEYMAP[e.code];
  if (action) {
    e.preventDefault();
    input[action] = true;
  }
  if (e.code === 'Space' && !e.repeat) {
    const now = performance.now();
    if (now - lastSpaceTap < 300) {
      player.flying = !player.flying;
      player.vel.y = 0;
      sounds.click();
      app.ui?.toast(player.flying ? '🕊️ Flying! Space = up, Shift = down' : '🚶 Walking again');
    }
    lastSpaceTap = now;
  }
  if (e.code === 'KeyF' && !e.repeat) walkPaint();
  if (e.code === 'KeyR' && !e.repeat) { app.rotate(); sounds.click(); }
  if (e.code === 'KeyT' && !e.repeat) { app.tip(); sounds.click(); }
  if (e.code === 'KeyQ' && !e.repeat) { app.ui?.toggleShape(); }
  if (e.code === 'KeyG' && !e.repeat) { app.ui?.cycleSize(); }
});

window.addEventListener('keyup', (e) => {
  const action = KEYMAP[e.code];
  if (action) input[action] = false;
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const saved = storage.loadCurrent();
const firstRun = !saved;
if (saved && Array.isArray(saved.blocks)) {
  app.name = saved.name || 'My Creation';
  world.loadArray(saved.blocks);
} else {
  app.name = 'My Rocket';
  world.loadArray(starterRocket());
}
worldRenderer.update(world);

app.ui = setupUI(app, { firstRun });
app.notify();

// On-screen first-person controls for touch devices.
let touch = null;
if (IS_TOUCH) {
  document.body.classList.add('touch-device'); // swaps welcome text to touch tips
  touch = setupTouchControls(app, {
    input, player, sounds,
    placeAt: touchPlaceAt,   // tap → place a block where the finger is
    breakAt: touchBreakAt,   // hold → break the block under the finger
    onLook: (dx, dy, sens) => player.look(dx, dy, sens),
  });
}

// Default view: first-person "walk" everywhere now — desktop uses pointer
// lock + WASD, touch uses the on-screen stick/buttons. Honor a saved choice.
const savedMode = storage.loadSettings().mode;
app.applyMode(savedMode || 'walk');

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let lastT = 0;
renderer.setAnimationLoop((t) => {
  const dt = Math.min((t - lastT) / 1000, 0.05);
  lastT = t;

  if (app.mode === 'walk') {
    if (app.walkActive()) {
      player.step(dt, input, world);
      player.syncCamera(camera);
      updateWalkAim();
    } else {
      player.syncCamera(camera);
    }
  } else {
    controls.update();
  }

  // Gentle breathing pulse on the ghost so it reads as "preview".
  const pulse = 0.38 + 0.12 * Math.sin(t / 180);
  ghost.material.opacity = pulse;
  ghostMirror.material.opacity = pulse;
  renderer.render(scene, camera);
});

// Hook for automated tests and debugging.
window.craft = {
  app, world, player, input, PALETTE, blocksToSTL, SIZE, HEIGHT, Q, QSIZE, QHEIGHT,
  SHAPE_CUBE, SHAPE_WEDGE, SHAPE_ROUND, SHAPE_CURVE,
  walkBreak, walkPlace, walkPaint, walkPickColor, pickCenter,
  stepPlayer: (dt) => { player.step(dt, input, world); player.syncCamera(camera); },
  doActionFromHit,
};
