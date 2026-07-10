// App-shell service worker: cache-first for the static shell so the app
// loads offline (songs already live in IndexedDB). Bump VERSION on deploys
// that change any shell file.
const VERSION = 'dtx-shell-v3';

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/main.js',
  './js/player.js',
  './js/audio.js',
  './js/dtx.js',
  './js/db.js',
  './js/zip.js',
  './js/stretch.js',
  './js/stretch-worker.js',
  './js/pdf.js',
  './js/score.js',
  './js/vendor/stbvorbis.js',
  './js/vendor/stbvorbis_asm.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((hit) =>
      hit ||
      fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : undefined)),
    ),
  );
});
