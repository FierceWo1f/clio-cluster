// Service worker: permite que la app instalada funcione sin servidor ni internet.
// Estrategia: red primero (para recibir actualizaciones), caché si no hay red.

const CACHE = 'clio-cluster-v8';
const ASSETS = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/link.js', 'js/media.js', 'js/id3.js', 'js/lyrics.js', 'js/elm327.js', 'js/transport.js', 'js/simulator.js',
  'js/pids.js', 'js/dtc.js', 'js/gauges.js', 'js/chart.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // No cachear música (respuestas 206 por partes), datos del hub ni mapas: son grandes o cambian.
  const path = new URL(e.request.url).pathname;
  if (e.request.headers.has('range') || /^\/(media|hub|datos|pantalla|tools)\//.test(path)) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))),
  );
});
