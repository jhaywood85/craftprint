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
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Teacher-Key',
};

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

  // Health check: lets the app verify a pasted server address instantly, and
  // tells it whether room creation needs a passcode so the UI can ask.
  if (path === '/api/health' && request.method === 'GET') {
    return json({ ok: true, service: 'craftprint-class', needsPasscode: !!requiredPasscode });
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

export default {
  fetch: (request, env) => handleRequest(request, env),
};
