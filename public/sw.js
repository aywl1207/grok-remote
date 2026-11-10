// grok-remote service worker.
//
// Never cache HTML or sw.js. iPad Home Screen apps otherwise keep a
// weeks-old shell (old index.html + old hashed JS) after a rebuild.
// Hashed /assets/* may be cached. /api/* is network only.

const CACHE = 'gr-shell-v4';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const accept = (req.headers && req.headers.get && req.headers.get('accept')) || '';
  if (accept.indexOf('text/event-stream') !== -1
      || url.pathname.endsWith('/stream')
      || url.pathname.indexOf('/stream?') !== -1) {
    return;
  }

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    event.respondWith(fetch(req, { cache: 'no-store', credentials: 'same-origin' }));
    return;
  }

  const neverCache =
    req.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/sw.js' ||
    url.pathname.endsWith('.webmanifest');

  if (neverCache) {
    event.respondWith(
      fetch(req, { cache: 'no-store', credentials: 'same-origin' }).catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response('', { status: 504, statusText: 'offline' });
      })
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      fetch(req).then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          caches.open(CACHE).then((cache) => cache.put(req, resp.clone())).catch(() => {});
        }
        return resp;
      }).catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response('', { status: 504, statusText: 'offline' });
      })
    );
    return;
  }

  event.respondWith(
    fetch(req, { cache: 'no-store', credentials: 'same-origin' }).catch(
      () => new Response('', { status: 504, statusText: 'offline' }),
    )
  );
});
