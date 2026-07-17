import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VoxelWorld, SIZE, HEIGHT, SHAPE_CUBE, SHAPE_WEDGE } from './world.js';
import { WorldRenderer, addBed, addBuildVolume, OFF } from './meshing.js';
import { shapeTriangles } from './shapes.js';
import { PALETTE } from './palette.js';
import { Sounds } from './sounds.js';
import { UndoStack } from './undo.js';
import { blocksToSTL } from './stl.js';
import * as storage from './storage.js';
import { starterRocket } from './starter.js';
import { setupUI } from './ui.js';
import { Player } from './player.js';

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
const GHOST_GEO = { [SHAPE_CUBE]: ghostGeometry(SHAPE_CUBE), [SHAPE_WEDGE]: ghostGeometry(SHAPE_WEDGE) };

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
  shape: SHAPE_CUBE,  // 0 = cube, 1 = wedge
  rot: 0,             // 0..3 quarter-turns for the block being placed
  mirror: false,
  name: 'My Creation',
  onChange: [],       // subscribers, called after any world change
  ui: null,           // filled by setupUI

  setTool(tool) { this.tool = tool; updateGhostFromLast(); },
  setColor(i) { this.colorIndex = i; updateGhostFromLast(); },
  setShape(s) { this.shape = s; updateGhostFromLast(); },
  rotate() { this.rot = (this.rot + 1) % 4; updateGhostFromLast(); },

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

  exportSTL(mm) {
    return blocksToSTL(world.toArray(), mm);
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

  // Flash a set of cells red (used for the "floating blocks" warning).
  highlightCells(cells) {
    if (cells.length === 0) return;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.1, 1.1, 1.1),
      new THREE.MeshBasicMaterial({ color: '#ff3030', transparent: true, opacity: 0.6, depthWrite: false }),
      cells.length
    );
    const m = new THREE.Matrix4();
    cells.forEach(([x, y, z], i) => {
      m.makeTranslation(x + 0.5 - OFF, y + 0.5, z + 0.5 - OFF);
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

  lockPointer() {
    if (this.mode !== 'walk' || this.isLocked()) return;
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
      // Pull the camera back for a nice overview of the whole plate.
      camera.position.set(30, 26, 38);
      controls.target.set(0, 5, 0);
    } else {
      player.ensureFree(world);
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
    const cell = worldRenderer.cellForHit(hit);
    if (cell) {
      // Placement direction: which cube face did the ray cross? Derive it from
      // the world-space hit point relative to the cell center, picking the
      // axis where the point sits closest to a cell boundary (±0.5). This is
      // robust for wedges' sloped faces, where the raw triangle normal is
      // diagonal and would point into an ambiguous place.
      const p = hit.point;
      const lx = p.x + OFF - (cell[0] + 0.5);
      const ly = p.y - (cell[1] + 0.5);
      const lz = p.z + OFF - (cell[2] + 0.5);
      const ax = Math.abs(lx), ay = Math.abs(ly), az = Math.abs(lz);
      let normal;
      if (ax >= ay && ax >= az) normal = [Math.sign(lx) || 1, 0, 0];
      else if (ay >= az) normal = [0, Math.sign(ly) || 1, 0];
      else normal = [0, 0, Math.sign(lz) || 1];
      return { type: 'block', cell, normal };
    }
  }

  if (raycaster.ray.intersectPlane(groundPlane, planeHit) &&
      raycaster.ray.origin.distanceTo(planeHit) <= far) {
    const x = Math.floor(planeHit.x + OFF);
    const z = Math.floor(planeHit.z + OFF);
    if (x >= 0 && x < SIZE && z >= 0 && z < SIZE) {
      return { type: 'ground', cell: [x, 0, z] };
    }
  }
  return null;
}

function pickAtPointer(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return pickNDC(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
    Infinity
  );
}

const pickCenter = () => pickNDC(0, 0, REACH);

const mirrorOf = ([x, y, z]) => [SIZE - 1 - x, y, z];
const sameCell = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

function sameRecord(a, b) {
  if (a == null || b == null) return a === b;
  return a.c === b.c && a.s === b.s && a.r === b.r;
}

// A wedge's facing when its cell is mirrored across the X axis. Rotations
// where the wall faces ±X (r=0,r=2) swap; ±Z facings (r=1,r=3) are unchanged.
// Cubes are symmetric, so their rotation never matters.
function mirrorRot(shape, rot) {
  if (shape !== SHAPE_WEDGE) return rot;
  return rot === 0 ? 2 : rot === 2 ? 0 : rot;
}

// Where would the given tool act, for a pick result?
function targetCells(hit, tool) {
  if (!hit) return [];
  let base = null;
  if (tool === 'build') {
    if (hit.type === 'block') {
      base = [hit.cell[0] + hit.normal[0], hit.cell[1] + hit.normal[1], hit.cell[2] + hit.normal[2]];
    } else {
      base = hit.cell;
    }
    if (!world.inBounds(...base) || world.has(...base)) base = null;
  } else if (hit.type === 'block') {
    base = hit.cell;
  }
  if (!base) return [];
  const cells = [base];
  if (app.mirror) {
    const m = mirrorOf(base);
    if (!sameCell(m, base)) {
      if (tool !== 'build' ? world.has(...m) : (world.inBounds(...m) && !world.has(...m))) {
        cells.push(m);
      }
    }
  }
  return cells;
}

function doActionFromHit(hit, tool) {
  if (!hit) return;

  if (tool === 'build' && hit.type === 'block') {
    const t = [hit.cell[0] + hit.normal[0], hit.cell[1] + hit.normal[1], hit.cell[2] + hit.normal[2]];
    if (!world.inBounds(...t)) { sounds.no(); app.flashBounds(); return; }
  }

  let cells = targetCells(hit, tool);
  if (tool === 'build' && app.mode === 'walk') {
    cells = cells.filter((c) => !player.overlapsCell(c)); // don't build inside yourself
  }
  if (cells.length === 0) {
    if (tool === 'build') sounds.no();
    return;
  }

  const changes = cells.map(([x, y, z], idx) => {
    const prev = world.getCell(x, y, z) ?? null;
    let next;
    if (tool === 'erase') {
      next = null;
    } else if (tool === 'paint') {
      // Keep the block's shape/rotation, just change its color.
      next = { c: app.colorIndex, s: prev?.s ?? SHAPE_CUBE, r: prev?.r ?? 0 };
    } else { // build
      // The mirror twin (idx 1) flips a wedge's facing so it mirrors visually.
      const r = idx === 1 ? mirrorRot(app.shape, app.rot) : app.rot;
      next = { c: app.colorIndex, s: app.shape, r };
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
function walkPickColor() {
  const hit = pickCenter();
  if (hit?.type === 'block') {
    const rec = world.getCell(...hit.cell);
    if (rec) {
      app.ui?.selectColor(rec.c);
      app.shape = rec.s;
      app.rot = rec.r;
      app.ui?.reflectShape();
      sounds.click();
    }
  }
}

// ---------------------------------------------------------------------------
// Ghost preview
// ---------------------------------------------------------------------------

let lastPointer = null;

function showGhosts(cells, tool) {
  const color = tool === 'erase' ? '#ff4040' : PALETTE[app.colorIndex].hex;
  // Building shows the shape/rotation you'll place; erase/paint just outline
  // the target cell as a cube.
  const shape = tool === 'build' ? app.shape : SHAPE_CUBE;
  const ghosts = [[ghost, cells[0], app.rot], [ghostMirror, cells[1], mirrorRot(shape, app.rot)]];
  for (const [g, cell, rot] of ghosts) {
    if (cell) {
      g.visible = true;
      g.geometry = GHOST_GEO[shape];
      g.material.color.set(color);
      g.position.set(cell[0] + 0.5 - OFF, cell[1] + 0.5, cell[2] + 0.5 - OFF);
      g.rotation.set(0, -rot * Math.PI / 2, 0);
    } else {
      g.visible = false;
    }
  }
}

function updateGhost(clientX, clientY) {
  lastPointer = [clientX, clientY];
  showGhosts(targetCells(pickAtPointer(clientX, clientY), app.tool), app.tool);
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
    selBox.visible = true;
    selBox.position.set(hit.cell[0] + 0.5 - OFF, hit.cell[1] + 0.5, hit.cell[2] + 0.5 - OFF);
  } else {
    selBox.visible = false;
  }
  const cells = targetCells(hit, 'build').filter((c) => !player.overlapsCell(c));
  showGhosts(cells, 'build');
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
  if (e.code === 'KeyR' && !e.repeat) { app.rotate(); app.ui?.reflectShape(); sounds.click(); }
  if (e.code === 'KeyQ' && !e.repeat) { app.ui?.toggleShape(); }
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

// Walk mode by default on mouse/keyboard machines; orbit on touch devices
// (no keyboard to walk with).
const coarse = window.matchMedia('(pointer: coarse)').matches;
const savedMode = storage.loadSettings().mode;
app.applyMode(coarse ? 'orbit' : (savedMode || 'walk'));
if (coarse) app.ui.hideModeToggle();

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
    if (app.isLocked()) {
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
  app, world, player, input, PALETTE, blocksToSTL, SIZE, HEIGHT,
  SHAPE_CUBE, SHAPE_WEDGE,
  walkBreak, walkPlace, walkPaint, walkPickColor, pickCenter,
  stepPlayer: (dt) => { player.step(dt, input, world); player.syncCamera(camera); },
  doActionFromHit,
};
