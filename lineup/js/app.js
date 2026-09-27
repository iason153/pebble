'use strict';

/**
 * Lineup — 1단계: PWA 기본 구조
 *
 * 이 파일은 앱 셸 배선(Service Worker 등록, 공유 진입 파라미터 수신,
 * 기본 UI 이벤트 훅)까지만 담당한다. 실제 큐 저장/렌더링(2단계),
 * oEmbed·Data API 조회(3단계), 재생·통근시간 계산(4단계) 로직은
 * 각 단계에서 이 파일에 이어서 구현한다. 아래 TODO 표시는 그 경계다.
 */

const LineupApp = {
  els: {},

  init() {
    this.cacheEls();
    this.registerServiceWorker();
    this.consumeShareTarget();
    this.wireAddForm();
    this.wireCommuteSlider();
    this.wireClearAll();

    // TODO(2단계): localStorage에서 큐를 불러와 렌더링
    // TODO(3단계): 큐 항목의 메타데이터(제목/썸네일/길이) 채우기
    // TODO(4단계): 재생 시작 버튼에 watch_videos 링크 생성 로직 연결
  },

  cacheEls() {
    this.els = {
      addForm: document.getElementById('form-add-url'),
      urlInput: document.getElementById('input-url'),
      clipboardHint: document.getElementById('clipboard-hint'),
      clipboardBtn: document.getElementById('btn-add-from-clipboard'),
      commuteSlider: document.getElementById('commute-slider'),
      commuteValue: document.getElementById('commute-value'),
      queueList: document.getElementById('queue-list'),
      queueEmpty: document.getElementById('queue-empty'),
      playBtn: document.getElementById('btn-play-queue'),
      clearAllBtn: document.getElementById('btn-clear-all'),
    };
  },

  // --- PWA: Service Worker ---------------------------------------------
  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch((err) => {
        console.warn('[Lineup] service worker 등록 실패:', err);
      });
    });
  },

  // --- 안드로이드 공유 연동(Web Share Target, GET 방식) 수신부 ----------
  // manifest.json의 share_target이 /lineup/?share_title=...&share_text=...&share_url=...
  // 형태로 앱을 열어준다. 실제 "큐에 추가"는 2단계 큐 저장 로직이 담당하므로,
  // 여기서는 값을 안전하게 집어와 세션에 보관하고 주소창만 정리한다.
  consumeShareTarget() {
    const params = new URLSearchParams(window.location.search);
    const sharedUrl = params.get('share_url') || params.get('share_text') || '';

    if (sharedUrl) {
      sessionStorage.setItem('lineup_pending_share', sharedUrl);
      // TODO(4단계): sessionStorage.getItem('lineup_pending_share')를 큐 추가 로직에 연결
    }

    if (params.has('share_title') || params.has('share_text') || params.has('share_url')) {
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  },

  // --- 영상 추가 폼 (URL 직접 입력 — 1군 경로) ---------------------------
  wireAddForm() {
    if (!this.els.addForm) return;
    this.els.addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = this.els.urlInput.value.trim();
      if (!url) return;

      // TODO(2단계): 실제 큐 배열에 push + localStorage 저장 + 목록 렌더링
      console.info('[Lineup] 큐 추가 요청(2단계 구현 예정):', url);

      this.els.urlInput.value = '';
    });
  },

  // --- 통근시간 슬라이더 (표시만, 계산은 4단계) --------------------------
  wireCommuteSlider() {
    if (!this.els.commuteSlider) return;
    const updateLabel = () => {
      this.els.commuteValue.textContent = `${this.els.commuteSlider.value}분`;
    };
    this.els.commuteSlider.addEventListener('input', updateLabel);
    updateLabel();
    // TODO(4단계): 큐 누적 재생시간과 비교해 트림 표시(commute-summary, is-trimmed 클래스)
  },

  // --- 전체 삭제 버튼 ------------------------------------------------
  wireClearAll() {
    if (!this.els.clearAllBtn) return;
    this.els.clearAllBtn.addEventListener('click', () => {
      // TODO(2단계): localStorage 큐 초기화 + 목록 다시 렌더링
      console.info('[Lineup] 전체 삭제 요청(2단계 구현 예정)');
    });
  },
};

document.addEventListener('DOMContentLoaded', () => LineupApp.init());
