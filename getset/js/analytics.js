'use strict';

/**
 * Pebble 공용 통계 (Google Analytics 4) — Lineup analytics.js를 툴 공용으로 일반화
 *
 * - GA4_ID가 비어 있으면 아무것도 불러오지 않고 track()도 조용히 무시한다.
 * - 개인정보 원칙: 장소명·주소·좌표 등 "어디에 가는지"는 절대 보내지 않는다.
 *   개수·분·종류·이동수단 같은 사용 패턴만 보낸다. (설계문서 §10)
 * - 모든 이벤트에 tool=getset 을 붙여 Pebble 속성 하나에서 툴별로 나눠 본다.
 */
(function () {
  const cfg = window.GETSET_CONFIG || {};
  const id = cfg.GA4_ID || '';
  const TOOL = 'getset';

  const appMode =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true
      ? 'pwa'
      : 'browser';

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }

  if (id) {
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    document.head.appendChild(s);

    gtag('js', new Date());
    gtag('set', 'user_properties', { app_mode: appMode });
    gtag('config', id, { tool: TOOL, app_mode: appMode });
  }

  /**
   * @param {string} name  이벤트 이름 (snake_case)
   * @param {object} [params]
   */
  window.pebbleTrack = function (name, params) {
    if (!id) return;
    try {
      gtag('event', name, Object.assign({ tool: TOOL, app_mode: appMode }, params || {}));
    } catch (_) {
      /* 통계 실패가 앱 동작을 막으면 안 됨 */
    }
  };
})();
