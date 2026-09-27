'use strict';

/**
 * Lineup — 1단계: Service Worker
 * 앱 셸(정적 자원)만 캐시한다. 외부 API 호출(oEmbed, YouTube Data API —
 * 3단계 이후 추가됨)은 항상 최신 응답이 필요하므로 캐시 대상에서 제외하고
 * 네트워크로 직접 흘려보낸다.
 *
 * 버전을 올릴 때는 CACHE_NAME의 숫자만 바꾸면 이전 캐시가 자동 정리된다.
 */

const CACHE_NAME = 'lineup-shell-v6';
const SCOPE = self.registration.scope; // 예: https://pebbleitgo.com/lineup/

const APP_SHELL = [
  '',                 // scope 자체 (index.html)
  'index.html',
  'manifest.json',
  'css/style.css',
  'js/config.js',
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

  // 다른 출처(oEmbed, YouTube Data API, youtube.com 등)는 캐시하지 않고
  // 브라우저 기본 동작(네트워크 직행)에 맡긴다.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached); // 오프라인 등 네트워크 실패 시 캐시로 대체

      // 캐시가 있으면 즉시 캐시를 보여주고(빠른 반응), 백그라운드로 최신화한다.
      return cached || network;
    })
  );
});
