// Service worker for the ADMIN app only (scope /admin).
const CACHE = 'mahad-admin-v1';

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(['/admin', '/icons/icon-192.png']).catch(() => {}))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// A fetch handler must exist for Chrome to treat the app as installable.
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  // Never touch API calls or non-GET requests: the browser handles them directly.
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200 && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('/admin')))
  );
});
