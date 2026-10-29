'use strict';

// Bump this generation whenever the trusted static shell changes. Never store
// documents with measurement UI, HTTP responses from APIs, or arbitrary URLs.
const CACHE_PREFIX = 'evse-control-shell-';
const CACHE_NAME = CACHE_PREFIX + 'v6';
const STATIC_PATHS = Object.freeze([
  '/static/app.js', '/static/charts.js', '/static/history.js', '/static/newcalendar.js',
  '/static/theme.js', '/static/smartmeter.js', '/static/smartmeter-chart.js', '/static/house-history.js', '/static/pwa.js', '/static/style.css',
  '/static/icon.svg', '/static/app-192.png', '/static/app-512.png',
  '/static/app-maskable-512.png', '/static/apple-touch-icon.png',
  '/manifest.webmanifest', '/static/offline.html'
]);
const PAGE_PATHS = ['/', '/diagramme', '/einstellungen'];

function requestKind(request, origin) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== origin) return null;
  if (url.pathname === '/healthz' || url.pathname === '/api' || url.pathname.startsWith('/api/')) return 'live';
  // Query strings must not populate or alias an allowlisted cache entry.
  if (url.search) return null;
  if (request.mode === 'navigate' && PAGE_PATHS.includes(url.pathname)) return 'navigation';
  return STATIC_PATHS.includes(url.pathname) ? 'static' : null;
}

async function boundedFetch(request, fetcher, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    // A separate race also bounds implementations where abort is delayed.
    return await Promise.race([
      fetcher(request, { cache: 'no-store', signal: controller.signal }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Keine Verbindung'));
      }, timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

async function navigation(request, cacheStorage, fetcher) {
  try {
    return await boundedFetch(request, fetcher, 5000);
  } catch (_) {
    const cache = await cacheStorage.open(CACHE_NAME);
    const fallback = await cache.match('/static/offline.html');
    if (fallback) return fallback;
    return new Response('Offline – keine Verbindung. Keine Livewerte verfügbar.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
}

async function staticResponse(request, cacheStorage, fetcher) {
  // Online always uses current server assets, never a stale-while-revalidate
  // race. Only installation writes this immutable generation's shell cache.
  // A blackholed connection must not leave the offline page's script/style
  // parser-blocking indefinitely even though navigation already timed out.
  try { return await boundedFetch(request, fetcher, 3000); }
  catch (error) {
    const cache = await cacheStorage.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CACHE_PREFIX, CACHE_NAME, STATIC_PATHS, requestKind, navigation, staticResponse };
}
if (typeof self !== 'undefined' && self.addEventListener) {
  self.addEventListener('install', event => {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(STATIC_PATHS.map(url => new Request(url, { cache: 'reload' })));
    })());
    // No skipWaiting: a waiting generation must not replace open app clients.
  });
  self.addEventListener('activate', event => {
    event.waitUntil((async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) await caches.delete(key);
      }
      await self.clients.claim();
    })());
  });
  self.addEventListener('fetch', event => {
    const kind = requestKind(event.request, self.location.origin);
    if (kind === 'live') event.respondWith(fetch(event.request, { cache: 'no-store' }));
    else if (kind === 'navigation') event.respondWith(navigation(event.request, caches, fetch));
    else if (kind === 'static') event.respondWith(staticResponse(event.request, caches, fetch));
  });
}
