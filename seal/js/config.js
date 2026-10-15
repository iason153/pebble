'use strict';
/** Seal 설정값. GA4_ID를 비우면 통계를 끈다. 모든 이벤트에 tool=seal. 사진·이름·백업 코드는 절대 보내지 않는다. */
window.SEAL_CONFIG = Object.freeze({
  GA4_ID: 'G-4Q8F4E2J61',
  /** 글자 자동 찾기(Tesseract.js, 저장소 안 vendor/tesseract/에 자체 호스팅) — "글자 찾아보기"를 누를 때만 불러온다. 폰 안에서 돌아가고 사진은 나가지 않는다. */
  OCR_BASE: 'vendor/tesseract/',
  OCR_LANG: 'eng',
  /** 얼굴 자동 찾기(MediaPipe Face Detection, vendor/mediapipe/) — "얼굴 찾아보기"를 누를 때만 불러온다(약 7MB). */
  FACE_BASE: 'vendor/mediapipe/',
});
