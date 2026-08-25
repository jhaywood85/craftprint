// Teacher account client: "Sign in with Google" against the classroom server
// (server/worker.js), plus cloud design storage.
//
// How sign-in works (no passwords anywhere):
//   1. We send the browser to <server>/api/auth/google/start?return=<app URL>.
//   2. The server bounces through Google's consent screen and back to the app
//      with a one-time ?login=CODE in the URL.
//   3. completeLogin(code) trades that code for a long-lived bearer token via
//      fetch, so the token itself never appears in a URL or browser history.
// The token + profile live in localStorage; every API call sends
// Authorization: Bearer <token>. A 401 (expired/revoked) signs us out locally.

import * as storage from './storage.js';
import { serverURL } from './classroom.js';

export const info = () => storage.loadAccount() || null;
export const signedIn = () => !!info()?.token;

// Where to send the browser to start the Google sign-in dance. `back` tags
// the return URL so the app can reopen the screen the user started from
// (e.g. 'class' brings a teacher back to the Class screen, not My Stuff).
export function signInURL(back) {
  const base = serverURL(); // '' = same origin
  const here = `${location.origin}${location.pathname}${back ? `?back=${back}` : ''}`;
  return `${base}/api/auth/google/start?return=${encodeURIComponent(here)}`;
}

export function signOut() {
  storage.saveAccount(null);
}

// Boot-time: the callback landed us back with ?login=CODE.
export async function completeLogin(code) {
  const data = await api('/auth/session', { method: 'POST', body: { code }, auth: false });
  storage.saveAccount({ token: data.token, email: data.email, name: data.name });
  return data;
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const base = serverURL(); // '' = same origin
  const token = info()?.token;
  if (auth && !token) throw new Error('signed-out');
  let res;
  try {
    res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('offline');
  }
  if (res.status === 401) {
    signOut(); // token expired or server reset — reflect reality locally
    throw new Error('signed-out');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `error ${res.status}`);
  return data;
}

// --- cloud designs -----------------------------------------------------------

// Batch sync (see src/sync.js): payload { known, changes } ->
// { designs, tombs, rejected }.
export const syncDesigns = (payload) =>
  api('/designs/sync', { method: 'POST', body: payload });
