'use strict';

/**
 * Lineup 방문·사용 통계 (Google Analytics 4)
 *
 * - config.js의 GA4_ID가 비어 있으면 아무것도 불러오지 않고 track()도 조용히 무시한다.
 * - 개인정보 원칙: 영상 ID·제목·채널 등 "무엇을 보는지"는 절대 보내지 않는다.
 *   개수·분·방법 같은 사용 패턴만 보낸다.
 * - 모든 이벤트에 tool=lineup 을 붙여, Pebble 속성 하나에서 툴별로 나눠 볼 수 있게 한다.
 * - 홈 화면 앱으로 연 경우 app_mode=pwa, 브라우저면 browser (설치 효과 확인용)
 */
(function () {
  const cfg = window.LINEUP_CONFIG || {};
  const id = cfg.GA4_ID || '';
  const TOOL = 'lineup';

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
  window.lineupTrack = function (name, params) {
    if (!id) return;
    try {
      gtag('event', name, Object.assign({ tool: TOOL, app_mode: appMode }, params || {}));
    } catch (_) {
      /* 통계 실패가 앱 동작을 막으면 안 됨 */
    }
  };
})();
