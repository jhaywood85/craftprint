// localStorage persistence: autosaved current creation, saved gallery, settings.

const CURRENT = 'craftprint.current';
const GALLERY = 'craftprint.gallery';
const SETTINGS = 'craftprint.settings';
const CLASSROOM = 'craftprint.classroom';
const ACCOUNT = 'craftprint.account';
const TOMBS = 'craftprint.tombs';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // storage full or unavailable -- fail quietly
  }
}

export function saveCurrent(data) { return write(CURRENT, data); }
export function loadCurrent() { return read(CURRENT, null); }

export function loadSettings() { return read(SETTINGS, { sound: true }); }
export function saveSettings(s) { return write(SETTINGS, s); }

// Gallery items: { id, name, date, thumb, blocks, updated, dirty }.
// `updated` (ms timestamp) and `dirty` (not yet in the cloud) drive sync
// (src/sync.js); items saved by older app versions are migrated on read.
export function getGallery() {
  const gallery = read(GALLERY, []);
  let migrated = false;
  for (const item of gallery) {
    if (!Number.isFinite(item.updated)) {
      item.updated = Date.parse(item.date) || Date.now();
      migrated = true;
    }
    if (item.dirty === undefined) { item.dirty = true; migrated = true; }
  }
  if (migrated) write(GALLERY, gallery);
  return gallery;
}

export function addToGallery(item) {
  const gallery = getGallery();
  gallery.unshift({ updated: Date.now(), dirty: true, ...item });
  // If storage is full, drop oldest saves until it fits.
  while (!write(GALLERY, gallery) && gallery.length > 1) gallery.pop();
  return gallery;
}

// Insert or replace a design by id (used by sync when the cloud has news).
export function upsertGallery(item) {
  const gallery = getGallery();
  const i = gallery.findIndex((g) => g.id === item.id);
  if (i >= 0) gallery[i] = item;
  else gallery.unshift(item);
  gallery.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  while (!write(GALLERY, gallery) && gallery.length > 1) gallery.pop();
  return gallery;
}

// Remove without leaving a tombstone (the cloud told US it was deleted).
export function dropFromGallery(id) {
  const gallery = getGallery().filter((g) => g.id !== id);
  write(GALLERY, gallery);
  return gallery;
}

// Clear dirty flags after a successful push — but only if the design wasn't
// touched again mid-flight (compare the timestamp that was pushed).
export function markSynced(pushed) {
  const gallery = getGallery();
  const byId = new Map(pushed.map((p) => [p.id, p.updated]));
  for (const item of gallery) {
    if (byId.get(item.id) === item.updated) item.dirty = false;
  }
  write(GALLERY, gallery);
}

// Local deletion tombstones (id -> deleted-at ms), waiting to reach the cloud.
export function getTombs() { return read(TOMBS, {}); }
export function saveTombs(t) { return write(TOMBS, t); }

// Classroom state: { server } plus either { code, student } (a student who
// joined) or { code, teacherKey, teacherName } (the teacher who made it).
export function loadClassroom() { return read(CLASSROOM, {}); }
export function saveClassroom(c) { return write(CLASSROOM, c); }

// Teacher account session: { token, email, name } or null when signed out.
export function loadAccount() { return read(ACCOUNT, null); }
export function saveAccount(a) { return write(ACCOUNT, a); }

// User-initiated delete: also leaves a tombstone so the deletion syncs to the
// cloud and from there to the user's other devices.
export function removeFromGallery(id) {
  const gallery = getGallery().filter((g) => g.id !== id);
  write(GALLERY, gallery);
  const tombs = getTombs();
  tombs[id] = Date.now();
  saveTombs(tombs);
  return gallery;
}
