const CACHE = 'our-days-v2';
const PREFIX = 'our-days-';
const ROOT = self.registration.scope;

async function cacheShell(cache, response) {
  const html = await response.clone().text();
  const rootUrl = new URL(ROOT);
  const assets = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)]
    .map(match => new URL(match[1], ROOT))
    .filter(url => url.origin === rootUrl.origin && url.pathname.startsWith(rootUrl.pathname));
  await cache.addAll(assets);
  await cache.put(ROOT, response);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll([new URL('manifest.webmanifest', ROOT), new URL('icon.svg', ROOT)]);
    const response = await fetch(ROOT, { cache: 'reload' });
    if (!response.ok) throw new Error('Could not cache the app shell.');
    await cacheShell(cache, response);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(new URL(ROOT).pathname)) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(request);
        if (!fresh.ok) return await cache.match(ROOT) || fresh;
        event.waitUntil(cacheShell(cache, fresh.clone()).catch(() => { /* Keep the previous complete shell. */ }));
        return fresh;
      } catch { return await cache.match(ROOT) || Response.error(); }
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Vite preview and some CDNs vary module responses by Origin. These are
    // immutable, same-origin files inside this app's own scope and cache.
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
    const fresh = await fetch(request);
    if (fresh.ok) {
      const root = new URL(ROOT);
      if (url.pathname.startsWith(root.pathname)) {
        await cache.put(request, fresh.clone());
      }
    }
    return fresh;
  })());
});
