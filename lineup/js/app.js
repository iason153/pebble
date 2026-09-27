'use strict';

/**
 * Lineup — 앱 로직
 *
 * 1단계: PWA 셸 배선(Service Worker 등록, 공유 진입 파라미터 수신)
 * 2단계: 큐 UI + localStorage — URL 파싱, 추가/삭제/순서변경(드래그·버튼·방향키),
 *        전체삭제, 되돌리기 토스트, 저장/복원, 다른 탭과 동기화
 *
 * 남은 경계(TODO 표시):
 *   3단계 — 큐 항목 메타데이터(제목 oEmbed / 길이 Data API) 채우기, 클립보드 감지
 *   4단계 — 안드로이드 공유 → 큐 추가 연결, 통근시간 계산, watch_videos 재생
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
          // 3단계에서 채워질 메타데이터 자리
          title: typeof it.title === 'string' ? it.title : null,
          author: typeof it.author === 'string' ? it.author : null,
          durationSec: Number.isFinite(it.durationSec) ? it.durationSec : null,
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

  init() {
    this.cacheEls();
    this.registerServiceWorker();
    this.consumeShareTarget();

    this.items = QueueStore.load();
    this.render();

    this.wireAddForm();
    this.wireQueueList();
    this.wireCommuteSlider();
    this.wireClearAll();
    this.wireToast();
    this.wireStorageSync();

    // TODO(3단계): 큐 항목의 메타데이터(제목/썸네일/길이) 채우기, 클립보드 자동 감지
    // TODO(4단계): 재생 시작 버튼에 watch_videos 링크 생성 로직 연결
  },

  cacheEls() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      addForm: $('form-add-url'),
      urlInput: $('input-url'),
      addError: $('add-error'),
      clipboardHint: $('clipboard-hint'),
      clipboardBtn: $('btn-add-from-clipboard'),
      commuteSlider: $('commute-slider'),
      commuteValue: $('commute-value'),
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
      sessionStorage.setItem('lineup_pending_share', sharedUrl);
      // TODO(4단계): sessionStorage.getItem('lineup_pending_share')를 addFromText()에 연결
    }

    if (params.has('share_title') || params.has('share_text') || params.has('share_url')) {
      window.history.replaceState({}, document.title, window.location.pathname);
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

  /** @returns {{ok:boolean, reason?:string, index?:number}} */
  addFromText(text) {
    const parsed = YouTubeUrl.parse(text);
    if (!parsed.ok) return parsed;

    const existing = this.items.findIndex((it) => it.videoId === parsed.videoId);
    if (existing !== -1) return { ok: false, reason: 'duplicate', index: existing };

    const item = {
      uid: QueueStore.uid(),
      videoId: parsed.videoId,
      isShort: parsed.isShort,
      addedAt: Date.now(),
      title: null,
      author: null,
      durationSec: null,
    };
    this.items.push(item);
    this.commit();
    return { ok: true, index: this.items.length - 1, uid: item.uid };
  },

  removeItem(uid) {
    const idx = this.items.findIndex((it) => it.uid === uid);
    if (idx === -1) return;
    const snapshot = this.items.slice();
    this.items.splice(idx, 1);
    this.commit({ keepToast: true });
    this.offerUndo(snapshot, '큐에서 뺐어요');
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
  // 렌더링
  // =====================================================================
  render() {
    const { queueList, queueEmpty, queueHead, queueCount, clearAllBtn, playBtn } = this.els;
    const count = this.items.length;

    queueEmpty.hidden = count > 0;
    queueHead.hidden = count === 0;
    clearAllBtn.hidden = count === 0;
    queueCount.textContent = `${count}개`;

    // TODO(4단계): 재생 로직 연결 후 count > 0 이면 활성화
    playBtn.disabled = true;

    const frag = document.createDocumentFragment();
    this.items.forEach((item, i) => frag.appendChild(this.renderItem(item, i, count)));
    queueList.replaceChildren(frag);
  },

  renderItem(item, index, total) {
    const li = document.createElement('li');
    li.className = 'queue-item';
    li.dataset.uid = item.uid;

    const title = item.title || `youtu.be/${item.videoId}`;
    const metaParts = [];
    if (item.isShort) metaParts.push('Shorts');
    if (item.durationSec != null) metaParts.push(this.formatDuration(item.durationSec));
    if (item.author) metaParts.push(item.author);
    if (!metaParts.length) metaParts.push('YouTube');

    li.innerHTML = `
      <button type="button" class="queue-item__handle" data-action="drag"
        aria-label="${index + 1}번째 영상 순서 바꾸기 (드래그하거나 위/아래 방향키)">${ICONS.grip}</button>
      <div class="queue-item__thumb-wrap">
        <img class="queue-item__thumb" alt="" loading="lazy" decoding="async" width="72" height="40">
        <span class="queue-item__index" aria-hidden="true"></span>
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

    addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const result = this.addFromText(urlInput.value);

      if (result.ok) {
        clearError();
        urlInput.value = '';
        this.showToast('큐에 담았어요');
        this.announce(`${result.index + 1}번째로 담았어요.`);
        this.flashItem(result.uid);
        return;
      }

      if (result.reason === 'duplicate') {
        clearError();
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
    });
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
        if (moved) this.focusItemControl(uid, `[data-action="${action}"]`);
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
      if (commitOrder) {
        const before = this.items.findIndex((it) => it.uid === uid);
        this.applyOrder(order);
        const after = this.items.findIndex((it) => it.uid === uid);
        if (before !== after) this.announce(`${after + 1}번째로 옮겼어요.`);
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
    if (!this.els.commuteSlider) return;
    const updateLabel = () => {
      this.els.commuteValue.textContent = `${this.els.commuteSlider.value}분`;
    };
    this.els.commuteSlider.addEventListener('input', updateLabel);
    updateLabel();
    // TODO(4단계): 큐 누적 재생시간과 비교해 트림 표시(commute-summary, is-trimmed 클래스)
  },

  // --- 전체 삭제 (확인창 대신 "되돌리기" 토스트로 실수 복구) -------------
  wireClearAll() {
    this.els.clearAllBtn.addEventListener('click', () => this.clearAll());
  },

  // --- 다른 탭/창에서 큐가 바뀌면 이 화면도 맞춰줌 -------------------------
  wireStorageSync() {
    window.addEventListener('storage', (e) => {
      if (e.key !== QueueStore.KEY || this.drag) return;
      this.items = QueueStore.load();
      this.render();
    });
  },

  // =====================================================================
  // 토스트(스낵바) + 되돌리기
  // =====================================================================
  wireToast() {
    this.els.toastAction.addEventListener('click', () => {
      if (!this.undoSnapshot) return;
      this.items = this.undoSnapshot;
      this.undoSnapshot = null;
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
