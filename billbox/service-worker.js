'use strict';

/**
 * Billbox — Service Worker
 * - 앱 셸 캐시(Getset과 같은 방식: HTML/JS/CSS는 네트워크 먼저, 아이콘은 캐시 먼저)
 * - 푸시 알림 받기·누르면 앱 열기
 * - OCR 엔진·언어 파일(CDN)은 Tesseract.js가 스스로 IndexedDB에 저장하므로 여기서 손대지 않음
 */

const CACHE_NAME = 'billbox-shell-v2';
const SCOPE = self.registration.scope; // https://pebbleitgo.com/billbox/

const APP_SHELL = [
  '',
  'index.html',
  'manifest.json',
  'css/style.css',
  'js/config.js',
  'js/analytics.js',
  'js/kinds.js',
  'js/store.js',
  'js/extract.js',
  'js/ocr.js',
  'js/push.js',
  'js/share.js',
  'js/install.js',
  'js/app.js',
  'icons/icon.svg',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
].map((p) => new URL(p, SCOPE).toString());

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('billbox-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.href.startsWith(SCOPE)) return;
  if (url.pathname.startsWith('/api/')) return;

  const putInCache = (res) => {
    if (res && res.status === 200) {
      const clone = res.clone();
      caches.open(CACHE_NAME).then((c) => c.put(req, clone));
    }
    return res;
  };
  const fresh = req.mode === 'navigate' || ['document', 'script', 'style', 'manifest'].includes(req.destination);
  if (fresh) {
    event.respondWith(
      fetch(req)
        .then(putInCache)
        .catch(() => caches.match(req).then((c) => c || caches.match(new URL('index.html', SCOPE).toString())))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then(putInCache).catch(() => cached);
      return cached || network;
    })
  );
});

// ---------- 푸시 ----------
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'Billbox', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Billbox';
  const opts = {
    body: data.body || '낼 것이 있어요',
    icon: new URL('icons/icon-192.png', SCOPE).toString(),
    badge: new URL('icons/badge-96.png', SCOPE).toString(),
    tag: data.tag || 'billbox',
    renotify: true,
    data: { url: data.url || SCOPE },
    vibrate: [80, 40, 80],
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || SCOPE;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(SCOPE) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
