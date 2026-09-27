'use strict';

/**
 * Lineup 설정값
 *
 * YT_API_KEY — YouTube Data API v3 키 (Google Cloud 프로젝트: pebble-lineup)
 *   정적 사이트라 이 값은 브라우저에서 누구나 볼 수 있다. 그래서 키 자체에
 *   아래 두 가지 잠금을 걸어두었다(2026-09-27 설정 완료):
 *     - 애플리케이션 제한: 웹사이트 — pebbleitgo.com/*, www.pebbleitgo.com/*, localhost
 *     - API 제한: YouTube Data API v3 만 허용
 *   키를 교체할 때는 이 파일 한 줄만 바꾸면 된다.
 */
window.LINEUP_CONFIG = Object.freeze({
  YT_API_KEY: 'AIzaSyD1YYH5Kxn3-uSeJLwJ66zIQwGCrCvG4Bg',
});
