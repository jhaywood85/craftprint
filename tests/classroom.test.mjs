// Validates the Classroom server handler (server/worker.js) against the same
// in-memory KV used by the local dev server: room creation (sign-in
// required), join checks, hand-ins (including upsert), owner-only teacher
// auth, deletion, and limits.
//
// Run: node tests/classroom.test.mjs

import { createHmac } from 'node:crypto';
import { handleRequest } from '../server/worker.js';
import { memoryKV } from '../server/dev.mjs';

// Mint a session token the same way the server does (HMAC over v1.sub.exp),
// so tests can act as signed-in teachers without the OAuth dance.
const SECRET = 'test-session-secret';
function tokenFor(sub) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const body = `v1.${sub}.${exp}`;
  const sig = createHmac('sha256', SECRET).update(body).digest('hex');
  return `${body}.${sig}`;
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else { failures++; console.error(`  FAIL - ${name} ${detail}`); }
}

const env = { ROOMS: memoryKV(), SESSION_SECRET: SECRET, GOOGLE_FAKE: 'test@school.example' };
const BASE = 'https://class.example';

async function call(method, path, { body, token } = {}) {
  const res = await handleRequest(new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

console.log('\nhealth check:');
const health = await call('GET', '/api/health');
check('health endpoint identifies the service',
  health.status === 200 && health.data.service === 'craftprint-class');

console.log('\nroom lifecycle:');
const teacherToken = tokenFor('g-ms-lee');
const anonCreate = await call('POST', '/api/rooms', { body: { teacher: 'Ms. Lee' } });
check('creating without signing in is refused', anonCreate.status === 401);
const created = await call('POST', '/api/rooms', { token: teacherToken, body: { teacher: 'Ms. Lee' } });
check('signed-in teacher creates a room', created.status === 200 &&
  /^[A-Z2-9]{5}$/.test(created.data.code), JSON.stringify(created.data));
check('no key material in the response', created.data.teacherKey === undefined);
const { code } = created.data;

const joined = await call('GET', `/api/rooms/${code}`);
check('students can check the room', joined.status === 200 && joined.data.teacher === 'Ms. Lee');
check('room codes avoid confusable letters', ![...code].some((c) => '01OIL'.includes(c)));

const missing = await call('GET', '/api/rooms/ZZZZZ');
check('unknown room is 404', missing.status === 404);

console.log('\nhand-ins:');
const design = { student: 'Sam', name: 'Rocket', blocks: [[0, 0, 0, 1], [0, 4, 0, 2, 1, 5, 2]] };
const handin = await call('POST', `/api/rooms/${code}/handin`, { body: design });
check('student hands in a design', handin.status === 200 && handin.data.ok);

const again = await call('POST', `/api/rooms/${code}/handin`, {
  body: { ...design, name: 'Rocket v2' },
});
check('handing in again upserts (same student)', again.status === 200);

await call('POST', `/api/rooms/${code}/handin`, {
  body: { student: 'Alex', name: 'Castle', blocks: [[1, 0, 1, 3]] },
});

const bad = await call('POST', `/api/rooms/${code}/handin`, {
  body: { student: 'Evil', name: 'x', blocks: 'not-blocks' },
});
check('invalid design rejected', bad.status === 400);
const anon = await call('POST', `/api/rooms/${code}/handin`, {
  body: { name: 'x', blocks: [[0, 0, 0, 1]] },
});
check('missing student name rejected', anon.status === 400);

console.log('\nteacher access:');
const listed = await call('GET', `/api/rooms/${code}/designs`, { token: teacherToken });
check('teacher lists designs', listed.status === 200 && listed.data.designs.length === 2);
check('upsert kept one design per student and the newest name',
  listed.data.designs.find((d) => d.student === 'Sam')?.name === 'Rocket v2');
check('blocks round-trip exactly',
  JSON.stringify(listed.data.designs.find((d) => d.student === 'Sam').blocks) === JSON.stringify(design.blocks));

const anonList = await call('GET', `/api/rooms/${code}/designs`);
check('listing without signing in is 403', anonList.status === 403);
const otherTeacher = await call('GET', `/api/rooms/${code}/designs`, { token: tokenFor('g-somebody-else') });
check("listing as a different teacher is 403", otherTeacher.status === 403);

const del = await call('DELETE', `/api/rooms/${code}/designs/alex`, { token: teacherToken });
const after = await call('GET', `/api/rooms/${code}/designs`, { token: teacherToken });
check('teacher can delete a hand-in', del.status === 200 && after.data.designs.length === 1);

console.log('\nfree-tier write efficiency:');
{
  // The KV free tier allows ~1,000 writes/day, so a hand-in must cost ONE
  // write, not two: the room's 60-day expiry is only refreshed periodically.
  let writes = 0;
  const counting = { ROOMS: { ...env.ROOMS, put: async (k, v) => { writes++; return env.ROOMS.put(k, v); } } };
  const handIn = (student) => handleRequest(new Request(`${BASE}/api/rooms/${code}/handin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ student, name: 'X', blocks: [[0, 0, 0, 1]] }),
  }), counting);
  await handIn('Kai');
  const first = writes;
  await handIn('Rae');
  await handIn('Ola');
  check('each hand-in costs a single KV write', writes - first === 2, `(${writes - first} writes for 2 hand-ins)`);
  check('first hand-in also single-write', first === 1, `(${first})`);
}

console.log('\nteacher passcode (shared school servers):');
{
  const guarded = { ...env, CREATE_PASSCODE: 'lego-time' };
  const callG = async (body) => {
    const res = await handleRequest(new Request(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${teacherToken}` },
      body: JSON.stringify(body),
    }), guarded);
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const blocked = await callG({ teacher: 'Sneaky' });
  check('creating without the passcode is refused', blocked.status === 403);
  const wrong = await callG({ teacher: 'Sneaky', passcode: 'nope' });
  check('wrong passcode is refused', wrong.status === 403);
  const good = await callG({ teacher: 'Ms. Lee', passcode: 'lego-time' });
  check('correct passcode creates the room', good.status === 200 && !!good.data.code);

  const hres = await handleRequest(new Request(`${BASE}/api/health`), guarded);
  const hdata = await hres.json();
  check('health advertises that a passcode is needed', hdata.needsPasscode === true);
  const openHealth = await call('GET', '/api/health');
  check('open servers report no passcode needed', openHealth.data.needsPasscode === false);

  // Students are unaffected by the passcode.
  const joinRes = await handleRequest(new Request(`${BASE}/api/rooms/${good.data.code}`), guarded);
  check('students still join a passcode-protected room freely', joinRes.status === 200);
}

console.log('\nCORS preflight:');
const opt = await handleRequest(new Request(`${BASE}/api/rooms`, { method: 'OPTIONS' }), env);
check('OPTIONS returns CORS headers', opt.status === 204 &&
  opt.headers.get('Access-Control-Allow-Origin') === '*');

console.log(failures === 0 ? '\nAll classroom tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
