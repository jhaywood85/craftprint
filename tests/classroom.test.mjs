// Validates the Classroom server handler (server/worker.js) against the same
// in-memory KV used by the local dev server: room creation, join checks,
// hand-ins (including upsert), teacher auth, deletion, and limits.
//
// Run: node tests/classroom.test.mjs

import { handleRequest } from '../server/worker.js';
import { memoryKV } from '../server/dev.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else { failures++; console.error(`  FAIL - ${name} ${detail}`); }
}

const env = { ROOMS: memoryKV() };
const BASE = 'https://class.example';

async function call(method, path, { body, key } = {}) {
  const res = await handleRequest(new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'X-Teacher-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

console.log('\nroom lifecycle:');
const created = await call('POST', '/api/rooms', { body: { teacher: 'Ms. Lee' } });
check('create room returns code + key', created.status === 200 &&
  /^[A-Z2-9]{5}$/.test(created.data.code) && created.data.teacherKey.length === 32,
  JSON.stringify(created.data));
const { code, teacherKey } = created.data;

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
const listed = await call('GET', `/api/rooms/${code}/designs`, { key: teacherKey });
check('teacher lists designs', listed.status === 200 && listed.data.designs.length === 2);
check('upsert kept one design per student and the newest name',
  listed.data.designs.find((d) => d.student === 'Sam')?.name === 'Rocket v2');
check('blocks round-trip exactly',
  JSON.stringify(listed.data.designs.find((d) => d.student === 'Sam').blocks) === JSON.stringify(design.blocks));

const noKey = await call('GET', `/api/rooms/${code}/designs`);
check('listing without key is 403', noKey.status === 403);
const wrongKey = await call('GET', `/api/rooms/${code}/designs`, { key: 'f'.repeat(32) });
check('listing with wrong key is 403', wrongKey.status === 403);

const del = await call('DELETE', `/api/rooms/${code}/designs/alex`, { key: teacherKey });
const after = await call('GET', `/api/rooms/${code}/designs`, { key: teacherKey });
check('teacher can delete a hand-in', del.status === 200 && after.data.designs.length === 1);

console.log('\nCORS preflight:');
const opt = await handleRequest(new Request(`${BASE}/api/rooms`, { method: 'OPTIONS' }), env);
check('OPTIONS returns CORS headers', opt.status === 204 &&
  opt.headers.get('Access-Control-Allow-Origin') === '*');

console.log(failures === 0 ? '\nAll classroom tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
