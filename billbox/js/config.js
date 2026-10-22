'use strict';

/**
 * Billbox 설정값
 *
 * GA4_ID — Pebble 속성 측정 ID. 모든 이벤트에 tool=billbox. 비우면 통계 끔.
 * API_BASE — 푸시 알림 서버(같은 Vercel 프로젝트의 /api/billbox). 비우면 푸시 기능 숨김.
 * OCR — 글자 읽기 엔진(Tesseract.js) 위치. 우리 사이트 vendor/ 폴더. 사진은 폰 밖으로 나가지 않는다.
 *       (처음 한 번만 받고 폰에 저장된다)
 */
window.BILLBOX_CONFIG = Object.freeze({
  GA4_ID: 'G-4Q8F4E2J61',
  API_BASE: '/api/billbox',
  // 글자 읽기 엔진·한글 사전: 우리 사이트(billbox/vendor/)에서 제공 — 외부 CDN이 느려 실패하던 문제(v1.1.2) 해결
  // 파일을 바꾸면 REV를 올릴 것(폰에 저장된 옛 사전 대신 새로 받게)
  OCR: Object.freeze({
    SCRIPT: 'vendor/tesseract/tesseract.min.js',
    WORKER: 'vendor/tesseract/worker.min.js',
    CORE: 'vendor/tesseract',
    LANG_PATH: 'vendor/lang',
    REV: '2',
  }),
  REMIND_HOUR_DEFAULT: 9,
  VERSION: '2.3.3',
});
