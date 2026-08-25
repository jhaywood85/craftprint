// Classroom client for the hosted CraftPrint service (server/worker.js).
//
// Teachers sign in with Google and create classes owned by their account;
// students join with the room code and their first name and hand in designs.
//
// Stored shape (localStorage):
//   {
//     server:  '',                               // dev/test override only
//     student: { code, name, teacher } | null,   // the class this kid joined
//     owned:   [{ code, teacher, created }],     // cached account class list
//     active:  'ABCDE' | null,                   // which one they're viewing
//   }

import * as storage from './storage.js';
// Circular with account.js (it imports serverURL from here) — safe because
// both modules only touch each other inside functions, never at load time.
import * as account from './account.js';

// CraftPrint is a hosted service: the app and its API are served by the SAME
// Cloudflare Worker, so API calls are same-origin ('' = relative /api/...).
// There is no user-facing server setting. state.server survives purely as a
// hidden override for development and automated tests (set via setState).
export const DEFAULT_SERVER = '';

export function getState() {
  const raw = storage.loadClassroom() || {};
  return { owned: [], active: null, student: null, ...raw };
}

export function setState(next) {
  storage.saveClassroom(next);
  return next;
}

const patch = (fields) => setState({ ...getState(), ...fields });

// --- student side ----------------------------------------------------------

export const studentInfo = () => getState().student || null;
export const joinAs = (code, name, teacher) => patch({ student: { code, name, teacher } });
export const leaveClass = () => patch({ student: null });

// --- teacher side ----------------------------------------------------------
//
// Classes belong to the teacher's Google account: created while signed in,
// listed from the account on any device, and every teacher action proves
// itself with the sign-in. The list is cached locally so the board (code +
// QR) still renders offline.

export const ownedRooms = () => getState().owned || [];

// Refresh the owned-class list from the account (call when signed in).
export async function refreshOwnedRooms() {
  if (!account.signedIn()) return ownedRooms();
  const { rooms } = await api('/my/rooms', { bearer: true });
  patch({ owned: rooms });
  return rooms;
}

export function activeClass() {
  const all = ownedRooms();
  const { active } = getState();
  return all.find((c) => c.code === active) || all[0] || null;
}


export const setActiveClass = (code) => patch({ active: code });



// '' = same origin (production). A dev/test override returns its absolute URL.
export function serverURL() {
  return (getState().server || DEFAULT_SERVER || '').trim().replace(/\/+$/, '');
}

// The link students open (or scan from the board) to join in one tap. The
// dev-only server override rides along so test devices configure themselves;
// production links are just ?class=CODE.
export function joinURL(code) {
  const app = `${location.origin}${location.pathname}`;
  const params = new URLSearchParams({ class: code });
  const server = serverURL();
  if (server) params.set('server', server);
  return `${app}?${params}`;
}

// Quick "is this really a classroom server?" probe for the setup screen.
// Returns { ok, needsPasscode } — schools can require a staff passcode to
// open rooms on a shared server (see server/README.md).
export async function health() {
  const data = await api('/health');
  return {
    ok: data?.service === 'craftprint-class',
    needsPasscode: !!data?.needsPasscode,
    login: !!data?.login, // server supports "Sign in with Google" accounts
  };
}

async function api(path, { method = 'GET', body, bearer } = {}) {
  const base = serverURL(); // '' = same origin
  const token = bearer && account.signedIn() ? account.info().token : null;
  let res;
  try {
    res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('offline'); // network unreachable / server down
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `error ${res.status}`);
  return data;
}

// Creating a class requires being signed in — the room is owned by the
// account and follows the teacher to every device.
export const createRoom = (teacher, passcode) =>
  api('/rooms', { method: 'POST', body: { teacher, passcode }, bearer: true });

// Close a class for good: deletes the room and every hand-in on the server.
export const closeRoom = (code) =>
  api(`/rooms/${encodeURIComponent(code)}`, { method: 'DELETE', bearer: true });

export const checkRoom = (code) =>
  api(`/rooms/${encodeURIComponent(code)}`);

export const handIn = (code, payload) =>
  api(`/rooms/${encodeURIComponent(code)}/handin`, { method: 'POST', body: payload });

export const listDesigns = (code) =>
  api(`/rooms/${encodeURIComponent(code)}/designs`, { bearer: true });

