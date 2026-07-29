// DOM wiring: toolbar, palette, modals (welcome / export / gallery / confirm /
// help), toasts, mode toggle, and keyboard shortcuts. All game logic lives in
// main.js's `app`; this module only reads/writes the DOM.
//
// Returns a small API used by main.js: { selectColor, toast, onModeChange,
// hideModeToggle }.

import { PALETTE } from './palette.js';
import { SOFT_EDGE_MM } from './geometry.js';
import { blocksToSTL } from './stl.js';
import { makeZip } from './zip.js';
import * as storage from './storage.js';
import * as classroom from './classroom.js';

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
  const dirGlyphs = Array.from(document.querySelectorAll('[data-shape] .dir-glyph'));
  function reflectShape() {
    for (const b of shapeButtons) {
      b.classList.toggle('selected', Number(b.dataset.shape) === app.shape);
    }
    // Spin the directional shape icons (wedge, round, curve) to show which
    // way they'll face: each Turn is a quarter turn, matching the ghost
    // preview in the world. Tipped orientations (Tip button) tilt the icon
    // in 3D as a "this block is on its side / upside down" cue — the ghost
    // preview shows the exact pose.
    const upright = app.rot < 4;
    const tf = upright
      ? `rotate(${app.rot * 90}deg)`
      : `perspective(60px) rotateX(52deg) rotate(${(app.rot % 4) * 90}deg)`;
    for (const g of dirGlyphs) g.style.transform = tf;
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
    selectShape((app.shape + 1) % shapeButtons.length); // cycle all shapes
    app.sounds.click();
  }
  for (const b of shapeButtons) {
    b.addEventListener('click', () => { app.sounds.click(); selectShape(Number(b.dataset.shape)); });
  }
  $('rotateBtn').addEventListener('click', () => { app.rotate(); app.sounds.click(); });
  $('tipBtn').addEventListener('click', () => { app.tip(); app.sounds.click(); });
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

  // Design files: the raw block data as JSON, so creations can be backed up,
  // shared with friends, and edited again later — unlike STL, which is only
  // for printing.
  $('exportDesignBtn').addEventListener('click', () => {
    app.sounds.click();
    if (app.world.count === 0) { toast('🙂 Build something first!'); return; }
    const data = JSON.stringify({
      app: 'craftprint',
      version: 1,
      name: app.name,
      blocks: app.world.toArray(),
    });
    downloadFile(data, `${slugName()}.craftprint.json`, 'application/json');
    app.sounds.tada();
    toast('⬇️ Design file saved! Share it, or load it back with “Open design file”.', 4000);
  });

  const importInput = $('importDesignFile');
  $('importDesignBtn').addEventListener('click', () => { app.sounds.click(); importInput.click(); });
  importInput.addEventListener('change', () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = ''; // allow re-picking the same file
    if (!file) return;
    file.text().then((text) => {
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      // Accept our wrapper format or a bare block array.
      const blocks = Array.isArray(data) ? data : data?.blocks;
      const valid = Array.isArray(blocks) && blocks.length > 0 &&
        blocks.every((row) => Array.isArray(row) && row.length >= 3 && row.every(Number.isFinite));
      if (!valid) { toast('😕 That file is not a CraftPrint design.'); return; }
      const name = (typeof data?.name === 'string' && data.name.trim())
        ? data.name.trim().slice(0, 24) : 'Imported design';
      const doLoad = () => {
        app.loadCells(blocks, name);
        nameInput.value = app.name;
        closeModals();
        app.sounds.tada();
        toast(`📂 Opened “${name}”!`);
      };
      if (app.world.count > 0) {
        confirmAction('📂 Open this design?',
          `Your current build will be replaced by “${name}”. Save it first if you want to keep it!`,
          '📂 Open', doLoad);
      } else {
        doLoad();
      }
    }).catch(() => toast('😕 Could not read that file.'));
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

  // -------------------------------------------------------------- classroom
  // Room codes: students join a teacher's room and hand in builds; the
  // teacher collects them all from one screen. See src/classroom.js and
  // server/README.md.
  const classViews = {
    join: $('classJoinView'),
    student: $('classStudentView'),
    teacher: $('classTeacherView'),
  };
  function showClassView(which) {
    for (const [k, el] of Object.entries(classViews)) el.classList.toggle('hidden', k !== which);
  }

  function classErrText(e) {
    const m = String(e?.message || e);
    if (m === 'no-server') return '🍎 Ask a grown-up to set up the class server first (server/README.md)!';
    if (m === 'offline') return '📡 Could not reach the class server — check the internet connection.';
    if (m.includes('room not found')) return '🤔 That room code doesn’t exist — check the board!';
    if (m.includes('room is full')) return '😅 The room is full — tell your teacher!';
    return `😕 Class problem: ${m}`;
  }

  const fileSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'design';

  let classDesignsCache = [];

  function renderClassModal() {
    const st = classroom.getState();
    $('classServer').value = st.server || '';
    if (st.code && st.teacherKey) {
      showClassView('teacher');
      $('classCodeBig').textContent = st.code;
      refreshClassDesigns();
    } else if (st.code && st.student) {
      showClassView('student');
      $('classStudentInfo').textContent =
        `🎒 You're in ${st.teacher || 'your teacher'}'s class (room ${st.code}) as ${st.student}.`;
    } else {
      showClassView('join');
    }
  }

  $('classBtn').addEventListener('click', () => {
    app.sounds.click();
    renderClassModal();
    openModal('classModal');
  });

  $('classServerSave').addEventListener('click', () => {
    app.sounds.click();
    const server = $('classServer').value.trim();
    classroom.setState({ ...classroom.getState(), server });
    toast(server ? '✅ Class server saved on this device!' : 'Class server cleared');
  });

  $('classJoinBtn').addEventListener('click', async () => {
    app.sounds.click();
    const code = $('classCode').value.trim().toUpperCase();
    const student = $('classStudent').value.trim();
    if (code.length < 4 || !student) { toast('🙂 Type the room code AND your first name!'); return; }
    try {
      const info = await classroom.checkRoom(code);
      classroom.setState({ ...classroom.getState(), code, student, teacher: info.teacher, teacherKey: undefined });
      app.sounds.tada();
      renderClassModal();
      toast(`🎒 You joined ${info.teacher}'s class!`);
    } catch (e) { toast(classErrText(e)); }
  });

  $('classHandInBtn').addEventListener('click', async () => {
    app.sounds.click();
    if (app.world.count === 0) { toast('🙂 Build something first, then hand it in!'); return; }
    const st = classroom.getState();
    try {
      await classroom.handIn(st.code, { student: st.student, name: app.name, blocks: app.world.toArray() });
      app.sounds.tada();
      toast(`🖐 Handed in “${app.name}”! Your teacher has it now.`, 4000);
    } catch (e) { toast(classErrText(e)); }
  });

  $('classLeaveBtn').addEventListener('click', () => {
    app.sounds.click();
    classroom.setState({ server: classroom.getState().server });
    renderClassModal();
  });

  $('classCreateBtn').addEventListener('click', async () => {
    app.sounds.click();
    try {
      const teacher = $('classTeacherName').value.trim() || 'My class';
      const room = await classroom.createRoom(teacher);
      classroom.setState({
        ...classroom.getState(),
        code: room.code, teacherKey: room.teacherKey, teacher, student: undefined,
      });
      app.sounds.tada();
      renderClassModal();
      toast(`🍎 Class created! Room code: ${room.code} — write it on the board.`, 5000);
    } catch (e) { toast(classErrText(e)); }
  });

  $('classTeacherLeaveBtn').addEventListener('click', () => {
    confirmAction(
      '👋 Close this class here?',
      'This device will forget the room and its teacher key, so you won’t be able to collect these hand-ins again. Download everything first!',
      '👋 Close it',
      () => { classroom.setState({ server: classroom.getState().server }); renderClassModal(); }
    );
  });

  async function refreshClassDesigns() {
    const st = classroom.getState();
    const grid = $('classDesigns');
    grid.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const { designs } = await classroom.listDesigns(st.code, st.teacherKey);
      classDesignsCache = designs;
      grid.innerHTML = '';
      if (designs.length === 0) {
        grid.innerHTML = '<p class="empty">Nothing handed in yet. Students: 🏫 → type the room code + first name → 🖐 Hand in!</p>';
        return;
      }
      for (const d of designs) {
        const card = document.createElement('div');
        card.className = 'class-card';
        const title = document.createElement('div');
        title.className = 'class-card-name';
        title.textContent = `${d.student} — “${d.name}”`;
        const meta = document.createElement('div');
        meta.className = 'class-card-meta';
        meta.textContent = `🧱 ${d.blocks.length} blocks`;
        const row = document.createElement('div');
        row.className = 'gallery-actions';
        const openB = document.createElement('button');
        openB.className = 'btn small';
        openB.textContent = '👀 Open';
        openB.addEventListener('click', () => {
          const doLoad = () => {
            app.loadCells(d.blocks, d.name);
            nameInput.value = app.name;
            closeModals();
            toast(`👀 Looking at ${d.student}'s “${d.name}”`);
          };
          if (app.world.count > 0) {
            confirmAction('👀 Open this build?', `Your current build will be replaced by ${d.student}'s “${d.name}”. Save yours first if you need it!`, '👀 Open', doLoad);
          } else doLoad();
        });
        const stlB = document.createElement('button');
        stlB.className = 'btn small';
        stlB.textContent = '🖨️ STL';
        stlB.addEventListener('click', () => {
          downloadFile(blocksToSTL(d.blocks, exportMM, exportOpts()),
            `${fileSlug(d.student)}-${fileSlug(d.name)}.stl`, 'model/stl');
        });
        row.append(openB, stlB);
        card.append(title, meta, row);
        grid.appendChild(card);
      }
    } catch (e) {
      grid.innerHTML = '<p class="empty">Could not load hand-ins.</p>';
      toast(classErrText(e));
    }
  }
  $('classRefreshBtn').addEventListener('click', () => { app.sounds.click(); refreshClassDesigns(); });

  $('classZipDesignsBtn').addEventListener('click', () => {
    app.sounds.click();
    if (classDesignsCache.length === 0) { toast('🙂 Nothing handed in yet!'); return; }
    const zip = makeZip(classDesignsCache.map((d) => ({
      name: `${fileSlug(d.student)}-${fileSlug(d.name)}.craftprint.json`,
      data: JSON.stringify({ app: 'craftprint', version: 1, name: d.name, blocks: d.blocks }),
    })));
    downloadFile(zip, `class-${classroom.getState().code}-designs.zip`, 'application/zip');
    app.sounds.tada();
  });

  $('classZipSTLBtn').addEventListener('click', () => {
    app.sounds.click();
    if (classDesignsCache.length === 0) { toast('🙂 Nothing handed in yet!'); return; }
    const zip = makeZip(classDesignsCache.map((d) => ({
      name: `${fileSlug(d.student)}-${fileSlug(d.name)}.stl`,
      data: new Uint8Array(blocksToSTL(d.blocks, exportMM, exportOpts())),
    })));
    downloadFile(zip, `class-${classroom.getState().code}-print-files.zip`, 'application/zip');
    app.sounds.tada();
    toast(`🖨️ ${classDesignsCache.length} print file${classDesignsCache.length > 1 ? 's' : ''} zipped — drop the STLs in your slicer!`, 4500);
  });

  // ----------------------------------------------------------------- export
  let exportMM = 5;
  const softEdges = $('softEdges');
  const exportOpts = () => ({ bevelMM: softEdges.checked ? SOFT_EDGE_MM : 0 });

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
    const data = app.export3MF(exportMM, exportOpts());
    const file = `${slugName()}.3mf`;
    downloadFile(data, file, 'model/3mf');
    app.sounds.tada();
    closeModals();
    toast(`🌈 ${file} saved! Open it in Bambu Studio to print in color!`, 4000);
  });

  // Plain single-color STL for any slicer.
  $('downloadBtn').addEventListener('click', () => {
    const buffer = app.exportSTL(exportMM, exportOpts());
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
      if (e.key.toLowerCase() === 't') { app.tip(); app.sounds.click(); return; }
      if (e.key.toLowerCase() === 'q') { toggleShape(); return; }

      // Tool keys only make sense in orbit mode (walk mode: LMB breaks,
      // RMB places like Minecraft, F paints — and WASD owns most letters).
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
