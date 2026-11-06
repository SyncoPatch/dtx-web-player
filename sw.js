// App-shell service worker: cache-first for the static shell so the app
// loads offline (songs already live in IndexedDB). Bump VERSION on deploys
// that change any shell file.
const VERSION = 'dtx-shell-v12';
// onnxruntime's 25 MB wasm is cached on first use instead of with the shell,
// in its own cache that survives shell updates (named by the vendored version).
const ORT_CACHE = 'dtx-ort-1.29.0';
const ORT_WASM = /\/js\/vendor\/onnxruntime\/[^/]+\.wasm$/;

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/main.js',
  './js/player.js',
  './js/audio.js',
  './js/xa.js',
  './js/dtx.js',
  './js/db.js',
  './js/zip.js',
  './js/zipwrite.js',
  './js/stretch.js',
  './js/stretch-worker.js',
  './js/pdf.js',
  './js/score.js',
  './js/chartview.js',
  './js/skin.js',
  './js/gp.js',
  './js/dtxwrite.js',
  './js/drumkit.js',
  './js/gpsync.js',
  './js/feet.js',
  './js/align.js',
  './js/align-core.js',
  './js/align-worker.js',
  './js/flac.js',
  './js/ogg.js',
  './js/models.js',
  './js/separate.js',
  './js/separate-core.js',
  './js/separate-worker.js',
  './js/stemslice.js',
  './js/vendor/onnxruntime/ort.webgpu.min.mjs',
  './js/vendor/onnxruntime/ort-wasm-simd-threaded.asyncify.mjs',
  './js/vendor/alphatab/alphaTab.core.min.mjs',
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
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== ORT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (ORT_WASM.test(url.pathname)) {
    e.respondWith(
      caches.open(ORT_CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) c.put(req, res.clone());
        return res;
      }))),
    );
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((hit) =>
      hit ||
      fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : undefined)),
    ),
  );
});
