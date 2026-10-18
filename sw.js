// Network-first cache so the app keeps working if venue Wi-Fi drops after
// the first load. Always tries the network, so updates show up immediately.
const CACHE = 'badge-printer-v2';
const SHELL = [
  './', 'index.html', 'style.css', 'badge.yaml', 'sample.csv', 'assets/logo.svg',
  'vendor/js-yaml.min.js', 'vendor/qrcode.min.js',
  'js/config.js', 'js/pronouns.js', 'js/render.js', 'js/share.js', 'js/zip.js',
  'js/batch.js', 'js/settings.js', 'js/app.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
