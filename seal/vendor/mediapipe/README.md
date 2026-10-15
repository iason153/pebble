# 얼굴 자동 찾기용 파일 (자체 호스팅, 비용 0원)
- @mediapipe/face_detection 0.4.1646425229 (Apache-2.0, Google). full-range 모델(기울인·돌린·멀리 있는 얼굴).
- 실제로 내려받는 것: face_detection.js + wasm(simd 5.8MB, 안 되면 일반판 5.7MB 중 하나) + short 모델(0.2MB, 초기화용) + full sparse 모델(0.7MB) ≈ 7MB. "얼굴 찾아보기"를 누를 때만 내려받고, 폰 안에서 돌아가며 사진은 나가지 않는다.
- 라이브러리가 초기화 때 short 모델 그래프를 먼저 올리고 setOptions(model:'full')로 바꾸므로 short 파일도 꼭 있어야 한다(없으면 "Aborted" 오류).
- v1.6의 face-api.js(Tiny Face Detector)를 대체: 같은 사진에서 0.35초 vs 3초, 60° 기울인 얼굴도 검출.
