'use strict';

/**
 * Lineup — Service Worker
 * 앱 셸(정적 자원)만 캐시한다. 외부 API 호출(oEmbed, YouTube Data API —
 * 3단계 이후 추가됨)은 항상 최신 응답이 필요하므로 캐시 대상에서 제외하고
 * 네트워크로 직접 흘려보낸다.
 *
 * 버전을 올릴 때는 CACHE_NAME의 숫자만 바꾸면 이전 캐시가 자동 정리된다.
 */

const CACHE_NAME = 'lineup-shell-v11';
const SCOPE = self.registration.scope; // 예: https://pebbleitgo.com/lineup/

const APP_SHELL = [
  '',                 // scope 자체 (index.html)
  'index.html',
  'guide.html',
  'manifest.json',
  'css/style.css',
  'js/config.js',
  'js/analytics.js',
  'js/share.js',
  'js/app.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-192-maskable.png',
  'icons/icon-512-maskable.png',
  'icons/favicon-64.png',
].map((path) => new URL(path, SCOPE).toString());

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // GET 요청만 다룬다. POST 등은 그대로 네트워크로.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 다른 출처(YouTube API, 애널리틱스 등)는 캐시하지 않고 네트워크 직행.
  if (url.origin !== self.location.origin) return;

  // Lineup 범위 밖(예: 저장소 루트의 다른 툴)은 관여하지 않는다.
  if (!url.href.startsWith(SCOPE)) return;

  const putInCache = (res) => {
    if (res && res.status === 200) {
      const clone = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
    }
    return res;
  };

  // 화면(HTML)·코드(JS/CSS)·manifest: "네트워크 먼저" → 배포하면 바로 새 버전이 보인다.
  // (예전엔 캐시를 먼저 보여줘서 새 버전이 한 번 늦게 떴음) 오프라인일 때만 캐시 사용.
  const fresh =
    req.mode === 'navigate' ||
    ['document', 'script', 'style', 'manifest'].includes(req.destination);

  if (fresh) {
    event.respondWith(
      fetch(req)
        .then(putInCache)
        .catch(() => caches.match(req).then((c) => c || caches.match(new URL('index.html', SCOPE).toString())))
    );
    return;
  }

  // 이미지·아이콘: 캐시 먼저(빠름), 뒤에서 조용히 최신화
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then(putInCache).catch(() => cached);
      return cached || network;
    })
  );
});
