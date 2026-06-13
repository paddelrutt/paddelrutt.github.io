// PaddlePlanner service worker.
// Strategy:
//  - App shell (same-origin): network-first with cache fallback, so deploys
//    show up immediately online but the app still loads offline.
//  - Map tiles + CDN libraries: cache-first (effectively immutable), so a
//    paddled area and the JS needed to run stay available with no signal.
//  - Data APIs (SMHI / EMODnet / Overpass / Open-Meteo): network-first with
//    cache fallback, so re-planning offline reuses the last response.

const SHELL_CACHE = 'pp-shell-v1';
const TILE_CACHE = 'pp-tiles-v1';
const DATA_CACHE = 'pp-data-v1';
const TILE_CACHE_LIMIT = 2000;

const SHELL = [
  './', './index.html', './style.css', './manifest.webmanifest',
  './icon-192.png', './icon-512.png',
  './js/app.js', './js/grid.js', './js/tiles.js', './js/router.js',
  './js/smhi.js', './js/marine.js', './js/sun.js', './js/overpass.js', './js/depth.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
];

const isTile = (u) =>
  /tile\.openstreetmap\.org/.test(u) || /tiles\.openfreemap\.org/.test(u);
const isLib = (u) => /esm\.sh/.test(u) || /unpkg\.com/.test(u);
const isData = (u) =>
  /smhi\.se/.test(u) || /emodnet/.test(u) || /overpass-api\.de/.test(u) ||
  /open-meteo\.com/.test(u);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![SHELL_CACHE, TILE_CACHE, DATA_CACHE].includes(k))
        .map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > limit) {
    for (let i = 0; i < keys.length - limit; i++) await cache.delete(keys[i]);
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) {
    cache.put(req, res.clone());
    if (cacheName === TILE_CACHE) trimCache(TILE_CACHE, TILE_CACHE_LIMIT);
  }
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = request.url;

  if (isTile(url) || isLib(url)) {
    e.respondWith(cacheFirst(request, isTile(url) ? TILE_CACHE : SHELL_CACHE));
  } else if (isData(url)) {
    e.respondWith(networkFirst(request, DATA_CACHE));
  } else if (new URL(url).origin === self.location.origin) {
    e.respondWith(networkFirst(request, SHELL_CACHE));
  }
});
