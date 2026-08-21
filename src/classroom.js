// Classroom client: talks to the tiny room-code server (server/worker.js).
//
// A teacher creates a room and gets { code, teacherKey }; students join with
// the code and their first name and hand in designs. State (which room this
// device is in, and the server address) persists in localStorage. The server
// address is configurable at runtime so schools can point the stock GitHub
// Pages app at their own deployed Worker — see server/README.md.
//
// Stored shape:
//   {
//     server:  'https://…',                     // this device's server
//     student: { code, name, teacher } | null,  // the class this kid joined
//     classes: [{ code, key, teacher, created }],  // classes this teacher runs
//     active:  'ABCDE' | null,                  // which one they're viewing
//   }
// A teacher can run many classes (a term's worth), and each class's key is
// what proves ownership of its hand-ins — so keys are also exportable, since
// losing them would otherwise mean losing the class (see keyFileFor()).

import * as storage from './storage.js';

// Bake your deployed server address here (e.g. after `wrangler deploy`) and
// every device using this copy of the app gets Classroom with zero setup.
// Teachers can still point an individual device elsewhere in the Class
// screen, and join links/QR codes carry the address regardless.
export const DEFAULT_SERVER = '';

// Read state, migrating the original single-class shape
// ({ code, teacherKey } / { code, student }) so nobody loses a live class.
export function getState() {
  const raw = storage.loadClassroom() || {};
  if (Array.isArray(raw.classes) || raw.student !== undefined) {
    return { classes: [], active: null, student: null, ...raw };
  }
  const migrated = { server: raw.server, classes: [], active: null, student: null };
  if (raw.code && raw.teacherKey) {
    migrated.classes = [{
      code: raw.code, key: raw.teacherKey, teacher: raw.teacher || 'My class', created: null,
    }];
    migrated.active = raw.code;
  } else if (raw.code && raw.student) {
    migrated.student = { code: raw.code, name: raw.student, teacher: raw.teacher };
  }
  storage.saveClassroom(migrated);
  return migrated;
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

export const myClasses = () => getState().classes || [];

export function activeClass() {
  const { classes = [], active } = getState();
  return classes.find((c) => c.code === active) || classes[0] || null;
}

export function addClass(cls) {
  const classes = myClasses().filter((c) => c.code !== cls.code);
  patch({ classes: [{ ...cls }, ...classes], active: cls.code });
  return cls;
}

export const setActiveClass = (code) => patch({ active: code });

export function forgetClass(code) {
  const classes = myClasses().filter((c) => c.code !== code);
  patch({ classes, active: classes[0]?.code ?? null });
  return classes;
}

// A class's key is its only proof of ownership, so make it saveable: this is
// what "Save my teacher key" downloads and what recovery imports.
export const keyFileFor = (cls) => JSON.stringify({
  app: 'craftprint',
  kind: 'teacher-key',
  code: cls.code,
  key: cls.key,
  teacher: cls.teacher,
  server: serverURL(),
  saved: new Date().toISOString(),
}, null, 2);

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

// Recovery: prove a (code, key) pair still opens a room, and recover the
// class name from the room itself so a restored class looks right. Throws
// the usual api() errors — 'room not found', 'teacher key required', etc.
export async function recoverClass(code, key) {
  await listDesigns(code, key);          // 403s if the key is wrong
  const room = await checkRoom(code);    // room name for the restored entry
  return { code, key, teacher: room.teacher || 'My class', created: null };
}
