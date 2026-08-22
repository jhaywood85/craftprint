// Local dev/test server for the Classroom worker: runs the exact same
// handler as Cloudflare, with an in-memory KV stand-in.
//
//   node server/dev.mjs [port]     (default 8787)

import { createServer } from 'node:http';
import { handleRequest } from './worker.js';

// Minimal KV-compatible store (get/put/list/delete; TTL ignored).
export function memoryKV() {
  const map = new Map();
  return {
    async get(key) { return map.get(key) ?? null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    async list({ prefix }) {
      return { keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

// Optional env passthrough so accounts can be exercised locally:
//   SESSION_SECRET=dev GOOGLE_FAKE=teacher@example.com node server/dev.mjs
// (GOOGLE_FAKE signs in as that email WITHOUT talking to Google — strictly a
// local testing shortcut. Real Google sign-in needs GOOGLE_CLIENT_ID/SECRET.)
const env = {
  ROOMS: memoryKV(),
  CREATE_PASSCODE: process.env.CREATE_PASSCODE,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  SESSION_SECRET: process.env.SESSION_SECRET,
  GOOGLE_FAKE: process.env.GOOGLE_FAKE,
};
const port = Number(process.argv[2]) || 8787;

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await handleRequest(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`Classroom dev server on http://localhost:${port}`));
