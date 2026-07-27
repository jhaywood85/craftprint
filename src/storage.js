// localStorage persistence: autosaved current creation, saved gallery, settings.

const CURRENT = 'craftprint.current';
const GALLERY = 'craftprint.gallery';
const SETTINGS = 'craftprint.settings';
const CLASSROOM = 'craftprint.classroom';

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

export function getGallery() { return read(GALLERY, []); }

export function addToGallery(item) {
  const gallery = getGallery();
  gallery.unshift(item);
  // If storage is full, drop oldest saves until it fits.
  while (!write(GALLERY, gallery) && gallery.length > 1) gallery.pop();
  return gallery;
}

// Classroom state: { server } plus either { code, student } (a student who
// joined) or { code, teacherKey, teacherName } (the teacher who made it).
export function loadClassroom() { return read(CLASSROOM, {}); }
export function saveClassroom(c) { return write(CLASSROOM, c); }

export function removeFromGallery(id) {
  const gallery = getGallery().filter((g) => g.id !== id);
  write(GALLERY, gallery);
  return gallery;
}
