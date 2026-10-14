'use strict';

/**
 * Billbox 설정값
 *
 * GA4_ID — Pebble 속성 측정 ID. 모든 이벤트에 tool=billbox. 비우면 통계 끔.
 * API_BASE — 푸시 알림 서버(같은 Vercel 프로젝트의 /api/billbox). 비우면 푸시 기능 숨김.
 * OCR — 글자 읽기 엔진(Tesseract.js) 주소. 전부 무료 CDN. 사진은 폰 밖으로 나가지 않는다.
 *       (언어 파일은 처음 한 번만 내려받고 브라우저에 저장된다)
 */
window.BILLBOX_CONFIG = Object.freeze({
  GA4_ID: 'G-4Q8F4E2J61',
  API_BASE: '/api/billbox',
  OCR: Object.freeze({
    SCRIPT: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    WORKER: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
    CORE: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
    // 언어 파일: 비우면 Tesseract.js 기본값(jsDelivr의 @tesseract.js-data/{언어}/4.0.0_best_int)을 쓴다.
    // v1.0.1까지 tessdata.projectnaptha.com/4.0.0_best_int 를 넣었는데 그 주소엔 best_int가 없어 내려받기가 멈췄다(치명 버그).
    LANG_PATH: '',
  }),
  REMIND_HOUR_DEFAULT: 9,
  VERSION: '1.0.3',
});
