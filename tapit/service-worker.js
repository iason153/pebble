'use strict';

/**
 * Tapit — Service Worker (Lineup·Getset과 같은 방식)
 * - 앱 셸(정적 파일)만 캐시. 카카오 SDK·글꼴·통계 등 다른 출처는 손대지 않음.
 * - HTML/JS/CSS/manifest는 "네트워크 먼저" → 배포하면 바로 새 버전, 오프라인일 때만 캐시.
 * - 이미지·아이콘은 "캐시 먼저".
 * 버전을 올릴 때는 CACHE_NAME 숫자만 바꾸면 이전 캐시가 자동 정리된다.
 */

const CACHE_NAME = 'tapit-shell-v3';
const SCOPE = self.registration.scope; // https://pebbleitgo.com/tapit/

const APP_SHELL = [
  '',
  'index.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'icons/favicon-32.png',
  'og.png',
].map((p) => new URL(p, SCOPE).toString());

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tapit-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 카카오·GA 등 외부는 네트워크 직행
  if (!url.href.startsWith(SCOPE)) return; // 다른 툴(lineup 등)은 관여 안 함

  const putInCache = (res) => {
    if (res && res.status === 200) {
      const clone = res.clone();
      caches.open(CACHE_NAME).then((c) => c.put(req, clone));
    }
    return res;
  };

  const fresh = req.mode === 'navigate' || ['document', 'script', 'style', 'manifest'].includes(req.destination) || url.pathname.endsWith('.json');
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
