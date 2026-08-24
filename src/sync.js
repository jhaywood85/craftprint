// Offline-first cloud sync for My Stuff (needs a signed-in teacher account —
// see account.js). The DEVICE is the source of truth: saves and deletes land
// in localStorage instantly and always work offline; this module mirrors them
// to the cloud whenever it can, and pulls down whatever other devices pushed.
//
// One round trip does everything (POST /api/designs/sync): send local dirty
// designs and pending deletions plus a map of what we have, receive whatever
// we're missing plus tombstones for things deleted elsewhere. Conflicts are
// last-writer-wins by timestamp — the honest choice for one family/teacher
// per account. Runs at boot, after every save/delete (debounced), and the
// moment the browser comes back online.

import * as storage from './storage.js';
import * as account from './account.js';

let timer = null;
let syncing = false;
let lastError = null;
const listeners = [];

// UI hook: called whenever sync starts, finishes, or fails.
export function onSync(fn) { listeners.push(fn); }
const emit = () => { for (const fn of listeners) { try { fn(); } catch { /* UI */ } } };

export const isSyncing = () => syncing;
export const lastSyncError = () => lastError;

// How many local changes are still waiting to reach the cloud?
export function pendingCount() {
  return storage.getGallery().filter((g) => g.dirty).length +
    Object.keys(storage.getTombs()).length;
}

export function scheduleSync(delayMs = 1500) {
  if (!account.signedIn()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow().catch(() => { /* reported via state */ }); }, delayMs);
}

export async function syncNow() {
  if (!account.signedIn() || syncing) return null;
  syncing = true;
  lastError = null;
  emit();
  try {
    const gallery = storage.getGallery();
    const tombs = storage.getTombs();

    const known = {};
    for (const item of gallery) known[item.id] = item.updated;

    const changes = [];
    const pushed = []; // {id, updated} snapshots, to clear dirty flags safely
    for (const item of gallery) {
      if (!item.dirty) continue;
      changes.push({
        id: item.id, updated: item.updated, name: item.name,
        blocks: item.blocks, ...(item.thumb ? { thumb: item.thumb } : {}),
      });
      pushed.push({ id: item.id, updated: item.updated });
    }
    const sentTombs = Object.entries(tombs);
    for (const [id, t] of sentTombs) changes.push({ id, updated: t, deleted: true });

    const res = await account.syncDesigns({ known, changes });

    // Pull: designs other devices saved (or newer versions of ours).
    for (const d of res.designs || []) {
      storage.upsertGallery({
        id: d.id, name: d.name, blocks: d.blocks,
        ...(d.thumb ? { thumb: d.thumb } : {}),
        date: new Date(d.updated).toISOString(),
        updated: d.updated,
        dirty: false,
      });
    }
    // Deletions made elsewhere: drop our copy (LWW — only if ours is older).
    for (const [id, t] of Object.entries(res.tombs || {})) {
      const mine = storage.getGallery().find((g) => g.id === id);
      if (mine && mine.updated <= t) storage.dropFromGallery(id);
    }
    // Everything we pushed (and wasn't rejected) is safely in the cloud now.
    const rejected = new Set(res.rejected || []);
    storage.markSynced(pushed.filter((p) => !rejected.has(p.id)));
    const remaining = storage.getTombs();
    for (const [id] of sentTombs) delete remaining[id];
    storage.saveTombs(remaining);

    return res;
  } catch (e) {
    lastError = String(e?.message || e);
    throw e;
  } finally {
    syncing = false;
    emit();
  }
}

// The moment connectivity returns, drain anything that queued up offline.
window.addEventListener('online', () => scheduleSync(800));
