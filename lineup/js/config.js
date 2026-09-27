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

  // 재생 방식 (설계문서 §4-1)
  //   'batch'  — youtube.com/watch_videos?video_ids=... 로 큐 전체를 한 번에 넘김 (기본)
  //   'single' — 유튜브가 watch_videos를 막으면 이 값으로 바꾼다 → 영상을 하나씩 여는 방식
  PLAY_MODE: 'batch',

  // Google Analytics 4 측정 ID (Pebble 속성, pebbleitgo.com 웹 스트림). 비워두면 통계 끔.
  GA4_ID: 'G-4Q8F4E2J61',
});
