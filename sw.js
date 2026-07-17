// Service worker: precache every asset so CraftPrint runs fully offline once
// it has been opened once. Bump CACHE when any asset changes to force a
// refresh (old caches are deleted on activate).
//
// Strategy: cache-first for our own assets (they're versioned by CACHE), so
// launches are instant and work with no network — ideal for a home-screen
// app on a kid's tablet.

const CACHE = 'craftprint-v8';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './src/main.js',
  './src/meshing.js',
  './src/palette.js',
  './src/player.js',
  './src/shapes.js',
  './src/sounds.js',
  './src/starter.js',
  './src/stl.js',
  './src/storage.js',
  './src/touchcontrols.js',
  './src/ui.js',
  './src/undo.js',
  './src/world.js',
  './vendor/three.module.min.js',
  './vendor/three.core.min.js',
  './vendor/addons/controls/OrbitControls.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((resp) => {
          // Cache same-origin successful responses we didn't precache (e.g.
          // a file the app requests later). Don't cache opaque cross-origin.
          if (resp.ok && new URL(request.url).origin === self.location.origin) {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return resp;
        })
        .catch(() => cached); // offline and uncached: nothing we can do
    })
  );
});
