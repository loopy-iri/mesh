/* Complete offline app-shell cache so the PWA opens and works 100% offline. */
const CACHE = 'p2psecure-v3';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './src/app.js',
  './src/mesh.js',
  './src/ledger.js',
  './src/direct-connect.js',
  './src/crypto.js',
  './src/db.js',
  './src/qr.js',
  './src/scanner.js',
  './src/signaling.js',
  './src/webrtc.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache live signaling or dynamic mailbox/relay requests.
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/signal/') ||
    url.pathname.startsWith('/mailbox/') ||
    url.pathname.startsWith('/relay/')
  ) return;
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request).catch(() => caches.match('./index.html'))),
  );
});
