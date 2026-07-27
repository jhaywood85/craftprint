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

const env = { ROOMS: memoryKV() };
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
