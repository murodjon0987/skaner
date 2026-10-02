// ScanPOS Service Worker (Offline Cache)
const CACHE_NAME = 'scanpos-v11';
const LOCAL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './auth.js',
  './firebase-config.js',
  './style.css',
  './logo.png',
  './logo.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './manifest.json'
];
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js',
  'https://unpkg.com/@zxing/browser@0.1.5/umd/zxing-browser.min.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'
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

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (e) => {
  // Faqat GET so'rovlari
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  const isFirebaseSDK = url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/10.12.0/');
  const isCdn = CDN_ASSETS.some(u => e.request.url.startsWith(u.split('/').slice(0, 3).join('/')));

  // Tashqi so'rovlarga (Firebase DB, OpenFoodFacts va b.) xalaqit bermaslik
  if (url.origin !== self.location.origin && !isCdn && !isFirebaseSDK) {
    return;
  }

  // Firebase SDK uchun Cache-First (offline ishlashi uchun)
  if (isFirebaseSDK) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((res) => {
          if (res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // 1. HTML, JS va CSS fayllar uchun Network-First (yangilanishlar darhol yetib borishi uchun)
  const isCodeAsset = e.request.mode === 'navigate' ||
                      url.pathname.endsWith('.html') ||
                      url.pathname.endsWith('.js') ||
                      url.pathname.endsWith('.css') ||
                      url.pathname.endsWith('.json') ||
                      url.pathname === '/';

  if (isCodeAsset) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(e.request);
          if (cached) return cached;
          return new Response('Internetga ulanish mavjud emas', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        })
    );
    return;
  }

  // 3. Boshqa resurslar (rasmlar, fontlar, CDN kutubxonalari) uchun Cache-First
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => {
        return new Response('Resurs topilmadi', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      });
    })
  );
});
