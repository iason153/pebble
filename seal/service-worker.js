'use strict';

/**
 * Seal — Service Worker (Getset과 같은 방식)
 * - 앱 셸(정적 파일)만 캐시. 글자 인식(Tesseract) CDN·통계 등 다른 출처는 손대지 않음.
 * - HTML/JS/CSS/manifest는 "네트워크 먼저", 이미지·아이콘은 "캐시 먼저".
 * - 공유 받기: 설치된 Seal로 캡처를 공유하면(share_target POST) 파일을 잠시 보관했다가 ./?shared=1 로 보낸다.
 * 버전을 올릴 때는 CACHE_NAME 숫자만 바꾼다.
 */

const CACHE_NAME = 'seal-shell-v10';
const SHARE_CACHE = 'seal-share';
const SCOPE = self.registration.scope; // https://pebbleitgo.com/seal/

const APP_SHELL = [
  '', 'index.html', 'manifest.json', 'css/style.css',
  'js/config.js', 'js/analytics.js', 'js/share.js', 'js/install.js', 'js/seal-core.js', 'js/seal-worker.js', 'js/app.js',
  'img/demo-original.jpg', 'img/demo-stamped.jpg', 'img/demo-revealed.jpg',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-192.png', 'icons/maskable-512.png', 'icons/favicon.ico', 'icons/favicon.svg',
].map((p) => new URL(p, SCOPE).toString());

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('seal-shell-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 공유 받기 (갤럭시 공유 메뉴 → Seal)
  if (req.method === 'POST' && url.pathname === new URL('share-target', SCOPE).pathname) {
    event.respondWith((async () => {
      try {
        const fd = await req.formData();
        const file = fd.get('photo');
        if (file) {
          const c = await caches.open(SHARE_CACHE);
          await c.put('shared-photo', new Response(file, { headers: { 'Content-Type': file.type || 'image/jpeg' } }));
        }
      } catch (_) {}
      return Response.redirect(new URL('./?shared=1', SCOPE).toString(), 303);
    })());
    return;
  }

  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return; // CDN·GA 등 외부는 네트워크 직행
  if (!url.pathname.startsWith(new URL(SCOPE).pathname)) return;

  const isAsset = /\.(png|jpg|jpeg|svg|ico|webp)$/i.test(url.pathname);
  if (isAsset) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  event.respondWith(
    fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); } return res; })
      .catch(() => caches.match(req).then((hit) => hit || caches.match(new URL('index.html', SCOPE).toString())))
  );
});
