// ScanPOS Service Worker (Offline Cache)
const CACHE_NAME = 'scanpos-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './logo.svg',
  './logo.png',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Faqat GET so'rovlari va mahalliy resurslarni keshlash
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Tashqi API yoki Firebase so'rovlariga xalaqit bermaslik
  if (!url.origin.includes(self.location.origin)) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const networked = fetch(e.request).then((res) => {
        if (res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || networked;
    })
  );
});
