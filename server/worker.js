// CraftPrint Classroom server — a single Cloudflare Worker.
//
// Teachers sign in with Google and create a room, getting a 5-letter room
// code (for the whiteboard). Students join with the room code and their
// first name — no passwords, no accounts, no email — and "hand in" their
// block designs. The room belongs to the teacher's account: every teacher
// action authenticates with the sign-in, on any device. Rooms and designs
// expire automatically after 60 days.
//
// Storage is a Cloudflare KV namespace bound as ROOMS. See README.md in this
// folder for the 5-minute deploy guide. The handler itself is plain
// fetch-in/Response-out, so dev.mjs can run the identical code under Node
// for local testing.
//
// API (all JSON, permissive CORS so the GitHub Pages app can call it):
//   POST   /api/rooms          (Bearer)   {teacher}      -> {code, teacher}
//   GET    /api/rooms/:code                               -> {ok, teacher}
//   POST   /api/rooms/:code/handin   {student, name, blocks} -> {ok}
//   GET    /api/rooms/:code/designs  (Bearer owner)       -> {designs: [...]}
//   DELETE /api/rooms/:code/designs/:student (Bearer owner) -> {ok}
//   GET    /api/my/rooms       (Bearer)                   -> {rooms: [...]}
//   DELETE /api/rooms/:code    (Bearer owner)
//     closes a class for good: deletes the room and every hand-in.
//
// OPTIONAL teacher accounts ("Sign in with Google" — see README's Accounts
// section). Enabled by setting three secrets: GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET, SESSION_SECRET. No passwords are ever stored — Google
// proves who the teacher is, and this server only keeps their email/name and
// their saved designs. Sessions are stateless HMAC-signed bearer tokens.
//   GET    /api/auth/google/start?return=URL  -> 302 to Google's consent page
//   GET    /api/auth/google/callback          -> 302 back to the app ?login=CODE
//   POST   /api/auth/session   {code}         -> {token, email, name}
//   GET    /api/me             (Bearer token) -> {email, name, designs}
//   GET    /api/designs        (Bearer token) -> {designs: [...]}
//   POST   /api/designs/sync   (Bearer token) {known, changes} -> see below
//   PUT    /api/designs/:id    (Bearer token) {name, blocks} -> {ok}
//   DELETE /api/designs/:id    (Bearer token) -> {ok}
//
// /api/designs/sync is the offline-first sync used by the app: the device
// sends everything that changed locally (upserts and deletions) plus a map of
// what it already has, and gets back everything it's missing — all merged
// last-writer-wins by timestamp, with deletions carried as tombstones so a
// design deleted on one device disappears from the others. Whatever the batch
// size, a sync costs at most ONE KV write.

const ROOM_TTL_S = 60 * 60 * 24 * 60; // 60 days
const MAX_BODY = 300 * 1024;          // a design is a few KB; 300 KB is generous
const MAX_DESIGNS = 60;               // per room
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

// The KV free tier allows ~1,000 writes/day, so don't spend one refreshing a
// room's expiry on every single hand-in: a room's TTL is 60 days, so touching
// it at most once every 12 hours keeps it alive with room to spare and halves
// the writes a class consumes.
const ROOM_TOUCH_MS = 12 * 60 * 60 * 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// --- Teacher accounts (Google sign-in) --------------------------------------

const SESSION_TTL_S = 60 * 60 * 24 * 90; // signed-in for 90 days
const LOGIN_CODE_TTL_S = 300;            // one-time code: callback -> session
const MAX_CLOUD_DESIGNS = 200;           // per account (a family's worth)
const MAX_THUMB = 64 * 1024;             // data-URL thumbnail per design
const SYNC_MAX_BODY = 5 * 1024 * 1024;   // a whole device's first sync
const TOMB_TTL_MS = 90 * 24 * 60 * 60 * 1000; // deletion markers linger 90 days

const te = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64uEncode = (s) => btoa(unescape(encodeURIComponent(s)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function b64uDecode(s) {
  try {
    return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  } catch { return null; }
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, te.encode(message)));
}

// Constant-time-ish comparison (both sides are fixed-length hex here).
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Session token: v1.<sub>.<exp>.<sig>. Stateless, so checking one costs no
// KV reads and signing out is just the browser forgetting it.
async function mintToken(secret, sub) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const body = `v1.${sub}.${exp}`;
  return `${body}.${await hmacHex(secret, body)}`;
}
async function verifyToken(secret, token) {
  const m = /^v1\.([\w-]{1,64})\.(\d{1,12})\.([0-9a-f]{64})$/.exec(String(token || ''));
  if (!m) return null;
  const [, sub, exp, sig] = m;
  if (Number(exp) * 1000 < Date.now()) return null;
  if (!sameHex(await hmacHex(secret, `v1.${sub}.${exp}`), sig)) return null;
  return sub;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', ...CORS },
});
const err = (status, message) => json({ error: message }, status);

function randomFrom(alphabet, n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// First names become design keys; keep them simple and collision-friendly
// (two "Sam"s overwrite each other — the second Sam should add an initial).
const slugStudent = (s) => String(s).trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

const cleanName = (s, max) => String(s ?? '').trim().slice(0, max);

function validBlocks(blocks) {
  return Array.isArray(blocks) && blocks.length > 0 && blocks.length <= 40000 &&
    blocks.every((row) => Array.isArray(row) && row.length >= 3 && row.length <= 8 &&
      row.every(Number.isFinite));
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // A school that exposes one shared server can set the CREATE_PASSCODE secret
  // (`wrangler secret put CREATE_PASSCODE`) so only staff can open rooms —
  // otherwise anyone who learns the address could burn the free-tier quota.
  // Unset = open, which is the right default for a single family/classroom.
  const requiredPasscode = env.CREATE_PASSCODE || '';

  // Accounts are optional: they switch on when the three secrets are set
  // (see README "Teacher accounts"). GOOGLE_FAKE is a TEST-ONLY shortcut for
  // local dev servers — never set it on a real deployment.
  const loginEnabled = !!((env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET)
    || (env.GOOGLE_FAKE && env.SESSION_SECRET));

  // Health check: lets the app verify a pasted server address instantly, and
  // tells it whether room creation needs a passcode so the UI can ask.
  if (path === '/api/health' && request.method === 'GET') {
    return json({
      ok: true,
      service: 'craftprint-class',
      needsPasscode: !!requiredPasscode,
      login: loginEnabled,
    });
  }

  if (path.startsWith('/api/auth/') || path === '/api/me' || path.startsWith('/api/designs')
      || path === '/api/my/rooms') {
    if (!loginEnabled) return err(404, 'accounts not enabled on this server');
    return handleAccounts(request, env, url, path);
  }

  // Who is calling, if anyone? Room routes accept a sign-in as teacher proof.
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const authedSub = (loginEnabled && bearer) ? await verifyToken(env.SESSION_SECRET, bearer) : null;

  const m = path.match(/^\/api\/rooms(?:\/([A-Za-z0-9]{4,8}))?(?:\/(handin|designs))?(?:\/([a-z0-9-]{1,24}))?$/);
  if (!m) return err(404, 'not found');
  const code = m[1]?.toUpperCase();
  const sub = m[2];
  const studentSlug = m[3];

  async function readBody() {
    const text = await request.text();
    if (text.length > MAX_BODY) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  async function getRoom() {
    if (!code) return null;
    const raw = await env.ROOMS.get(`room:${code}`);
    return raw ? JSON.parse(raw) : null;
  }

  // Teacher proof: signed in as the account that owns the room. That's it —
  // no keys, nothing to save or lose.
  const teacherAuthed = (room) => !!(room?.owner && authedSub && room.owner === authedSub);

  // POST /api/rooms — create a room, owned by the signed-in teacher: it
  // lands in their account's class list and follows them to any device.
  if (!code && request.method === 'POST') {
    if (!authedSub) return err(401, 'sign in first');
    const body = (await readBody()) || {};
    if (requiredPasscode && String(body.passcode ?? '') !== requiredPasscode) {
      return err(403, 'teacher passcode required');
    }
    const teacher = cleanName(body.teacher, 40) || 'My teacher';
    // Retry on the (unlikely) chance of a code collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const newCode = randomFrom(CODE_ALPHABET, 5);
      if (await env.ROOMS.get(`room:${newCode}`)) continue;
      const now = Date.now();
      const room = { teacher, owner: authedSub, created: now, touched: now };
      await env.ROOMS.put(`room:${newCode}`, JSON.stringify(room), { expirationTtl: ROOM_TTL_S });
      await addRoomToAccount(env, authedSub, { code: newCode, teacher, created: now });
      return json({ code: newCode, teacher });
    }
    return err(500, 'could not allocate a room code');
  }

  const room = await getRoom();
  if (code && !room) return err(404, 'room not found');

  // GET /api/rooms/:code — student join check.
  if (code && !sub && request.method === 'GET') {
    return json({ ok: true, teacher: room.teacher });
  }


  // DELETE /api/rooms/:code — close a class for good: the room, every
  // hand-in, and (for owned rooms) its entry in the teacher's class list.
  if (code && !sub && request.method === 'DELETE') {
    if (!teacherAuthed(room)) return err(403, "sign in as this class's teacher");
    const list = await env.ROOMS.list({ prefix: `d:${code}:` });
    for (const k of list.keys) await env.ROOMS.delete(k.name);
    await env.ROOMS.delete(`room:${code}`);
    if (room.owner) await removeRoomFromAccount(env, room.owner, code);
    return json({ ok: true });
  }

  // POST /api/rooms/:code/handin — student submits a design (upsert by name).
  if (sub === 'handin' && request.method === 'POST') {
    const body = await readBody();
    const student = cleanName(body?.student, 24);
    const slug = slugStudent(student);
    if (!slug) return err(400, 'missing student name');
    if (!validBlocks(body?.blocks)) return err(400, 'invalid design');
    const existing = await env.ROOMS.list({ prefix: `d:${code}:` });
    const already = existing.keys.some((k) => k.name === `d:${code}:${slug}`);
    if (!already && existing.keys.length >= MAX_DESIGNS) return err(409, 'room is full');
    const design = {
      student,
      name: cleanName(body?.name, 24) || 'My Creation',
      blocks: body.blocks,
      updated: Date.now(),
    };
    await env.ROOMS.put(`d:${code}:${slug}`, JSON.stringify(design), { expirationTtl: ROOM_TTL_S });
    // Keep the room alive while it's in use, but at most once every
    // ROOM_TOUCH_MS so a busy class doesn't spend two write quota units per
    // hand-in (see ROOM_TOUCH_MS).
    const now = Date.now();
    if (now - (room.touched ?? room.created ?? 0) > ROOM_TOUCH_MS) {
      await env.ROOMS.put(`room:${code}`, JSON.stringify({ ...room, touched: now }),
        { expirationTtl: ROOM_TTL_S });
    }
    return json({ ok: true });
  }

  // Teacher-only endpoints below.
  if (sub === 'designs') {
    if (!teacherAuthed(room)) return err(403, 'sign in as this class\'s teacher');

    // DELETE /api/rooms/:code/designs/:student
    if (studentSlug && request.method === 'DELETE') {
      await env.ROOMS.delete(`d:${code}:${studentSlug}`);
      return json({ ok: true });
    }

    // GET /api/rooms/:code/designs — everything handed in.
    if (request.method === 'GET') {
      const list = await env.ROOMS.list({ prefix: `d:${code}:` });
      const designs = [];
      for (const k of list.keys) {
        const raw = await env.ROOMS.get(k.name);
        if (raw) designs.push(JSON.parse(raw));
      }
      designs.sort((a, b) => a.student.localeCompare(b.student));
      return json({ teacher: room.teacher, designs });
    }
  }

  return err(404, 'not found');
}

// --- Account class lists ------------------------------------------------------

// Rooms an account owns, kept on the account record so a teacher's classes
// follow them to any signed-in device. Entries: { code, teacher, created }.
async function addRoomToAccount(env, sub, entry) {
  const key = `acct:${sub}`;
  const acct = JSON.parse((await env.ROOMS.get(key)) || 'null') || { designs: {}, created: Date.now() };
  const rooms = (acct.rooms || []).filter((r) => r.code !== entry.code);
  rooms.unshift(entry);
  await env.ROOMS.put(key, JSON.stringify({ ...acct, rooms }));
}

async function removeRoomFromAccount(env, sub, code) {
  const key = `acct:${sub}`;
  const acct = JSON.parse((await env.ROOMS.get(key)) || 'null');
  if (!acct?.rooms?.some((r) => r.code === code)) return;
  await env.ROOMS.put(key, JSON.stringify({
    ...acct, rooms: acct.rooms.filter((r) => r.code !== code),
  }));
}

// --- Teacher accounts: Google OAuth code flow + per-account designs ---------

async function handleAccounts(request, env, url, path) {
  const secret = env.SESSION_SECRET;
  const self = `${url.origin}/api/auth/google/callback`;

  // GET /api/auth/google/start?return=<app URL> — kick off the sign-in.
  // The state parameter carries the return URL, a timestamp, and a nonce,
  // HMAC-signed so the callback can trust it round-tripped unmodified.
  if (path === '/api/auth/google/start' && request.method === 'GET') {
    const ret = String(url.searchParams.get('return') || '');
    if (!/^https?:\/\//.test(ret)) return err(400, 'bad return url');
    const payload = b64uEncode(JSON.stringify({ r: ret, t: Date.now(), n: randomFrom('abcdef0123456789', 16) }));
    const state = `${payload}.${await hmacHex(secret, payload)}`;
    if (env.GOOGLE_FAKE) {
      // Test-only: skip Google entirely and bounce straight to the callback.
      return Response.redirect(`${self}?code=fake&state=${encodeURIComponent(state)}`, 302);
    }
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    auth.searchParams.set('redirect_uri', self);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', 'openid email profile');
    auth.searchParams.set('state', state);
    auth.searchParams.set('prompt', 'select_account');
    return Response.redirect(auth.toString(), 302);
  }

  // GET /api/auth/google/callback?code&state — Google sent the teacher back.
  if (path === '/api/auth/google/callback' && request.method === 'GET') {
    const state = String(url.searchParams.get('state') || '');
    const [payload, sig] = state.split('.');
    if (!payload || !sig || !sameHex(await hmacHex(secret, payload), sig)) {
      return err(400, 'bad state');
    }
    let ret;
    try {
      const parsed = JSON.parse(b64uDecode(payload));
      if (Date.now() - parsed.t > 10 * 60 * 1000) return err(400, 'sign-in took too long — try again');
      ret = parsed.r;
    } catch { return err(400, 'bad state'); }
    const backTo = (params) => {
      const u = new URL(ret);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      return Response.redirect(u.toString(), 302);
    };

    const code = String(url.searchParams.get('code') || '');
    if (!code) return backTo({ login_error: '1' });

    let profile = null;
    if (env.GOOGLE_FAKE) {
      // Test-only fake identity (see dev.mjs).
      profile = { sub: `fake-${await hmacHex(secret, env.GOOGLE_FAKE)}`.slice(0, 24), email: env.GOOGLE_FAKE, name: 'Test Teacher' };
    } else {
      // Exchange the code for tokens, straight from Google over TLS. The
      // id_token arrives directly from Google's token endpoint, so its
      // payload can be trusted after checking audience/issuer/expiry
      // (per OIDC §3.1.3.7 — no JWKS round-trip needed for the code flow).
      try {
        const res = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: self,
            grant_type: 'authorization_code',
          }),
        });
        const tokens = await res.json();
        const claims = JSON.parse(b64uDecode(String(tokens.id_token || '').split('.')[1] || '') || 'null');
        if (claims &&
            claims.aud === env.GOOGLE_CLIENT_ID &&
            /(^|\/\/)accounts\.google\.com$/.test(claims.iss || '') &&
            claims.exp * 1000 > Date.now() &&
            claims.sub) {
          profile = { sub: String(claims.sub), email: String(claims.email || ''), name: String(claims.name || claims.email || 'Teacher') };
        }
      } catch { /* fall through to login_error */ }
    }
    if (!profile) return backTo({ login_error: '1' });

    // Upsert the account (keep existing designs), then hand the browser a
    // one-time short-lived code — the app trades it for a bearer token with
    // a fetch, so the token itself never appears in a URL or history.
    const acctKey = `acct:${profile.sub}`;
    const existing = JSON.parse((await env.ROOMS.get(acctKey)) || 'null') || { designs: {}, created: Date.now() };
    await env.ROOMS.put(acctKey, JSON.stringify({
      ...existing, email: profile.email, name: profile.name,
    }));
    const login = randomFrom('abcdef0123456789', 32);
    await env.ROOMS.put(`login:${login}`, JSON.stringify(profile), { expirationTtl: LOGIN_CODE_TTL_S });
    return backTo({ login });
  }

  // POST /api/auth/session {code} — trade the one-time code for a token.
  if (path === '/api/auth/session' && request.method === 'POST') {
    let body = null;
    try { body = JSON.parse(await request.text()); } catch { /* 400 below */ }
    const code = String(body?.code || '');
    if (!/^[a-f0-9]{32}$/.test(code)) return err(400, 'bad code');
    const raw = await env.ROOMS.get(`login:${code}`);
    if (!raw) return err(403, 'sign-in expired — try again');
    await env.ROOMS.delete(`login:${code}`); // strictly one-time
    const profile = JSON.parse(raw);
    return json({
      token: await mintToken(secret, profile.sub),
      email: profile.email,
      name: profile.name,
    });
  }

  // Everything below requires a valid bearer token.
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const sub = await verifyToken(secret, bearer);
  if (!sub) return err(401, 'sign in first');
  const acctKey = `acct:${sub}`;
  const acct = JSON.parse((await env.ROOMS.get(acctKey)) || 'null');
  if (!acct) return err(401, 'sign in first');
  const designs = acct.designs || {};
  const tombs = acct.tombs || {}; // id -> deletion timestamp

  if (path === '/api/me' && request.method === 'GET') {
    return json({ email: acct.email, name: acct.name, designs: Object.keys(designs).length });
  }

  // GET /api/my/rooms — the classes this account owns, on any device.
  if (path === '/api/my/rooms' && request.method === 'GET') {
    return json({ rooms: acct.rooms || [] });
  }

  if (path === '/api/designs' && request.method === 'GET') {
    const list = Object.entries(designs)
      .map(([id, d]) => ({ id, name: d.name, updated: d.updated, thumb: d.thumb, blocks: d.blocks }))
      .sort((a, b) => b.updated - a.updated);
    return json({ designs: list });
  }

  const validId = (id) => /^[a-z0-9-]{1,40}$/.test(id);
  const validStamp = (t) => Number.isFinite(t) && t > 0 && t < Date.now() + 24 * 60 * 60 * 1000;
  const validThumb = (t) => t === undefined ||
    (typeof t === 'string' && t.length <= MAX_THUMB && t.startsWith('data:image/'));

  // POST /api/designs/sync — the offline-first batch sync (see header).
  //   body:  { known: {id: updatedTs}, changes: [{id, updated, name, blocks,
  //            thumb?} | {id, updated, deleted: true}] }
  //   reply: { designs: [server records the device is missing or has stale],
  //            tombs: {id: ts} for ids the device still has but were deleted,
  //            rejected: [id] upserts refused (account full / invalid) }
  if (path === '/api/designs/sync' && request.method === 'POST') {
    const text = await request.text();
    if (text.length > SYNC_MAX_BODY) return err(400, 'sync too big');
    let body = null;
    try { body = JSON.parse(text); } catch { /* 400 below */ }
    const known = (body?.known && typeof body.known === 'object') ? body.known : null;
    const changes = Array.isArray(body?.changes) ? body.changes : null;
    if (!known || !changes || changes.length > 500) return err(400, 'bad sync request');

    // Merge the device's changes, last-writer-wins per design id.
    let dirty = false;
    const rejected = [];
    for (const ch of changes) {
      const id = String(ch?.id || '');
      if (!validId(id) || !validStamp(ch?.updated)) { if (id) rejected.push(id); continue; }
      const current = designs[id]?.updated ?? tombs[id] ?? 0;
      if (ch.updated <= current) continue; // we already have newer news
      if (ch.deleted) {
        delete designs[id];
        tombs[id] = ch.updated;
        dirty = true;
      } else {
        if (!validBlocks(ch.blocks) || !validThumb(ch.thumb) ||
            JSON.stringify(ch.blocks).length > MAX_BODY) { rejected.push(id); continue; }
        if (!(id in designs) && Object.keys(designs).length >= MAX_CLOUD_DESIGNS) {
          rejected.push(id);
          continue;
        }
        designs[id] = {
          name: cleanName(ch.name, 24) || 'My Creation',
          blocks: ch.blocks,
          ...(ch.thumb ? { thumb: ch.thumb } : {}),
          updated: ch.updated,
        };
        delete tombs[id];
        dirty = true;
      }
    }
    // Old tombstones have long since propagated — stop paying to store them.
    for (const [id, t] of Object.entries(tombs)) {
      if (Date.now() - t > TOMB_TTL_MS) { delete tombs[id]; dirty = true; }
    }
    if (dirty) {
      await env.ROOMS.put(acctKey, JSON.stringify({ ...acct, designs, tombs }));
    }

    // What is the device missing? Records newer than what it says it has,
    // and tombstones for ids it still holds.
    const out = [];
    for (const [id, d] of Object.entries(designs)) {
      if (d.updated > (Number(known[id]) || 0)) {
        out.push({ id, name: d.name, updated: d.updated, thumb: d.thumb, blocks: d.blocks });
      }
    }
    const outTombs = {};
    for (const [id, t] of Object.entries(tombs)) {
      if (id in known) outTombs[id] = t;
    }
    return json({ designs: out, tombs: outTombs, rejected });
  }

  const dm = path.match(/^\/api\/designs\/([a-z0-9-]{1,40})$/);
  if (dm) {
    const id = dm[1];

    // PUT /api/designs/:id — single-design save (kept for older app builds;
    // new clients use /sync). Same id overwrites: newest version wins.
    if (request.method === 'PUT') {
      const text = await request.text();
      if (text.length > MAX_BODY) return err(400, 'design too big');
      let body = null;
      try { body = JSON.parse(text); } catch { /* 400 below */ }
      if (!validBlocks(body?.blocks)) return err(400, 'invalid design');
      if (!(id in designs) && Object.keys(designs).length >= MAX_CLOUD_DESIGNS) {
        return err(409, 'cloud is full — delete an old design first');
      }
      designs[id] = { name: cleanName(body?.name, 24) || 'My Creation', blocks: body.blocks, updated: Date.now() };
      delete tombs[id];
      await env.ROOMS.put(acctKey, JSON.stringify({ ...acct, designs, tombs }));
      return json({ ok: true, id });
    }

    // DELETE /api/designs/:id — leaves a tombstone so other devices delete too.
    if (request.method === 'DELETE') {
      if (id in designs) {
        delete designs[id];
        tombs[id] = Date.now();
        await env.ROOMS.put(acctKey, JSON.stringify({ ...acct, designs, tombs }));
      }
      return json({ ok: true });
    }
  }

  return err(404, 'not found');
}

export default {
  fetch: (request, env) => handleRequest(request, env),
};
