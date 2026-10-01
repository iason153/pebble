'use strict';

/**
 * Getset — Service Worker (Lineup과 같은 방식)
 * - 앱 셸(정적 파일)만 캐시. 카카오 SDK·장소 검색·통계 등 다른 출처는 손대지 않음.
 * - HTML/JS/CSS/manifest는 "네트워크 먼저" → 배포하면 바로 새 버전, 오프라인일 때만 캐시.
 * - 이미지·아이콘은 "캐시 먼저".
 * 버전을 올릴 때는 CACHE_NAME 숫자만 바꾸면 이전 캐시가 자동 정리된다.
 */

const CACHE_NAME = 'getset-shell-v7';
const SCOPE = self.registration.scope; // https://pebbleitgo.com/getset/

const APP_SHELL = [
  '',
  'index.html',
  'manifest.json',
  'css/style.css',
  'js/config.js',
  'js/analytics.js',
  'js/share.js',
  'js/kinds.js',
  'js/store.js',
  'js/places.js',
  'js/engine.js',
  'js/timefield.js',
  'js/profile.js',
  'js/learn.js',
  'js/onboarding.js',
  'js/install.js',
  'js/app.js',
  'data/model.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'icons/favicon.ico',
  'icons/favicon.svg',
].map((p) => new URL(p, SCOPE).toString());

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('getset-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
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

  // 값 파일(data/*.json)도 항상 최신을 먼저 — 관리 페이지에서 올린 값이 바로 반영되게
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
