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
import * as account from './account.js';
import * as sync from './sync.js';
import { STARTERS } from './starters.js';
import qrcode from '../vendor/qrcode.mjs';

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
    if (i < 10) {
      b.dataset.key = `${(i + 1) % 10}`; // 1..9 then 0
      const k = document.createElement('span');
      k.className = 'key-hint';
      k.textContent = b.dataset.key;
      b.appendChild(k);
    }
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
    // Cycle through the shapes in shape-bar order (ids aren't contiguous:
    // legacy shape 2 was folded into 3).
    const order = shapeButtons.map((b) => Number(b.dataset.shape));
    const i = order.indexOf(app.shape);
    selectShape(order[(i + 1) % order.length]);
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

  // ---------------------------------------------------- loose-pieces chip
  // main.js re-checks the structure after every change and calls onStructure.
  // The chip shows how many blocks aren't REALLY attached (corner/edge/slope
  // contact doesn't hold a print together); tapping it flashes them.
  const looseChip = $('looseChip');
  function onStructure({ loose }) {
    looseChip.classList.toggle('hidden', loose.length === 0);
    if (loose.length === 0) return;
    looseChip.textContent = `🧩 ${loose.length} loose`;
    // First time a kid makes a loose piece, explain the rule once.
    const settings = storage.loadSettings();
    if (!settings.looseTipShown) {
      settings.looseTipShown = true;
      storage.saveSettings(settings);
      toast('🧩 Red blocks aren’t stuck on! Blocks need to share a flat side — corners alone fall apart when printed.', 6000);
    }
  }
  looseChip.addEventListener('click', () => {
    app.sounds.click();
    app.highlightCells(app.structure.loose);
    toast('🧩 The flashing blocks need a flat side to hold onto — or use 🩹 Glue it on the Print screen!', 4500);
  });

  // ------------------------------------------------------ see-inside cutaway
  // Camera-view slider that peels the build open from the top, layer by
  // layer, so kids can check (and fill) the inside of their models.
  const insidePanel = $('insidePanel');
  const insideSlider = $('insideSlider');
  let insideMax = 1;
  function openInsideView() {
    const b = app.world.bounds();
    insideMax = b ? b.max[1] : 4;
    insideSlider.max = String(insideMax);
    insideSlider.value = String(insideMax);
    insidePanel.classList.remove('hidden');
    $('insideBtn').classList.add('selected');
    app.setCutY(null);
  }
  function resetInsideView() {
    insidePanel.classList.add('hidden');
    $('insideBtn').classList.remove('selected');
    app.setCutY(null);
  }
  function toggleInsideView() {
    app.sounds.click();
    if (insidePanel.classList.contains('hidden')) {
      if (app.world.count === 0) { toast('🙂 Build something first!'); return; }
      // No toast here — the panel labels itself, and a toast would land right
      // on top of the slider (toasts stack from the same top-center spot).
      openInsideView();
    } else {
      resetInsideView();
    }
  }
  $('insideBtn').addEventListener('click', toggleInsideView);
  $('insideDoneBtn').addEventListener('click', () => { app.sounds.click(); resetInsideView(); });
  insideSlider.addEventListener('input', () => {
    const v = Number(insideSlider.value);
    app.setCutY(v >= insideMax ? null : v);
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

  // "New" offers a choice rather than just wiping the plate: an empty plate,
  // or one of the starter builds (the starters were invisible when they only
  // lived in My Stuff, which reads as "my saves").
  $('newBtn').addEventListener('click', () => {
    app.sounds.click();
    openModal('newModal');
  });

  $('emptyPlateBtn').addEventListener('click', () => {
    app.sounds.click();
    const fresh = () => {
      app.clearAll();
      closeModals();
      toast('✨ Fresh plate! What will you build?');
    };
    if (app.world.count === 0) { fresh(); return; }
    confirmAction(
      '🧹 Start fresh?',
      'This clears the whole build plate. (You can Undo, or save it in My Stuff first!)',
      '🧹 Clear it',
      fresh
    );
  });

  // ---------------------------------------------------------------- gallery
  const galleryGrid = $('galleryGrid');

  // A neutral picture for designs that arrived from the cloud without a
  // thumbnail (saved by an older app version).
  const FALLBACK_THUMB = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect width="4" height="3" fill="#cfeeff"/><text x="2" y="2" font-size="1.4" text-anchor="middle">🧱</text></svg>');

  function renderGallery() {
    const items = storage.getGallery();
    galleryGrid.innerHTML = '';
    if (items.length === 0) {
      galleryGrid.innerHTML = '<p class="empty">Nothing saved yet. Build something and press 📸 Save!</p>';
      return;
    }
    const signedIn = account.signedIn();
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'gallery-card';
      const img = document.createElement('img');
      img.src = item.thumb || FALLBACK_THUMB;
      img.alt = item.name;
      const label = document.createElement('div');
      label.className = 'gallery-name';
      label.textContent = item.name;
      // Sync badge (signed in only): in the cloud, or still waiting to go up.
      if (signedIn) {
        const dot = document.createElement('span');
        dot.className = 'sync-dot';
        dot.textContent = item.dirty ? '📴' : '☁️';
        dot.title = item.dirty ? 'Saved on this device — goes to your cloud when online' : 'Safe in your cloud';
        card.appendChild(dot);
      }
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
        const where = signedIn ? ' everywhere — this device AND your cloud' : ' forever';
        confirmAction('🗑️ Delete?', `Really delete “${item.name}”${where}?`, '🗑️ Delete', () => {
          storage.removeFromGallery(item.id);
          sync.scheduleSync(600);
          openModal('galleryModal');
          renderGallery();
          renderAccountArea();
        });
      });
      row.append(load, del);
      card.append(img, label, row);
      galleryGrid.appendChild(card);
    }
  }

  // Starter builds: ready-made models to load and take apart. Offered in two
  // places because people arrive from two directions — "✨ New" (I want to
  // start something) and "📦 My Stuff" (show me builds).
  function starterCard(s) {
    const b = document.createElement('button');
    b.className = 'btn starter-card';
    b.title = `Load the ${s.name} starter build`;
    b.innerHTML = `<span class="starter-emoji">${s.emoji}</span>`;
    const label = document.createElement('span');
    label.className = 'starter-name';
    label.textContent = s.name;
    const blurb = document.createElement('span');
    blurb.className = 'starter-blurb';
    blurb.textContent = s.blurb;
    b.append(label, blurb);
    b.addEventListener('click', () => {
      app.sounds.click();
      const load = () => {
        app.loadCells(s.build(), s.name);
        nameInput.value = app.name;
        closeModals();
        app.sounds.tada();
        toast(`${s.emoji} Loaded the ${s.name}! Take it apart and make it yours.`, 4000);
      };
      if (app.world.count > 0) {
        confirmAction('✨ Load this starter?',
          `Your current build will be replaced by the ${s.name}. Save it first if you want to keep it!`,
          '✨ Load it', load);
      } else load();
    });
    return b;
  }
  for (const row of [$('starterRow'), $('newStarterRow')]) {
    for (const s of STARTERS) row.appendChild(starterCard(s));
  }

  $('galleryBtn').addEventListener('click', () => {
    app.sounds.click();
    renderGallery();
    renderAccountArea();
    sync.scheduleSync(400); // freshen the list while it's on screen
    openModal('galleryModal');
  });

  // ------------------------------------------------- account + sync status
  // My Stuff is ONE list. Signed in, it mirrors to the cloud automatically
  // (offline saves queue and drain when the connection returns — src/sync.js);
  // signed out it's local-only, with a gentle offer to sign in.
  let cloudLoginAvailable = null; // null = not yet probed
  function accErrText(e) {
    const m = String(e?.message || e);
    if (m === 'offline') return '📡 Could not reach the server — check the connection.';
    if (m === 'signed-out') return '🔑 You were signed out — sign in again.';
    return `😕 Cloud problem: ${m}`;
  }

  function syncStatusText() {
    if (sync.isSyncing()) return '🔄 Syncing…';
    const pending = sync.pendingCount();
    if (pending > 0) {
      return navigator.onLine === false || sync.lastSyncError()
        ? `📴 ${pending} waiting to sync`
        : '🔄 Syncing…';
    }
    return '☁️ All saved to your cloud';
  }

  async function renderAccountArea() {
    const area = $('accountArea');
    area.innerHTML = '';
    area.classList.add('hidden');

    if (account.signedIn()) {
      area.classList.remove('hidden');
      const row = document.createElement('div');
      row.className = 'cloud-row';
      const who = document.createElement('span');
      who.className = 'fine cloud-who';
      who.textContent = `☁️ ${account.info().email}`;
      const status = document.createElement('span');
      status.className = 'fine';
      status.id = 'syncStatus';
      status.textContent = syncStatusText();
      const outB = document.createElement('button');
      outB.className = 'btn small';
      outB.textContent = 'Sign out';
      outB.addEventListener('click', () => {
        app.sounds.click();
        confirmAction('👋 Sign out?',
          'Your saves stay on this device and in your cloud — they just stop syncing until you sign in again.',
          '👋 Sign out',
          () => { account.signOut(); openModal('galleryModal'); renderGallery(); renderAccountArea(); });
      });
      row.append(who, status, outB);
      area.appendChild(row);
      return;
    }

    // Signed out: offer sign-in when the server supports it.
    if (cloudLoginAvailable === null) {
      try { cloudLoginAvailable = (await classroom.health()).login; }
      catch { cloudLoginAvailable = false; }
    }
    if (!cloudLoginAvailable) return;
    area.classList.remove('hidden');
    const row = document.createElement('div');
    row.className = 'cloud-row';
    const p = document.createElement('span');
    p.className = 'fine cloud-who';
    p.textContent = 'Keep these safe in the cloud and on all your devices:';
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = '🔑 Sign in with Google';
    btn.addEventListener('click', () => {
      app.sounds.click();
      const url = account.signInURL();
      if (url) location.href = url; // full-page round trip through Google
    });
    row.append(p, btn);
    area.appendChild(row);
  }

  // Keep badges and the status line live while syncs run in the background.
  sync.onSync(() => {
    const status = $('syncStatus');
    if (status) status.textContent = syncStatusText();
    if (!$('galleryModal').classList.contains('hidden')) renderGallery();
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
    renderAccountArea();
    if (account.signedIn()) {
      sync.scheduleSync(600);
      toast(`📸 Saved “${app.name}” — syncing to your cloud!`);
    } else {
      toast(`📸 Saved “${app.name}” to My Stuff!`);
    }
  });

  // -------------------------------------------------------------- classroom
  // Room codes: students join a teacher's room and hand in builds; the
  // teacher collects them all from one screen. See src/classroom.js and
  // server/README.md.
  const classViews = {
    join: $('classJoinView'),
    setup: $('classSetupView'),
    student: $('classStudentView'),
    teacher: $('classTeacherView'),
  };
  function showClassView(which) {
    for (const [k, el] of Object.entries(classViews)) el.classList.toggle('hidden', k !== which);
  }

  function classErrText(e) {
    const m = String(e?.message || e);
    if (m === 'offline') return '📡 Could not reach the class server — check the internet connection.';
    if (m.includes('room not found')) return '🤔 That room code doesn’t exist — check the board!';
    if (m.includes('room is full')) return '😅 The room is full — tell your teacher!';
    if (m.includes('passcode')) return '🔒 That teacher passcode isn’t right — check with your school.';
    return `😕 Class problem: ${m}`;
  }

  const fileSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'design';

  let classDesignsCache = [];
  // Has the teacher saved the active class's key on this device? Drives the
  // "save your key" nag, which is the difference between a recoverable class
  // and a lost one.
  let keySaved = false;

  // Big scannable QR of the join link on the teacher's screen: students point
  // the tablet camera at the board and land in the room with zero typing
  // beyond their name (the link carries the room code AND server address).
  function drawJoinQR(code) {
    const canvas = $('classQR');
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    try {
      const qr = qrcode(0, 'M'); // auto version, medium error correction
      qr.addData(classroom.joinURL(code));
      qr.make();
      const n = qr.getModuleCount();
      const quiet = 8;
      const cell = (size - quiet * 2) / n;
      ctx.fillStyle = '#241d3d';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) {
            ctx.fillRect(quiet + c * cell, quiet + r * cell, Math.ceil(cell), Math.ceil(cell));
          }
        }
      }
    } catch { /* link too long to encode — the Copy link button still works */ }
  }

  // One chip per class this teacher runs, so a term's worth of classes stays
  // reachable from one screen; the active one is highlighted.
  function renderClassTabs() {
    const tabs = $('classTabs');
    const classes = classroom.allClasses();
    const active = classroom.activeClass();
    tabs.innerHTML = '';
    for (const cls of classes) {
      const b = document.createElement('button');
      b.className = 'btn small class-tab' + (cls.code === active?.code ? ' selected' : '');
      b.textContent = `${cls.owned ? '☁️ ' : ''}${cls.teacher} · ${cls.code}`;
      b.title = `Switch to ${cls.teacher} (room ${cls.code})`;
      b.addEventListener('click', () => {
        app.sounds.click();
        classroom.setActiveClass(cls.code);
        renderClassModal();
      });
      tabs.appendChild(b);
    }
    tabs.classList.toggle('hidden', classes.length < 2);
  }

  function renderClassModal() {
    const cls = classroom.activeClass();
    const student = classroom.studentInfo();
    if (cls) {
      showClassView('teacher');
      renderClassTabs();
      $('classCodeBig').textContent = cls.code;
      drawJoinQR(cls.code);
      // Owned classes need no key ceremony at all; legacy ones keep it, plus
      // (when signed in) a one-tap upgrade into the account.
      $('classSaveKeyBtn').classList.toggle('hidden', !!cls.owned);
      $('classClaimBtn').classList.toggle('hidden', !!cls.owned || !account.signedIn());
      $('classTeacherLeaveBtn').textContent = cls.owned ? 'Close this class' : 'Close on this device';
      renderKeyWarning();
      refreshClassDesigns();
    } else if (student) {
      showClassView('student');
      $('classStudentInfo').textContent =
        `🎒 You're in ${student.teacher || 'your teacher'}'s class (room ${student.code}) as ${student.name}.`;
    } else {
      showClassView('join');
    }
  }

  $('classBtn').addEventListener('click', () => {
    app.sounds.click();
    renderClassModal();
    openModal('classModal');
    // Signed in? Pull the account's class list so classes created on another
    // device appear here too, then re-render if anything changed.
    if (account.signedIn()) {
      const before = JSON.stringify(classroom.ownedRooms());
      classroom.refreshOwnedRooms()
        .then((rooms) => { if (JSON.stringify(rooms) !== before) renderClassModal(); })
        .catch(() => { /* offline: cached list still renders */ });
    }
  });

  // Teacher setup gate: signing in is what makes classes portable, so the
  // create form appears once they are (or when the server has no accounts).
  async function renderClassAuthArea() {
    const area = $('classAuthArea');
    const form = $('classCreateForm');
    area.innerHTML = '';
    if (account.signedIn()) {
      const p = document.createElement('p');
      p.className = 'fine';
      p.textContent = `☁️ Signed in as ${account.info().email} — your classes follow you to any device.`;
      area.appendChild(p);
      form.classList.remove('hidden');
      return;
    }
    let login = false;
    try { login = (await classroom.health()).login; } catch { /* offline */ }
    if (!login) { form.classList.remove('hidden'); return; } // key-only server
    form.classList.add('hidden');
    const p = document.createElement('p');
    p.className = 'fine';
    p.textContent = 'Sign in once and your classes go with you — any device, no keys to keep track of.';
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = '🔑 Sign in with Google';
    btn.addEventListener('click', () => {
      app.sounds.click();
      const url = account.signInURL('class'); // come back to the Class screen
      if (url) location.href = url;
    });
    area.append(p, btn);
  }

  $('classTeacherModeBtn').addEventListener('click', () => {
    app.sounds.click();
    showClassView('setup');
    renderClassAuthArea();
    // Ask the service whether it wants a staff passcode, so the field is
    // already there before the teacher presses Create.
    classroom.health()
      .then((info) => $('classPasscodeRow').classList.toggle('hidden', !info.needsPasscode))
      .catch(() => { /* offline: Create will report it */ });
  });
  $('classBackBtn').addEventListener('click', () => { app.sounds.click(); showClassView('join'); });


  $('classCode').addEventListener('input', () => {
    $('classCode').value = $('classCode').value.toUpperCase();
  });

  $('classJoinBtn').addEventListener('click', async () => {
    app.sounds.click();
    const code = $('classCode').value.trim().toUpperCase();
    const student = $('classStudent').value.trim();
    if (code.length < 4 || !student) { toast('🙂 Type the room code AND your first name!'); return; }
    try {
      const info = await classroom.checkRoom(code);
      classroom.joinAs(code, student, info.teacher);
      app.sounds.tada();
      renderClassModal();
      toast(`🎒 You joined ${info.teacher}'s class!`);
      // Joined via a link/QR? Tidy the address bar so reloads start clean.
      if (location.search) history.replaceState(null, '', location.pathname);
    } catch (e) { toast(classErrText(e)); }
  });

  $('classHandInBtn').addEventListener('click', async () => {
    app.sounds.click();
    if (app.world.count === 0) { toast('🙂 Build something first, then hand it in!'); return; }
    const me = classroom.studentInfo();
    if (!me) { toast('🙂 Join a class first!'); return; }
    try {
      await classroom.handIn(me.code, { student: me.name, name: app.name, blocks: app.world.toArray() });
      app.sounds.tada();
      toast(`🖐 Handed in “${app.name}”! Your teacher has it now.`, 4000);
    } catch (e) { toast(classErrText(e)); }
  });

  $('classLeaveBtn').addEventListener('click', () => {
    app.sounds.click();
    classroom.leaveClass();
    renderClassModal();
  });

  $('classCopyLinkBtn').addEventListener('click', async () => {
    app.sounds.click();
    const url = classroom.joinURL(classroom.activeClass()?.code);
    try {
      await navigator.clipboard.writeText(url);
      toast('🔗 Join link copied — paste it in Google Classroom, email, anywhere!');
    } catch {
      toast(`🔗 ${url}`, 8000); // clipboard blocked: show it long enough to copy by hand
    }
  });

  $('classCreateBtn').addEventListener('click', async () => {
    app.sounds.click();
    try {
      const teacher = $('classTeacherName').value.trim() || 'My class';
      const room = await classroom.createRoom(teacher, $('classPasscode').value);
      if (room.owned) {
        // Account-owned: no key to keep — the class lives on the account.
        await classroom.refreshOwnedRooms().catch(() => { /* board renders from cache */ });
        classroom.setActiveClass(room.code);
      } else {
        classroom.addClass({ code: room.code, key: room.teacherKey, teacher, created: Date.now() });
        keySaved = false; // remind them to save this new class's key
      }
      app.sounds.tada();
      renderClassModal();
      toast(`🍎 Class created! Room code: ${room.code} — write it on the board.`, 5000);
    } catch (e) { toast(classErrText(e)); }
  });

  // "New class" from the teacher screen: back to the setup form, keeping the
  // classes they already run.
  $('classNewBtn').addEventListener('click', () => {
    app.sounds.click();
    $('classTeacherName').value = '';
    showClassView('setup');
    renderClassAuthArea();
  });

  // Saving the key is what makes a LEGACY class recoverable, so nag until
  // it's done. Account-owned classes need no key at all — no nag.
  function renderKeyWarning() {
    const owned = !!classroom.activeClass()?.owned;
    $('classKeyWarning').classList.toggle('hidden', owned || keySaved);
  }

  // Upgrade a legacy class into the signed-in account: prove the key once,
  // then it appears on every device the teacher signs into.
  $('classClaimBtn').addEventListener('click', async () => {
    app.sounds.click();
    const cls = classroom.activeClass();
    if (!cls || cls.owned || !cls.key) return;
    try {
      await classroom.claimRoom(cls.code, cls.key);
      await classroom.refreshOwnedRooms();
      classroom.forgetClass(cls.code); // drop the legacy entry; owned now
      classroom.setActiveClass(cls.code);
      app.sounds.tada();
      renderClassModal();
      toast(`☁️ “${cls.teacher}” is in your account now — it follows you to any device.`, 4500);
    } catch (e) { toast(classErrText(e)); }
  });

  $('classSaveKeyBtn').addEventListener('click', () => {
    app.sounds.click();
    const cls = classroom.activeClass();
    if (!cls) return;
    downloadFile(classroom.keyFileFor(cls),
      `craftprint-teacher-key-${cls.code}.json`, 'application/json');
    keySaved = true;
    renderKeyWarning();
    toast('🔑 Teacher key saved — keep it somewhere safe (email it to yourself!).', 5000);
  });

  $('classTeacherLeaveBtn').addEventListener('click', () => {
    const cls = classroom.activeClass();
    if (!cls) return;
    if (cls.owned) {
      // Owned classes close FOR REAL: room + hand-ins deleted on the server,
      // gone from every device. Download the designs first if they matter.
      confirmAction(
        '🏁 Close this class for good?',
        `This ends “${cls.teacher}” (room ${cls.code}) everywhere: students can no longer join or hand in, and all its hand-ins are deleted. Download the designs first if you want to keep them!`,
        '🏁 Close the class',
        async () => {
          try {
            await classroom.closeRoom(cls.code);
            await classroom.refreshOwnedRooms();
            renderClassModal();
            toast(`🏁 “${cls.teacher}” is closed.`);
          } catch (e) { toast(classErrText(e)); }
        }
      );
      return;
    }
    confirmAction(
      '👋 Close this class here?',
      `This device will forget “${cls.teacher}” (room ${cls.code}). You can get it back later with its teacher key — but without that key the hand-ins are gone for good. Save the key or download the designs first!`,
      '👋 Close it',
      () => { classroom.forgetClass(cls.code); renderClassModal(); }
    );
  });

  // --- recovery: room code + teacher key, typed or from a saved key file ---
  async function recoverInto(code, key) {
    if (!code || !key) { toast('🙂 Enter both the room code and the teacher key.'); return; }
    try {
      const cls = await classroom.recoverClass(code.trim().toUpperCase(), key.trim());
      classroom.addClass(cls);
      keySaved = true; // they clearly have the key
      app.sounds.tada();
      renderClassModal();
      toast(`🔑 Got “${cls.teacher}” back — its hand-ins are here.`, 4000);
    } catch (e) { toast(classErrText(e)); }
  }

  $('classRecoverCode').addEventListener('input', () => {
    $('classRecoverCode').value = $('classRecoverCode').value.toUpperCase();
  });
  $('classRecoverBtn').addEventListener('click', () => {
    app.sounds.click();
    recoverInto($('classRecoverCode').value, $('classRecoverKey').value);
  });

  const recoverFile = $('classRecoverFile');
  $('classRecoverFileBtn').addEventListener('click', () => { app.sounds.click(); recoverFile.click(); });
  recoverFile.addEventListener('change', () => {
    const file = recoverFile.files && recoverFile.files[0];
    recoverFile.value = '';
    if (!file) return;
    file.text().then((text) => {
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!data?.code || !data?.key) { toast('😕 That file isn’t a CraftPrint teacher key.'); return; }
      // A key file remembers which server the class lives on, so a teacher
      // restoring onto a fresh device doesn't have to set that up again.
      if (data.server && !classroom.getState().server) {
        classroom.setState({ ...classroom.getState(), server: data.server });
      }
      recoverInto(data.code, data.key);
    }).catch(() => toast('😕 Could not read that file.'));
  });

  async function refreshClassDesigns() {
    const cls = classroom.activeClass();
    const grid = $('classDesigns');
    if (!cls) { grid.innerHTML = ''; return; }
    grid.innerHTML = '<p class="empty">Loading…</p>';
    try {
      // Owned classes authenticate with the sign-in; legacy ones use the key.
      const { designs } = await classroom.listDesigns(cls.code, cls.owned ? undefined : cls.key);
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
    downloadFile(zip, `class-${classroom.activeClass()?.code}-designs.zip`, 'application/zip');
    app.sounds.tada();
  });

  $('classZipSTLBtn').addEventListener('click', () => {
    app.sounds.click();
    if (classDesignsCache.length === 0) { toast('🙂 Nothing handed in yet!'); return; }
    const zip = makeZip(classDesignsCache.map((d) => ({
      name: `${fileSlug(d.student)}-${fileSlug(d.name)}.stl`,
      data: new Uint8Array(blocksToSTL(d.blocks, exportMM, exportOpts())),
    })));
    downloadFile(zip, `class-${classroom.activeClass()?.code}-print-files.zip`, 'application/zip');
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

  // Print-check: uses the real contact-area analysis (structure.js) that
  // main.js keeps fresh in app.structure — loose pieces would print as
  // separate bits, skinny joints may snap.
  function updatePrintCheck() {
    const { loose, skinny } = app.structure;
    const warn = $('floatWarning');
    warn.classList.toggle('hidden', loose.length === 0);
    if (loose.length > 0) {
      $('floatCount').textContent =
        `${loose.length} block${loose.length > 1 ? 's aren’t' : ' isn’t'} really stuck on — corners and edges don't hold! They'll fall off when printed.`;
    }
    const skinnyWarn = $('skinnyWarning');
    skinnyWarn.classList.toggle('hidden', skinny.length === 0);
    if (skinny.length > 0) {
      $('skinnyCount').textContent =
        `${skinny.length > 2 ? 'Some parts hang' : 'A part hangs'} on a tiny joint that might snap — make it thicker!`;
    }
  }

  $('printBtn').addEventListener('click', () => {
    app.sounds.click();
    if (app.world.count === 0) { toast('🙂 Build something first, then print it!'); return; }
    updatePrintCheck();
    updateExportInfo();
    openModal('exportModal');
  });

  $('showFloating').addEventListener('click', () => {
    closeModals();
    app.highlightCells(app.structure.loose);
  });

  $('showSkinny').addEventListener('click', () => {
    closeModals();
    app.highlightCells(app.structure.skinny, '#ff9d2e');
  });

  $('glueBtn').addEventListener('click', () => {
    app.sounds.click();
    const added = app.glueLoose();
    updatePrintCheck();
    if (added > 0) {
      app.sounds.tada();
      toast(`🩹 Glued! Added ${added} bridging block${added > 1 ? 's' : ''} — Undo if you'd rather fix it yourself.`, 5000);
    } else {
      toast('🤔 Couldn’t find a way to glue those — try connecting them with blocks yourself.');
    }
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
  // A join link / scanned QR (?class=CODE&server=...) beats the welcome tour:
  // it drops the student straight into the Class screen with the room code
  // (and server) prefilled — they only type their first name.
  const bootParams = new URLSearchParams(location.search);

  // Returning from Google sign-in: ?login=CODE (or ?login_error=1). Trade the
  // one-time code for a session, then tidy the address bar.
  const bootLogin = (bootParams.get('login') || '').trim();
  if (bootLogin || bootParams.get('login_error')) {
    history.replaceState(null, '', location.pathname);
    const backTo = bootParams.get('back');
    if (bootLogin) {
      account.completeLogin(bootLogin)
        .then(async (me) => {
          app.sounds.tada();
          toast(`☁️ Signed in as ${me.email} — your saves sync to the cloud now!`, 4500);
          // First sync merges both ways: everything local goes up, everything
          // from other devices comes down. Nothing is lost.
          try { await sync.syncNow(); } catch { /* status line reports it */ }
          if (backTo === 'class') {
            // The teacher was mid class-setup: put them right back there.
            await classroom.refreshOwnedRooms().catch(() => { /* cached */ });
            renderClassModal();
            if (!classroom.activeClass()) { showClassView('setup'); renderClassAuthArea(); }
            openModal('classModal');
          } else {
            renderGallery();
            renderAccountArea();
            openModal('galleryModal');
          }
        })
        .catch((e) => toast(accErrText(e)));
    } else {
      toast('😕 Google sign-in didn’t finish — try again.');
    }
  } else if (account.signedIn()) {
    // Normal boot while signed in: catch up with the cloud in the background.
    sync.scheduleSync(1500);
  }

  const bootJoin = (bootParams.get('class') || '').trim().toUpperCase();
  if (bootJoin) {
    const bootServer = (bootParams.get('server') || '').trim();
    if (bootServer) classroom.setState({ ...classroom.getState(), server: bootServer });
    renderClassModal();
    if (!classroom.activeClass() && !classroom.studentInfo()) {
      showClassView('join');
      $('classCode').value = bootJoin;
    }
    openModal('classModal');
    setTimeout(() => $('classStudent').focus(), 50);
  } else if (firstRun) {
    openModal('welcomeModal');
  }
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
    // Z/X/C pick a shape directly (badged on the buttons); works in orbit
    // and in unlocked walk mode (locked walk is handled in main.js). Never
    // steal Ctrl/Cmd/Alt combos (copy/paste etc.).
    const SHAPE_KEYS = { z: 0, x: 1, c: 3 };
    if (!mod && !e.altKey && e.key.toLowerCase() in SHAPE_KEYS) {
      selectShape(SHAPE_KEYS[e.key.toLowerCase()]);
      app.sounds.click();
      return;
    }

    if (app.mode === 'orbit') {
      if (e.key.toLowerCase() === 'r') { app.rotate(); app.sounds.click(); return; }
      if (e.key.toLowerCase() === 't') { app.tip(); app.sounds.click(); return; }
      if (e.key.toLowerCase() === 'q') { toggleShape(); return; }
      if (e.key.toLowerCase() === 'i') { toggleInsideView(); return; }

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
    selectShape,
    reflectShape,
    reflectSize,
    toggleShape,
    cycleSize,
    toast,
    onModeChange,
    onStructure,
    resetInsideView,
    hideModeToggle: () => { modeBtn.style.display = 'none'; },
  };
}
