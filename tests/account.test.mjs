// Validates teacher accounts on the Classroom server (server/worker.js):
// the Google OAuth round trip (with Google's token endpoint stubbed), state
// signing, one-time login codes, bearer-token sessions, and per-account
// design storage. Run: node tests/account.test.mjs

import { handleRequest } from '../server/worker.js';
import { memoryKV } from '../server/dev.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else { failures++; console.error(`  FAIL - ${name} ${detail}`); }
}

const env = {
  ROOMS: memoryKV(),
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 'test-session-secret',
};
const BASE = 'https://class.example';
const APP = 'https://kid.example/app/';

async function call(method, path, { body, token, key } = {}) {
  const res = await handleRequest(new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'X-Teacher-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  }), env);
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => ({})) };
}

// Stub Google's token endpoint: hand back an id_token whose payload carries
// the identity we want (signature is not re-verified for the code flow —
// the response comes straight from Google over TLS).
const b64u = (s) => Buffer.from(s).toString('base64url');
function fakeIdToken(claims) {
  return `${b64u('{"alg":"RS256"}')}.${b64u(JSON.stringify(claims))}.${b64u('sig')}`;
}
let googleCalls = 0;
let googleClaims = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = String(input);
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    googleCalls++;
    const params = new URLSearchParams(String(init.body));
    check(`token exchange sends the auth code (#${googleCalls})`, params.get('code')?.length > 0);
    return new Response(JSON.stringify({ id_token: fakeIdToken(googleClaims) }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(input, init);
};

console.log('\nhealth:');
{
  const off = await handleRequest(new Request(`${BASE}/api/health`), { ROOMS: memoryKV() });
  check('login=false without secrets', (await off.json()).login === false);
  const on = await call('GET', '/api/health');
  check('login=true with secrets', on.data.login === true);
}

console.log('\nsign-in round trip:');
let token = null;
{
  const start = await call('GET', `/api/auth/google/start?return=${encodeURIComponent(APP)}`);
  const loc = start.headers.get('Location') || '';
  check('start redirects to Google', start.status === 302 && loc.startsWith('https://accounts.google.com/'));
  const authURL = new URL(loc);
  check('redirect_uri points at our callback',
    authURL.searchParams.get('redirect_uri') === `${BASE}/api/auth/google/callback`);
  check('asks only for openid email profile',
    authURL.searchParams.get('scope') === 'openid email profile');
  const state = authURL.searchParams.get('state');

  googleClaims = {
    aud: 'test-client-id', iss: 'https://accounts.google.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: 'g-12345', email: 'ms.lee@school.org', name: 'Ms. Lee',
  };
  const cb = await call('GET', `/api/auth/google/callback?code=authcode&state=${encodeURIComponent(state)}`);
  const back = new URL(cb.headers.get('Location') || 'https://x/');
  check('callback bounces back to the app', cb.status === 302 && back.origin + back.pathname === APP);
  const loginCode = back.searchParams.get('login');
  check('carries a one-time login code', /^[a-f0-9]{32}$/.test(loginCode || ''));

  const sess = await call('POST', '/api/auth/session', { body: { code: loginCode } });
  check('session issues a token + profile', sess.status === 200 &&
    sess.data.token?.startsWith('v1.') && sess.data.email === 'ms.lee@school.org');
  token = sess.data.token;

  const again = await call('POST', '/api/auth/session', { body: { code: loginCode } });
  check('login code is strictly one-time', again.status === 403);
}

console.log('\nstate and token hardening:');
{
  const badState = await call('GET', '/api/auth/google/callback?code=x&state=abc.def');
  check('tampered state rejected', badState.status === 400);
  const noRet = await call('GET', '/api/auth/google/start?return=javascript:alert(1)');
  check('non-http return URL rejected', noRet.status === 400);
  const me401 = await call('GET', '/api/me');
  check('no token -> 401', me401.status === 401);
  const forged = token.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  check('tampered token -> 401', (await call('GET', '/api/me', { token: forged })).status === 401);
}

console.log('\naccount + designs:');
{
  const me = await call('GET', '/api/me', { token });
  check('me returns profile', me.data.email === 'ms.lee@school.org' && me.data.designs === 0);

  const blocks = [[0, 0, 0, 1], [0, 1, 0, 2, 1, 5]];
  const put = await call('PUT', '/api/designs/my-rocket', { token, body: { name: 'My Rocket', blocks } });
  check('save a design', put.status === 200 && put.data.ok);

  const put2 = await call('PUT', '/api/designs/my-rocket', {
    token, body: { name: 'My Rocket', blocks: [...blocks, [1, 0, 0, 3]] },
  });
  check('same id overwrites (newest wins)', put2.status === 200);

  await call('PUT', '/api/designs/castle', { token, body: { name: 'Castle', blocks } });
  const list = await call('GET', '/api/designs', { token });
  check('list has both designs', list.data.designs?.length === 2, JSON.stringify(list.data));
  check('newest first', list.data.designs?.[0]?.id === 'castle');
  check('overwrite kept the newer blocks',
    list.data.designs?.find((d) => d.id === 'my-rocket')?.blocks.length === 3);

  const bad = await call('PUT', '/api/designs/junk', { token, body: { name: 'x', blocks: [['a']] } });
  check('invalid blocks rejected', bad.status === 400);

  const del = await call('DELETE', '/api/designs/castle', { token });
  const after = await call('GET', '/api/designs', { token });
  check('delete works', del.status === 200 && after.data.designs.length === 1);

  // Signing in again keeps the saved designs (upsert must not clobber them).
  const start = await call('GET', `/api/auth/google/start?return=${encodeURIComponent(APP)}`);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const cb = await call('GET', `/api/auth/google/callback?code=authcode2&state=${encodeURIComponent(state)}`);
  const loginCode = new URL(cb.headers.get('Location')).searchParams.get('login');
  const sess = await call('POST', '/api/auth/session', { body: { code: loginCode } });
  const relist = await call('GET', '/api/designs', { token: sess.data.token });
  check('designs survive a fresh sign-in', relist.data.designs?.length === 1);
}

console.log('\nwrong-audience id_token:');
{
  const start = await call('GET', `/api/auth/google/start?return=${encodeURIComponent(APP)}`);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  googleClaims = {
    aud: 'SOME-OTHER-APP', iss: 'https://accounts.google.com',
    exp: Math.floor(Date.now() / 1000) + 3600, sub: 'evil', email: 'evil@x',
  };
  const cb = await call('GET', `/api/auth/google/callback?code=c&state=${encodeURIComponent(state)}`);
  const back = new URL(cb.headers.get('Location'));
  check('rejected: bounced back with login_error', back.searchParams.get('login_error') === '1'
    && !back.searchParams.get('login'));
}

console.log('\noffline-first sync (/api/designs/sync):');
{
  // Fresh account for clean numbers: sign in as a second teacher.
  const start = await call('GET', `/api/auth/google/start?return=${encodeURIComponent(APP)}`);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  googleClaims = {
    aud: 'test-client-id', iss: 'https://accounts.google.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: 'g-sync-1', email: 'sync@school.org', name: 'Sync Teacher',
  };
  const cb = await call('GET', `/api/auth/google/callback?code=c&state=${encodeURIComponent(state)}`);
  const loginCode = new URL(cb.headers.get('Location')).searchParams.get('login');
  const tokenA = (await call('POST', '/api/auth/session', { body: { code: loginCode } })).data.token;

  // Count KV writes per request to prove sync batches into one.
  let writes = 0;
  const realPut = env.ROOMS.put.bind(env.ROOMS);
  env.ROOMS.put = (k, v, o) => { writes++; return realPut(k, v, o); };
  const blocks = [[0, 0, 0, 1]];
  const t0 = Date.now() - 5000;

  // Device A pushes three designs + gets nothing back.
  writes = 0;
  const push = await call('POST', '/api/designs/sync', {
    token: tokenA,
    body: {
      known: { a1: t0, a2: t0 + 1, a3: t0 + 2 },
      changes: [
        { id: 'a1', updated: t0, name: 'One', blocks, thumb: 'data:image/jpeg;base64,AAA' },
        { id: 'a2', updated: t0 + 1, name: 'Two', blocks },
        { id: 'a3', updated: t0 + 2, name: 'Three', blocks },
      ],
    },
  });
  check('push accepts a batch', push.status === 200 && push.data.rejected.length === 0,
    JSON.stringify(push.data));
  check('device with everything gets nothing back', push.data.designs.length === 0);
  check('a 3-design sync costs exactly 1 KV write', writes === 1, `writes=${writes}`);

  // A brand-new device (empty known) pulls all three, costing 0 writes.
  writes = 0;
  const fresh = await call('POST', '/api/designs/sync', {
    token: tokenA, body: { known: {}, changes: [] },
  });
  check('new device pulls everything', fresh.data.designs.length === 3);
  check('thumbs round-trip', fresh.data.designs.find((d) => d.id === 'a1')?.thumb === 'data:image/jpeg;base64,AAA');
  check('a pull-only sync costs 0 KV writes', writes === 0, `writes=${writes}`);

  // Last-writer-wins: an OLDER update for a1 must be ignored.
  await call('POST', '/api/designs/sync', {
    token: tokenA,
    body: { known: {}, changes: [{ id: 'a1', updated: t0 - 999, name: 'Stale', blocks }] },
  });
  const afterStale = await call('POST', '/api/designs/sync', {
    token: tokenA, body: { known: {}, changes: [] },
  });
  check('older update loses (LWW)', afterStale.data.designs.find((d) => d.id === 'a1')?.name === 'One');

  // Device A deletes a2 (tombstone); device B, which still has a2, hears it.
  await call('POST', '/api/designs/sync', {
    token: tokenA,
    body: { known: { a1: t0, a3: t0 + 2 }, changes: [{ id: 'a2', updated: Date.now(), deleted: true }] },
  });
  const deviceB = await call('POST', '/api/designs/sync', {
    token: tokenA, body: { known: { a1: t0, a2: t0 + 1, a3: t0 + 2 }, changes: [] },
  });
  check('tombstone reaches the other device', 'a2' in deviceB.data.tombs, JSON.stringify(deviceB.data.tombs));
  check('deleted design no longer listed', !deviceB.data.designs.some((d) => d.id === 'a2'));

  // A device that never had a2 is not bothered with its tombstone.
  const deviceC = await call('POST', '/api/designs/sync', {
    token: tokenA, body: { known: { a1: t0 }, changes: [] },
  });
  check('unknown ids get no tombstones', !('a2' in deviceC.data.tombs));

  // Recreating a deleted id with a NEWER save resurrects it.
  await call('POST', '/api/designs/sync', {
    token: tokenA,
    body: { known: {}, changes: [{ id: 'a2', updated: Date.now() + 1, name: 'Two again', blocks }] },
  });
  const revived = await call('POST', '/api/designs/sync', {
    token: tokenA, body: { known: {}, changes: [] },
  });
  check('newer save resurrects a deleted id', revived.data.designs.some((d) => d.id === 'a2'));

  // Junk in the batch is rejected without poisoning the rest.
  const junk = await call('POST', '/api/designs/sync', {
    token: tokenA,
    body: {
      known: {},
      changes: [
        { id: 'BAD ID!', updated: Date.now(), name: 'x', blocks },
        { id: 'badblocks', updated: Date.now(), name: 'x', blocks: [['a']] },
        { id: 'badthumb', updated: Date.now(), name: 'x', blocks, thumb: 'javascript:alert(1)' },
        { id: 'good', updated: Date.now(), name: 'Good', blocks },
      ],
    },
  });
  check('invalid changes rejected, valid applied',
    junk.data.rejected.length === 3, JSON.stringify(junk.data.rejected));
  const afterJunk = await call('POST', '/api/designs/sync', {
    token: tokenA, body: { known: {}, changes: [] },
  });
  check('good design landed', afterJunk.data.designs.some((d) => d.id === 'good'));
  check('bad ones did not', !afterJunk.data.designs.some((d) => ['badblocks', 'badthumb'].includes(d.id)));

  check('sync requires auth', (await call('POST', '/api/designs/sync', {
    body: { known: {}, changes: [] },
  })).status === 401);

  env.ROOMS.put = realPut;
}

console.log('\naccount-owned classrooms:');
{
  // Two teachers.
  async function signInAs(sub, email) {
    const start = await call('GET', `/api/auth/google/start?return=${encodeURIComponent(APP)}`);
    const state = new URL(start.headers.get('Location')).searchParams.get('state');
    googleClaims = {
      aud: 'test-client-id', iss: 'https://accounts.google.com',
      exp: Math.floor(Date.now() / 1000) + 3600, sub, email, name: email,
    };
    const cb = await call('GET', `/api/auth/google/callback?code=c&state=${encodeURIComponent(state)}`);
    const loginCode = new URL(cb.headers.get('Location')).searchParams.get('login');
    return (await call('POST', '/api/auth/session', { body: { code: loginCode } })).data.token;
  }
  const tokenA = await signInAs('g-teach-a', 'a@school.org');
  const tokenB = await signInAs('g-teach-b', 'b@school.org');

  // A creates two classes while signed in — no key needed ever again.
  const c1 = await call('POST', '/api/rooms', { token: tokenA, body: { teacher: 'Grade 3' } });
  const c2 = await call('POST', '/api/rooms', { token: tokenA, body: { teacher: 'Grade 5' } });
  check('signed-in create marks the room owned', c1.data.owned === true && c2.data.owned === true);

  const mine = await call('GET', '/api/my/rooms', { token: tokenA });
  check('my/rooms lists both classes, newest first',
    mine.data.rooms.length === 2 && mine.data.rooms[0].code === c2.data.code,
    JSON.stringify(mine.data));

  // Owner reads hand-ins with the sign-in alone.
  await call('POST', `/api/rooms/${c1.data.code}/handin`, {
    body: { student: 'Sam', name: 'Boat', blocks: [[0, 0, 0, 1]] },
  });
  const ownerList = await call('GET', `/api/rooms/${c1.data.code}/designs`, { token: tokenA });
  check('owner lists hand-ins without a key', ownerList.status === 200 &&
    ownerList.data.designs.length === 1);

  // Teacher B can neither read nor destroy A's class.
  check("another account can't read the hand-ins",
    (await call('GET', `/api/rooms/${c1.data.code}/designs`, { token: tokenB })).status === 403);
  check("another account can't close the class",
    (await call('DELETE', `/api/rooms/${c1.data.code}`, { token: tokenB })).status === 403);
  check('anonymous close is refused',
    (await call('DELETE', `/api/rooms/${c1.data.code}`)).status === 403);

  // The classic key still works alongside ownership.
  const byKey = await call('GET', `/api/rooms/${c1.data.code}/designs`, { key: c1.data.teacherKey });
  check('legacy key path still works on owned rooms', byKey.status === 200);

  // Claim: a key-only room can be attached to an account.
  const legacy = await call('POST', '/api/rooms', { body: { teacher: 'Old class' } });
  check('anonymous create is not owned', legacy.data.owned === false);
  check('claim needs the right key', (await call('POST', `/api/rooms/${legacy.data.code}/claim`, {
    token: tokenA, key: 'wrong'.padEnd(32, '0'),
  })).status === 403);
  const claimed = await call('POST', `/api/rooms/${legacy.data.code}/claim`, {
    token: tokenA, key: legacy.data.teacherKey,
  });
  check('claim with the key succeeds', claimed.status === 200);
  const mine2 = await call('GET', '/api/my/rooms', { token: tokenA });
  check('claimed class joins my/rooms', mine2.data.rooms.some((r) => r.code === legacy.data.code));
  check("claimed class can't be claimed by someone else",
    (await call('POST', `/api/rooms/${legacy.data.code}/claim`, {
      token: tokenB, key: legacy.data.teacherKey,
    })).status === 403);
  const ownedNow = await call('GET', `/api/rooms/${legacy.data.code}/designs`, { token: tokenA });
  check('claimed class works with sign-in alone', ownedNow.status === 200);

  // Close a class: room gone, hand-ins gone, class list updated.
  const del = await call('DELETE', `/api/rooms/${c1.data.code}`, { token: tokenA });
  check('owner closes the class', del.status === 200);
  check('closed room is gone', (await call('GET', `/api/rooms/${c1.data.code}`)).status === 404);
  const mine3 = await call('GET', '/api/my/rooms', { token: tokenA });
  check('closed class left my/rooms', !mine3.data.rooms.some((r) => r.code === c1.data.code));
  check('other classes untouched', mine3.data.rooms.some((r) => r.code === c2.data.code));
}

globalThis.fetch = realFetch;
console.log(failures === 0 ? '\nAll account tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
