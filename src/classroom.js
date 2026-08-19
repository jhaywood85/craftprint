// Classroom client: talks to the tiny room-code server (server/worker.js).
//
// A teacher creates a room and gets { code, teacherKey }; students join with
// the code and their first name and hand in designs. State (which room this
// device is in, and the server address) persists in localStorage. The server
// address is configurable at runtime so schools can point the stock GitHub
// Pages app at their own deployed Worker — see server/README.md.

import * as storage from './storage.js';

// Bake your deployed server address here (e.g. after `wrangler deploy`) and
// every device using this copy of the app gets Classroom with zero setup.
// Teachers can still point an individual device elsewhere in the Class
// screen, and join links/QR codes carry the address regardless.
export const DEFAULT_SERVER = '';

export function getState() {
  return storage.loadClassroom() || {};
}

export function setState(next) {
  storage.saveClassroom(next);
  return next;
}

export function serverURL() {
  return (getState().server || DEFAULT_SERVER || '').trim().replace(/\/+$/, '');
}

// The link students open (or scan from the board) to join in one tap: it
// carries the room code AND the server address, so student devices need no
// setup at all.
export function joinURL(code) {
  const app = `${location.origin}${location.pathname}`;
  const params = new URLSearchParams({ class: code });
  const server = serverURL();
  if (server && server !== DEFAULT_SERVER) params.set('server', server);
  return `${app}?${params}`;
}

// Quick "is this really a classroom server?" probe for the setup screen.
// Returns { ok, needsPasscode } — schools can require a staff passcode to
// open rooms on a shared server (see server/README.md).
export async function health() {
  const data = await api('/health');
  return { ok: data?.service === 'craftprint-class', needsPasscode: !!data?.needsPasscode };
}

async function api(path, { method = 'GET', body, teacherKey } = {}) {
  const base = serverURL();
  if (!base) throw new Error('no-server');
  let res;
  try {
    res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(teacherKey ? { 'X-Teacher-Key': teacherKey } : {}),
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

export const createRoom = (teacher, passcode) =>
  api('/rooms', { method: 'POST', body: { teacher, passcode } });

export const checkRoom = (code) =>
  api(`/rooms/${encodeURIComponent(code)}`);

export const handIn = (code, payload) =>
  api(`/rooms/${encodeURIComponent(code)}/handin`, { method: 'POST', body: payload });

export const listDesigns = (code, teacherKey) =>
  api(`/rooms/${encodeURIComponent(code)}/designs`, { teacherKey });
