# 글자 자동 찾기용 파일 (자체 호스팅, 비용 0원)

- tesseract.min.js / worker.min.js — tesseract.js 5.1.1 (Apache-2.0)
- tesseract-core-lstm.wasm.js / tesseract-core-simd-lstm.wasm.js — tesseract.js-core (Apache-2.0). 브라우저가 SIMD를 지원하면 simd 판을 고른다.
- eng.traineddata.gz — tessdata_fast 영어(숫자·영문). 번호판·전화번호 찾기에 충분. 한글은 못 읽는다(한글 파일은 10MB가 넘어 넣지 않음).

CDN 대신 저장소에 두는 이유: 외부 CDN이 막히거나 바뀌어도 동작하고, 사진이 어디로도 나가지 않는다는 것을 코드만 보고 확인할 수 있게 하려고.
