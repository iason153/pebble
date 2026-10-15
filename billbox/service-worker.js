'use strict';

/**
 * Billbox — Service Worker
 * - 앱 셸 캐시(Getset과 같은 방식: HTML/JS/CSS는 네트워크 먼저, 아이콘은 캐시 먼저)
 * - 푸시 알림 받기·누르면 앱 열기
 * - OCR 엔진·언어 파일(CDN)은 Tesseract.js가 스스로 IndexedDB에 저장하므로 여기서 손대지 않음
 */

importScripts('js/db.js'); // 폰 저장소(알림 문구에 금액 붙이기, 공유로 받은 사진)

const CACHE_NAME = 'billbox-shell-v8';
const ENGINE_CACHE = 'billbox-engine-r2'; // 읽기 엔진·사전(약 12MB). 앱 버전이 바뀌어도 그대로 둠, REV 바뀔 때만 새로
const SCOPE = self.registration.scope; // https://pebbleitgo.com/billbox/

const APP_SHELL = [
  '',
  'index.html',
  'manifest.json',
  'css/style.css',
  'js/config.js',
  'js/analytics.js',
  'js/db.js',
  'js/kinds.js',
  'js/guide.js',
  'js/store.js',
  'js/extract.js',
  'js/ocr.js',
  'js/push.js',
  'js/viewer.js',
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
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('billbox-') && k !== CACHE_NAME && k !== ENGINE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // 카톡·갤러리 "공유 → Billbox" (manifest share_target). 사진을 폰 저장소에 잠깐 두고 앱을 연다
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/billbox/share-target')) {
    event.respondWith(
      (async () => {
        try {
          const fd = await req.formData();
          const f = fd.getAll('image').find((x) => x && x.size) || fd.get('image');
          if (f) await self.BillboxDB.putInbox(f);
        } catch (_) {}
        return Response.redirect(new URL('./?shared=1', SCOPE).toString(), 303);
      })()
    );
    return;
  }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.href.startsWith(SCOPE)) return;
  if (url.pathname.startsWith('/api/')) return;

  // 읽기 엔진·사전: 한 번 받으면 폰에 저장해 두고 계속 씀(인터넷이 느리거나 끊겨도 읽기 가능)
  if (url.pathname.includes('/billbox/vendor/')) {
    event.respondWith(
      caches.open(ENGINE_CACHE).then((c) =>
        c.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res && res.status === 200) c.put(req, res.clone());
              return res;
            })
        )
      )
    );
    return;
  }

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
// 서버는 "어느 항목을, 며칠 남았다고 알릴지"만 보낸다(items:[{id, days}]). 금액은 서버에 없다.
// 여기서 폰 저장소의 사본(mirror)을 열어 금액을 붙여 문구를 만든다.
//   - 이번 차례 고지서를 찍음(예상 아님) → "전기요금 52,340원 · 3일 남았어요"
//   - 고지서 안 찍음(예상) → "전기요금 납부를 준비하세요 · 3일 남았어요 · 지난번 약 52,340원"
//   - 한 번만 오는 것 → 금액 포함
const won = (n) => Number(n).toLocaleString('ko-KR');
function whenText(days) {
  if (days === 0) return '오늘까지!';
  if (days < 0) return '어제가 마감이었어요';
  return `${days}일 남았어요`;
}
function lineFor(sig, m) {
  const name = (m && m.name) || sig.name || '낼 것';
  const emoji = (m && m.emoji) || '💸';
  const when = whenText(sig.days);
  if (!m || m.amount == null) return `${emoji} ${name} · ${when}`;
  if (m.estimated) return `${emoji} ${name} 납부를 준비하세요 · ${when} · 지난번 약 ${won(m.amount)}원`;
  return `${emoji} ${name} ${won(m.amount)}원 · ${when}`;
}
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'Billbox', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    (async () => {
      let title = data.title || 'Billbox';
      let body = data.body || '낼 것이 있어요';
      if (Array.isArray(data.items) && data.items.length) {
        let mirror = [];
        try {
          mirror = (await self.BillboxDB.getMirror()) || [];
        } catch (_) {}
        const byId = new Map(mirror.map((x) => [x.id, x]));
        // 이미 냈거나 지운 항목은 빼기(서버 정보가 조금 늦을 수 있음)
        const sigs = data.items.filter((sig) => !mirror.length || byId.has(sig.id));
        if (!sigs.length) return;
        const lines = sigs.map((sig) => lineFor(sig, byId.get(sig.id)));
        title = lines.length === 1 ? 'Billbox 💸' : `Billbox 💸 낼 것 ${lines.length}건`;
        body = lines.slice(0, 4).join('\n') + (lines.length > 4 ? `\n외 ${lines.length - 4}건` : '');
      }
      await self.registration.showNotification(title, {
        body,
        icon: new URL('icons/icon-192.png', SCOPE).toString(),
        badge: new URL('icons/badge-96.png', SCOPE).toString(),
        tag: data.tag || 'billbox',
        renotify: true,
        data: { url: data.url || SCOPE },
        vibrate: [80, 40, 80],
      });
    })()
  );
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
