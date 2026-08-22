// CraftPrint Classroom server — a single Cloudflare Worker.
//
// Teachers create a room and get a 5-letter room code (for the whiteboard)
// plus a private teacher key (kept in their browser). Students join with the
// room code and their first name — no passwords, no accounts, no email —
// and "hand in" their block designs. The teacher lists and downloads every
// design with the key. Rooms and designs expire automatically after 60 days.
//
// Storage is a Cloudflare KV namespace bound as ROOMS. See README.md in this
// folder for the 5-minute deploy guide. The handler itself is plain
// fetch-in/Response-out, so dev.mjs can run the identical code under Node
// for local testing.
//
// API (all JSON, permissive CORS so the GitHub Pages app can call it):
//   POST   /api/rooms                          {teacher}  -> {code, teacherKey}
//   GET    /api/rooms/:code                               -> {ok, teacher}
//   POST   /api/rooms/:code/handin   {student, name, blocks} -> {ok}
//   GET    /api/rooms/:code/designs  (X-Teacher-Key)      -> {designs: [...]}
//   DELETE /api/rooms/:code/designs/:student (X-Teacher-Key) -> {ok}
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
//   PUT    /api/designs/:id    (Bearer token) {name, blocks} -> {ok}
//   DELETE /api/designs/:id    (Bearer token) -> {ok}

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
  'Access-Control-Allow-Headers': 'Content-Type, X-Teacher-Key, Authorization',
};

// --- Teacher accounts (Google sign-in) --------------------------------------

const SESSION_TTL_S = 60 * 60 * 24 * 90; // signed-in for 90 days
const LOGIN_CODE_TTL_S = 300;            // one-time code: callback -> session
const MAX_CLOUD_DESIGNS = 60;            // per account (mirrors room limit)

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

  if (path.startsWith('/api/auth/') || path === '/api/me' || path.startsWith('/api/designs')) {
    if (!loginEnabled) return err(404, 'accounts not enabled on this server');
    return handleAccounts(request, env, url, path);
  }

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

  const teacherAuthed = (room) => {
    const key = request.headers.get('X-Teacher-Key') || url.searchParams.get('key') || '';
    return room && key && key === room.key;
  };

  // POST /api/rooms — create a room.
  if (!code && request.method === 'POST') {
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
      const room = { teacher, key: randomFrom('abcdef0123456789', 32), created: now, touched: now };
      await env.ROOMS.put(`room:${newCode}`, JSON.stringify(room), { expirationTtl: ROOM_TTL_S });
      return json({ code: newCode, teacherKey: room.key, teacher });
    }
    return err(500, 'could not allocate a room code');
  }

  const room = await getRoom();
  if (code && !room) return err(404, 'room not found');

  // GET /api/rooms/:code — student join check.
  if (code && !sub && request.method === 'GET') {
    return json({ ok: true, teacher: room.teacher });
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
    if (!teacherAuthed(room)) return err(403, 'teacher key required');

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

  if (path === '/api/me' && request.method === 'GET') {
    return json({ email: acct.email, name: acct.name, designs: Object.keys(designs).length });
  }

  if (path === '/api/designs' && request.method === 'GET') {
    const list = Object.entries(designs)
      .map(([id, d]) => ({ id, name: d.name, updated: d.updated, blocks: d.blocks }))
      .sort((a, b) => b.updated - a.updated);
    return json({ designs: list });
  }

  const dm = path.match(/^\/api\/designs\/([a-z0-9-]{1,40})$/);
  if (dm) {
    const id = dm[1];

    // PUT /api/designs/:id — save (same id overwrites: newest version wins).
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
      await env.ROOMS.put(acctKey, JSON.stringify({ ...acct, designs }));
      return json({ ok: true, id });
    }

    // DELETE /api/designs/:id
    if (request.method === 'DELETE') {
      if (id in designs) {
        delete designs[id];
        await env.ROOMS.put(acctKey, JSON.stringify({ ...acct, designs }));
      }
      return json({ ok: true });
    }
  }

  return err(404, 'not found');
}

export default {
  fetch: (request, env) => handleRequest(request, env),
};
