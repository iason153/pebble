# Billbox vendor (글자 읽기 엔진 — 우리 사이트에서 직접 제공)

외부 CDN(jsDelivr)이 느리거나 끊기면 "읽기 도구 준비 못함"이 났던 문제(v1.1.2)를 없애려고
엔진·한글 사전을 pebbleitgo.com 안에 둔다. 처음 한 번 받고 나면 폰에 저장돼 다시 안 받는다.

| 파일 | 출처 | 버전 | 라이선스 |
|---|---|---|---|
| tesseract/tesseract.min.js, worker.min.js | npm `tesseract.js` | 5.1.1 | Apache-2.0 |
| tesseract/tesseract-core-lstm.wasm.js, tesseract-core-simd-lstm.wasm.js | npm `tesseract.js-core` | 5.1.1 | Apache-2.0 |
| lang/kor.traineddata.gz, eng.traineddata.gz | npm `@tesseract.js-data/kor`·`eng` 4.0.0_best_int | 1.0.0 | Apache-2.0 (tessdata) |

- 엔진은 LSTM 전용(oem 1)이라 `*-lstm.wasm.js` 두 개만 있으면 된다(SIMD 되는 폰/안 되는 폰).
- 파일을 바꾸면 `js/config.js`의 `OCR_REV`를 올려 캐시를 새로 받게 할 것.
