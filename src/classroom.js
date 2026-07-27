// Classroom client: talks to the tiny room-code server (server/worker.js).
//
// A teacher creates a room and gets { code, teacherKey }; students join with
// the code and their first name and hand in designs. State (which room this
// device is in, and the server address) persists in localStorage. The server
// address is configurable at runtime so schools can point the stock GitHub
// Pages app at their own deployed Worker — see server/README.md.

import * as storage from './storage.js';

export function getState() {
  return storage.loadClassroom() || {};
}

export function setState(next) {
  storage.saveClassroom(next);
  return next;
}

export function serverURL() {
  return (getState().server || '').trim().replace(/\/+$/, '');
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

export const createRoom = (teacher) =>
  api('/rooms', { method: 'POST', body: { teacher } });

export const checkRoom = (code) =>
  api(`/rooms/${encodeURIComponent(code)}`);

export const handIn = (code, payload) =>
  api(`/rooms/${encodeURIComponent(code)}/handin`, { method: 'POST', body: payload });

export const listDesigns = (code, teacherKey) =>
  api(`/rooms/${encodeURIComponent(code)}/designs`, { teacherKey });
