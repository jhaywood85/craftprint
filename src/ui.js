// DOM wiring: toolbar, palette, modals (welcome / export / gallery / confirm /
// help), toasts, mode toggle, and keyboard shortcuts. All game logic lives in
// main.js's `app`; this module only reads/writes the DOM.
//
// Returns a small API used by main.js: { selectColor, toast, onModeChange,
// hideModeToggle }.

import { PALETTE } from './palette.js';
import * as storage from './storage.js';

const $ = (id) => document.getElementById(id);

export function setupUI(app, { firstRun }) {
  // ------------------------------------------------------------------ modals
  const overlay = $('overlay');
  const modals = Array.from(document.querySelectorAll('.modal'));

  function openModal(id) {
    if (app.isLocked()) document.exitPointerLock();
    document.body.classList.add('modal-open');
    overlay.classList.remove('hidden');
    for (const m of modals) m.classList.toggle('hidden', m.id !== id);
  }
  function closeModals() {
    document.body.classList.remove('modal-open');
    overlay.classList.add('hidden');
    for (const m of modals) m.classList.add('hidden');
  }
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) closeModals();
  });
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => { app.sounds.click(); closeModals(); });
  }

  // ------------------------------------------------------------------ toasts
  const toasts = $('toasts');
  function toast(message, ms = 2600) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    toasts.appendChild(el);
    setTimeout(() => el.classList.add('gone'), ms);
    setTimeout(() => el.remove(), ms + 400);
  }

  // ------------------------------------------------------------- mode toggle
  const modeBtn = $('modeBtn');
  modeBtn.addEventListener('click', () => {
    app.setMode(app.mode === 'walk' ? 'orbit' : 'walk');
  });
  function onModeChange(mode) {
    // The button names the view you'd switch TO.
    modeBtn.innerHTML = mode === 'walk' ? '🎥 Camera view' : '🚶 Walk inside';
    modeBtn.title = mode === 'walk'
      ? 'Switch to the spin-around camera'
      : 'Walk around inside your creation, like Minecraft';
  }

  // ------------------------------------------------------------------- tools
  const toolButtons = Array.from(document.querySelectorAll('[data-tool]'));
  function selectTool(tool) {
    app.setTool(tool);
    for (const b of toolButtons) b.classList.toggle('selected', b.dataset.tool === tool);
  }
  for (const b of toolButtons) {
    b.addEventListener('click', () => { app.sounds.click(); selectTool(b.dataset.tool); });
  }
  selectTool('build');

  const mirrorBtn = $('mirrorBtn');
  mirrorBtn.addEventListener('click', () => {
    app.mirror = !app.mirror;
    mirrorBtn.classList.toggle('selected', app.mirror);
    app.sounds.click();
    app.updateGhostFromLast();
    toast(app.mirror ? '🦋 Mirror on — build two at once!' : 'Mirror off');
  });

  const undoBtn = $('undoBtn');
  const redoBtn = $('redoBtn');
  undoBtn.addEventListener('click', () => app.undo());
  redoBtn.addEventListener('click', () => app.redo());

  // ----------------------------------------------------------------- palette
  const paletteEl = $('palette');
  function selectColor(i) {
    app.setColor(i);
    for (const [j, s] of Array.from(paletteEl.children).entries()) {
      s.classList.toggle('selected', j === i);
    }
  }
  PALETTE.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c.hex;
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    if (i < 10) b.dataset.key = `${(i + 1) % 10}`; // 1..9 then 0
    b.addEventListener('click', () => {
      selectColor(i);
      app.sounds.click();
      // Picking a color while erasing means "I want to build/paint again".
      if (app.tool === 'erase') selectTool('build');
    });
    paletteEl.appendChild(b);
  });
  paletteEl.children[0].classList.add('selected');

  // ---------------------------------------------------------------- shapes
  const shapeButtons = Array.from(document.querySelectorAll('[data-shape]'));
  const wedgeGlyph = document.querySelector('[data-shape="1"] .glyph');
  function reflectShape() {
    for (const b of shapeButtons) {
      b.classList.toggle('selected', Number(b.dataset.shape) === app.shape);
    }
    // Spin the wedge icon to show which way the slope will face: each Turn
    // is a quarter turn, matching the ghost preview in the world.
    if (wedgeGlyph) wedgeGlyph.style.transform = `rotate(${app.rot * 90}deg)`;
  }
  function selectShape(s) {
    app.setShape(s);
    // Fresh shape starts unrotated; feels more predictable for a kid.
    app.rot = 0;
    reflectShape();
    // Choosing a shape implies you want to build (not erase).
    if (app.tool === 'erase') selectTool('build');
  }
  function toggleShape() {
    selectShape(app.shape === 0 ? 1 : 0);
    app.sounds.click();
  }
  for (const b of shapeButtons) {
    b.addEventListener('click', () => { app.sounds.click(); selectShape(Number(b.dataset.shape)); });
  }
  $('rotateBtn').addEventListener('click', () => { app.rotate(); app.sounds.click(); });
  reflectShape();

  // ------------------------------------------------------------- block size
  // Full / half / quarter-size building blocks (g = 4 / 2 / 1 quarter units).
  // One compact button that cycles sizes, like Turn cycles rotation; its icon
  // and label always show the current size, and it lights up when you're
  // building small so it's obvious why blocks come out tiny.
  const sizeBtn = $('sizeBtn');
  const SIZE_LABELS = { 4: 'Full', 2: 'Half', 1: 'Quarter' };
  function reflectSize() {
    sizeBtn.querySelector('.sizebox').className = `sizebox s${app.gsize}`;
    sizeBtn.querySelector('.label').textContent = SIZE_LABELS[app.gsize] || 'Full';
    sizeBtn.classList.toggle('selected', app.gsize !== 4);
  }
  function selectSize(g) {
    app.setGsize(g);
    reflectSize();
    // Choosing a size implies you want to build (not erase).
    if (app.tool === 'erase') selectTool('build');
  }
  function cycleSize() {
    const order = [4, 2, 1];
    selectSize(order[(order.indexOf(app.gsize) + 1) % order.length]);
    app.sounds.click();
  }
  sizeBtn.addEventListener('click', cycleSize);
  reflectSize();

  // ------------------------------------------------------------------- name
  const nameInput = $('creationName');
  nameInput.value = app.name;
  nameInput.addEventListener('input', () => {
    app.name = nameInput.value.trim() || 'My Creation';
    app.scheduleAutosave();
  });

  // ---------------------------------------------------------------- counter
  const counter = $('counter');
  app.onChange.push(() => {
    counter.textContent = `🧱 ${app.world.count}`;
    undoBtn.disabled = !app.undoStack.canUndo;
    redoBtn.disabled = !app.undoStack.canRedo;
  });

  // ------------------------------------------------------------------ sound
  const soundBtn = $('soundBtn');
  const settings = storage.loadSettings();
  soundBtn.textContent = app.sounds.enabled ? '🔊' : '🔇';
  soundBtn.addEventListener('click', () => {
    app.sounds.enabled = !app.sounds.enabled;
    soundBtn.textContent = app.sounds.enabled ? '🔊' : '🔇';
    settings.sound = app.sounds.enabled;
    storage.saveSettings(settings);
    app.sounds.click();
  });

  // ---------------------------------------------------------------- confirm
  // Generic confirm dialog: confirmAction(title, body, buttonLabel, onYes).
  function confirmAction(title, body, label, onYes) {
    $('confirmTitle').textContent = title;
    $('confirmBody').textContent = body;
    const yes = $('confirmYes');
    yes.textContent = label;
    yes.onclick = () => { closeModals(); onYes(); };
    openModal('confirmModal');
  }

  $('newBtn').addEventListener('click', () => {
    app.sounds.click();
    if (app.world.count === 0) return;
    confirmAction(
      '🧹 Start fresh?',
      'This clears the whole build plate. (You can Undo, or save it in My Stuff first!)',
      '🧹 Clear it',
      () => { app.clearAll(); toast('✨ Fresh plate! What will you build?'); }
    );
  });

  // ---------------------------------------------------------------- gallery
  const galleryGrid = $('galleryGrid');

  function renderGallery() {
    const items = storage.getGallery();
    galleryGrid.innerHTML = '';
    if (items.length === 0) {
      galleryGrid.innerHTML = '<p class="empty">Nothing saved yet. Build something and press 📸 Save!</p>';
      return;
    }
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'gallery-card';
      const img = document.createElement('img');
      img.src = item.thumb;
      img.alt = item.name;
      const label = document.createElement('div');
      label.className = 'gallery-name';
      label.textContent = item.name;
      const row = document.createElement('div');
      row.className = 'gallery-actions';
      const load = document.createElement('button');
      load.className = 'btn small';
      load.textContent = '📂 Open';
      load.addEventListener('click', () => {
        const doLoad = () => {
          app.loadCells(item.blocks, item.name);
          nameInput.value = item.name;
          closeModals();
          toast(`📂 Opened “${item.name}”!`);
        };
        if (app.world.count > 0) {
          confirmAction('📂 Open this?', `Your current build will be replaced by “${item.name}”. Save it first if you want to keep it!`, '📂 Open', doLoad);
        } else {
          doLoad();
        }
      });
      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = '🗑️';
      del.title = 'Delete';
      del.addEventListener('click', () => {
        confirmAction('🗑️ Delete?', `Really delete “${item.name}” forever?`, '🗑️ Delete', () => {
          storage.removeFromGallery(item.id);
          openModal('galleryModal');
          renderGallery();
        });
      });
      row.append(load, del);
      card.append(img, label, row);
      galleryGrid.appendChild(card);
    }
  }

  $('galleryBtn').addEventListener('click', () => {
    app.sounds.click();
    renderGallery();
    openModal('galleryModal');
  });

  $('saveBtn').addEventListener('click', () => {
    if (app.world.count === 0) { toast('🙂 Build something first!'); return; }
    storage.addToGallery({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: app.name,
      date: new Date().toISOString(),
      thumb: app.captureThumbnail(),
      blocks: app.world.toArray(),
    });
    app.sounds.tada();
    renderGallery();
    toast(`📸 Saved “${app.name}” to My Stuff!`);
  });

  // ----------------------------------------------------------------- export
  let exportMM = 5;

  function updateExportInfo() {
    const b = app.world.bounds(); // quarter units, max exclusive
    if (!b) return;
    const blocksW = (b.max[0] - b.min[0]) / 4;
    const blocksH = (b.max[1] - b.min[1]) / 4;
    const blocksD = (b.max[2] - b.min[2]) / 4;
    const cm = (n) => ((n * exportMM) / 10).toFixed(1);
    const fb = (n) => String(Math.round(n * 100) / 100); // "2.5", not "2.50"
    $('exportDims').textContent =
      `${app.world.count} blocks • ${fb(blocksW)} × ${fb(blocksD)} × ${fb(blocksH)} tall`;
    $('exportSize').textContent =
      `Printed size: ${cm(blocksW)} × ${cm(blocksD)} cm, ${cm(blocksH)} cm tall`;
  }

  for (const chip of document.querySelectorAll('#scaleChips button')) {
    chip.addEventListener('click', () => {
      exportMM = Number(chip.dataset.mm);
      for (const c of chip.parentElement.children) c.classList.remove('selected');
      chip.classList.add('selected');
      app.sounds.click();
      updateExportInfo();
    });
  }

  let floatingCache = [];
  $('printBtn').addEventListener('click', () => {
    app.sounds.click();
    if (app.world.count === 0) { toast('🙂 Build something first, then print it!'); return; }
    floatingCache = app.world.floatingCells();
    const warn = $('floatWarning');
    warn.classList.toggle('hidden', floatingCache.length === 0);
    if (floatingCache.length > 0) {
      $('floatCount').textContent =
        `${floatingCache.length} block${floatingCache.length > 1 ? 's are' : ' is'} floating in the air — they'll fall off when printed!`;
    }
    updateExportInfo();
    openModal('exportModal');
  });

  $('showFloating').addEventListener('click', () => {
    closeModals();
    app.highlightCells(floatingCache);
  });

  function slugName() {
    return app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'craftprint';
  }
  function downloadFile(data, filename, mime) {
    const blob = new Blob([data], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // Color 3MF for Bambu Studio + AMS.
  $('download3mfBtn').addEventListener('click', () => {
    const data = app.export3MF(exportMM);
    const file = `${slugName()}.3mf`;
    downloadFile(data, file, 'model/3mf');
    app.sounds.tada();
    closeModals();
    toast(`🌈 ${file} saved! Open it in Bambu Studio to print in color!`, 4000);
  });

  // Plain single-color STL for any slicer.
  $('downloadBtn').addEventListener('click', () => {
    const buffer = app.exportSTL(exportMM);
    const file = `${slugName()}.stl`;
    downloadFile(buffer, file, 'model/stl');
    app.sounds.tada();
    closeModals();
    toast(`🎉 ${file} saved! Open it in your slicer and print it!`, 4000);
  });

  // ------------------------------------------------------------------- help
  $('helpBtn').addEventListener('click', () => { app.sounds.click(); openModal('helpModal'); });

  // ---------------------------------------------------------------- welcome
  if (firstRun) openModal('welcomeModal');
  $('letsBuildBtn').addEventListener('click', () => {
    app.sounds.click();
    closeModals();
    app.lockPointer(); // jump straight into first person
  });

  // --------------------------------------------------------------- keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? app.redo() : app.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); app.redo(); return; }
    if (e.key === 'Escape') { closeModals(); return; }

    // Number keys pick colors in both modes (1..9, 0 = tenth).
    if (/^[0-9]$/.test(e.key)) {
      const i = e.key === '0' ? 9 : Number(e.key) - 1;
      if (i < PALETTE.length) { selectColor(i); app.sounds.click(); }
      return;
    }

    if (e.key.toLowerCase() === 'm') { mirrorBtn.click(); return; }
    if (e.key.toLowerCase() === 'g' && app.mode === 'orbit') { cycleSize(); return; }

    // Shape controls work in both modes. (In walk mode, main.js also binds R
    // and Q while the pointer is locked; this covers the unlocked/orbit case.)
    if (app.mode === 'orbit') {
      if (e.key.toLowerCase() === 'r') { app.rotate(); app.sounds.click(); return; }
      if (e.key.toLowerCase() === 'q') { toggleShape(); return; }

      // Tool keys only make sense in orbit mode (walk mode: RMB breaks,
      // LMB places, F paints — and WASD owns most letters).
      switch (e.key.toLowerCase()) {
        case 'b': selectTool('build'); break;
        case 'e': selectTool('erase'); break;
        case 'p': selectTool('paint'); break;
      }
    }
  });

  return {
    selectColor,
    reflectShape,
    reflectSize,
    toggleShape,
    cycleSize,
    toast,
    onModeChange,
    hideModeToggle: () => { modeBtn.style.display = 'none'; },
  };
}
