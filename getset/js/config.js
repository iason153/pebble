'use strict';

/**
 * Getset 설정값
 *
 * KAKAO_JS_KEY — 카카오디벨로퍼스 "Pebble" 앱(ID 1593623)의 JavaScript 키.
 *   웹페이지에 공개되는 키라 여기 적어도 된다. 대신 키 자체에 사이트 주소 잠금을
 *   걸어두었다(2026-10-01): https://pebbleitgo.com, https://www.pebbleitgo.com
 *   → 다른 주소(로컬·미리보기 주소 포함)에서는 장소 검색이 동작하지 않는 게 정상.
 *   ※ REST API 키는 절대 여기에 넣지 않는다. 길찾기용 REST 키는 Vercel 환경변수
 *     KAKAO_REST_KEY 에만 둔다(4단계 서버리스 함수에서 사용).
 *
 * GA4_ID — Pebble 속성 측정 ID. 비워두면 통계 끔. 모든 이벤트에 tool=getset.
 */
window.GETSET_CONFIG = Object.freeze({
  KAKAO_JS_KEY: 'a80d2ef426799af21b478795292dd6f8',
  GA4_ID: 'G-4Q8F4E2J61',
});
