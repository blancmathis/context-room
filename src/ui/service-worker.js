/* BUILD and PRECACHE are generated from public source bytes, not user state. */
const CACHE = 'context-room-shell-' + BUILD;
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  try {
    for (const path of PRECACHE) {
      const response = await fetch(new Request(path, { cache: 'reload', credentials: 'omit', redirect: 'error' }));
      if (!response.ok) throw new Error('Incomplete Context Room application build.');
      await cache.put(path, response);
    }
  } catch (error) { await caches.delete(CACHE); throw error; }
  // No skipWaiting: a drawing window must never be replaced under a held pen.
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('context-room-shell-') && name !== CACHE) await caches.delete(name);
  // Do not claim existing windows. IndexedDB, gestures and recordings are untouched.
})()));
const publicPaths = new Set(PRECACHE);
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // API, source documents, rendered reviews, nonces and all writes are network-only.
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/offline.html')) {
    event.respondWith(fetch(request).catch(async () => (await caches.open(CACHE)).match('/offline.html')));
  } else if (publicPaths.has(url.pathname + url.search)) {
    event.respondWith((async () => (await (await caches.open(CACHE)).match(url.pathname + url.search)) || fetch(request))());
  }
});
