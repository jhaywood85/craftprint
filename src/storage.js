// localStorage persistence: autosaved current creation, saved gallery, settings.

const CURRENT = 'craftprint.current';
const GALLERY = 'craftprint.gallery';
const SETTINGS = 'craftprint.settings';

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

export function removeFromGallery(id) {
  const gallery = getGallery().filter((g) => g.id !== id);
  write(GALLERY, gallery);
  return gallery;
}
