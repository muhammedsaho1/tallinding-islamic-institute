// KILL SWITCH: replaces the old public-site service worker.
// Browsers that already registered the old /sw.js will pick this up,
// clear the old caches and remove the worker, so the landing page is a normal website again.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.navigate(c.url));
  })());
});
