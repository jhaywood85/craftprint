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

async function call(method, path, { body, token } = {}) {
  const res = await handleRequest(new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

globalThis.fetch = realFetch;
console.log(failures === 0 ? '\nAll account tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
