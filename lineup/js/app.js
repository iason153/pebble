'use strict';

/**
 * Lineup — 앱 로직
 *
 * 1단계: PWA 셸 배선(Service Worker 등록, 공유 진입 파라미터 수신)
 * 2단계: 큐 UI + localStorage — URL 파싱, 추가/삭제/순서변경(드래그·버튼·방향키),
 *        전체삭제, 되돌리기 토스트, 저장/복원, 다른 탭과 동기화
 *
 * 3단계: 영상 정보(제목·채널·길이) 조회 — YouTube Data API 1회 호출로 한꺼번에,
 *        실패 시 oEmbed로 제목만 폴백 / 클립보드 링크 감지·붙여넣기
 *
 * 4단계: 재생(watch_videos 일괄 전달 + 하나씩 열기 폴백), 통근시간 맞춤(누적 길이로
 *        자르기), 안드로이드 공유로 담기(Web Share Target), 홈 화면 설치 버튼
 */

// ---------------------------------------------------------------------------
// 유튜브 URL → 영상 ID 파서 (순수 함수, DOM 의존 없음)
// ---------------------------------------------------------------------------
const YouTubeUrl = {
  ID_RE: /^[A-Za-z0-9_-]{11}$/,

  /**
   * 사용자가 붙여넣은 문자열에서 유튜브 영상 ID를 뽑는다.
   * 공유 시트가 "제목 + 링크" 형태로 넘기는 경우도 있어 문장 속 링크도 찾는다.
   * @returns {{ok:true, videoId:string, isShort:boolean} | {ok:false, reason:string}}
   */
  parse(raw) {
    const text = String(raw || '').trim();
    if (!text) return { ok: false, reason: 'empty' };

    // 영상 ID만 단독으로 붙여넣은 경우
    if (this.ID_RE.test(text)) return { ok: true, videoId: text, isShort: false };

    // 문장 속에서 URL 후보 추출 (스킴 없는 youtu.be/..., youtube.com/... 도 허용)
    const match =
      text.match(/https?:\/\/[^\s<>"']+/i) ||
      text.match(/(?:^|\s)((?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/[^\s<>"']*)/i);
    if (!match) return { ok: false, reason: 'not_youtube' };

    let candidate = match[1] || match[0];
    if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate.trim();

    let url;
    try {
      url = new URL(candidate);
    } catch (_) {
      return { ok: false, reason: 'not_youtube' };
    }

    const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    let id = null;
    let isShort = false;

    if (host === 'youtu.be') {
      id = url.pathname.split('/')[1] || null;
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') {
        id = url.searchParams.get('v');
      } else {
        const m = url.pathname.match(/^\/(shorts|embed|live|v|e)\/([^/?#]+)/);
        if (m) {
          id = m[2];
          isShort = m[1] === 'shorts';
        } else if (url.searchParams.get('list')) {
          return { ok: false, reason: 'playlist' };
        }
      }
    } else {
      return { ok: false, reason: 'not_youtube' };
    }

    if (!id || !this.ID_RE.test(id)) return { ok: false, reason: 'no_video' };
    return { ok: true, videoId: id, isShort };
  },

  thumb(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  },

  watchUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  },
};

// ---------------------------------------------------------------------------
// 영상 정보 조회 (3단계)
//   설계문서 v1.1은 제목=oEmbed, 길이=Data API로 나눴지만, Data API
//   videos.list(part=snippet,contentDetails) 한 번이면 제목·채널·길이가 모두 온다.
//   → 호출 수 절반, 영상 50개까지 1회 호출 = 쿼터 1단위.
//   Data API가 실패(쿼터 초과·키 문제·네트워크)하면 oEmbed로 제목·채널만 폴백하고,
//   길이는 비워둔다 → 통근시간 기능만 비활성, 나머지는 정상 (설계문서 §7).
// ---------------------------------------------------------------------------
const VideoMeta = {
  API: 'https://www.googleapis.com/youtube/v3/videos',
  OEMBED: 'https://www.youtube.com/oembed',
  BATCH: 50,
  TIMEOUT_MS: 8000,

  get apiKey() {
    return (window.LINEUP_CONFIG && window.LINEUP_CONFIG.YT_API_KEY) || '';
  },

  /** ISO 8601 기간(PT1H2M3S, P1DT2H 등) → 초. 라이브는 P0D → 0 */
  parseDuration(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
    if (!m) return null;
    const [, d = 0, h = 0, mi = 0, sec = 0] = m.map((v) => (v === undefined ? 0 : Number(v)));
    return d * 86400 + h * 3600 + mi * 60 + sec;
  },

  async fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * @param {string[]} ids
   * @returns {Promise<Map<string, object>>} videoId → 패치할 필드들
   *   찾은 영상:  {title, author, durationSec, isLive, unavailable:false, metaAt}
   *   없는 영상(삭제·비공개): {unavailable:true, metaAt}
   *   조회 실패: Map에 없음 (다음 기회에 재시도)
   */
  async lookup(ids) {
    const out = new Map();
    const unique = Array.from(new Set(ids));
    if (!unique.length) return out;

    let apiOk = false;
    if (this.apiKey) {
      try {
        for (let i = 0; i < unique.length; i += this.BATCH) {
          const chunk = unique.slice(i, i + this.BATCH);
          const url =
            `${this.API}?part=snippet,contentDetails&id=${chunk.join(',')}` +
            `&fields=${encodeURIComponent('items(id,snippet(title,channelTitle,liveBroadcastContent),contentDetails(duration))')}` +
            `&key=${encodeURIComponent(this.apiKey)}`;
          const data = await this.fetchJson(url);
          const found = new Set();
          (data.items || []).forEach((it) => {
            found.add(it.id);
            const live = it.snippet && it.snippet.liveBroadcastContent;
            const dur = this.parseDuration(it.contentDetails && it.contentDetails.duration);
            out.set(it.id, {
              title: (it.snippet && it.snippet.title) || null,
              author: (it.snippet && it.snippet.channelTitle) || null,
              durationSec: live === 'live' || live === 'upcoming' || !dur ? null : dur,
              isLive: live === 'live' || live === 'upcoming',
              unavailable: false,
              metaAt: Date.now(),
            });
          });
          chunk.filter((id) => !found.has(id)).forEach((id) => {
            out.set(id, { unavailable: true, metaAt: Date.now() });
          });
        }
        apiOk = true;
      } catch (err) {
        console.warn('[Lineup] YouTube Data API 조회 실패 → oEmbed 폴백:', err.message);
        track('meta_api_fail', { status: err.status || 0 });
      }
    }

    if (!apiOk) {
      await Promise.all(
        unique.map(async (id) => {
          try {
            const url = `${this.OEMBED}?format=json&url=${encodeURIComponent(YouTubeUrl.watchUrl(id))}`;
            const data = await this.fetchJson(url);
            // metaAt을 비워둬서, 다음에 앱을 열 때 Data API로 길이를 다시 시도한다
            out.set(id, { title: data.title || null, author: data.author_name || null, unavailable: false });
          } catch (err) {
            // 404 = 존재하지 않는 영상. (401은 "퍼가기 금지" 영상이라 유튜브에선 재생되므로 제외)
            if (err.status === 404) out.set(id, { unavailable: true });
          }
        })
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 재생 (4단계) — 설계문서 §4-1
//   Lineup은 직접 재생하지 않고 유튜브로 "넘긴다". 기본은 watch_videos 링크 하나로
//   큐 전체를 넘기는 방식. 이 주소는 유튜브 비공식 기능이라 막힐 수 있으므로
//   config.js의 PLAY_MODE를 'single'로 바꾸면 영상을 하나씩 여는 방식으로 즉시 전환된다.
// ---------------------------------------------------------------------------
const Player = {
  MAX_BATCH: 50, // watch_videos 한 번에 넘길 수 있는 안전 상한

  get mode() {
    const m = window.LINEUP_CONFIG && window.LINEUP_CONFIG.PLAY_MODE;
    return m === 'single' ? 'single' : 'batch';
  },

  batchUrl(ids) {
    return `https://www.youtube.com/watch_videos?video_ids=${ids.slice(0, this.MAX_BATCH).join(',')}`;
  },

  open(url) {
    // 새 탭/유튜브 앱으로 연다. 팝업이 막히면 현재 탭에서 이동.
    const win = window.open(url, '_blank', 'noopener');
    if (!win) window.location.href = url;
  },
};

// ---------------------------------------------------------------------------
// 실행 환경 판별 — 설치 안내를 "지금 이 폰·이 브라우저"에 맞춰 보여주기 위함
// ---------------------------------------------------------------------------
const Env = {
  IN_APPS: [
    { id: 'kakao', name: '카카오톡', re: /KAKAOTALK/i },
    { id: 'naver', name: '네이버 앱', re: /NAVER\(inapp|NAVER\//i },
    { id: 'band', name: '밴드', re: /BAND\//i },
    { id: 'instagram', name: '인스타그램', re: /Instagram/i },
    { id: 'facebook', name: '페이스북', re: /FBAN|FBAV|FB_IAB/i },
    { id: 'line', name: '라인', re: /\bLine\//i },
    { id: 'daum', name: '다음 앱', re: /DaumApps/i },
  ],

  detect() {
    const ua = navigator.userAgent || '';
    const ios = /iP(hone|od|ad)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const android = /Android/i.test(ua);
    const inApp = this.IN_APPS.find((a) => a.re.test(ua)) || null;
    let browser = 'other';
    if (/SamsungBrowser/i.test(ua)) browser = 'samsung';
    else if (/CriOS/i.test(ua)) browser = 'chrome-ios';
    else if (/FxiOS|Firefox/i.test(ua)) browser = 'firefox';
    else if (/Edg/i.test(ua)) browser = 'edge';
    else if (/Chrome/i.test(ua)) browser = 'chrome';
    else if (ios && /Safari/i.test(ua)) browser = 'safari';
    const standalone =
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
    const platform = ios ? 'ios' : android ? 'android' : 'desktop';
    return { ios, android, platform, inApp, browser, standalone };
  },

  /** 앱 안 브라우저에서 바깥 브라우저로 여는 주소 (없으면 null → 메뉴 안내로 대체)
   *  현재 주소(utm 포함)를 그대로 넘겨서, 크롬으로 옮겨가도 "카페에서 온 방문"으로 집계되게 한다 */
  externalOpenUrl(env, url) {
    if (!env.inApp) return null;
    // 카카오톡은 안드로이드·아이폰 모두 공식 "외부 브라우저로 열기" 주소를 지원
    if (env.inApp.id === 'kakao') return `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
    // 안드로이드는 크롬을 직접 지정해서 열 수 있음
    if (env.android) {
      const u = new URL(url);
      return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;end`;
    }
    return null; // 아이폰의 다른 앱들은 메뉴에서 "Safari로 열기"를 눌러야 함
  },
};

// ---------------------------------------------------------------------------
// 사용자 설정 (통근시간 등) — 큐와 별도 키로 저장
// ---------------------------------------------------------------------------
const Settings = {
  KEY: 'lineup:settings:v1',
  defaults: { commuteOn: false, commuteMin: 30 },

  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.KEY) || '{}');
      const min = Number(raw.commuteMin);
      return {
        commuteOn: !!raw.commuteOn,
        commuteMin: Number.isFinite(min) && min >= 5 && min <= 120 ? min : this.defaults.commuteMin,
      };
    } catch (_) {
      return { ...this.defaults };
    }
  },

  save(settings) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(settings));
    } catch (_) {}
  },
};

// ---------------------------------------------------------------------------
// 재생 세션 — "지금 유튜브로 넘긴 묶음". 유튜브에서 돌아왔을 때(페이지가 새로
// 열려도) "재생 중" 바와 끝내기 흐름을 보여주려고 저장해 둔다.
// ---------------------------------------------------------------------------
const SessionStore = {
  KEY: 'lineup:session:v1',
  MAX_AGE_MS: 12 * 60 * 60 * 1000, // 12시간 지난 세션은 조용히 정리

  load() {
    try {
      const s = JSON.parse(localStorage.getItem(this.KEY) || 'null');
      if (!s || !Array.isArray(s.uids) || !s.uids.length) return null;
      if (Date.now() - Number(s.startedAt) > this.MAX_AGE_MS) {
        this.clear();
        return null;
      }
      return { uids: s.uids.filter((u) => typeof u === 'string'), startedAt: Number(s.startedAt) };
    } catch (_) {
      return null;
    }
  },

  save(session) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(session));
    } catch (_) {}
  },

  clear() {
    try {
      localStorage.removeItem(this.KEY);
    } catch (_) {}
  },
};

// ---------------------------------------------------------------------------
// 큐 저장소 (localStorage) — 저장 실패해도 앱은 메모리 상태로 계속 동작
// ---------------------------------------------------------------------------
const QueueStore = {
  KEY: 'lineup:queue:v1',
  VERSION: 1,

  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : data && data.items;
      if (!Array.isArray(list)) return [];
      const seen = new Set();
      return list
        .filter((it) => it && YouTubeUrl.ID_RE.test(it.videoId) && !seen.has(it.videoId) && seen.add(it.videoId))
        .map((it) => ({
          uid: typeof it.uid === 'string' ? it.uid : QueueStore.uid(),
          videoId: it.videoId,
          isShort: !!it.isShort,
          addedAt: Number(it.addedAt) || Date.now(),
          title: typeof it.title === 'string' ? it.title : null,
          author: typeof it.author === 'string' ? it.author : null,
          durationSec: Number.isFinite(it.durationSec) ? it.durationSec : null,
          isLive: !!it.isLive,
          unavailable: !!it.unavailable,
          metaAt: Number(it.metaAt) || null, // Data API로 조회 완료한 시각 (없으면 재조회 대상)
        }));
    } catch (err) {
      console.warn('[Lineup] 저장된 큐를 읽지 못했어요:', err);
      return [];
    }
  },

  /** @returns {boolean} 저장 성공 여부 */
  save(items) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify({ v: this.VERSION, items }));
      return true;
    } catch (err) {
      console.warn('[Lineup] 큐 저장 실패:', err);
      return false;
    }
  },

  uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },
};

// ---------------------------------------------------------------------------
// 앱
// ---------------------------------------------------------------------------
const CLIP_OFFERED_KEY = 'lineup:clip-offered';

/** 통계 전송 (analytics.js가 없거나 GA4_ID가 비어 있으면 아무 일도 안 함) */
const track = (name, params) => {
  if (typeof window.lineupTrack === 'function') window.lineupTrack(name, params);
};

const ERROR_MESSAGES = {
  empty: '유튜브 링크를 붙여넣어 주세요.',
  not_youtube: '유튜브 링크가 아닌 것 같아요. 다시 확인해 주세요.',
  playlist: '재생목록 링크는 아직 못 담아요. 영상 하나의 링크를 넣어주세요.',
  no_video: '영상 주소를 찾지 못했어요. 영상 페이지의 링크를 복사해 주세요.',
};

const ICONS = {
  grip: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M9 6.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm0 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-1.5 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM18 6.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM16.5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm1.5 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="m6 15 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>',
};

const LineupApp = {
  els: {},
  items: [],
  storageOk: true,
  drag: null,
  toastTimer: null,
  undoSnapshot: null,
  loadingIds: new Set(), // 지금 정보 조회 중인 videoId (저장 안 함)
  metaDirty: false, // 드래그 중에 정보가 도착해 렌더를 미뤘는지
  clip: null, // 클립보드 제안 상태 {text, videoId}
  settings: null,
  plan: null, // 현재 재생 계획 (통근시간 반영) — render() 때마다 다시 계산
  installPrompt: null,
  session: null, // 재생 중인 묶음 {uids, startedAt}
  endSel: 0, // 끝내기 시트에서 "여기까지 봤어요"로 고른 개수

  init() {
    this.cacheEls();
    this.registerServiceWorker();
    this.consumeShareTarget();

    this.items = QueueStore.load();
    this.settings = Settings.load();
    this.session = SessionStore.load();
    this.render();

    this.wireAddForm();
    this.wireQueueList();
    this.wireCommuteSlider();
    this.wireClearAll();
    this.wireToast();
    this.wireStorageSync();
    this.wireClipboard();
    this.wirePlay();
    this.wireInstall();
    this.processPendingShare();

    this.fetchMissingMeta();
    window.addEventListener('online', () => this.fetchMissingMeta());

  },

  cacheEls() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      addForm: $('form-add-url'),
      urlInput: $('input-url'),
      addError: $('add-error'),
      clipSuggest: $('clip-suggest'),
      clipThumb: $('clip-suggest-thumb'),
      clipTitle: $('clip-suggest-title'),
      clipAddBtn: $('btn-clip-add'),
      clipCloseBtn: $('btn-clip-close'),
      pasteBtn: $('btn-paste'),
      queueTotal: $('queue-total'),
      commuteSlider: $('commute-slider'),
      commuteValue: $('commute-value'),
      commutePanel: $('commute-panel'),
      commuteToggle: $('commute-toggle'),
      commuteBody: $('commute-body'),
      commuteSummary: $('commute-summary'),
      playMeta: $('play-meta'),
      playSheet: $('play-sheet'),
      playSheetTitle: $('play-sheet-title'),
      playSheetDesc: $('play-sheet-desc'),
      playSheetList: $('play-sheet-list'),
      playAgainBtn: $('btn-play-again'),
      installBtn: $('btn-install'),
      installSheet: $('install-sheet'),
      installSheetTitle: $('install-sheet-title'),
      installSheetDesc: $('install-sheet-desc'),
      installSheetBody: $('install-sheet-body'),
      installPrimaryBtn: $('btn-install-primary'),
      inappBanner: $('inapp-banner'),
      inappName: $('inapp-name'),
      inappTarget: $('inapp-target'),
      inappOpenBtn: $('btn-inapp-open'),
      inappCloseBtn: $('btn-inapp-close'),
      sessionBar: $('session-bar'),
      sessionMeta: $('session-meta'),
      sessionListBtn: $('btn-session-list'),
      sessionEndBtn: $('btn-session-end'),
      sessionNextBtn: $('btn-session-next'),
      endSheetTitle: $('end-sheet-title'),
      endSheetDesc: $('end-sheet-desc'),
      endSheet: $('end-sheet'),
      endSheetList: $('end-sheet-list'),
      endConfirmBtn: $('btn-end-confirm'),
      queueHead: $('queue-head'),
      queueCount: $('queue-count'),
      queueList: $('queue-list'),
      queueEmpty: $('queue-empty'),
      playBtn: $('btn-play-queue'),
      clearAllBtn: $('btn-clear-all'),
      toast: $('toast'),
      toastMsg: $('toast-msg'),
      toastAction: $('toast-action'),
      srStatus: $('sr-status'),
    };
  },

  // --- PWA: Service Worker ---------------------------------------------
  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    // 새 버전이 배포되면(새 서비스워커가 자리를 잡으면) 한 번만 자동 새로고침해서
    // "두 번 새로고침해야 새 버전이 보이는" 문제를 없앤다. 첫 설치 때는 새로고침 안 함.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded || this.drag) return;
      reloaded = true;
      window.location.reload();
    });

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch((err) => {
        console.warn('[Lineup] service worker 등록 실패:', err);
      });
    });
  },

  // --- 안드로이드 공유 연동(Web Share Target, GET 방식) 수신부 ----------
  consumeShareTarget() {
    const params = new URLSearchParams(window.location.search);
    const sharedUrl = params.get('share_url') || params.get('share_text') || '';

    if (sharedUrl) {
      // 제목과 링크가 따로 오기도, text 안에 섞여 오기도 해서 둘 다 합쳐 보관
      const combined = [params.get('share_url'), params.get('share_text')].filter(Boolean).join(' ');
      try {
        sessionStorage.setItem('lineup_pending_share', combined || sharedUrl);
      } catch (_) {}
    }

    if (params.has('share_title') || params.has('share_text') || params.has('share_url')) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  },

  /** 안드로이드 공유 시트로 들어온 링크를 큐에 담는다 */
  processPendingShare() {
    let text = null;
    try {
      text = sessionStorage.getItem('lineup_pending_share');
      sessionStorage.removeItem('lineup_pending_share');
    } catch (_) {}
    if (!text) return;

    const result = this.addFromText(text, 'share');
    if (result.ok) {
      const where = result.asNext ? '다음 순서로' : `${result.index + 1}번째로`;
      this.showToast(`${where} 담았어요 · 뒤로 가기를 누르면 유튜브로 돌아가요`, { duration: 4500 });
      this.flashItem(result.uid);
    } else if (result.reason === 'duplicate') {
      this.showToast(`이미 ${result.index + 1}번째에 있는 영상이에요`, { duration: 3500 });
      this.flashItem(this.items[result.index].uid);
    } else {
      this.showToast('공유된 내용에서 유튜브 영상 링크를 찾지 못했어요.', { duration: 3500 });
    }
  },

  // =====================================================================
  // 상태 변경 (모든 변경은 commit()을 거쳐 저장 + 렌더링)
  // =====================================================================
  commit({ keepToast = false } = {}) {
    const ok = QueueStore.save(this.items);
    if (!ok && this.storageOk) {
      this.storageOk = false;
      this.showToast('이 브라우저에선 큐를 저장할 수 없어요. 창을 닫으면 사라질 수 있어요.');
      keepToast = true;
    }
    if (!keepToast) this.hideToast();
    this.render();
  },

  /**
   * @param {string} text
   * @param {'input'|'paste'|'clip_button'|'clip_suggest'|'share'} method  통계용: 어떤 경로로 담았는지
   * @returns {{ok:boolean, reason?:string, index?:number}}
   */
  addFromText(text, method = 'input') {
    const parsed = YouTubeUrl.parse(text);
    if (!parsed.ok) {
      track('video_add_fail', { method, reason: parsed.reason });
      return parsed;
    }

    const existing = this.items.findIndex((it) => it.videoId === parsed.videoId);
    if (existing !== -1) {
      track('video_add_fail', { method, reason: 'duplicate' });
      return { ok: false, reason: 'duplicate', index: existing };
    }

    const item = {
      uid: QueueStore.uid(),
      videoId: parsed.videoId,
      isShort: parsed.isShort,
      addedAt: Date.now(),
      title: null,
      author: null,
      durationSec: null,
      isLive: false,
      unavailable: false,
      metaAt: null,
    };
    // 재생 중(유튜브로 넘긴 뒤)에 담으면 "다음 순서"로 맨 앞에 끼워 넣는다.
    // → 지금 영상 다 보고 "다음 재생" 한 번이면 이 영상부터 이어서 재생 (v1 끼워넣기)
    const asNext = this.sessionItems().length > 0;
    if (asNext) this.items.unshift(item);
    else this.items.push(item);
    this.loadingIds.add(item.videoId);
    this.commit();
    this.fetchMeta([item.videoId]);
    const index = asNext ? 0 : this.items.length - 1;
    track('video_add', { method, as_next: asNext, is_short: parsed.isShort, queue_size: this.items.length });
    return { ok: true, index, uid: item.uid, asNext };
  },

  removeItem(uid) {
    const idx = this.items.findIndex((it) => it.uid === uid);
    if (idx === -1) return;
    const snapshot = this.items.slice();
    this.items.splice(idx, 1);
    this.commit({ keepToast: true });
    this.offerUndo(snapshot, '큐에서 뺐어요');
    track('video_remove', { queue_size: this.items.length });
    this.announce(`${idx + 1}번째 영상을 삭제했어요.`);

    // 삭제 후 포커스를 이웃 항목으로 옮겨 키보드 흐름이 끊기지 않게 함
    const next = this.items[idx] || this.items[idx - 1];
    if (next) this.focusItemControl(next.uid, '.queue-item__remove');
    else this.els.urlInput.focus();
  },

  clearAll() {
    if (!this.items.length) return;
    const snapshot = this.items.slice();
    this.items = [];
    this.commit({ keepToast: true });
    this.offerUndo(snapshot, `${snapshot.length}개 영상을 모두 비웠어요`);
    track('queue_clear', { count: snapshot.length });
    this.announce('큐를 모두 비웠어요.');
  },

  moveItem(uid, delta) {
    const from = this.items.findIndex((it) => it.uid === uid);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= this.items.length) return false;
    const [item] = this.items.splice(from, 1);
    this.items.splice(to, 0, item);
    this.commit();
    this.announce(`${to + 1}번째로 옮겼어요.`);
    return true;
  },

  applyOrder(uids) {
    const byUid = new Map(this.items.map((it) => [it.uid, it]));
    const next = uids.map((u) => byUid.get(u)).filter(Boolean);
    if (next.length !== this.items.length) return;
    const changed = next.some((it, i) => it !== this.items[i]);
    if (!changed) return;
    this.items = next;
    this.commit();
  },

  // =====================================================================
  // 영상 정보(제목·채널·길이) 채우기
  // =====================================================================
  fetchMissingMeta() {
    const ids = this.items.filter((it) => !it.metaAt && !it.unavailable).map((it) => it.videoId);
    if (ids.length) this.fetchMeta(ids);
  },

  async fetchMeta(ids) {
    ids = ids.filter((id) => !this.pendingFetch || !this.pendingFetch.has(id));
    if (!ids.length) return;
    this.pendingFetch = this.pendingFetch || new Set();
    ids.forEach((id) => {
      this.pendingFetch.add(id);
      this.loadingIds.add(id);
    });
    if (!this.drag) this.render();

    let results = new Map();
    try {
      results = await VideoMeta.lookup(ids);
    } finally {
      ids.forEach((id) => {
        this.pendingFetch.delete(id);
        this.loadingIds.delete(id);
      });
    }

    // 조회하는 사이 큐가 바뀌었을 수 있으므로 videoId로 다시 찾아서 덮어쓴다
    this.items.forEach((it) => {
      const patch = results.get(it.videoId);
      if (patch) Object.assign(it, patch);
    });
    QueueStore.save(this.items);
    if (this.drag) this.metaDirty = true;
    else this.render();
  },

  // =====================================================================
  // 렌더링
  // =====================================================================
  render() {
    const { queueList, queueEmpty, queueHead, queueCount, clearAllBtn, playBtn } = this.els;
    const count = this.items.length;

    queueEmpty.hidden = count > 0;
    queueHead.hidden = count === 0;
    clearAllBtn.hidden = count === 0;
    queueCount.textContent = `${count}개`;

    // 총 재생시간: 길이를 아는 영상만 합산, 모르는 게 섞여 있으면 "+" 표시
    const known = this.items.filter((it) => it.durationSec != null);
    const total = known.reduce((sum, it) => sum + it.durationSec, 0);
    const partial = known.length < this.items.filter((it) => !it.unavailable).length;
    this.els.queueTotal.hidden = known.length === 0;
    this.els.queueTotal.textContent = known.length ? `총 ${this.formatTotal(total)}${partial ? '+' : ''}` : '';

    // 재생 계획 (통근시간 반영) → 버튼·요약·흐리게 표시에 공통으로 사용
    this.plan = this.computePlan();
    this.renderCommute(known.length > 0);
    const n = this.plan.included.length;
    playBtn.disabled = n === 0;

    // 재생 중이면 "재생 시작" 자리에 상태 바(목록/끝)를 대신 보여준다
    const sessionItems = this.sessionItems();
    const playingUids = new Set(sessionItems.map((it) => it.uid));
    playBtn.hidden = sessionItems.length > 0;
    this.els.sessionBar.hidden = sessionItems.length === 0;
    const pending = this.pendingNext();
    const pendingUids = new Set(pending.map((it) => it.uid));
    if (sessionItems.length) {
      const sec = sessionItems.reduce((sum, it) => sum + (it.durationSec || 0), 0);
      this.els.sessionMeta.textContent = pending.length
        ? `새로 담은 ${pending.length}개가 다음 차례예요`
        : `${sessionItems.length}개${sec ? ' · ' + this.formatTotal(sec) : ''} · 다 보면 "끝"`;
    }
    // 끼워넣은 영상이 있으면 "목록" 대신 "다음 재생"을 보여준다
    this.els.sessionListBtn.hidden = pending.length > 0;
    this.els.sessionNextBtn.hidden = pending.length === 0;
    const playSec = this.plan.included.reduce((sum, it) => sum + (it.durationSec || 0), 0);
    this.els.playMeta.textContent = n
      ? `${n}개${playSec ? ' · ' + this.formatTotal(playSec) : ''}${this.plan.unknownCount && playSec ? '+' : ''}`
      : '';

    const frag = document.createDocumentFragment();
    this.items.forEach((item, i) => {
      const li = this.renderItem(item, i, count);
      if (this.plan.trimmed.has(item.uid)) li.classList.add('is-trimmed');
      if (playingUids.has(item.uid)) li.classList.add('is-playing');
      if (pendingUids.has(item.uid)) li.classList.add('is-next');
      frag.appendChild(li);
    });
    queueList.replaceChildren(frag);
  },

  renderItem(item, index, total) {
    const li = document.createElement('li');
    li.className = 'queue-item';
    li.dataset.uid = item.uid;

    const loading = this.loadingIds.has(item.videoId) && !item.title;
    let title = item.title || `youtu.be/${item.videoId}`;
    const metaParts = [];
    if (item.unavailable) {
      if (!item.title) title = '재생할 수 없는 영상';
      metaParts.push('삭제·비공개 영상');
      li.classList.add('is-unavailable');
    } else if (loading) {
      title = '영상 정보 불러오는 중…';
      li.classList.add('is-loading');
    } else {
      if (item.author) metaParts.push(item.author);
      if (item.isShort) metaParts.push('Shorts');
      if (item.isLive) metaParts.push('라이브');
      if (!metaParts.length) metaParts.push('YouTube');
    }
    const durationText = item.durationSec != null && !item.unavailable ? this.formatDuration(item.durationSec) : '';

    li.innerHTML = `
      <button type="button" class="queue-item__handle" data-action="drag"
        aria-label="${index + 1}번째 영상 순서 바꾸기 (드래그하거나 위/아래 방향키)">${ICONS.grip}</button>
      <div class="queue-item__thumb-wrap">
        <img class="queue-item__thumb" alt="" loading="lazy" decoding="async" width="72" height="40">
        <span class="queue-item__index" aria-hidden="true"></span>
        <span class="queue-item__time" aria-hidden="true"></span>
      </div>
      <div class="queue-item__meta">
        <p class="queue-item__title"></p>
        <p class="queue-item__duration"></p>
      </div>
      <div class="queue-item__move">
        <button type="button" class="queue-item__move-btn" data-action="up" aria-label="위로 올리기">${ICONS.up}</button>
        <button type="button" class="queue-item__move-btn" data-action="down" aria-label="아래로 내리기">${ICONS.down}</button>
      </div>
      <button type="button" class="queue-item__remove" data-action="remove" aria-label="${index + 1}번째 영상 삭제">${ICONS.close}</button>
    `;

    const img = li.querySelector('.queue-item__thumb');
    img.src = YouTubeUrl.thumb(item.videoId);
    img.addEventListener('error', () => img.classList.add('is-broken'), { once: true });

    li.querySelector('.queue-item__index').textContent = index + 1;
    const titleEl = li.querySelector('.queue-item__title');
    titleEl.textContent = title;
    titleEl.title = title;
    li.querySelector('.queue-item__duration').textContent = metaParts.join(' · ');
    const timeBadge = li.querySelector('.queue-item__time');
    timeBadge.textContent = durationText;
    timeBadge.hidden = !durationText;
    if (durationText) li.querySelector('.queue-item__meta').setAttribute('aria-label', `${title}, ${metaParts.join(', ')}, 길이 ${durationText}`);

    li.querySelector('[data-action="up"]').disabled = index === 0;
    li.querySelector('[data-action="down"]').disabled = index === total - 1;
    return li;
  },

  formatDuration(sec) {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  },

  // =====================================================================
  // 통근시간 맞춤 (설계문서 §4-3)
  //   큐 순서대로 길이를 더해가다 이동시간을 넘는 지점부터 뒤는 전부 "이번엔 제외"
  //   (순서가 핵심인 서비스라, 뒤쪽의 짧은 영상을 끼워 넣는 식으로 건너뛰지 않는다)
  //   - 길이 모르는 영상(라이브 등)은 계산에서 빼고 포함, 요약에 따로 알림
  //   - 첫 영상 하나만으로 이동시간을 넘으면 그 영상 하나는 재생(아무것도 안 트는 것보다 낫다)
  //   - 재생 불가 영상은 항상 제외
  // =====================================================================
  computePlan() {
    const playable = this.items.filter((it) => !it.unavailable);
    const plan = { included: [], trimmed: new Set(), usedSec: 0, unknownCount: 0, overLong: false, active: false };
    const hasDurations = playable.some((it) => it.durationSec != null);

    if (!this.settings.commuteOn || !hasDurations) {
      plan.included = playable;
      plan.unknownCount = playable.filter((it) => it.durationSec == null).length;
      return plan;
    }

    plan.active = true;
    const limit = this.settings.commuteMin * 60;
    let cut = false;
    for (const it of playable) {
      if (cut) {
        plan.trimmed.add(it.uid);
      } else if (it.durationSec == null) {
        plan.included.push(it);
        plan.unknownCount++;
      } else if (plan.usedSec + it.durationSec <= limit) {
        plan.included.push(it);
        plan.usedSec += it.durationSec;
      } else if (!plan.included.some((x) => x.durationSec != null)) {
        plan.included.push(it);
        plan.usedSec += it.durationSec;
        plan.overLong = true;
        cut = true;
      } else {
        cut = true;
        plan.trimmed.add(it.uid);
      }
    }
    return plan;
  },

  renderCommute(hasDurations) {
    const { commutePanel, commuteToggle, commuteBody, commuteSlider, commuteValue, commuteSummary } = this.els;
    // 길이 정보가 하나도 없으면(아직 조회 전·API 실패) 통근시간 기능 자체를 숨김 (설계문서 §7)
    commutePanel.hidden = !hasDurations;
    if (!hasDurations) return;

    const on = this.settings.commuteOn;
    commuteToggle.checked = on;
    commuteBody.hidden = !on;
    commuteValue.hidden = !on;
    commuteSlider.value = this.settings.commuteMin;
    commuteValue.textContent = this.formatTotal(this.settings.commuteMin * 60);
    this.paintSlider();
    if (!on) return;

    const p = this.plan;
    const left = this.settings.commuteMin * 60 - p.usedSec;
    let text = `${p.included.length}개 · ${this.formatTotal(p.usedSec)} 재생`;
    if (p.overLong) text = `첫 영상이 이동시간보다 길어서 1개만 재생해요 (${this.formatTotal(p.usedSec)})`;
    else if (p.trimmed.size) text += ` · 뒤의 ${p.trimmed.size}개는 다음 이동 때`;
    else if (left >= 60) text += ` · ${this.formatTotal(left)} 남아요`;
    if (p.unknownCount) text += ` · 길이 모르는 영상 ${p.unknownCount}개 포함`;
    commuteSummary.textContent = text;
  },

  /** 슬라이더 채워진 부분을 브랜드 레드로 (크로스브라우저) */
  paintSlider() {
    const el = this.els.commuteSlider;
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--fill', `${pct}%`);
  },

  /** 총 재생시간: 38분 / 1시간 12분 */
  formatTotal(sec) {
    const min = Math.max(1, Math.round(sec / 60));
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return `${m}분`;
    return m ? `${h}시간 ${m}분` : `${h}시간`;
  },

  focusItemControl(uid, selector) {
    const li = this.els.queueList.querySelector(`[data-uid="${uid}"]`);
    const el = li && li.querySelector(selector);
    if (el && !el.disabled) el.focus({ preventScroll: false });
    else if (li) li.querySelector('.queue-item__handle').focus();
  },

  flashItem(uid) {
    const li = this.els.queueList.querySelector(`[data-uid="${uid}"]`);
    if (!li) return;
    li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    li.classList.remove('is-flash');
    void li.offsetWidth; // 애니메이션 재시작
    li.classList.add('is-flash');
  },

  // =====================================================================
  // 이벤트 배선
  // =====================================================================
  wireAddForm() {
    const { addForm, urlInput, addError } = this.els;

    const clearError = () => {
      addError.hidden = true;
      addError.textContent = '';
      urlInput.removeAttribute('aria-invalid');
    };

    urlInput.addEventListener('input', clearError);

    // 입력창에 유튜브 링크를 "붙여넣는 순간" 바로 담는다 ("담기" 버튼 생략).
    // 클립보드 읽기 권한과 무관하게 모든 브라우저에서 동작하는 가장 확실한 경로.
    urlInput.addEventListener('paste', (e) => {
      const text = e.clipboardData && e.clipboardData.getData('text');
      if (!text || urlInput.value.trim()) return; // 이미 뭔가 입력 중이면 평소대로
      if (!YouTubeUrl.parse(text).ok) return; // 유튜브 링크가 아니면 평소대로 붙여넣기
      e.preventDefault();
      this.hideClipSuggestion();
      this.handleAddResult(this.addFromText(text, 'paste'));
      urlInput.blur(); // 모바일 키보드를 내려 담긴 목록이 보이게
    });

    this.clearAddError = clearError;

    addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleAddResult(this.addFromText(urlInput.value, 'input'));
    });
  },

  /** 입력창·붙여넣기 버튼·클립보드 제안이 공통으로 쓰는 결과 처리 */
  handleAddResult(result) {
    const { urlInput, addError } = this.els;

    if (result.ok) {
      this.clearAddError();
      urlInput.value = '';
      const where = result.asNext ? '다음 순서로' : `${result.index + 1}번째로`;
      this.showToast(`${where} 담았어요`);
      this.announce(`${where} 담았어요.`);
      this.flashItem(result.uid);
      return;
    }

    if (result.reason === 'duplicate') {
      this.clearAddError();
      urlInput.value = '';
      const dup = this.items[result.index];
      this.showToast(`이미 ${result.index + 1}번째에 있는 영상이에요`);
      this.flashItem(dup.uid);
      return;
    }

    addError.textContent = ERROR_MESSAGES[result.reason] || ERROR_MESSAGES.not_youtube;
    addError.hidden = false;
    urlInput.setAttribute('aria-invalid', 'true');
    urlInput.focus();
  },

  wireQueueList() {
    const list = this.els.queueList;

    list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || this.drag) return;
      const uid = btn.closest('.queue-item').dataset.uid;
      const action = btn.dataset.action;

      if (action === 'remove') this.removeItem(uid);
      if (action === 'up' || action === 'down') {
        const moved = this.moveItem(uid, action === 'up' ? -1 : 1);
        if (moved) {
          this.focusItemControl(uid, `[data-action="${action}"]`);
          track('queue_reorder', { method: 'button' });
        }
      }
    });

    // 핸들에 포커스된 상태에서 방향키로 순서 변경 (키보드·스크린리더 대응)
    list.addEventListener('keydown', (e) => {
      const handle = e.target.closest('.queue-item__handle');
      if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const uid = handle.closest('.queue-item').dataset.uid;
      if (this.moveItem(uid, e.key === 'ArrowUp' ? -1 : 1)) {
        this.focusItemControl(uid, '.queue-item__handle');
      }
    });

    this.wireDragSort();
  },

  // --- 드래그 정렬: 핸들을 잡고 끌기 (터치·마우스·펜 공통 Pointer Events) --
  // 핸들 영역만 touch-action:none 이라, 목록의 나머지 부분은 평소처럼 스크롤된다.
  wireDragSort() {
    const list = this.els.queueList;
    const EDGE = 80; // 화면 가장자리 자동 스크롤 감지 폭(px)

    const update = () => {
      const d = this.drag;
      if (!d) return;
      const pageY = d.clientY + window.scrollY;
      const maxTop = list.offsetHeight - d.li.offsetHeight;
      const desiredTop = Math.max(0, Math.min(maxTop, d.startTop + (pageY - d.startPageY)));

      // 주의: 끌고 있는 li 자체를 DOM에서 옮기면 브라우저가 pointer capture를
      // 해제해버린다(마우스에서 드래그가 즉시 끊김). 그래서 항상 "이웃"을 옮긴다.
      let prev = d.li.previousElementSibling;
      while (prev && desiredTop < prev.offsetTop + prev.offsetHeight / 2) {
        list.insertBefore(prev, d.li.nextElementSibling);
        prev = d.li.previousElementSibling;
      }
      let next = d.li.nextElementSibling;
      while (next && desiredTop + d.li.offsetHeight > next.offsetTop + next.offsetHeight / 2) {
        list.insertBefore(next, d.li);
        next = d.li.nextElementSibling;
      }
      d.li.style.transform = `translateY(${desiredTop - d.li.offsetTop}px)`;
      this.refreshIndexBadges();
    };

    const autoScroll = () => {
      const d = this.drag;
      if (!d) return;
      const footerH = document.querySelector('.app-footer')?.offsetHeight || 0;
      let dy = 0;
      if (d.clientY < EDGE) dy = -Math.ceil((EDGE - d.clientY) / 6);
      else if (d.clientY > window.innerHeight - footerH - EDGE) {
        dy = Math.ceil((d.clientY - (window.innerHeight - footerH - EDGE)) / 6);
      }
      if (dy) {
        window.scrollBy(0, dy);
        update();
      }
      d.raf = requestAnimationFrame(autoScroll);
    };

    const finish = (commitOrder) => {
      const d = this.drag;
      if (!d) return;
      cancelAnimationFrame(d.raf);
      d.li.style.transform = '';
      d.li.classList.remove('is-dragging');
      list.classList.remove('is-sorting');
      document.body.classList.remove('is-sorting');
      const uid = d.li.dataset.uid;
      const order = Array.from(list.children, (el) => el.dataset.uid);
      this.drag = null;
      if (this.metaDirty) {
        this.metaDirty = false;
        this.render();
      }
      if (commitOrder) {
        const before = this.items.findIndex((it) => it.uid === uid);
        this.applyOrder(order);
        const after = this.items.findIndex((it) => it.uid === uid);
        if (before !== after) {
          this.announce(`${after + 1}번째로 옮겼어요.`);
          track('queue_reorder', { method: 'drag' });
        }
      } else {
        this.render();
      }
      // 포인터 드래그 후에는 포커스를 옮기지 않는다(마우스 사용 시 불필요한 포커스 링 방지)
    };

    list.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.queue-item__handle');
      if (!handle || this.drag) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();

      const li = handle.closest('.queue-item');
      handle.setPointerCapture(e.pointerId);
      this.drag = {
        li,
        handle,
        pointerId: e.pointerId,
        startTop: li.offsetTop,
        startPageY: e.clientY + window.scrollY,
        clientY: e.clientY,
        raf: 0,
      };
      this.hideToast();
      li.classList.add('is-dragging');
      list.classList.add('is-sorting');
      document.body.classList.add('is-sorting');
      if (navigator.vibrate) navigator.vibrate(8);
      this.drag.raf = requestAnimationFrame(autoScroll);
    });

    list.addEventListener('pointermove', (e) => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      this.drag.clientY = e.clientY;
      update();
    });

    list.addEventListener('pointerup', (e) => {
      if (this.drag && e.pointerId === this.drag.pointerId) finish(true);
    });
    list.addEventListener('pointercancel', (e) => {
      if (this.drag && e.pointerId === this.drag.pointerId) finish(false);
    });
    list.addEventListener('lostpointercapture', (e) => {
      if (this.drag && e.pointerId === this.drag.pointerId) finish(true);
    });
  },

  /** 드래그 도중 DOM 순서가 바뀌면 번호 배지만 즉시 갱신 (전체 렌더 없이) */
  refreshIndexBadges() {
    Array.from(this.els.queueList.children).forEach((li, i) => {
      const badge = li.querySelector('.queue-item__index');
      if (badge) badge.textContent = i + 1;
    });
  },

  // --- 통근시간 슬라이더 (표시만, 계산은 4단계) --------------------------
  wireCommuteSlider() {
    const { commuteSlider, commuteToggle } = this.els;
    commuteToggle.addEventListener('change', () => {
      this.settings.commuteOn = commuteToggle.checked;
      Settings.save(this.settings);
      this.render();
      track('commute_toggle', { on: this.settings.commuteOn, minutes: this.settings.commuteMin });
    });
    // 드래그 중엔 input이 계속 오므로, 손을 뗀 시점(change)에만 기록
    commuteSlider.addEventListener('change', () => {
      track('commute_set', { minutes: this.settings.commuteMin });
    });
    commuteSlider.addEventListener('input', () => {
      this.settings.commuteMin = Number(commuteSlider.value);
      Settings.save(this.settings);
      this.render();
    });
  },

  // =====================================================================
  // 재생
  // =====================================================================
  wirePlay() {
    const { playBtn, playSheet, playAgainBtn } = this.els;
    const { sessionListBtn, sessionEndBtn, endSheet, endSheetList, endConfirmBtn } = this.els;
    playBtn.addEventListener('click', () => this.play());
    playAgainBtn.addEventListener('click', () => {
      this.closeSheet(playSheet);
      this.replaySession();
    });
    sessionListBtn.addEventListener('click', () => {
      this.openPlaySheet(this.sessionItems(), Player.mode);
      track('play_list_open');
    });
    sessionEndBtn.addEventListener('click', () => this.openEndSheet('end'));
    this.els.sessionNextBtn.addEventListener('click', () => this.openEndSheet('next'));
    endConfirmBtn.addEventListener('click', () => this.finishSession());
    endSheetList.addEventListener('click', (e) => {
      const btn = e.target.closest('.sheet__pick');
      if (!btn) return;
      const n = Number(btn.dataset.n);
      // 이미 여기까지 골라져 있으면 한 칸 뒤로(= 이 영상은 안 봤음)
      this.endSel = this.endSel === n ? n - 1 : n;
      this.paintEndSheet();
    });
    [playSheet, endSheet].forEach((sheet) =>
      sheet.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) this.closeSheet(sheet);
      })
    );
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!playSheet.hidden) this.closeSheet(playSheet);
      if (!endSheet.hidden) this.closeSheet(endSheet);
      if (!this.els.installSheet.hidden) this.closeSheet(this.els.installSheet);
    });
  },

  /** 세션에 담긴 영상 중 아직 큐에 남아 있는 것 (큐 순서대로). 없으면 세션 정리 */
  sessionItems() {
    if (!this.session) return [];
    const set = new Set(this.session.uids);
    const list = this.items.filter((it) => set.has(it.uid));
    if (!list.length) {
      this.session = null;
      SessionStore.clear();
    }
    return list;
  },

  /** 재생 중에 새로 담아서 "다음 차례"를 기다리는 영상들 */
  pendingNext() {
    if (!this.session) return [];
    const inSession = new Set(this.session.uids);
    return this.items.filter((it) => !inSession.has(it.uid) && it.addedAt > this.session.startedAt);
  },

  /**
   * 재생 시작 후 흐른 시간과 영상 길이로 "지금 몇 번째를 보고 있을지" 추정.
   * 끼워넣기 시트의 기본 선택값(= 지금 보던 영상까지)으로 쓴다. 틀리면 사용자가 고친다.
   */
  estimateWatching(list) {
    let elapsed = (Date.now() - this.session.startedAt) / 1000;
    for (let i = 0; i < list.length; i++) {
      const d = list[i].durationSec;
      if (d == null) return i + 1;
      if (elapsed < d) return i + 1;
      elapsed -= d;
    }
    return list.length;
  },

  play() {
    const list = this.plan ? this.plan.included.slice(0, Player.MAX_BATCH) : [];
    if (!list.length) return;

    this.session = { uids: list.map((it) => it.uid), startedAt: Date.now() };
    SessionStore.save(this.session);
    const sec = list.reduce((sum, it) => sum + (it.durationSec || 0), 0);
    track('play_start', {
      count: list.length,
      minutes: Math.round(sec / 60),
      commute_on: !!this.plan.active,
      trimmed: this.plan.trimmed.size,
      mode: Player.mode,
    });
    this.render();

    if (this.plan.included.length > Player.MAX_BATCH) {
      this.showToast(`한 번에 ${Player.MAX_BATCH}개까지만 넘길 수 있어서 앞의 ${Player.MAX_BATCH}개만 재생해요`, { duration: 4000 });
    }
    this.openInYouTube(list);
  },

  replaySession() {
    const list = this.sessionItems();
    track('play_replay', { count: list.length });
    if (list.length) this.openInYouTube(list);
  },

  openInYouTube(list) {
    if (Player.mode === 'batch') {
      Player.open(Player.batchUrl(list.map((it) => it.videoId)));
    } else {
      Player.open(YouTubeUrl.watchUrl(list[0].videoId));
      this.openPlaySheet(list, 'single', 0);
    }
  },

  // --- 끝내기: 어디까지 봤는지 고르고, 본 영상은 큐에서 정리 -------------
  openEndSheet(mode = 'end') {
    const list = this.sessionItems();
    if (!list.length) return this.render();
    this.endMode = mode;
    if (mode === 'next') {
      this.els.endSheetTitle.textContent = '지금 보던 영상까지 체크해 주세요';
      this.els.endSheetDesc.textContent = '체크한 영상은 큐에서 빼고, 새로 담은 영상부터 이어서 재생해요. 나머지는 그 뒤로 그대로 이어져요.';
      this.endSel = this.estimateWatching(list); // 기본값: 시간으로 추정한 "지금 보던 영상"까지
    } else {
      this.els.endSheetTitle.textContent = '어디까지 보셨어요?';
      this.els.endSheetDesc.textContent = '다 본 영상까지 눌러주세요. 그 영상들은 큐에서 빼고, 나머지는 다음 이동 때 그대로 남아요.';
      this.endSel = list.length; // 기본값: 전부 봤음
    }
    const frag = document.createDocumentFragment();
    list.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'sheet__item';
      li.innerHTML = `
        <button type="button" class="sheet__pick" data-n="${i + 1}">
          <span class="sheet__check" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="m5 12 5 5 9-10"/></svg></span>
          <span class="sheet__num"></span><span class="sheet__name"></span><span class="sheet__time"></span>
        </button>`;
      li.querySelector('.sheet__num').textContent = i + 1;
      li.querySelector('.sheet__name').textContent = it.title || `youtu.be/${it.videoId}`;
      li.querySelector('.sheet__time').textContent = it.durationSec != null ? this.formatDuration(it.durationSec) : '';
      frag.appendChild(li);
    });
    this.els.endSheetList.replaceChildren(frag);
    this.paintEndSheet();
    this.openSheet(this.els.endSheet);
  },

  paintEndSheet() {
    const rows = Array.from(this.els.endSheetList.children);
    rows.forEach((li, i) => {
      const on = i < this.endSel;
      li.classList.toggle('is-selected', on);
      li.querySelector('.sheet__pick').setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (this.endMode === 'next') {
      this.els.endConfirmBtn.textContent = this.endSel ? `${this.endSel}개 빼고 다음 재생` : '새 영상부터 재생';
    } else {
      this.els.endConfirmBtn.textContent = this.endSel
        ? `${this.endSel}개 다 봤어요 · 큐에서 빼기`
        : '큐는 그대로 두고 끝내기';
    }
  },

  finishSession() {
    const all = this.sessionItems();
    const watched = all.slice(0, this.endSel).map((it) => it.uid);
    const next = this.endMode === 'next';
    const minutesSinceStart = this.session ? Math.round((Date.now() - this.session.startedAt) / 60000) : 0;
    track(next ? 'play_next' : 'session_end', {
      watched: watched.length,
      total: all.length,
      pending: this.pendingNext().length,
      minutes_since_start: minutesSinceStart,
    });
    this.session = null;
    SessionStore.clear();
    this.closeSheet(this.els.endSheet);

    if (next) {
      // 본 영상 빼고 → 끼워넣은 영상이 맨 앞인 상태로 바로 다시 재생
      const gone = new Set(watched);
      this.items = this.items.filter((it) => !gone.has(it.uid));
      this.commit();
      this.play();
      return;
    }

    if (!watched.length) {
      this.commit();
      this.showToast('재생을 끝냈어요. 큐는 그대로예요');
      return;
    }
    const snapshot = this.items.slice();
    const gone = new Set(watched);
    this.items = this.items.filter((it) => !gone.has(it.uid));
    this.commit({ keepToast: true });
    this.offerUndo(snapshot, `다 본 ${watched.length}개를 큐에서 뺐어요`);
  },

  /**
   * 유튜브에서 돌아왔을 때 보이는 시트.
   *   batch  — "순서대로 안 나오면 하나씩 열 수 있어요" (폴백 안내)
   *   single — 하나씩 열기 모드 본체
   */
  openPlaySheet(list, mode, openedIndex = -1) {
    const { playSheet, playSheetTitle, playSheetDesc, playSheetList, playAgainBtn } = this.els;
    playSheetTitle.textContent = mode === 'batch' ? '재생 중인 목록' : '하나씩 재생하기';
    playSheetDesc.textContent =
      mode === 'batch'
        ? '유튜브가 이 순서대로 이어서 틀어줘요. 순서대로 안 나오면 아래에서 하나씩 열어주세요.'
        : '영상을 다 보면 여기로 돌아와서 다음 영상을 여세요.';
    playAgainBtn.hidden = mode !== 'batch';

    const frag = document.createDocumentFragment();
    list.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'sheet__item' + (i <= openedIndex ? ' is-opened' : '');
      const a = document.createElement('a');
      a.className = 'sheet__link';
      a.href = YouTubeUrl.watchUrl(it.videoId);
      a.target = '_blank';
      a.rel = 'noopener';
      a.innerHTML = '<span class="sheet__num"></span><span class="sheet__name"></span><span class="sheet__time"></span><span class="sheet__open">열기</span>';
      a.querySelector('.sheet__num').textContent = i + 1;
      a.querySelector('.sheet__name').textContent = it.title || `youtu.be/${it.videoId}`;
      a.querySelector('.sheet__time').textContent = it.durationSec != null ? this.formatDuration(it.durationSec) : '';
      a.addEventListener('click', () => {
        li.classList.add('is-opened');
        a.querySelector('.sheet__open').textContent = '다시';
      });
      if (i <= openedIndex) a.querySelector('.sheet__open').textContent = '다시';
      li.appendChild(a);
      frag.appendChild(li);
    });
    playSheetList.replaceChildren(frag);
    this.openSheet(playSheet);
  },

  openSheet(sheet) {
    sheet.hidden = false;
    document.body.classList.add('has-sheet');
    requestAnimationFrame(() => sheet.classList.add('is-open'));
    const first = sheet.querySelector('.sheet__panel button, .sheet__panel a');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 50);
  },

  closeSheet(sheet) {
    sheet.classList.remove('is-open');
    document.body.classList.remove('has-sheet');
    setTimeout(() => {
      if (!sheet.classList.contains('is-open')) sheet.hidden = true;
    }, 200);
    const target = this.els.sessionBar.hidden ? this.els.playBtn : this.els.sessionEndBtn;
    target.focus({ preventScroll: true });
  },

  // =====================================================================
  // 홈 화면 설치 (안드로이드 크롬 등) — 설치해야 "공유 → Lineup"이 뜬다
  // =====================================================================
  // 설치를 어려워하는 사용자가 많아서(2026-09-28 가족 피드백):
  //   - "설치" 버튼을 항상 보여주고, 누르면 지금 기기·브라우저에 맞는 방법을 안내
  //   - 한 번에 설치 가능한 브라우저(안드로이드 크롬 등)는 "지금 설치하기" 한 번으로 끝
  //   - 카카오톡·네이버 앱 안에서 열었으면 먼저 "크롬(사파리)으로 열기"로 안내
  wireInstall() {
    const { installBtn, installSheet, installPrimaryBtn, inappBanner, inappOpenBtn, inappCloseBtn } = this.els;
    this.env = Env.detect();

    // 이미 홈 화면 앱으로 열었으면 설치 관련 UI는 전부 숨김
    if (this.env.standalone) return;

    installBtn.hidden = false;
    installBtn.addEventListener('click', () => this.openInstallSheet());
    installSheet.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) this.closeSheet(installSheet);
      const copyBtn = e.target.closest('[data-copy-url]');
      if (copyBtn) this.copyAppUrl(copyBtn);
    });
    installPrimaryBtn.addEventListener('click', () => this.runInstallPrimary());

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e;
      track('install_available');
      // 시트가 열려 있으면 "지금 설치하기" 버튼이 바로 보이게 다시 그림
      if (!installSheet.hidden) this.renderInstallSheet();
    });
    window.addEventListener('appinstalled', () => {
      installBtn.hidden = true;
      this.closeSheet(installSheet);
      track('app_installed');
      const msg = this.env.android
        ? '설치됐어요! 홈 화면의 Lineup 아이콘으로 열고, 유튜브 공유 메뉴에서도 Lineup을 고를 수 있어요'
        : '설치됐어요! 홈 화면의 Lineup 아이콘으로 열어보세요';
      this.showToast(msg, { duration: 5000 });
    });

    // 앱 안 브라우저 안내 배너 (한 번 닫으면 이번 방문 동안은 안 보임)
    if (this.env.inApp) {
      let dismissed = false;
      try {
        dismissed = sessionStorage.getItem('lineup:inapp-dismissed') === '1';
      } catch (_) {}
      const target = this.env.ios ? '사파리' : '크롬';
      const targetRo = this.env.ios ? '사파리로' : '크롬으로';
      this.els.inappName.textContent = this.env.inApp.name;
      this.els.inappTarget.textContent = target;
      const ext = Env.externalOpenUrl(this.env, window.location.href);
      inappOpenBtn.textContent = ext ? `${targetRo} 열기` : '여는 방법';
      inappBanner.hidden = dismissed;
      inappOpenBtn.addEventListener('click', () => {
        track('inapp_open_click', { app: this.env.inApp.id, direct: !!ext });
        if (ext) window.location.href = ext;
        else this.openInstallSheet();
      });
      inappCloseBtn.addEventListener('click', () => {
        inappBanner.hidden = true;
        try {
          sessionStorage.setItem('lineup:inapp-dismissed', '1');
        } catch (_) {}
      });
      track('inapp_detected', { app: this.env.inApp.id });
    }
  },

  /** 공유·설치용 깔끔한 주소 (utm 등 꼬리표 제거) */
  appUrl() {
    return new URL('./', window.location.href).toString();
  },

  openInstallSheet() {
    this.renderInstallSheet();
    this.openSheet(this.els.installSheet);
    track('install_sheet_open', {
      platform: this.env.platform,
      browser: this.env.browser,
      in_app: this.env.inApp ? this.env.inApp.id : 'none',
      can_prompt: !!this.installPrompt,
    });
  },

  renderInstallSheet() {
    const env = this.env;
    const { installSheetTitle, installSheetDesc, installSheetBody, installPrimaryBtn } = this.els;
    const I = {
      share: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 3v12M7.5 7.5 12 3l4.5 4.5M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>',
      dots: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>',
      hdots: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>',
      menu: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M4 7h16M4 12h16M4 17h16"/></svg>',
      plus: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    };
    const chip = (label, icon = '') => `<span class="ui-chip">${icon}${label}</span>`;
    const copyBox = () => `
      <div class="install-copy">
        <input type="text" readonly value="${this.appUrl()}" aria-label="Lineup 주소">
        <button type="button" data-copy-url>주소 복사</button>
      </div>`;

    let desc = '';
    let steps = [];
    let note = '';
    let extra = '';
    let primary = null; // {label, action}

    if (env.inApp) {
      const target = env.ios ? '사파리' : '크롬';
      const targetRo = env.ios ? '사파리로' : '크롬으로';
      const ext = Env.externalOpenUrl(env, window.location.href);
      installSheetTitle.textContent = `먼저 ${targetRo} 열어주세요`;
      desc = `지금은 ${env.inApp.name} 안에서 열려 있어서 설치가 안 돼요. ${targetRo} 연 다음 다시 "설치"를 눌러주세요.`;
      if (ext) {
        primary = { label: `${targetRo} 열기`, action: () => (window.location.href = ext) };
        steps = [`아래 ${chip(`${targetRo} 열기`)} 버튼을 눌러요.`, `${target}에서 Lineup이 열리면 오른쪽 위 ${chip('설치')}를 다시 눌러요.`];
      } else {
        steps = env.ios
          ? [`화면 오른쪽 아래(또는 위)의 ${chip('', I.hdots)} 또는 ${chip('', I.share)} 버튼을 눌러요.`, `${chip('Safari로 열기')} (또는 "기본 브라우저로 열기")를 눌러요.`, `사파리에서 Lineup이 열리면 ${chip('설치')}를 다시 눌러요.`]
          : [`화면 오른쪽 위의 ${chip('', I.dots)} 버튼을 눌러요.`, `${chip('다른 브라우저로 열기')} (또는 "Chrome으로 열기")를 눌러요.`, `크롬에서 Lineup이 열리면 ${chip('설치')}를 다시 눌러요.`];
      }
      note = '메뉴가 안 보이면 아래 주소를 복사해서 크롬·사파리 주소창에 붙여넣어도 돼요.';
      extra = copyBox();
    } else if (this.installPrompt) {
      installSheetTitle.textContent = '홈 화면에 Lineup 설치하기';
      desc = '버튼 한 번이면 끝나요. 홈 화면에 Lineup 아이콘이 생겨요.';
      primary = { label: '지금 설치하기', action: () => this.promptInstall() };
      steps = [`아래 ${chip('지금 설치하기')}를 눌러요.`, `뜨는 창에서 ${chip('설치')}를 눌러요.`];
      if (env.android) note = '설치하면 유튜브의 공유 메뉴에도 Lineup이 생겨서, 링크 복사 없이 바로 담을 수 있어요. (처음엔 공유 메뉴 끝의 "더보기" 쪽에 있을 수 있어요)';
    } else if (env.ios) {
      installSheetTitle.textContent = '아이폰 홈 화면에 추가하기';
      desc = env.browser === 'safari' ? '사파리에서 세 번만 누르면 돼요.' : '브라우저의 공유 버튼에서 추가할 수 있어요.';
      steps = env.browser === 'safari'
        ? [`화면 아래 가운데 ${chip('', I.share)} 공유 버튼을 눌러요. (안 보이면 화면을 살짝 위로 올려보세요)`, `목록을 아래로 내려 ${chip('홈 화면에 추가', I.plus)}를 눌러요.`, `오른쪽 위 ${chip('추가')}를 눌러요.`]
        : [`주소창 옆의 ${chip('', I.share)} 공유 버튼을 눌러요.`, `${chip('홈 화면에 추가', I.plus)}를 눌러요.`, `${chip('추가')}를 눌러요.`];
      note = '아이폰은 유튜브 공유 메뉴에 Lineup이 뜨지 않아요. 유튜브에서 "링크 복사" 후 Lineup 입력창에 붙여넣으면 바로 담겨요.';
    } else if (env.android && env.browser === 'samsung') {
      installSheetTitle.textContent = '갤럭시 홈 화면에 추가하기';
      desc = '삼성 인터넷에서 추가하는 방법이에요.';
      steps = [`화면 아래 오른쪽 ${chip('', I.menu)} 메뉴를 눌러요.`, `${chip('현재 페이지 추가')} (또는 "페이지 추가")를 눌러요.`, `${chip('홈 화면')}을 고르고 ${chip('추가')}를 눌러요.`];
      note = '주소창에 ⬇ 모양 설치 아이콘이 보이면 그걸 눌러도 돼요. 메뉴 이름은 버전에 따라 조금 달라요.';
    } else if (env.android) {
      installSheetTitle.textContent = '홈 화면에 Lineup 설치하기';
      desc = '크롬 메뉴에서 추가할 수 있어요.';
      steps = [`화면 오른쪽 위 ${chip('', I.dots)} 메뉴를 눌러요.`, `${chip('홈 화면에 추가')} 또는 ${chip('앱 설치')}를 눌러요.`, `${chip('설치')} (또는 "추가")를 눌러요.`];
      note = '설치하면 유튜브 공유 메뉴에도 Lineup이 생겨요. 이미 설치했다면 홈 화면의 Lineup 아이콘으로 열어주세요.';
    } else {
      installSheetTitle.textContent = '휴대폰에서 쓰면 더 편해요';
      desc = 'Lineup은 출퇴근길 휴대폰용으로 만들었어요. 아래 주소를 휴대폰으로 보내서 열어보세요.';
      steps = [`휴대폰 크롬(아이폰은 사파리)에서 아래 주소를 열어요.`, `오른쪽 위 ${chip('설치')}를 누르면 기기에 맞는 방법이 나와요.`];
      note = 'PC 크롬에서도 주소창 오른쪽의 설치 아이콘으로 설치할 수 있어요.';
      extra = copyBox();
    }

    installSheetDesc.textContent = desc;
    installSheetBody.innerHTML =
      `<ol class="install-steps">${steps.map((t) => `<li><span>${t}</span></li>`).join('')}</ol>` +
      (note ? `<p class="install-note">${note}</p>` : '') +
      extra;
    this.installPrimary = primary;
    installPrimaryBtn.hidden = !primary;
    if (primary) installPrimaryBtn.textContent = primary.label;
  },

  runInstallPrimary() {
    if (!this.installPrimary) return;
    track('install_primary_click', { label: this.installPrimary.label });
    this.installPrimary.action();
  },

  async promptInstall() {
    if (!this.installPrompt) return;
    this.installPrompt.prompt();
    try {
      const choice = await this.installPrompt.userChoice;
      track('install_click', { outcome: (choice && choice.outcome) || 'unknown' });
    } catch (_) {}
    this.installPrompt = null;
    // 취소한 경우엔 다시 누를 수 있도록 메뉴 안내 버전으로 바꿔 둔다
    if (!this.els.installSheet.hidden) this.renderInstallSheet();
  },

  async copyAppUrl(btn) {
    const url = this.appUrl();
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch (_) {
      const input = btn.parentElement.querySelector('input');
      input.focus();
      input.select();
      try {
        ok = document.execCommand('copy');
      } catch (_) {}
    }
    btn.textContent = ok ? '복사됨' : '길게 눌러 복사';
    track('install_copy_url', { ok });
  },

  // --- 전체 삭제 (확인창 대신 "되돌리기" 토스트로 실수 복구) -------------
  wireClearAll() {
    this.els.clearAllBtn.addEventListener('click', () => this.clearAll());
  },

  // =====================================================================
  // 클립보드 (2군 진입 경로)
  //   - Chrome/Edge(안드로이드 포함)에서 클립보드 읽기 권한이 "허용"된 상태면,
  //     앱을 열거나 돌아올 때 자동으로 읽어 "방금 복사한 영상, 담을까요?"를 띄운다.
  //   - iOS Safari 등은 탭(사용자 동작) 없이는 클립보드를 못 읽는다(브라우저 정책).
  //     그래서 "복사한 링크 붙여넣기" 버튼을 항상 두고, 누르면 바로 읽어서 담는다.
  //     (iOS는 이때 작은 "붙여넣기" 말풍선이 뜨고, 그걸 누르면 담긴다.)
  //   - 한 번 제안했거나 닫은 링크는 같은 세션에서 다시 제안하지 않는다.
  // =====================================================================
  wireClipboard() {
    const canRead = !!(navigator.clipboard && navigator.clipboard.readText);
    this.els.pasteBtn.hidden = !canRead;
    if (!canRead) return;

    this.refreshPasteButton();
    this.els.pasteBtn.addEventListener('click', () => this.pasteFromClipboard());
    this.els.clipAddBtn.addEventListener('click', () => this.acceptClipSuggestion());
    this.els.clipCloseBtn.addEventListener('click', () => this.dismissClipSuggestion());

    const check = () => {
      if (document.visibilityState === 'visible') this.checkClipboardSilently();
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    check();
  },

  /** 권한이 이미 "허용"인 브라우저에서만 조용히 읽는다 (권한 팝업을 갑자기 띄우지 않기 위해) */
  async checkClipboardSilently() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return;
      const status = await navigator.permissions.query({ name: 'clipboard-read' });
      if (status.state !== 'granted') return;
      const text = await navigator.clipboard.readText();
      this.maybeSuggestClip(text);
    } catch (_) {
      // Safari/Firefox는 clipboard-read 권한 조회 자체를 지원하지 않음 → 버튼 방식만 사용
    }
  },

  maybeSuggestClip(text) {
    const parsed = YouTubeUrl.parse(text);
    if (!parsed.ok) return;
    if (this.items.some((it) => it.videoId === parsed.videoId)) return;
    let offered = null;
    try {
      offered = sessionStorage.getItem(CLIP_OFFERED_KEY);
    } catch (_) {}
    if (offered === parsed.videoId) return;
    try {
      sessionStorage.setItem(CLIP_OFFERED_KEY, parsed.videoId);
    } catch (_) {}

    this.clip = { text, videoId: parsed.videoId };
    const { clipSuggest, clipThumb, clipTitle } = this.els;
    clipThumb.src = YouTubeUrl.thumb(parsed.videoId);
    clipTitle.textContent = `youtu.be/${parsed.videoId}`;
    clipSuggest.hidden = false;
    track('clip_suggest_shown');
    this.els.pasteBtn.hidden = true; // 제안 카드가 떠 있을 땐 같은 역할의 버튼은 숨김

    // 제목은 곧바로 조회해서 채워 넣는다 (실패하면 주소 그대로)
    VideoMeta.lookup([parsed.videoId]).then((res) => {
      const meta = res.get(parsed.videoId);
      if (this.clip && this.clip.videoId === parsed.videoId && meta && meta.title) {
        clipTitle.textContent = meta.title;
      }
    });
  },

  acceptClipSuggestion() {
    if (!this.clip) return;
    const { text } = this.clip;
    this.hideClipSuggestion();
    this.handleAddResult(this.addFromText(text, 'clip_suggest'));
  },

  dismissClipSuggestion() {
    this.hideClipSuggestion();
    this.els.pasteBtn.focus();
  },

  hideClipSuggestion() {
    if (!this.clip) return;
    this.clip = null;
    this.els.clipSuggest.hidden = true;
    this.els.pasteBtn.hidden = false;
    this.refreshPasteButton();
  },

  isIOS() {
    return /iP(hone|od|ad)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  clipboardFailMessage() {
    if (this.isIOS()) {
      return '버튼을 누른 뒤 뜨는 "붙여넣기" 말풍선을 눌러주세요. 안 되면 입력창에 붙여넣으면 바로 담겨요.';
    }
    return '브라우저가 클립보드 읽기를 막았어요. 입력창을 길게 눌러 붙여넣으면 바로 담겨요.';
  },

  /** 클립보드 권한이 "차단"으로 굳어진 브라우저에선 버튼이 쓸모없으니 숨긴다 */
  async refreshPasteButton() {
    try {
      const status = await navigator.permissions.query({ name: 'clipboard-read' });
      if (status.state === 'denied') this.els.pasteBtn.hidden = true;
      status.onchange = () => {
        this.els.pasteBtn.hidden = status.state === 'denied' || !this.els.clipSuggest.hidden;
      };
    } catch (_) {
      // 권한 조회 미지원(Safari 등) → 버튼 유지
    }
  },

  async pasteFromClipboard() {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      console.warn('[Lineup] 클립보드 읽기 실패:', err && err.name, err && err.message);
      track('clipboard_fail', { error: (err && err.name) || 'unknown' });
      this.showToast(this.clipboardFailMessage(), { duration: 5000 });
      this.els.urlInput.focus();
      this.refreshPasteButton();
      return;
    }
    if (!text.trim()) {
      this.showToast('복사된 내용이 없어요. 유튜브에서 "링크 복사"를 먼저 해주세요.', { duration: 3500 });
      return;
    }
    this.hideClipSuggestion();
    const result = this.addFromText(text, 'clip_button');
    if (!result.ok && result.reason !== 'duplicate') {
      // 유튜브 링크가 아니면 입력창에 넣어서 무엇이 복사됐는지 보여준다
      this.els.urlInput.value = text.trim().slice(0, 300);
    }
    this.handleAddResult(result);
  },

  // --- 다른 탭/창에서 큐가 바뀌면 이 화면도 맞춰줌 -------------------------
  wireStorageSync() {
    window.addEventListener('storage', (e) => {
      if (e.key !== QueueStore.KEY || this.drag) return;
      this.items = QueueStore.load();
      this.render();
    });
    // (다른 탭이 이미 조회한 정보도 localStorage를 통해 같이 넘어온다)
  },

  // =====================================================================
  // 토스트(스낵바) + 되돌리기
  // =====================================================================
  wireToast() {
    this.els.toastAction.addEventListener('click', () => {
      if (!this.undoSnapshot) return;
      this.items = this.undoSnapshot;
      this.undoSnapshot = null;
      track('undo');
      this.commit();
      this.announce('되돌렸어요.');
    });
  },

  showToast(message, { actionLabel = null, duration = 2400 } = {}) {
    const { toast, toastMsg, toastAction } = this.els;
    clearTimeout(this.toastTimer);
    toastMsg.textContent = message;
    toastAction.hidden = !actionLabel;
    if (actionLabel) toastAction.textContent = actionLabel;
    else this.undoSnapshot = null;
    toast.hidden = false;
    // 다음 프레임에 클래스를 붙여야 등장 트랜지션이 동작
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    this.toastTimer = setTimeout(() => this.hideToast(), duration);
  },

  hideToast() {
    const { toast } = this.els;
    clearTimeout(this.toastTimer);
    this.undoSnapshot = null;
    toast.classList.remove('is-visible');
    this.toastTimer = setTimeout(() => {
      if (!toast.classList.contains('is-visible')) toast.hidden = true;
    }, 200);
  },

  offerUndo(snapshot, message) {
    this.showToast(message, { actionLabel: '되돌리기', duration: 6000 });
    this.undoSnapshot = snapshot;
  },

  announce(text) {
    const el = this.els.srStatus;
    el.textContent = '';
    setTimeout(() => (el.textContent = text), 30);
  },
};

document.addEventListener('DOMContentLoaded', () => LineupApp.init());
