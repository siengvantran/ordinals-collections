// WORDS service worker: makes the app shell load without a connection.
// API calls are never cached: points, games and codes always come from the server.
const VERSION = 'words-v1';
const SHELL = [
  '/words/', '/words/index.html', '/words/css/words.css', '/words/icon.svg', '/words/manifest.webmanifest',
  '/words/js/app.js', '/words/js/api.js', '/words/js/config.js', '/words/js/game.js', '/words/js/ui.js',
  '/words/js/core/errors.js', '/words/js/core/grid.js', '/words/js/core/scoring.js', '/words/vendor/qrcode.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (!url.pathname.startsWith('/words/')) return;
  // Network first, so new releases arrive straight away; cache as the fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && !url.pathname.endsWith('/dictionary.txt')) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('/words/')))
  );
});
