// ScanPOS Service Worker (Offline Cache)
const CACHE_NAME = 'scanpos-v2';
const LOCAL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './logo.png',
  './manifest.json'
];
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://unpkg.com/@zxing/browser@0.1.5/umd/zxing-browser.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Mahalliy fayllar (kritik) — barchasi yuklanishi shart
      await cache.addAll(LOCAL_ASSETS);
      // CDN fayllar — har biri alohida try/catch bilan (tarmoq yo'q bo'lsa o'tkazib yuboriladi)
      await Promise.all(
        CDN_ASSETS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`SW: CDN faylini keshlab bo'lmadi (${url}):`, err)
          )
        )
      );
    }).then(() => self.skipWaiting())
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
  // Faqat GET so'rovlari
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Tashqi so'rovlarga (Firebase, API) xalaqit bermaslik
  if (url.origin !== self.location.origin &&
      !CDN_ASSETS.some(u => e.request.url.startsWith(u.split('/').slice(0, 3).join('/')))) {
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
