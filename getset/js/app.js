'use strict';

/**
 * Getset — 화면 동작
 *
 * 화면 흐름
 *   [날짜] 달력 → 그날 계획 (날짜마다 따로 저장)
 *   [볼일 추가] → 장소 찾기 → 볼일 시트(한 화면: 머무는 시간·정해진 시간·순서·가는 방법·주차) → [추가하기]
 *   [순서 추천받기] → engine.js → 결과 시트(끝나는 시각·이유·시간표)
 *
 * 개인정보: 장소 정보는 이 기기(localStorage)에만 저장. 통계엔 종류·개수·이동수단만.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const Store = window.GetsetStore;
  const Kinds = window.GetsetKinds;
  const Places = window.GetsetPlaces;
  const Profile = window.GetsetProfile;
  const Learn = window.GetsetLearn;
  const track = (name, params) => {
    if (typeof window.pebbleTrack === 'function') window.pebbleTrack(name, params);
  };

  const MAX_STOPS = 12; // 설계문서 §6-2: 13곳 이상은 v1에서 제한
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

  const ICON = {
    car: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" d="M5 16.5V12l1.8-4.6A2 2 0 0 1 8.7 6h6.6a2 2 0 0 1 1.9 1.4L19 12v4.5M5 12h14M4 16.5h16v1.8a.7.7 0 0 1-.7.7H17.5a.7.7 0 0 1-.7-.7v-1.1H7.2v1.1a.7.7 0 0 1-.7.7H4.7a.7.7 0 0 1-.7-.7z"/><circle cx="8" cy="14.3" r="1" fill="currentColor"/><circle cx="16" cy="14.3" r="1" fill="currentColor"/></svg>',
    walk: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="13" cy="4.6" r="1.9" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="m10.5 21 1.6-5.4-2.4-2.4.9-4.6M10.6 8.6 7.5 10.4l-.8 3.1M10.6 8.6l2.6.2 2 3 2.6.8M12.1 15.6l2.6 2 1 3.4"/></svg>',
    bike: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="6" cy="16" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="16" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m6 16 3.6-7h5.2L18 16M9.6 9l2.6 7h-6M12.6 6h2.4l1.2 3"/></svg>',
    transit: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="5" y="3.5" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M5 11h14" stroke="currentColor" stroke-width="1.9"/><circle cx="8.6" cy="14.2" r="1" fill="currentColor"/><circle cx="15.4" cy="14.2" r="1" fill="currentColor"/><path d="m8 17.5-1.6 3M16 17.5l1.6 3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  };
  const MODE_LABEL = { car: '자동차', walk: '도보', bike: '자전거', transit: '대중교통' };

  const App = {
    plans: null, // 날짜별 계획
    date: null, // 지금 보고 있는 날짜
    places: null,
    saveWarned: false,

    pickMode: 'stop', // 장소 찾기: stop | start | end
    searchSeq: 0,
    searchTimer: null,

    draft: null, // 볼일 시트에서 고치는 중인 볼일
    editingUid: null,
    apptType: 'none',

    get plan() {
      return this.plans[this.date];
    },

    init() {
      this.plans = Store.loadPlans();
      this.places = Store.loadPlaces();
      this.profile = Profile.load();
      this.syncHome();
      this.date = Store.todayStr();
      Store.planFor(this.plans, this.date);

      this.startTF = window.GetsetTimeField($('start-tf'), { onChange: () => ($('time-error').hidden = true) });
      this.apptTF = window.GetsetTimeField($('appt-tf'), {
        onChange: (v) => {
          if (this.draft && this.apptType !== 'none') this.draft[this.apptKey()] = v;
          $('stop-error').hidden = true;
        },
      });

      this.wireDate();
      this.wireTrip();
      this.wireStops();
      this.wirePlaceSheet();
      this.wireStopSheet();
      this.wireEndSheet();
      this.wireSheets();
      this.wireResult();
      $('btn-share').addEventListener('click', () => window.GetsetShare.share('header'));
      $('btn-plan').addEventListener('click', () => this.onPlan());
      window.GetsetInstall.init({
        appName: 'Getset',
        track,
        showToast: (m, o) => this.showToast(m, o),
        openSheet: (s) => this.openSheet(s),
        closeSheet: (s) => this.closeSheet(s),
      });

      this.wireMe();
      this.wireRun();
      this.render();
      this.showNotice();
      if (!this.profile.onboarded) setTimeout(() => this.openOnboarding(null, null, true), 300);
      // 값 파일(model.json)을 다 읽으면 이름·시간을 다시 그림. 관리자 시험 값이면 알림 띠 표시
      const onModel = () => {
        this.render();
        $('model-banner').hidden = Kinds.source !== 'override';
      };
      window.addEventListener('getset:model', onModel);
      Kinds.ready.then(onModel);
      $('btn-model-reset').addEventListener('click', () => {
        Kinds.clearOverride();
        window.location.reload();
      });
      setInterval(() => {
        this.renderTime();
        this.renderTripLine();
      }, 30 * 1000);
      this.registerServiceWorker();
    },

    // =================================================================
    // 저장
    // =================================================================
    save() {
      const ok = Store.savePlans(this.plans);
      if (!ok && !this.saveWarned) {
        this.saveWarned = true;
        this.showToast('이 브라우저에선 저장이 안 돼요. 창을 닫으면 내용이 사라질 수 있어요.', { duration: 4500 });
      }
    },

    savePlaces() {
      Store.savePlaces(this.places);
    },

    // =================================================================
    // 날짜 (달력)
    // =================================================================
    isToday() {
      return this.date === Store.todayStr();
    },

    isWeekend(date = this.date) {
      const d = Store.parseDate(date).getDay();
      return d === 0 || d === 6;
    },

    /** "오늘" / "내일" / "모레" / "" */
    relDay(date) {
      const diff = Math.round((Store.parseDate(date) - Store.parseDate(Store.todayStr())) / 86400000);
      return diff === 0 ? '오늘' : diff === 1 ? '내일' : diff === 2 ? '모레' : diff === -1 ? '어제' : '';
    },

    /** "10월 3일 (토)" */
    fullDay(date) {
      const d = Store.parseDate(date);
      return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;
    },

    wireDate() {
      $('row-date').addEventListener('click', () => this.openDateSheet());
      $('cal-prev').addEventListener('click', () => this.moveMonth(-1));
      $('cal-next').addEventListener('click', () => this.moveMonth(1));
      $('date-sheet').addEventListener('click', (e) => {
        const b = e.target.closest('[data-date]');
        if (b && !b.disabled) this.selectDate(b.dataset.date);
      });
    },

    openDateSheet() {
      const d = Store.parseDate(this.date);
      this.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      this.renderCalendar();
      this.openSheet($('date-sheet'));
    },

    moveMonth(n) {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const next = new Date(this.calMonth.getFullYear(), this.calMonth.getMonth() + n, 1);
      const max = new Date(now.getFullYear() + 1, now.getMonth(), 1);
      if (next < first || next > max) return;
      this.calMonth = next;
      this.renderCalendar();
    },

    hasStops(date) {
      return !!(this.plans[date] && this.plans[date].stops.length);
    },

    renderCalendar() {
      const today = Store.todayStr();
      $('date-quick').innerHTML = [0, 1, 2]
        .map((n) => {
          const d = Store.addDays(today, n);
          const dd = Store.parseDate(d);
          const on = d === this.date;
          return `<button class="date-quick__btn" type="button" data-date="${d}" aria-pressed="${on}"><b>${this.relDay(d)}</b><small>${dd.getMonth() + 1}/${dd.getDate()} ${WEEK[dd.getDay()]}</small>${this.hasStops(d) ? '<span class="cal__dot"></span>' : ''}</button>`;
        })
        .join('');

      const m = this.calMonth;
      $('cal-title').textContent = `${m.getFullYear()}년 ${m.getMonth() + 1}월`;
      const now = new Date();
      $('cal-prev').disabled = m.getFullYear() === now.getFullYear() && m.getMonth() === now.getMonth();
      const cells = [];
      const lead = m.getDay();
      for (let i = 0; i < lead; i++) cells.push('<span class="cal__cell cal__cell--empty"></span>');
      const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      for (let day = 1; day <= days; day++) {
        const d = Store.todayStr(new Date(m.getFullYear(), m.getMonth(), day));
        const wd = (lead + day - 1) % 7;
        const past = d < today;
        const cls = ['cal__cell'];
        if (d === today) cls.push('is-today');
        if (d === this.date) cls.push('is-selected');
        if (wd === 0) cls.push('sun');
        if (wd === 6) cls.push('sat');
        cells.push(
          `<button class="${cls.join(' ')}" type="button" data-date="${d}" ${past ? 'disabled' : ''} aria-label="${this.fullDay(d)}${this.hasStops(d) ? ', 볼일 있음' : ''}"${d === this.date ? ' aria-current="date"' : ''}>${day}${this.hasStops(d) ? '<span class="cal__dot"></span>' : ''}</button>`
        );
      }
      $('cal-grid').innerHTML = cells.join('');
    },

    selectDate(date) {
      this.date = date;
      Store.planFor(this.plans, date);
      this.save();
      this.closeSheet($('date-sheet'));
      $('notice').hidden = true;
      this.render();
      track('date_select', { days_ahead: Math.round((Store.parseDate(date) - Store.parseDate(Store.todayStr())) / 86400000) });
      this.showToast(`${this.relDay(date) ? this.relDay(date) + ' · ' : ''}${this.fullDay(date)} 계획이에요`);
    },

    renderDate() {
      const rel = this.relDay(this.date);
      $('date-name').textContent = rel ? `${rel} · ${this.fullDay(this.date)}` : this.fullDay(this.date);
      $('date-sub').textContent = this.isWeekend() ? '주말이라 마트·식당 주차가 더 오래 걸리게 계산해요' : '눌러서 다른 날 계획하기';
      $('stops-heading').textContent = rel === '오늘' ? '오늘 볼일' : `${rel || this.fullDay(this.date)} 볼일`;
    },

    // 다가오는 일정 / 지난 볼일 가져오기 안내 (처음 열 때 한 번)
    showNotice() {
      const today = Store.todayStr();
      if (this.hasStops(today)) return;
      const dates = Object.keys(this.plans).filter((d) => this.hasStops(d)).sort();
      const future = dates.find((d) => d > today);
      const past = dates.filter((d) => d < today && d >= Store.addDays(today, -7)).pop();
      const box = $('notice');
      if (future) {
        $('notice-text').innerHTML = `<b>${this.relDay(future) || this.fullDay(future)}</b>에 넣어 둔 볼일 <b>${this.plans[future].stops.length}개</b>가 있어요.`;
        $('btn-notice-yes').textContent = '그날 계획 보기';
        this.noticeAction = () => this.selectDate(future);
      } else if (past) {
        $('notice-text').innerHTML = `<b>${this.relDay(past) || this.fullDay(past)}</b> 넣어 둔 볼일 <b>${this.plans[past].stops.length}개</b>가 남아 있어요. 오늘로 가져올까요?`;
        $('btn-notice-yes').textContent = '오늘로 가져오기';
        this.noticeAction = () => {
          this.plan.stops = this.plans[past].stops.map((s) => Object.assign({}, JSON.parse(JSON.stringify(s)), { uid: Store.newUid() }));
          this.save();
          this.render();
          this.showToast('지난 볼일을 오늘로 가져왔어요');
        };
      } else return;
      box.hidden = false;
      $('btn-notice-yes').onclick = () => {
        box.hidden = true;
        this.noticeAction();
      };
      $('btn-notice-no').onclick = () => (box.hidden = true);
    },

    // =================================================================
    // 출발 정보 (출발지 · 시각 · 끝나는 곳 · 그날 기본 이동수단)
    // =================================================================
    wireTrip() {
      $('trip-line').addEventListener('click', () => this.openSheet($('trip-sheet')));
      $('row-start').addEventListener('click', () => this.openPlaceSheet('start'));
      $('row-end').addEventListener('click', () => this.openEndSheet());
      $('row-time').addEventListener('click', () => this.openTimeSheet());
      $('time-options').addEventListener('click', (e) => {
        const b = e.target.closest('[data-time]');
        if (b) this.setStartTime(b.dataset.time);
      });
      $('btn-time-ok').addEventListener('click', () => {
        const v = this.startTF.get();
        if (!v) {
          $('time-error').textContent = '시와 분을 숫자로 넣어 주세요 (예: 오후 2시 30분)';
          $('time-error').hidden = false;
          this.startTF.focus();
          return;
        }
        this.setStartTime(v);
      });

      this.renderModes($('day-mode'), false, (mode) => {
        this.plan.mode = mode;
        this.save();
        this.render();
      });
    },

    renderModes(box, withDefault, onPick) {
      const items = withDefault ? [['', '기본']] : [];
      Store.MODES.forEach((m) => items.push([m, MODE_LABEL[m]]));
      box.innerHTML = items
        .map(([m, label]) => `<button class="mode" type="button" role="radio" data-mode="${m}">${m ? ICON[m] : ''}<span>${label}</span></button>`)
        .join('');
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-mode]');
        if (b) onPick(b.dataset.mode || null);
      });
    },

    setModeChecked(box, mode) {
      box.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.mode || null) === (mode || null))));
    },

    /** 지금부터 n분 뒤를 5분 단위로 올린 "HH:MM" */
    suggestTime(after = 5) {
      const d = new Date(Date.now() + after * 60000);
      d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },

    nowHHMM() {
      const d = new Date();
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },

    /** 메인의 한 줄: "오늘 · 집에서 · 오후 2:30 출발 · 자동차" */
    renderTripLine() {
      const rel = this.relDay(this.date);
      const day = rel === '오늘' ? '오늘' : rel || this.fullDay(this.date);
      const st = this.plan.start;
      const from = !st ? '<b class="is-empty">출발지 정하기</b>' : this.isHome(st) ? '집에서' : `${esc(st.name.length > 10 ? st.name.slice(0, 9) + '…' : st.name)}에서`;
      const t = this.plan.startTime;
      const when = t === 'now' && this.isToday() ? '지금 출발' : `${fmtTime(t === 'now' ? '09:00' : t)} 출발`;
      $('trip-line-text').innerHTML = `<b>${day}</b> · ${from} · ${when} · ${MODE_LABEL[this.plan.mode]}`;
    },

    renderTime() {
      const t = this.plan.startTime;
      if (t === 'now' && this.isToday()) {
        $('time-name').textContent = `${fmtTime(this.nowHHMM())} 출발`;
        $('time-sub').textContent = '지금 시각 기준 · 눌러서 바꾸기';
      } else {
        $('time-name').textContent = `${fmtTime(t === 'now' ? '09:00' : t)} 출발`;
        $('time-sub').textContent = '눌러서 바꾸기';
      }
    },

    openTimeSheet() {
      const opts = this.isToday()
        ? [['now', '지금'], [this.suggestTime(10), '10분 뒤'], [this.suggestTime(30), '30분 뒤'], [this.suggestTime(60), '1시간 뒤']]
        : [['08:00'], ['09:00'], ['10:00'], ['13:00'], ['14:00'], ['15:00']];
      const cur = this.plan.startTime;
      $('time-options').classList.toggle('time-chips--2', opts.length === 4);
      $('time-options').innerHTML = opts
        .map(([v, label]) => {
          const on = v === cur;
          const t = v === 'now' ? fmtTime(this.nowHHMM()) : fmtTime(v);
          return `<button class="time-chip" type="button" aria-pressed="${on}" data-time="${v}">${label ? `<b>${label}</b><small>${t}</small>` : `<b>${t}</b>`}</button>`;
        })
        .join('');
      this.startTF.set(cur === 'now' ? this.suggestTime(60) : cur);
      $('time-error').hidden = true;
      $('time-sheet-title').textContent = this.isToday() ? '몇 시에 출발해요?' : `${this.fullDay(this.date)} 몇 시에 출발해요?`;
      this.openSheet($('time-sheet'));
    },

    setStartTime(v) {
      this.plan.startTime = v === 'now' ? 'now' : v;
      this.save();
      this.renderTime();
      this.closeSheet($('time-sheet'));
      this.showToast(v === 'now' ? '지금 시각에 맞춰 계산할게요' : `${fmtTime(v)}에 출발해요`);
    },

    isHome(p) {
      const h = this.places.home;
      return !!(p && h && ((p.id && p.id === h.id) || (Math.abs(p.lat - h.lat) < 1e-5 && Math.abs(p.lng - h.lng) < 1e-5)));
    },

    renderTrip() {
      const s = this.plan.start;
      $('start-name').textContent = s ? s.name : '출발지를 정해 주세요';
      $('start-name').classList.toggle('is-empty', !s);
      const sub = $('start-sub');
      sub.hidden = !s || !(this.isHome(s) || s.address);
      sub.textContent = s ? (this.isHome(s) ? '집' + (s.address ? ' · ' + s.address : '') : s.address) : '';

      const e = this.plan.end;
      if (e.type === 'place' && e.place) {
        $('end-name').textContent = e.place.name;
        $('end-sub').textContent = e.place.address;
        $('end-sub').hidden = !e.place.address;
      } else {
        $('end-name').textContent = e.type === 'none' ? '상관없어요 (마지막 볼일에서 끝)' : '출발지로 돌아오기';
        $('end-sub').hidden = true;
      }
      this.renderDate();
      this.renderTime();
      this.setModeChecked($('day-mode'), this.plan.mode);
      this.renderTripLine();
    },

    // =================================================================
    // 볼일 목록
    // =================================================================
    wireStops() {
      $('btn-add').addEventListener('click', () => {
        if (this.plan.stops.length >= MAX_STOPS) {
          this.showToast(`볼일은 ${MAX_STOPS}개까지 넣을 수 있어요`);
          return;
        }
        this.editingUid = null;
        this.draft = null;
        this.openPlaceSheet('stop');
      });
      $('stop-list').addEventListener('click', (e) => {
        const st = e.target.closest('[data-stay-step]');
        if (st) {
          const [uid, dir] = st.dataset.stayStep.split('|');
          this.stepStay(uid, Number(dir));
          return;
        }
        const b = e.target.closest('[data-uid]');
        if (b) this.openStopSheet(this.plan.stops.find((s) => s.uid === b.dataset.uid));
      });
      $('btn-clear').addEventListener('click', () => {
        const before = this.plan.stops.slice();
        this.plan.stops = [];
        this.save();
        this.render();
        this.offerUndo('볼일을 모두 비웠어요', () => {
          this.plan.stops = before;
          this.save();
          this.render();
        });
      });
    },

    stopMeta(s) {
      const parts = [fmtMin(s.stay)];
      if (s.fixedAt) parts.push(`<span class="tag tag--fixed">예약 ${fmtTime(s.fixedAt)}</span>`);
      if (s.prefAt) parts.push(`<span class="tag">${fmtTime(s.prefAt)}쯤</span>`);
      if (s.deadline) parts.push(`<span class="tag">${fmtTime(s.deadline)}까지</span>`);
      if (s.order === 'first') parts.push('<span class="tag">제일 먼저</span>');
      if (s.order === 'last') parts.push('<span class="tag">제일 마지막</span>');
      if (s.mode && s.mode !== this.plan.mode) parts.push(`<span class="tag tag--mode">${ICON[s.mode]}${MODE_LABEL[s.mode]}</span>`);
      return parts.join('');
    },

    renderStops() {
      const stops = this.plan.stops;
      const minus = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 12h12" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
      const plus = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 6v12M6 12h12" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
      $('stop-list').innerHTML = stops
        .map((s) => {
          const kind = Kinds.get(s.kind);
          const tags = this.stopTags(s);
          return `<li class="stop2${s.kind === 'home' ? ' stop2--home' : ''}">
            <button class="stop2__main" type="button" data-uid="${s.uid}" aria-label="${esc(s.place.name)} 고치기">
              <span class="stop2__kind">${esc(kind.label)}</span>
              <span class="stop2__name">${esc(s.place.name)}</span>
              ${tags ? `<span class="stop2__tags">${tags}</span>` : ''}
            </button>
            <div class="stop2__stay" role="group" aria-label="${esc(s.place.name)} 머무는 시간">
              <button class="stop2__btn" type="button" data-stay-step="${s.uid}|-1" aria-label="10분 줄이기"${s.stay <= Store.STAY_MIN ? ' disabled' : ''}>${minus}</button>
              <span class="stop2__min">${fmtMin(s.stay)}</span>
              <button class="stop2__btn" type="button" data-stay-step="${s.uid}|1" aria-label="10분 늘리기"${s.stay >= Store.STAY_MAX ? ' disabled' : ''}>${plus}</button>
            </div>
          </li>`;
        })
        .join('');
      const n = stops.length;
      $('stops-empty').hidden = n > 0;
      $('stops-hint').hidden = n < 1;
      $('stops-count').hidden = n === 0;
      $('stops-count').textContent = `${n}개`;
      $('btn-clear').hidden = n === 0;
      $('btn-add').hidden = n >= MAX_STOPS;
      $('btn-plan').disabled = n === 0;
      $('btn-routine-save').hidden = n < 2;
      $('btn-routine-load').hidden = n >= 2 || !this.loadRoutines().length;
      $('plan-meta').textContent = n ? `볼일 ${n}개` : '';
    },

    /** 목록 카드에 붙는 작은 꼬리표 (사용자가 직접 정한 것만) */
    stopTags(s) {
      const t = [];
      if (s.fixedAt) t.push(`<span class="tag tag--fixed">예약 ${fmtTime(s.fixedAt)}</span>`);
      if (s.prefAt) t.push(`<span class="tag">${fmtTime(s.prefAt)}쯤</span>`);
      if (s.deadline) t.push(`<span class="tag">${fmtTime(s.deadline)}까지</span>`);
      if (s.order === 'first') t.push('<span class="tag">제일 먼저</span>');
      if (s.order === 'last') t.push('<span class="tag">제일 마지막</span>');
      if (s.mode && s.mode !== this.plan.mode) t.push(`<span class="tag tag--mode">${ICON[s.mode]}${MODE_LABEL[s.mode]}</span>`);
      return t.join('');
    },

    quickAdd(place) {
      const kind = this.kindFor(place);
      const my = Profile.findMy(this.profile, place);
      const stop = Store.cleanStop({
        place,
        kind,
        stay: Kinds.get(kind).stay,
        order: 'any',
        mode: null,
        parking: my && my.parking !== 'auto' && kind !== 'home' ? my.parking : 'auto',
      });
      if (!stop) return;
      const hint = Learn.stayHint(Profile.placeKey(place));
      if (hint) stop.stay = Math.max(Store.STAY_MIN, Math.round(hint.median / 5) * 5);
      this.plan.stops.push(stop);
      this.save();
      this.render();
      track('stop_add', { category: stop.kind, mode: this.plan.mode, has_fixed: false, has_pref: false, has_deadline: false, parking: stop.parking, quick: true });
      // 영업시간 걸리는 곳이면 그 자리에서 알려 줌 (예: 토요일 은행)
      const hrs = this.hoursFor(stop.kind, this.date);
      const msg = hrs && hrs.closed ? `${place.name}: ${hrs.closedNote}` : `${place.name} 넣었어요 · ${fmtMin(stop.stay)}`;
      this.showToast(msg, { actionLabel: '예약 시간 등', duration: 4500, onAction: () => this.openStopSheet(this.plan.stops.find((x) => x.uid === stop.uid)) });
      const li = document.querySelector(`#stop-list [data-uid="${stop.uid}"]`);
      if (li) {
        li.closest('li').classList.add('is-new');
        li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    },

    /** 목록에서 바로 머무는 시간 조절: 20분까지 5분, 그 위로 10분씩 */
    stepStay(uid, dir) {
      const i = this.plan.stops.findIndex((x) => x.uid === uid);
      if (i < 0) return;
      const st = this.plan.stops[i];
      const v = st.stay;
      const d = v < 20 || (v === 20 && dir < 0) ? 5 : 10;
      st.stay = Math.min(Store.STAY_MAX, Math.max(Store.STAY_MIN, v + dir * d));
      this.save();
      this.renderStops();
    },

    render() {
      this.renderTrip();
      this.renderStops();
      this.renderRunBar();
    },

    // =================================================================
    // 순서 추천 (engine.js)
    // =================================================================
    toMin(hhmm) {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    },

    /** 이 장소가 내 집이면 'home', 아니면 카카오 정보로 추정 */
    kindFor(place) {
      const h = this.profile.home;
      if (h && place && Profile.placeKey(place) === h.key) return 'home';
      return Kinds.guess(place);
    },

    syncHome() {
      // 예전 "집으로 저장"과 첫 실행의 집을 하나로 맞춤
      if (this.profile.home && this.profile.home.place) this.places.home = this.profile.home.place;
      else if (this.places.home && !this.profile.home) {
        this.profile.home = Profile.cleanMy({ label: '집', place: this.places.home, parking: 'pilotis' });
        Profile.save(this.profile);
      }
    },

    /** 그날 그 장소 종류의 보통 영업시간 (없으면 null) */
    hoursFor(kind, date) {
      const k = Kinds.get(kind);
      const h = k && k.hours;
      if (!h) return null;
      const day = Store.parseDate(date).getDay();
      const span = day === 0 ? h.sun : day === 6 ? h.sat : h.weekday;
      const dayName = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'][day];
      if (!span) return { closed: true, closedNote: `${dayName}엔 보통 쉬어요` };
      const breaks = Array.isArray(h.breaks) ? h.breaks.filter((x) => Array.isArray(x) && Store.isTime(x[0]) && Store.isTime(x[1])) : [];
      return {
        open: span[0],
        close: span[1],
        breaks,
        breakText: breaks.length ? `점심 ${breaks.map(([a, b]) => `${fmtTime(a).replace('오후 ', '')}~${fmtTime(b).replace('오후 ', '')}`).join(', ')} 쉼` : '',
      };
    },

    /** 엔진에 넘길 볼일 하나 (분 단위 시각, 내 장소·학습 열쇠, 영업시간 포함) */
    engineStop(s) {
      const my = Profile.findMy(this.profile, s.place);
      const isHome = s.kind === 'home';
      const out = {
        uid: s.uid,
        place: s.place,
        kind: s.kind,
        parking: isHome ? (this.profile.home && this.profile.home.parking) || 'auto' : s.parking && s.parking !== 'auto' ? s.parking : my && my.parking !== 'auto' ? my.parking : 'auto',
        lkey: Profile.placeKey(s.place),
        myArrive: my && my.arriveMin != null ? my.arriveMin : null,
        myLeave: my && my.leaveMin != null ? my.leaveMin : null,
        stay: s.stay,
        fixedAt: s.fixedAt ? this.toMin(s.fixedAt) : null,
        prefAt: s.prefAt ? this.toMin(s.prefAt) : null,
        deadline: s.deadline ? this.toMin(s.deadline) : null,
        order: s.order,
        mode: s.mode,
      };
      const h = !s.ignoreHours && !isHome ? this.hoursFor(s.kind, this.date) : null;
      if (h) {
        if (h.closed) {
          out.closed = true;
          out.closedNote = h.closedNote;
        } else {
          out.openAt = this.toMin(h.open);
          out.closeAt = this.toMin(h.close);
          out.breaks = h.breaks.map(([a, b]) => [this.toMin(a), this.toMin(b)]);
        }
      }
      return out;
    },

    /**
     * 도착 후·출발 전 실질 시간 = 값 파일(주차장·장소 종류·혼잡) → 내 장소에서 정한 분 → 내 기록으로 보정 → 여유
     * 순서 계산 때 수만 번 불리므로 결과를 기억해 둔다
     */
    makeOverheadFn(weekend) {
      const buf = (Kinds.model.buffer || {})[this.profile.buffer] || { perStop: 0 };
      const memo = new WeakMap();
      return (st, mode, which, at) => {
        const inner = Kinds.overheadCached(st, mode, which, { weekend, atMin: at });
        const hit = memo.get(inner);
        if (hit) return hit;
        let base = inner.total;
        let parts = inner.parts.slice();
        const custom = which === 'arrive' ? st.myArrive : st.myLeave;
        if (mode === 'car' && custom != null) {
          base = custom;
          parts = [[st.kind === 'home' ? (which === 'arrive' ? '집 주차하고 들어가기' : '집에서 나와 차까지') : '내가 정한 시간', custom]];
        }
        const L = Learn.estimate(st.lkey, st.kind, mode, which === 'arrive' ? 'a' : 'l', base);
        let total = L.total;
        if (total !== base) parts.push([`내 기록 반영(${L.n || L.kn}회)`, total - base]);
        if (which === 'arrive' && buf.perStop) {
          total += buf.perStop;
          parts.push(['여유', buf.perStop]);
        }
        const res = { total, parts, parking: inner.parking, learned: L.n, learnedKind: L.kn };
        memo.set(inner, res);
        return res;
      };
    },

    buildInput() {
      const now = new Date();
      const startIsNow = this.plan.startTime === 'now' && this.isToday();
      const startMin = startIsNow ? now.getHours() * 60 + now.getMinutes() : this.toMin(this.plan.startTime === 'now' ? '09:00' : this.plan.startTime);
      const weekend = this.isWeekend();
      const tp = Kinds.travelParams;
      const pct = ((Kinds.model.buffer || {})[this.profile.buffer] || { travelPct: 0 }).travelPct || 0;
      return {
        start: this.plan.start,
        startMin,
        startIsNow,
        weekend,
        end: this.plan.end,
        dayMode: this.plan.mode,
        overheadFn: this.makeOverheadFn(weekend),
        travelParams: tp,
        travelFn: (a, b, m) => {
          const r = window.GetsetEngine.travel(a, b, m, tp);
          return pct ? { min: Math.ceil(r.min * (1 + pct / 100)), dist: r.dist } : r;
        },
        pref: Kinds.prefParams,
        stops: this.plan.stops.map((s) => this.engineStop(s)),
      };
    },

    onPlan() {
      if (!this.plan.start) {
        this.showToast('먼저 어디서 출발하는지 정해 주세요');
        this.openPlaceSheet('start');
        return;
      }
      const input = this.buildInput();
      $('btn-plan').disabled = true;
      $('plan-meta').textContent = '계산 중…';
      track('plan_request', { stops: input.stops.length, modes: Array.from(new Set(input.stops.map((s) => s.mode || input.dayMode))).join(',') });
      setTimeout(() => {
        let result = null;
        try {
          result = window.GetsetEngine.plan(input);
        } catch (err) {
          console.error(err);
        }
        this.renderStops();
        if (!result || result.tooMany) {
          this.showToast('계산하지 못했어요. 볼일을 줄이거나 다시 시도해 주세요.');
          return;
        }
        this.result = { input, result, tab: 0 };
        const best = result.options[0].sim;
        track('plan_result', {
          stops: input.stops.length,
          end_minutes: best.finishAll - input.startMin,
          slack_minutes: best.waitSum,
          warnings: result.options[0].warnings.length,
          alt_shown: result.options.length > 1,
          method: result.method,
        });
        this.renderResult();
        this.openSheet($('result-sheet'));
      }, 30);
    },

    // =================================================================
    // 결과 화면 — 한 볼일 = 한 줄 카드, 세부는 눌렀을 때만 (설계문서 v1.1 §10)
    // =================================================================
    renderResult() {
      const { input, result, tab } = this.result;
      const opt = result.options[tab];
      const sim = opt.sim;
      const fmt = window.GetsetEngine.fmt;
      const stops = input.stops;
      const t = (m) => fmt(m).replace('오전 ', '').replace('오후 ', '');

      const tabs = $('result-tabs');
      tabs.hidden = result.options.length < 2;
      tabs.innerHTML = result.options
        .map((o, i) => `<button class="tab" type="button" role="tab" aria-selected="${i === tab}" data-tab="${i}"><b>${o.label}</b><small>${fmt(o.sim.doneAt)} 끝 · 이동 ${o.sim.travelSum}분</small></button>`)
        .join('');

      const endLabel = input.end.type === 'return' ? (this.isHome(this.plan.start) ? '집 도착' : '출발지 도착') : '도착';
      const rel = this.relDay(this.date);
      const latest = opt.latest != null && opt.latest > input.startMin ? opt.latest : null;
      const head = `
        <section class="summary${opt.warnings.length ? ' summary--warn' : ''}">
          <p class="summary__label">${rel === '오늘' ? '' : `${rel ? rel + ' · ' : ''}${this.fullDay(this.date)} · `}볼일이 모두 끝나는 시각</p>
          <p class="summary__time">${fmt(sim.doneAt)}</p>
          <p class="summary__meta">${fmt(input.startMin)} 출발 · ${stops.length}곳${sim.endLeg ? ` · ${fmt(sim.endLeg.arrive)} ${endLabel}` : ''}</p>
          <p class="summary__incl">주차·엘리베이터·접수 시간까지 넣었어요${this.learnedCount(sim) ? ` · 내 기록 ${this.learnedCount(sim)}곳 반영` : ''}</p>
          ${latest ? `<p class="summary__slack">늦어도 ${fmt(latest)}엔 출발해야 시간 약속을 지켜요</p>` : ''}
        </section>`;

      const warn = opt.warnings.length
        ? `<section class="alert" role="alert">
            <p class="alert__title">이대로는 시간이 모자라요</p>
            <ul>${opt.warnings.slice(0, 3).map((w) => `<li>${esc(w)}</li>`).join('')}${opt.warnings.length > 3 ? `<li>그 밖에 ${opt.warnings.length - 3}곳도 시간이 안 맞아요</li>` : ''}</ul>
            ${result.suggestions.length ? `<p class="alert__sub">이렇게 해 보세요</p><ul class="alert__tips">${result.suggestions.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
          </section>`
        : '';

      const why = opt.reasons.length ? `<p class="why-line">${esc(opt.reasons[0])}</p>` : '';
      this.currentSuggestions = this.suggestionsFor(input, sim);
      const sug = this.currentSuggestions
        .slice(0, 1)
        .map(
          (g, i) => `<section class="sug"><p class="sug__text">${esc(g.text)}</p><div class="sug__actions">${g.actions
            .map((a, j) => `<button class="${j === 0 ? 'btn-soft' : 'btn-line'} btn-line--sm" type="button" data-sug="${i}|${j}">${esc(a.label)}</button>`)
            .join('')}</div></section>`
        )
        .join('');

      const partsText = (parts) => parts.map(([l, m]) => `${esc(l)} ${m}분`).join(' · ');
      const leg = (mode, min, dist) => {
        const walkHint = mode === 'car' && dist >= 30 && dist < 800 ? ` · 걸으면 ${Math.ceil((dist * 1.3) / 70)}분` : '';
        return `<li class="leg">${ICON[mode]}<span>${min === 0 ? '바로 옆' : `${MODE_LABEL[mode]} ${min}분`}${walkHint}</span></li>`;
      };
      const items = [`<li class="ends"><span class="ends__dot"></span><b>${fmt(input.startMin)}</b> 출발 · ${esc(this.plan.start.name)}</li>`];
      sim.rows.forEach((row, p) => {
        const s = stops[row.i];
        const kind = Kinds.get(s.kind);
        items.push(leg(row.mode, row.travel, row.dist));
        const badges = [];
        if (s.fixedAt != null) badges.push(row.late && s.deadline == null ? `<span class="badge badge--late">예약 ${t(s.fixedAt)} · ${row.late}분 늦음</span>` : `<span class="badge badge--ok">✓ 예약 ${t(s.fixedAt)}</span>`);
        if (s.prefAt != null) badges.push(row.prefLate > Kinds.prefParams.tolerance ? `<span class="badge badge--soft">${t(s.prefAt)}쯤 원했는데 ${row.prefLate}분 늦음</span>` : `<span class="badge badge--ok">✓ ${t(s.prefAt)}쯤</span>`);
        const dl = Math.min(s.deadline != null ? s.deadline : Infinity, s.closeAt != null ? s.closeAt : Infinity);
        if (dl !== Infinity) {
          const over = row.finish - dl;
          if (over > 0) badges.push(`<span class="badge badge--late">${t(dl)}까지 · ${over}분 늦음</span>`);
          else if (s.deadline != null) badges.push(`<span class="badge badge--ok">✓ ${t(s.deadline)} 전</span>`);
        }
        if (s.closed) badges.push(`<span class="badge badge--late">${esc(s.closedNote)}</span>`);
        const hasNext = p + 1 < sim.rows.length || sim.endLeg;
        const learned = row.arriveParts && row.arriveParts.some(([l]) => l.startsWith('내 기록'));
        items.push(`
          <li class="card${s.kind === 'home' ? ' card--home' : ''}">
            <button class="card__main" type="button" data-expand aria-expanded="false">
              <span class="card__num">${s.kind === 'home' ? '집' : p + 1}</span>
              <span class="card__body">
                <span class="card__name">${esc(s.place.name)}</span>
                <span class="card__time">${t(row.begin)} ~ ${t(row.finish)}<small>${fmtMin(s.stay)}</small></span>
                ${row.wait >= 15 ? `<span class="card__sub">${fmtMin(row.wait)} 일찍 도착해요</span>` : ''}
                ${badges.length ? `<span class="card__badges">${badges.join('')}</span>` : ''}
              </span>
              <svg class="card__chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>
            </button>
            <div class="card__detail" hidden>
              <p><b>${esc(kind.label)}</b>${row.mode === 'car' && row.parking && s.kind !== 'home' ? ` · ${esc(Kinds.PARKING[row.parking].label)}` : ''}</p>
              ${row.arriveOH ? `<p>도착 후 ${row.arriveOH}분: ${partsText(row.arriveParts || [])}</p>` : ''}
              ${hasNext && row.leaveOH ? `<p>끝나고 출발까지 ${row.leaveOH}분: ${partsText(row.leaveParts || [])}</p>` : ''}
              <p>${t(row.arrive)} 도착${learned ? ' · 내 기록 반영' : ''}</p>
              <div class="card__fix">
                <button class="btn-line btn-line--sm" type="button" data-fix="${s.uid}">이 곳 고치기</button>
                <a class="map-link" href="${this.mapUrl(s.place)}" target="_blank" rel="noopener">카카오맵</a>
              </div>
            </div>
          </li>`);
      });
      items.push(`<li class="ends ends--done"><span class="ends__dot">✓</span><b>${fmt(sim.doneAt)}</b> 볼일 끝</li>`);
      if (sim.endLeg) {
        items.push(leg(sim.endLeg.mode, sim.endLeg.travel, sim.endLeg.dist));
        const endName = input.end.type === 'return' ? this.plan.start.name : input.end.place.name;
        items.push(`<li class="ends"><span class="ends__dot"></span><b>${fmt(sim.endLeg.arrive)}</b> ${endLabel} · ${esc(endName)}</li>`);
      }
      const note = `<p class="result-note">이동은 직선거리로 어림한 시간이에요(실제 길찾기는 곧 붙어요). 카드를 누르면 주차·엘리베이터·접수 시간이 보여요.${input.weekend ? ' 주말 혼잡을 반영했어요.' : ''}</p>`;

      $('result-title').textContent = opt.warnings.length ? '가장 나은 순서예요' : '이 순서로 가면 돼요';
      $('result-body').innerHTML = head + warn + why + sug + `<ol class="plan-list">${items.join('')}</ol>` + note;
    },

    learnedCount(sim) {
      return sim.rows.filter((r) => (r.arriveParts || []).some(([l]) => l.startsWith('내 기록'))).length;
    },

    mapUrl(place) {
      return `https://map.kakao.com/link/to/${encodeURIComponent(place.name.replace(/,/g, ' '))},${place.lat},${place.lng}`;
    },

    // ---- 편의 제안 (설계문서 v1.1 §7) -------------------------------------
    suggestionsFor(input, sim) {
      const out = [];
      const dismissed = (this.dismissed = this.dismissed || new Set());
      const stops = input.stops;
      const M = Kinds.model;
      const home = this.profile.home;
      const rows = sim.rows;

      // ① 식사
      const meals = [['lunch', '점심'], ['dinner', '저녁']];
      for (const [id, name] of meals) {
        const w = M.meals && M.meals[id];
        if (!w || dismissed.has(id)) continue;
        const from = this.toMin(w.from);
        const to = this.toMin(w.to);
        const overlap = Math.min(sim.doneAt, to) - Math.max(input.startMin, from);
        const hasMeal = rows.some((r) => {
          const s = stops[r.i];
          // 식당·집에 식사 시간대와 30분 이상 겹쳐 있어야 식사한 것으로 봄
          return (s.kind === 'food' || s.kind === 'home') && Math.min(r.finish, to) - Math.max(r.begin, from) >= 30;
        });
        if (overlap >= 30 && !hasMeal) {
          const at = this.toMin(id === 'lunch' ? '12:00' : '18:00');
          const actions = [{ label: '근처 식당 찾기', run: () => this.findMeal(sim, input, at, w.stay) }];
          if (home) actions.push({ label: '집에서 먹기', run: () => this.addHomeStop({ prefAt: this.hhmm(at), stay: w.stay }) });
          actions.push({ label: '괜찮아요', run: () => dismissed.add(id) });
          out.push({ type: 'meal', text: `${name}시간(${fmtTime(w.from)}~${fmtTime(w.to).replace('오후 ', '')})이 끼어 있어요. ${name}은 어떻게 할까요?`, actions });
          break; // 식사 제안은 하나만
        }
      }

      // ② 비는 시간 → 집 들르기
      //    엔진과 똑같은 계산(이동·주차·여유 포함)으로 쉴 시간을 구하고, 실제로 넣어 다시 계산해 봐서
      //    약속을 다 지키고 끝나는 시각도 안 늦어질 때만 제안한다
      if (home && home.place && !dismissed.has('home')) {
        const minRest = (M.homeSuggest && M.homeSuggest.minRest) || 30;
        const homeStop = this.engineStop(Store.cleanStop({ place: home.place, kind: 'home', stay: 30, order: 'any', mode: null, parking: 'auto' }));
        for (let p = 0; p < rows.length && out.length < 2; p++) {
          const r = rows[p];
          if (r.wait < minRest + 10) continue;
          const prevPlace = p === 0 ? input.start : stops[rows[p - 1].i].place;
          if (Profile.placeKey(prevPlace) === home.key || stops[r.i].kind === 'home') continue;
          const mode = stops[r.i].mode || input.dayMode;
          const go = input.travelFn(prevPlace, home.place, mode).min;
          const back = input.travelFn(home.place, stops[r.i].place, mode).min;
          const hA = input.overheadFn(homeStop, mode, 'arrive', 0).total;
          const hL = input.overheadFn(homeStop, mode, 'leave', 0).total;
          let rest = r.wait + r.travel - go - back - hA - hL - 5;
          const dayStartOk = p > 0; // 첫 볼일 전이면 그냥 늦게 출발하면 됨
          if (!dayStartOk || rest < minRest) continue;
          let fit = null;
          for (let tries = 0; tries < 3 && rest >= minRest; tries++, rest -= 10) {
            const at = rows[p - 1].depart + go + hA;
            const trial = Object.assign({}, homeStop, { uid: '__home_try', stay: rest, prefAt: at });
            const res = window.GetsetEngine.plan(Object.assign({}, input, { stops: stops.concat([trial]) }));
            const best = res && res.options[0].sim;
            if (res && res.ok && best.doneAt <= sim.doneAt + 1) {
              fit = { stay: rest, at };
              break;
            }
          }
          if (!fit) continue;
          const name = stops[r.i].place.name;
          out.push({
            type: 'home',
            text: `${name} 전에 ${fmtMin(r.wait)} 비어요. 집에 다녀와도 ${fmtMin(fit.stay)} 쉴 수 있어요.`,
            actions: [
              { label: '집 들르기 넣기', run: () => this.addHomeStop({ stay: fit.stay, prefAt: this.hhmm(fit.at) }) },
              { label: '괜찮아요', run: () => dismissed.add('home') },
            ],
          });
          break;
        }
      }

      // ③ 마트는 마지막에
      if (!dismissed.has('mart') && out.length < 2) {
        const order = rows.map((r) => stops[r.i]);
        const idx = order.findIndex((s) => (s.kind === 'mart' || s.kind === 'local') && s.order === 'any');
        const after = idx >= 0 ? order.slice(idx + 1).filter((s) => s.kind !== 'home') : [];
        if (idx >= 0 && after.length) {
          const s = order[idx];
          out.push({
            type: 'mart',
            text: `장 본 걸 들고 다니지 않게 ${window.GetsetEngine.josa(s.place.name, '을', '를')} 마지막에 갈까요?`,
            actions: [
              { label: '마지막으로', run: () => this.updateStop(s.uid, { order: 'last' }) },
              { label: '괜찮아요', run: () => dismissed.add('mart') },
            ],
          });
        }
      }
      // 보여 줄 순서: 집 들르기(쉬는 시간이 생김, 점심도 겸할 수 있음) → 식사 → 마트
      const rank = { home: 0, meal: 1, mart: 2 };
      return out.sort((a, b) => rank[a.type] - rank[b.type]).slice(0, 2);
    },

    hhmm(min) {
      const m = ((min % 1440) + 1440) % 1440;
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    },

    updateStop(uid, patch) {
      const i = this.plan.stops.findIndex((s) => s.uid === uid);
      if (i < 0) return;
      this.plan.stops[i] = Store.cleanStop(Object.assign({}, this.plan.stops[i], patch));
      this.save();
      this.render();
      this.recompute();
    },

    addHomeStop(extra = {}, { recompute = true } = {}) {
      const home = this.profile.home;
      if (!home || !home.place) return;
      const stop = Store.cleanStop(Object.assign({ place: home.place, kind: 'home', stay: 30, order: 'any', mode: null, parking: 'auto' }, extra));
      this.plan.stops.push(stop);
      this.save();
      this.render();
      track('home_visit_add', { source: recompute ? 'suggest' : 'manual' });
      if (recompute) this.recompute();
    },

    async findMeal(sim, input, at, stay) {
      // 그 시각쯤 있을 곳 근처 음식점
      let near = input.start;
      for (const r of sim.rows) if (r.begin <= at) near = input.stops[r.i].place;
      this.mealPlan = { prefAt: this.hhmm(at), stay };
      this.pickMode = 'meal';
      $('place-sheet-title').textContent = '근처 식당';
      $('place-input').value = '';
      $('place-clear').hidden = true;
      $('place-quick').hidden = true;
      $('place-status').textContent = '찾는 중…';
      $('place-results').innerHTML = '';
      this.openSheet($('place-sheet'));
      try {
        const list = await Places.nearby('FD6', near, 1500);
        this.shownPlaces = list;
        $('place-status').textContent = list.length ? '가까운 순 · 이름으로 찾아도 돼요' : '';
        $('place-results').innerHTML = list.length ? list.map((p, i) => this.placeItem(p, i)).join('') : '<li class="results__hint">근처 음식점을 못 찾았어요. 이름으로 찾아 주세요</li>';
      } catch (_) {
        $('place-status').textContent = '';
        $('place-results').innerHTML = '<li class="results__hint">근처 음식점을 못 찾았어요. 이름으로 찾아 주세요</li>';
      }
    },

    /** 결과 화면이 열린 채로 다시 계산 */
    recompute() {
      if (!this.plan.start || !this.plan.stops.length) return;
      const input = this.buildInput();
      const result = window.GetsetEngine.plan(input);
      if (!result || result.tooMany) return;
      this.result = { input, result, tab: 0 };
      this.renderResult();
      $('result-body').scrollTop = 0;
      if ($('result-sheet').hidden) this.openSheet($('result-sheet'));
    },

    wireResult() {
      $('result-tabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (!b || !this.result) return;
        this.result.tab = Number(b.dataset.tab);
        track('plan_adjust', { method: 'alt_tab', tab: this.result.result.options[this.result.tab].key });
        this.renderResult();
      });
      $('result-body').addEventListener('click', (e) => {
        const ex = e.target.closest('[data-expand]');
        if (ex) {
          const d = ex.parentElement.querySelector('.card__detail');
          d.hidden = !d.hidden;
          ex.setAttribute('aria-expanded', String(!d.hidden));
          return;
        }
        const fx = e.target.closest('[data-fix]');
        if (fx) {
          const stop = this.plan.stops.find((x) => x.uid === fx.dataset.fix);
          if (stop) {
            this.fixFromResult = true;
            this.openStopSheet(stop, { precise: true });
          }
          return;
        }
        const sg = e.target.closest('[data-sug]');
        if (sg) {
          const [i, j] = sg.dataset.sug.split('|').map(Number);
          const g = this.currentSuggestions[i];
          track('suggestion_accept', { type: g.type, action: j });
          g.actions[j].run();
          if (g.actions[j].label === '괜찮아요') this.renderResult();
        }
      });
      $('btn-go').addEventListener('click', () => this.startRun());
      $('btn-ics').addEventListener('click', () => this.exportIcs());
      $('btn-share-plan').addEventListener('click', () => this.sharePlan());
    },

    // ---- 캘린더 · 공유 ----------------------------------------------------
    planText(withPlaces = true) {
      if (!this.result) return '';
      const { input, result, tab } = this.result;
      const sim = result.options[tab].sim;
      const fmt = window.GetsetEngine.fmt;
      const lines = [`[Getset] ${this.fullDay(this.date)} 일정`, `${fmt(input.startMin)} 출발`];
      sim.rows.forEach((r, p) => {
        const s = input.stops[r.i];
        lines.push(`${p + 1}. ${withPlaces ? s.place.name : Kinds.get(s.kind).label} ${fmt(r.begin)}~${fmt(r.finish).replace(/오[전후] /, '')}`);
      });
      lines.push(`→ ${fmt(sim.doneAt)} 볼일 끝${sim.endLeg ? ` · ${fmt(sim.endLeg.arrive)} 도착` : ''}`);
      return lines.join('\n');
    },

    async sharePlan() {
      const text = this.planText() + '\n\npebbleitgo.com/getset';
      track('plan_share', {});
      if (navigator.share) {
        try {
          await navigator.share({ text });
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      const ok = await copyText(text);
      this.showToast(ok ? '시간표를 복사했어요. 카톡에 붙여넣어 보내세요' : '복사하지 못했어요');
    },

    exportIcs() {
      if (!this.result) return;
      const { input, result, tab } = this.result;
      const sim = result.options[tab].sim;
      const d = Store.parseDate(this.date);
      const stamp = (min) => {
        const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
        x.setMinutes(min);
        const p = (n) => String(n).padStart(2, '0');
        return `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}T${p(x.getHours())}${p(x.getMinutes())}00`;
      };
      const escI = (v) => String(v).replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
      const now = stamp(new Date().getHours() * 60 + new Date().getMinutes());
      const ev = sim.rows.map((r, p) => {
        const s = input.stops[r.i];
        const before = Math.max(0, r.begin - r.leaveAt) + 10; // 출발 10분 전에 알림
        return [
          'BEGIN:VEVENT',
          `UID:getset-${this.date}-${p}-${Date.now()}@pebbleitgo.com`,
          `DTSTAMP:${now}`,
          `DTSTART;TZID=Asia/Seoul:${stamp(r.begin)}`,
          `DTEND;TZID=Asia/Seoul:${stamp(r.finish)}`,
          `SUMMARY:${escI(`${p + 1}. ${s.place.name}`)}`,
          `LOCATION:${escI(s.place.address || s.place.name)}`,
          `DESCRIPTION:${escI(`Getset 시간표 · ${window.GetsetEngine.fmt(r.leaveAt)} 출발 → ${window.GetsetEngine.fmt(r.arrive)} 도착`)}`,
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `DESCRIPTION:${escI(`10분 뒤 ${s.place.name}로 출발`)}`,
          `TRIGGER:-PT${before}M`,
          'END:VALARM',
          'END:VEVENT',
        ].join('\r\n');
      });
      const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pebble//Getset//KO', 'CALSCALE:GREGORIAN', ...ev, 'END:VCALENDAR'].join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
      a.download = `getset-${this.date}.ics`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      track('calendar_export', { stops: sim.rows.length });
      this.showToast('캘린더 파일을 받았어요. 열어서 캘린더 앱에 추가하세요 (출발 10분 전 알림)', { duration: 4500 });
    },

    // =================================================================
    // 진행 모드 — [도착] → [볼일 시작] → [다 끝남] → [출발] (설계문서 v1.1 §6-1)
    // =================================================================
    startRun() {
      if (!this.result) return;
      if (!this.isToday()) {
        this.showToast(`${this.relDay(this.date) || this.fullDay(this.date)} 계획이에요. 그날 열어서 [이대로 출발]을 눌러 주세요. 지금은 캘린더에 넣어 두면 좋아요.`, { duration: 5000 });
        return;
      }
      // 계획한 출발 시각보다 10분 넘게 늦게 출발하면, 지금 시각으로 다시 계산해서 출발
      const lateBy = Math.round(this.nowMin() - this.result.input.startMin);
      if (lateBy > 10) {
        this.plan.startTime = 'now';
        this.save();
        this.render();
        const input = this.buildInput();
        const result = window.GetsetEngine.plan(input);
        if (result && !result.tooMany) {
          const keep = this.result.result.options[this.result.tab].key;
          const tab = Math.max(0, result.options.findIndex((o) => o.key === keep));
          this.result = { input, result, tab };
          if (!result.ok) {
            // 지금 출발하면 약속을 못 지킴 → 출발하지 말고 경고를 먼저 보여 줌
            this.renderResult();
            $('result-body').scrollTop = 0;
            this.showToast(`지금(${fmtTime(this.nowHHMM())}) 출발하면 시간이 모자라요. 빨간 안내를 보고 볼일을 고친 뒤 다시 눌러 주세요`, { duration: 6000 });
            return;
          }
          this.renderResult();
          this.showToast(`지금 시각(${fmtTime(this.nowHHMM())}) 기준으로 다시 계산했어요 · ${window.GetsetEngine.fmt(result.options[tab].sim.doneAt)} 끝`, { duration: 4500 });
        }
      }
      const { input, result, tab } = this.result;
      const sim = result.options[tab].sim;
      const eta = {};
      sim.rows.forEach((r) => {
        const s = input.stops[r.i];
        eta[s.uid] = { arrive: r.arrive, begin: r.begin, finish: r.finish, depart: r.depart };
      });
      this.plan.run = { order: sim.rows.map((r) => input.stops[r.i].uid), eta, marks: {}, startedAt: Date.now(), done: false, doneAt: sim.doneAt };
      this.save();
      track('plan_start', { stops: sim.rows.length });
      this.hideSheetNow($('result-sheet'));
      this.renderRunBar();
      this.openRun();
    },

    runStops() {
      const run = this.plan.run;
      if (!run) return [];
      return run.order.map((uid) => this.plan.stops.find((s) => s.uid === uid)).filter(Boolean);
    },

    /** 지금 단계: arrive | start | finish | depart, 다 끝났으면 null */
    runCurrent() {
      const run = this.plan.run;
      const list = this.runStops();
      for (let i = 0; i < list.length; i++) {
        const m = run.marks[list[i].uid] || {};
        const last = i === list.length - 1;
        if (m.skip) continue;
        if (!m.arrive && !m.start) return { i, stop: list[i], step: 'arrive' };
        if (!m.start) return { i, stop: list[i], step: 'start' };
        if (!m.finish) return { i, stop: list[i], step: 'finish' };
        if (!m.depart && !last) return { i, stop: list[i], step: 'depart' };
      }
      return null;
    },

    nowMin() {
      const d = new Date();
      return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    },

    openRun() {
      this.renderRun();
      this.openSheet($('run-sheet'));
      clearInterval(this.runTimer);
      this.runTimer = setInterval(() => {
        if (!$('run-sheet').hidden) this.renderRun();
      }, 30000);
    },

    renderRun() {
      const run = this.plan.run;
      const body = $('run-body');
      if (!run) return;
      const list = this.runStops();
      const cur = this.runCurrent();
      const fmt = window.GetsetEngine.fmt;
      const t = (m) => fmt(m).replace('오전 ', '').replace('오후 ', '');

      if (!cur) {
        const lastUid = list[list.length - 1] && list[list.length - 1].uid;
        const endTs = lastUid && run.marks[lastUid] && run.marks[lastUid].finish;
        const endMin = endTs ? new Date(endTs).getHours() * 60 + new Date(endTs).getMinutes() : null;
        const n = Object.values(run.marks).filter((m) => m.arrive || m.start).length;
        $('run-title').textContent = '모두 끝났어요!';
        body.innerHTML = `<section class="summary"><p class="summary__label">실제로 끝난 시각</p><p class="summary__time">${endMin != null ? fmt(endMin) : '—'}</p>
          <p class="summary__meta">처음 계산: ${fmt(run.doneAt)}${endMin != null ? ` · ${endMin - run.doneAt > 0 ? endMin - run.doneAt + '분 늦게' : endMin - run.doneAt < 0 ? run.doneAt - endMin + '분 일찍' : '딱 맞게'}` : ''}</p></section>
          <p class="why-line">${n}곳의 기록이 다음 계산부터 반영돼요. 쓸수록 더 정확해져요.</p>
          ${this.profile.consent === null ? `<section class="sug"><p class="sug__text">이 기록을 다른 사람들 계산에도 보탤까요?<br><small class="muted">가게·기관의 주차·대기 시간만 익명으로 보내요. 집·회사·동선은 안 보내요.</small></p><div class="sug__actions"><button class="btn-soft btn-line--sm" type="button" data-run="consent-yes">보탤게요</button><button class="btn-line btn-line--sm" type="button" data-run="consent-no">안 보낼래요</button></div></section>` : ''}
          <div class="run-end">
            <button class="btn-soft" type="button" data-run="feedback">어땠는지 의견 보내기</button>
            <button class="btn-line" type="button" data-run="close">일정 마치기</button>
          </div>`;
        return;
      }

      const s = cur.stop;
      const eta = run.eta[s.uid] || {};
      const planned = { arrive: eta.arrive, start: eta.begin, finish: eta.finish, depart: eta.depart }[cur.step];
      const late = planned != null ? Math.round(this.nowMin() - planned) : 0;
      const label = { arrive: '도착했어요', start: '볼일 시작', finish: '다 끝났어요', depart: '출발해요' }[cur.step];
      const hint = {
        arrive: '주차장이나 건물에 도착하면 눌러요',
        start: '접수·번호표·카트 챙기기까지 끝나고 볼일을 시작할 때',
        finish: '볼일이 끝나면 눌러요',
        depart: '차(또는 정류장)에서 출발할 때 눌러요',
      }[cur.step];
      const isLast = cur.i === list.length - 1;
      $('run-title').textContent = `${cur.i + 1}/${list.length} · ${late >= 5 ? `예정보다 ${late}분 늦어요` : late <= -10 ? '예정보다 빨라요' : '예정대로예요'}`;
      body.innerHTML = `
        <section class="run-now${late >= 10 ? ' run-now--late' : ''}">
          <p class="run-now__kind">${esc(Kinds.get(s.kind).label)}</p>
          <p class="run-now__name">${esc(s.place.name)}</p>
          <p class="run-now__plan">예정 ${eta.begin != null ? `${t(eta.begin)} ~ ${t(eta.finish)}` : ''} · ${fmtMin(s.stay)}</p>
          ${cur.step === 'arrive' ? `<a class="btn-line run-now__map" href="${this.mapUrl(s.place)}" target="_blank" rel="noopener" data-run-map>카카오맵으로 길찾기</a>` : ''}
          <button class="run-btn" type="button" data-run="mark">${isLast && cur.step === 'finish' ? '다 끝났어요 (마지막)' : label}</button>
          <p class="run-now__hint">${hint}</p>
          <div class="run-now__more">
            ${cur.step === 'arrive' || cur.step === 'start' ? '<button class="text-btn" type="button" data-run="skipstep">이 단계 건너뛰기</button>' : ''}
            <button class="text-btn" type="button" data-run="skipstop">이 볼일 안 하기</button>
          </div>
        </section>
        ${late >= 10 ? `<button class="btn-soft run-replan" type="button" data-run="replan">남은 일정 다시 짜기</button>` : ''}
        <ol class="run-list">${list
          .map((x, i) => {
            const m = run.marks[x.uid] || {};
            const e = run.eta[x.uid] || {};
            const state = m.skip ? '안 함' : m.finish ? '끝' : i === cur.i ? '지금' : e.begin != null ? t(e.begin) : '';
            return `<li class="${i < cur.i || m.finish || m.skip ? 'is-done' : i === cur.i ? 'is-now' : ''}"><span>${i + 1}. ${esc(x.place.name)}</span><b>${state}</b></li>`;
          })
          .join('')}</ol>
        <button class="text-btn run-stop" type="button" data-run="close">일정 그만하기</button>`;
    },

    wireRun() {
      $('run-body').addEventListener('click', (e) => {
        const b = e.target.closest('[data-run]');
        if (!b) return;
        const act = b.dataset.run;
        const run = this.plan.run;
        if (act === 'mark') this.runMark();
        else if (act === 'skipstep') this.runMark(true);
        else if (act === 'skipstop') {
          const cur = this.runCurrent();
          if (!cur) return;
          run.marks[cur.stop.uid] = Object.assign(run.marks[cur.stop.uid] || {}, { skip: true });
          this.save();
          this.renderRun();
        } else if (act === 'replan') this.replan();
        else if (act === 'feedback') this.openFeedback('progress');
        else if (act === 'consent-yes' || act === 'consent-no') {
          this.profile.consent = act === 'consent-yes';
          Profile.save(this.profile);
          track('consent_set', { value: this.profile.consent, from: 'run_end' });
          this.renderRun();
          this.showToast(this.profile.consent ? '고마워요! 다음 기록부터 함께 보태요' : '알겠어요. 기록은 이 폰에서만 써요');
        }
        else if (act === 'close') {
          if (this.runCurrent() && !confirm('일정을 그만할까요? 지금까지 기록은 남아요.')) return;
          run.done = true;
          this.save();
          clearInterval(this.runTimer);
          this.closeSheet($('run-sheet'));
          this.renderRunBar();
        }
      });
      $('run-bar').addEventListener('click', () => this.openRun());
    },

    runMark(skip) {
      const run = this.plan.run;
      const cur = this.runCurrent();
      if (!cur) return;
      const m = (run.marks[cur.stop.uid] = run.marks[cur.stop.uid] || {});
      const now = Date.now();
      if (!skip) m[cur.step] = now;
      else m[cur.step + 'Skipped'] = true;
      if (skip && cur.step === 'arrive') m.arriveSkipped = true;
      if (skip && cur.step === 'start') m.start = now; // 시작은 건너뛰면 지금으로 (도착 후 시간은 기록 안 함)
      track('stop_step', { step: cur.step, skipped: !!skip });
      const list = this.runStops();
      const last = cur.i === list.length - 1;
      if (cur.step === 'depart' || (last && cur.step === 'finish')) this.learnFrom(cur.stop, m, list, cur.i);
      if (navigator.vibrate) navigator.vibrate(30);
      this.save();
      this.renderRun();
      this.renderRunBar();
    },

    /** 끝난 방문지 하나를 학습에 넣고, 동의했으면 모두의 기록 대기열에 */
    learnFrom(stop, m, list, i) {
      const min = (a, b) => (m[a] && m[b] ? (m[b] - m[a]) / 60000 : null);
      const mode = stop.mode || this.plan.mode;
      const rec = {
        key: Profile.placeKey(stop.place),
        kind: stop.kind,
        mode,
        arrive: m.arriveSkipped || m.startSkipped ? null : min('arrive', 'start'),
        stay: min('start', 'finish'),
        leave: min('finish', 'depart'),
      };
      Learn.add(rec);
      track('learn_update', { scope: 'place', kind: stop.kind });
      const mine = Profile.findMy(this.profile, stop.place);
      if (this.profile.consent === true && !mine && stop.place.id && stop.place.id !== 'current') {
        const d = new Date(m.start || Date.now());
        Learn.queueObs({
          pid: stop.place.id,
          kind: stop.kind,
          parking: this.engineStop(stop).parking,
          mode,
          weekend: d.getDay() === 0 || d.getDay() === 6,
          hour: Math.floor(d.getHours() / 2) * 2,
          arrive: rec.arrive != null ? Math.round(rec.arrive * 10) / 10 : null,
          stay: rec.stay != null ? Math.round(rec.stay * 10) / 10 : null,
          leave: rec.leave != null ? Math.round(rec.leave * 10) / 10 : null,
        });
      }
    },

    /** 늦어졌을 때: 아직 도착 안 한 볼일만 지금 시각·지금 있는 곳에서 다시 짬 */
    replan() {
      const run = this.plan.run;
      const list = this.runStops();
      const cur = this.runCurrent();
      if (!cur) return;
      const doneIdx = list.findIndex((x) => x.uid === cur.stop.uid);
      const started = run.marks[cur.stop.uid] && (run.marks[cur.stop.uid].arrive || run.marks[cur.stop.uid].start);
      const fixedPart = list.slice(0, started ? doneIdx + 1 : doneIdx);
      const remaining = list.slice(started ? doneIdx + 1 : doneIdx).filter((x) => !(run.marks[x.uid] && run.marks[x.uid].skip));
      if (!remaining.length) return this.showToast('다시 짤 볼일이 없어요');
      const here = fixedPart.length ? fixedPart[fixedPart.length - 1].place : this.plan.start;
      const input = this.buildInput();
      input.start = here;
      input.startIsNow = true;
      input.startMin = Math.round(this.nowMin()) + (started ? Math.max(0, Math.round((run.eta[cur.stop.uid] || {}).depart - (run.eta[cur.stop.uid] || {}).arrive || 0)) : 0);
      input.stops = remaining.map((x) => this.engineStop(x));
      input.end = this.plan.end.type === 'return' ? { type: 'place', place: this.plan.start } : this.plan.end;
      const r = window.GetsetEngine.plan(input);
      if (!r) return;
      const sim = r.options[0].sim;
      run.order = fixedPart.map((x) => x.uid).concat(sim.rows.map((row) => input.stops[row.i].uid));
      sim.rows.forEach((row) => {
        const s = input.stops[row.i];
        run.eta[s.uid] = { arrive: row.arrive, begin: row.begin, finish: row.finish, depart: row.depart };
      });
      run.doneAt = sim.doneAt;
      this.save();
      track('replan', { remaining: remaining.length, ok: r.ok });
      this.renderRun();
      this.showToast(`남은 ${remaining.length}곳을 다시 짰어요 · ${window.GetsetEngine.fmt(sim.doneAt)} 끝${r.ok ? '' : ' (시간이 모자라요)'}`, { duration: 4000 });
    },

    renderRunBar() {
      const run = this.plan && this.plan.run;
      const cur = run && !run.done ? this.runCurrent() : null;
      $('run-bar').hidden = !cur;
      if (cur) $('run-bar-text').textContent = `진행 중 ${cur.i + 1}/${this.runStops().length} · ${cur.stop.place.name}`;
    },

    // =================================================================
    // 내 정보 · 첫 실행 · 루틴 · 의견
    // =================================================================
    openOnboarding(steps, after, first) {
      window.GetsetOnboard.open({
        steps,
        first,
        onDone: (p, info) => {
          this.profile = Profile.load();
          this.syncHome();
          this.savePlaces();
          if (!steps) {
            if (!this.plan.start && this.profile.home) this.plan.start = this.profile.home.place;
            if (!this.plan.stops.length) this.plan.mode = this.profile.mode;
            this.save();
            track('onboarding_done', { home: !!this.profile.home, places: this.profile.places.length, consent: String(this.profile.consent), skipped: !!(info && info.skipped) });
          }
          this.render();
          if (!$('me-sheet').hidden) this.renderMe();
          if (after) after();
        },
      });
    },

    wireMe() {
      $('btn-me').addEventListener('click', () => {
        this.renderMe();
        this.openSheet($('me-sheet'));
      });
      $('me-body').addEventListener('click', (e) => {
        const b = e.target.closest('[data-me]');
        if (!b) return;
        const a = b.dataset.me;
        if (a === 'home') this.openOnboarding(['home', 'homePark']);
        else if (a === 'places') this.openOnboarding(['places']);
        else if (a === 'mode') this.openOnboarding(['mode']);
        else if (a === 'consent') this.openOnboarding(['consent']);
        else if (a === 'redo') this.openOnboarding();
        else if (a === 'feedback') this.openFeedback('me');
        else if (a === 'routines') this.openRoutines();
        else if (a === 'learn-clear') {
          if (!confirm('내 기록(실제로 걸린 시간)을 모두 지울까요?')) return;
          Learn.clear();
          this.renderMe();
          this.showToast('내 기록을 지웠어요');
        }
      });
      $('btn-home-visit').addEventListener('click', () => {
        if (!this.profile.home || !this.profile.home.place) {
          this.showToast('먼저 집을 알려 주세요');
          this.openOnboarding(['home', 'homePark'], () => this.profile.home && this.quickAdd(this.profile.home.place));
          return;
        }
        this.quickAdd(this.profile.home.place);
      });
      $('btn-routine-load').addEventListener('click', () => this.openRoutines());
      $('btn-routine-save').addEventListener('click', () => this.saveRoutine());
      $('btn-feedback-2').addEventListener('click', () => this.openFeedback('footer'));
      $('feedback-chips').addEventListener('click', (e) => {
        const b = e.target.closest('[data-fb]');
        if (!b) return;
        const ta = $('feedback-text');
        ta.value = (ta.value ? ta.value + '\n' : '') + b.dataset.fb;
        ta.focus();
      });
      $('btn-feedback-send').addEventListener('click', () => this.sendFeedback());
      $('routine-body').addEventListener('click', (e) => {
        const b = e.target.closest('[data-rt]');
        if (!b) return;
        const [act, i] = b.dataset.rt.split('|');
        const list = this.loadRoutines();
        if (act === 'load') {
          const r = list[Number(i)];
          const room = MAX_STOPS - this.plan.stops.length;
          r.stops.slice(0, room).forEach((s) => {
            const st = Store.cleanStop(Object.assign({}, s, { uid: Store.newUid() }));
            if (st) this.plan.stops.push(st);
          });
          this.save();
          this.render();
          this.closeSheet($('routine-sheet'));
          track('routine_load', { stops: r.stops.length });
          this.showToast(`'${r.name}' 볼일 ${Math.min(room, r.stops.length)}개를 넣었어요`);
        } else if (act === 'del') {
          if (!confirm('이 루틴을 지울까요?')) return;
          list.splice(Number(i), 1);
          this.saveRoutines(list);
          this.openRoutines(true);
        }
      });
    },

    renderMe() {
      const p = this.profile;
      const K = Kinds;
      const park = (id) => (id === 'none' ? '차 안 씀' : id && K.PARKING[id] ? K.PARKING[id].label : '보통 주차');
      const ls = Learn.summary();
      const buf = ((K.model.buffer || {})[p.buffer] || {}).label || '보통';
      const MODE_TXT = { car: '자동차', walk: '걸어서', bike: '자전거', transit: '대중교통' };
      $('me-body').innerHTML = `
        <div class="me-list">
          <button class="me-row" type="button" data-me="home"><span class="me-row__label">집</span><span class="me-row__value">${p.home ? `<b>${esc(p.home.place.name)}</b><small>${esc(park(p.home.parking))}${p.home.arriveMin != null ? ` · 주차하고 집 안까지 ${p.home.arriveMin}분` : ''}</small>` : '<b class="is-empty">알려 주세요</b>'}</span></button>
          <button class="me-row" type="button" data-me="places"><span class="me-row__label">자주 가는 곳</span><span class="me-row__value"><b>${p.places.length ? p.places.map((x) => esc(x.label || x.place.name)).join(', ') : '없음'}</b><small>회사·학교 등 주차 정보</small></span></button>
          <button class="me-row" type="button" data-me="mode"><span class="me-row__label">평소 이동·여유</span><span class="me-row__value"><b>${MODE_TXT[p.mode]} · ${esc(buf)}</b></span></button>
          <button class="me-row" type="button" data-me="consent"><span class="me-row__label">모두의 기록</span><span class="me-row__value"><b>${p.consent === true ? '보태는 중' : p.consent === false ? '안 보냄' : '아직 안 정함'}</b>${p.consent === true ? `<small>보낼 기록 ${Learn.queueSize()}개 (서버가 열리면 보내요)</small>` : ''}</span></button>
          <div class="me-row me-row--static"><span class="me-row__label">내 기록</span><span class="me-row__value"><b>${ls.visits}번 방문 · ${ls.places}곳</b><small>진행 모드에서 버튼을 누를수록 정확해져요</small></span>${ls.visits ? '<button class="btn-line btn-line--sm" type="button" data-me="learn-clear">지우기</button>' : ''}</div>
          <button class="me-row" type="button" data-me="routines"><span class="me-row__label">루틴</span><span class="me-row__value"><b>${this.loadRoutines().length}개</b><small>자주 하는 볼일 묶음</small></span></button>
        </div>
        <div class="me-actions">
          <button class="btn-soft" type="button" data-me="feedback">의견 보내기</button>
          <button class="btn-line" type="button" data-me="redo">처음 설정 다시 하기</button>
        </div>
        <p class="result-note">모든 정보는 이 기기에만 저장돼요. 값 파일 v${esc(K.model.version)}${K.source === 'override' ? ' (관리자 시험 값)' : ''}</p>`;
    },

    loadRoutines() {
      try {
        const r = JSON.parse(localStorage.getItem('getset:routines:v1') || '[]');
        return Array.isArray(r) ? r.filter((x) => x && x.name && Array.isArray(x.stops)) : [];
      } catch (_) {
        return [];
      }
    },
    saveRoutines(list) {
      try {
        localStorage.setItem('getset:routines:v1', JSON.stringify(list.slice(0, 20)));
      } catch (_) {}
    },
    saveRoutine() {
      if (this.plan.stops.length < 1) return;
      const name = (prompt('루틴 이름을 적어 주세요 (예: 토요일 장보기)', '') || '').trim().slice(0, 20);
      if (!name) return;
      const list = this.loadRoutines().filter((r) => r.name !== name);
      list.unshift({ name, stops: this.plan.stops.map((s) => Object.assign({}, s, { uid: undefined })) });
      this.saveRoutines(list);
      track('routine_save', { stops: this.plan.stops.length });
      this.showToast(`'${name}' 루틴으로 저장했어요`);
    },
    openRoutines(refresh) {
      const list = this.loadRoutines();
      $('routine-body').innerHTML = list.length
        ? `<ul class="rt-list">${list
            .map((r, i) => `<li><button class="rt-item" type="button" data-rt="load|${i}"><b>${esc(r.name)}</b><small>${r.stops.map((s) => esc(s.place.name)).join(' · ')}</small></button><button class="icon-del" type="button" data-rt="del|${i}" aria-label="지우기">×</button></li>`)
            .join('')}</ul><p class="result-note">누르면 지금 날짜에 볼일이 더해져요.</p>`
        : '<p class="results__hint">저장한 루틴이 없어요.<br>볼일을 넣고 "이 볼일들을 루틴으로 저장"을 눌러 보세요.</p>';
      if (!refresh) this.openSheet($('routine-sheet'));
    },

    openFeedback(from) {
      this.feedbackFrom = from;
      $('feedback-text').value = '';
      this.openSheet($('feedback-sheet'), { focus: $('feedback-text') });
    },

    async sendFeedback() {
      const msg = $('feedback-text').value.trim();
      if (!msg) {
        $('feedback-text').focus();
        return;
      }
      let text = `[Getset 의견]\n${msg}`;
      if ($('feedback-ctx').checked) {
        const ctx = this.result ? this.planText() : `${this.fullDay(this.date)} 볼일: ${this.plan.stops.map((s) => s.place.name).join(', ') || '없음'}`;
        text += `\n\n--- 참고 ---\n${ctx}\n화면 ${window.innerWidth}px · 값 v${Kinds.model.version} · ${navigator.userAgent.match(/(Android [\d.]+|iPhone OS [\d_]+|Windows|Mac OS X)/) ? RegExp.$1 : ''}`;
      }
      track('feedback_send', { from: this.feedbackFrom || '', with_ctx: $('feedback-ctx').checked });
      if (navigator.share) {
        try {
          await navigator.share({ text });
          this.closeSheet($('feedback-sheet'));
          this.showToast('고마워요! 꼭 반영할게요');
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      const ok = await copyText(text);
      this.closeSheet($('feedback-sheet'));
      this.showToast(ok ? '의견을 복사했어요. 카톡으로 보내 주세요' : '복사하지 못했어요', { duration: 4000 });
    },

    // =================================================================
    // 장소 찾기 시트
    // =================================================================
    wirePlaceSheet() {
      const input = $('place-input');
      $('place-form').addEventListener('submit', (e) => {
        e.preventDefault();
        clearTimeout(this.searchTimer);
        this.runSearch(input.value);
        input.blur(); // 키보드 내려서 결과가 보이게
      });
      input.addEventListener('input', () => {
        $('place-clear').hidden = !input.value;
        clearTimeout(this.searchTimer);
        const q = input.value.trim();
        if (!q) {
          this.searchSeq++;
          this.renderQuick();
          this.renderRecent();
          return;
        }
        this.searchTimer = setTimeout(() => this.runSearch(q), 300);
      });
      $('place-clear').addEventListener('click', () => {
        input.value = '';
        input.dispatchEvent(new Event('input'));
        input.focus();
      });
      $('place-results').addEventListener('click', (e) => {
        const retry = e.target.closest('[data-retry]');
        if (retry) return this.runSearch(input.value);
        const b = e.target.closest('[data-i]');
        if (b) this.pickPlace(this.shownPlaces[Number(b.dataset.i)]);
      });
      $('place-quick').addEventListener('click', (e) => {
        const b = e.target.closest('[data-quick]');
        if (!b) return;
        if (b.dataset.quick === 'current') this.useCurrentLocation(b);
        if (b.dataset.quick === 'home' && this.places.home) this.pickPlace(this.places.home);
      });
    },

    openPlaceSheet(mode) {
      this.pickMode = mode;
      const titles = { stop: '어디에 가세요?', start: '어디서 출발해요?', end: '어디서 끝나요?' };
      $('place-sheet-title').textContent = titles[mode];
      const input = $('place-input');
      input.value = '';
      $('place-clear').hidden = true;
      $('place-status').textContent = '';
      this.renderQuick();
      this.renderRecent();
      const sheet = $('place-sheet');
      this.openSheet(sheet, { focus: input });
    },

    renderQuick() {
      const box = $('place-quick');
      const items = [];
      if (this.pickMode !== 'stop') {
        items.push(
          `<button class="quick__btn" type="button" data-quick="current"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>현재 위치</button>`
        );
      }
      if (this.places.home) {
        items.push(
          `<button class="quick__btn" type="button" data-quick="home"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" d="M4 11 12 4l8 7v8.5a.5.5 0 0 1-.5.5H15v-5.5H9V20H4.5a.5.5 0 0 1-.5-.5z"/></svg>집</button>`
        );
      }
      box.innerHTML = items.join('');
      box.hidden = !items.length;
    },

    renderRecent() {
      const recent = this.places.recent;
      this.shownPlaces = recent;
      $('place-status').textContent = recent.length ? '최근 장소' : '';
      $('place-status').classList.toggle('place-status--label', !!recent.length);
      $('place-results').innerHTML = recent.map((p, i) => this.placeItem(p, i)).join('');
      if (!recent.length) {
        $('place-results').innerHTML = `<li class="results__hint">가게·기관 이름으로 찾아보세요.<br>지점명까지 넣으면 더 정확해요 <span class="muted">(예: 국민은행 산본)</span></li>`;
      }
    },

    placeItem(p, i) {
      const cat = (p.categoryName || '').split('>').pop().trim();
      const dist = p.distance != null && Number.isFinite(p.distance) ? fmtDist(p.distance) : '';
      return `<li><button class="result" type="button" data-i="${i}">
        <span class="result__top"><span class="result__name">${esc(p.name)}</span>${cat ? `<span class="result__cat">${esc(cat)}</span>` : ''}</span>
        <span class="result__addr">${dist ? `<b>${dist}</b>` : ''}${esc(p.address || '')}</span>
      </button></li>`;
    },

    nearPoint() {
      if (this.plan.start) return this.plan.start;
      if (this.places.home) return this.places.home;
      return null;
    },

    async runSearch(raw) {
      const q = String(raw || '').trim();
      if (!q) return;
      const seq = ++this.searchSeq;
      const status = $('place-status');
      status.classList.remove('place-status--label');
      status.textContent = '찾는 중…';
      $('place-quick').hidden = true;
      try {
        const results = await Places.search(q, this.nearPoint());
        if (seq !== this.searchSeq) return; // 더 최근 검색이 있으면 버림
        this.shownPlaces = results;
        status.textContent = results.length ? '' : '';
        $('place-results').innerHTML = results.length
          ? results.map((p, i) => this.placeItem(p, i)).join('')
          : `<li class="results__hint">‘${esc(q)}’ 검색 결과가 없어요.<br>가게는 지점명까지, 집은 도로명 주소(예: 고산로 600)로 찾아보세요.</li>`;
      } catch (err) {
        if (seq !== this.searchSeq) return;
        status.textContent = '';
        this.shownPlaces = [];
        $('place-results').innerHTML = `<li class="results__hint">장소 검색을 불러오지 못했어요.<br>인터넷 연결을 확인해 주세요.<button class="btn-line btn-line--sm results__retry" type="button" data-retry>다시 검색</button></li>`;
        track('place_search_error', { reason: String((err && err.message) || 'unknown').slice(0, 40) });
      }
    },

    async useCurrentLocation(btn) {
      btn.disabled = true;
      const label = btn.lastChild;
      const old = label.textContent;
      label.textContent = '위치 찾는 중…';
      try {
        const p = await Places.current();
        this.pickPlace(p);
      } catch (err) {
        const msg =
          err && err.message === 'denied'
            ? '위치 권한이 꺼져 있어요. 주소창 옆 자물쇠 → 위치 허용 후 다시 눌러 주세요.'
            : '현재 위치를 찾지 못했어요. 장소 이름으로 검색해 주세요.';
        this.showToast(msg, { duration: 4500 });
      } finally {
        btn.disabled = false;
        label.textContent = old;
      }
    },

    pickPlace(place) {
      if (!place) return;
      const clean = Store.cleanPlace(place);
      if (!clean) return;
      if (this.pickMode === 'meal') {
        // 식사 제안에서 고른 식당: 원하는 시간(12:00·18:00)으로 넣고 바로 다시 계산
        const stop = Store.cleanStop({ place: clean, kind: 'food', stay: this.mealPlan.stay, prefAt: this.mealPlan.prefAt, order: 'any', mode: null, parking: 'auto' });
        this.plan.stops.push(stop);
        this.save();
        this.closeSheet($('place-sheet'));
        this.render();
        track('suggestion_done', { type: 'meal' });
        setTimeout(() => this.recompute(), 250);
        return;
      }
      if (place.id !== 'current') {
        Store.pushRecent(this.places, clean);
        this.savePlaces();
      }

      if (this.pickMode === 'stop' && !this.draft) {
        // 새 볼일: 고르면 바로 목록에 (보통 시간·내 장소 주차로). 고치고 싶으면 목록에서 −/+ 또는 눌러서
        this.closeSheet($('place-sheet'));
        this.quickAdd(clean);
        return;
      }
      if (this.pickMode === 'stop') {
        // 고치는 중에 장소만 바꾼 경우
        this.hideSheetNow($('place-sheet'));
        if (this.draft && this.editingUid) {
          this.draft.place = clean;
          this.openStopSheet(null, { replace: true, keepDraft: true });
        } else if (this.draft) {
          this.draft.place = clean;
          this.openStopSheet(null, { replace: true, keepDraft: true });
        } else {
          this.openStopSheet(null, { replace: true, place: clean });
        }
        return;
      }

      this.closeSheet($('place-sheet'));
      if (this.pickMode === 'start') {
        this.plan.start = clean;
        this.save();
        this.render();
        if (clean.id !== 'current' && !this.isHome(clean)) {
          this.showToast(`출발지: ${clean.name}`, {
            actionLabel: '집으로 저장',
            duration: 5000,
            onAction: () => {
              this.places.home = clean;
              this.savePlaces();
              this.render();
              this.showToast('집으로 저장했어요. 다음부터 한 번에 고를 수 있어요.');
            },
          });
        }
      } else if (this.pickMode === 'end') {
        this.plan.end = { type: 'place', place: clean };
        this.save();
        this.render();
      }
    },

    // =================================================================
    // 볼일 시트 — 한 화면에서 끝내고 [추가하기]
    // =================================================================
    apptKey() {
      return { fixed: 'fixedAt', pref: 'prefAt', deadline: 'deadline' }[this.apptType];
    },

    wireStopSheet() {
      const sel = $('kind-select');
      sel.innerHTML = Kinds.LIST.map((k) => `<option value="${k.id}">${k.label}</option>`).join('');
      sel.addEventListener('change', () => {
        const usual = Kinds.get(this.draft.kind).stay;
        this.draft.kind = sel.value;
        this.kindAuto = false;
        if (this.draft.stay === usual) this.draft.stay = Kinds.get(sel.value).stay; // 손대지 않았으면 새 종류의 보통값으로
        this.renderStopSheet();
      });

      const step = (dir) => {
        const s = this.draft.stay;
        const d = s < 20 || (s === 20 && dir < 0) ? 5 : 10;
        this.draft.stay = Math.min(Store.STAY_MAX, Math.max(Store.STAY_MIN, s + dir * d));
        this.renderStopSheet();
      };
      $('stay-minus').addEventListener('click', () => step(-1));
      $('stay-plus').addEventListener('click', () => step(1));

      $('appt-seg').addEventListener('click', (e) => {
        const b = e.target.closest('[data-appt]');
        if (!b) return;
        const prev = this.apptType !== 'none' ? this.draft[this.apptKey()] : null;
        this.draft.fixedAt = this.draft.prefAt = this.draft.deadline = null;
        this.apptType = b.dataset.appt;
        if (this.apptType !== 'none') {
          const k = Kinds.get(this.draft.kind);
          const def = this.apptType === 'deadline' ? (k.id === 'bank' ? '16:00' : '18:00') : this.apptType === 'pref' && k.id === 'food' ? '12:00' : null;
          this.draft[this.apptKey()] = prev || def || this.apptTF.get() || null;
          this.apptTF.set(this.draft[this.apptKey()]);
        }
        $('stop-error').hidden = true;
        this.renderStopSheet();
        // 시각이 비어 있으면 바로 시 칸에 커서 (단, 그새 사용자가 칸을 눌렀으면 건드리지 않음)
        if (this.apptType !== 'none' && !this.draft[this.apptKey()]) {
          setTimeout(() => {
            if (!$('appt-tf').contains(document.activeElement)) this.apptTF.focus();
          }, 50);
        }
      });

      $('order-seg').addEventListener('click', (e) => {
        const b = e.target.closest('[data-order]');
        if (!b) return;
        this.draft.order = b.dataset.order;
        this.renderStopSheet();
      });

      $('btn-mode-change').addEventListener('click', () => {
        this.showModePick = !this.showModePick;
        this.renderStopSheet();
      });
      this.renderModes($('stop-mode'), true, (mode) => {
        this.draft.mode = mode;
        this.showModePick = false;
        this.renderStopSheet();
      });

      $('btn-parking-change').addEventListener('click', () => {
        this.showParkPick = !this.showParkPick;
        this.renderStopSheet();
      });
      $('parking-opts').addEventListener('click', (e) => {
        const b = e.target.closest('[data-parking]');
        if (!b) return;
        this.draft.parking = b.dataset.parking;
        this.showParkPick = false;
        this.renderStopSheet();
      });

      $('btn-repick').addEventListener('click', () => {
        this.hideSheetNow($('stop-sheet'));
        this.pickMode = 'stop';
        $('place-sheet-title').textContent = '어디로 바꿀까요?';
        $('place-input').value = '';
        $('place-clear').hidden = true;
        this.renderQuick();
        this.renderRecent();
        this.openSheet($('place-sheet'), { replace: true, focus: $('place-input') });
      });

      $('btn-hours').addEventListener('click', () => {
        this.draft.ignoreHours = !this.draft.ignoreHours;
        this.renderStopSheet();
      });
      $('btn-stop-save').addEventListener('click', () => this.saveStop());
      $('btn-stop-delete').addEventListener('click', () => this.deleteStop());
    },

    /**
     * @param {object|null} stop  고칠 볼일 (새로 추가면 null)
     * @param {{replace?:boolean, place?:object, keepDraft?:boolean}} opts
     */
    openStopSheet(stop, opts = {}) {
      if (stop) {
        this.editingUid = stop.uid;
        this.draft = JSON.parse(JSON.stringify(stop));
        this.kindAuto = false;
      } else if (!opts.keepDraft) {
        const kind = this.kindFor(opts.place);
        const my = Profile.findMy(this.profile, opts.place);
        this.editingUid = null;
        this.draft = { place: opts.place, kind, stay: Kinds.get(kind).stay, fixedAt: null, prefAt: null, deadline: null, order: 'any', mode: null, parking: my && my.parking !== 'auto' && kind !== 'home' ? my.parking : 'auto', ignoreHours: false };
        this.kindAuto = kind !== 'home';
      } else if (!this.editingUid) {
        const usual = Kinds.get(this.draft.kind).stay;
        const kind = this.kindFor(this.draft.place);
        if (this.draft.stay === usual) this.draft.stay = Kinds.get(kind).stay;
        this.draft.kind = kind;
        this.kindAuto = true;
      }
      const d = this.draft;
      this.apptType = d.fixedAt ? 'fixed' : d.prefAt ? 'pref' : d.deadline ? 'deadline' : 'none';
      this.apptTF.set(d.fixedAt || d.prefAt || d.deadline || null);
      this.showModePick = false;
      this.showParkPick = false;
      $('stop-error').hidden = true;
      $('stop-sheet-title').textContent = d.kind === 'home' ? '집 들르기' : this.editingUid ? '볼일 고치기' : '볼일 추가';
      $('stop-more').open = !!opts.precise;
      $('stop-more').hidden = d.kind === 'home';
      $('btn-stop-save').textContent = this.editingUid ? '저장' : '추가하기';
      $('btn-stop-delete').hidden = !this.editingUid;

      this.renderStopSheet();
      this.openSheet($('stop-sheet'), { replace: !!opts.replace });
      const scroller = document.querySelector('#stop-sheet .sheet__scroll');
      if (scroller) scroller.scrollTop = 0;
      // 결과 화면의 "이 곳 고치기"로 왔으면 주차·영업시간 쪽을 바로 보여 줌
      if (opts.precise && scroller) setTimeout(() => (scroller.scrollTop = $('stop-more').offsetTop - 12), 60);
    },

    renderStopSheet() {
      const d = this.draft;
      const k = Kinds.get(d.kind);
      $('picked-name').textContent = d.place.name;
      $('picked-addr').textContent = d.place.address || '';

      // 머무는 시간
      $('stay-value').textContent = fmtMin(d.stay);
      $('stay-minus').disabled = d.stay <= Store.STAY_MIN;
      $('stay-plus').disabled = d.stay >= Store.STAY_MAX;
      const hint = Learn.stayHint(Profile.placeKey(d.place));
      $('stay-note').textContent = hint
        ? `여기선 실제로 보통 ${fmtMin(hint.median)} 걸렸어요 (기록 ${hint.n}회) · −/+는 10분씩`
        : d.kind === 'home'
        ? '집에서 쉬거나 밥 먹는 시간이에요 · −/+는 10분씩'
        : `${window.GetsetEngine.josa(k.label, '은', '는')} 보통 ${fmtMin(k.stay)} 정도예요 · −/+는 10분씩`;

      // 정해진 시간
      $('appt-seg').querySelectorAll('[data-appt]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.appt === this.apptType)));
      $('appt-box').hidden = this.apptType === 'none';
      $('appt-help').textContent = {
        fixed: '몇 시에 도착해야 해요? 이 시각은 꼭 지켜요.',
        pref: '몇 시쯤 하고 싶어요? 최대한 맞춰 볼게요. (꼭은 아니에요)',
        deadline: '몇 시에 문을 닫아요? 그 전에 끝나게 할게요.',
        none: '',
      }[this.apptType];

      // 순서
      $('order-seg').querySelectorAll('[data-order]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.order === d.order)));

      // 가는 방법
      const dayMode = this.plan.mode;
      const mode = d.mode || dayMode;
      $('mode-line-text').innerHTML = d.mode ? `${ICON[d.mode]}<b>${MODE_LABEL[d.mode]}</b>` : `${ICON[dayMode]}<b>${MODE_LABEL[dayMode]}</b><span class="muted">(그날 기본)</span>`;
      $('btn-mode-change').textContent = this.showModePick ? '닫기' : '바꾸기';
      $('stop-mode').hidden = !this.showModePick;
      this.setModeChecked($('stop-mode'), d.mode);
      const defBtn = $('stop-mode').querySelector('[data-mode=""] span');
      if (defBtn) defBtn.textContent = `그날 기본(${MODE_LABEL[dayMode]})으로`;

      // 주차 (자동차일 때만, 집은 "내 정보"의 집 주차로 계산)
      const isCar = mode === 'car';
      const isHome = d.kind === 'home';
      $('parking-row').hidden = !isCar || isHome;
      $('kind-row').hidden = isHome;
      // 영업시간 (장소 종류의 보통 규칙)
      const hrs = this.hoursFor(d.kind, this.date);
      $('hours-row').hidden = isHome || !hrs;
      if (hrs) {
        $('hours-text').innerHTML = d.ignoreHours
          ? '<b>상관없음</b><span class="muted">(영업시간 안 따짐)</span>'
          : hrs.closed
          ? `<b>이날 보통 쉬어요</b><span class="muted">(${hrs.closedNote})</span>`
          : `<b>${fmtTime(hrs.open)} ~ ${fmtTime(hrs.close)}</b><span class="muted">(보통${hrs.breakText ? ', ' + hrs.breakText : ''})</span>`;
        $('btn-hours').textContent = d.ignoreHours ? '따지기' : '상관없음';
      }
      const pid = d.parking && d.parking !== 'auto' ? d.parking : k.parking;
      $('parking-line-text').innerHTML = `<b>${Kinds.PARKING[pid].label}</b>${d.parking === 'auto' || !d.parking ? '<span class="muted">(보통)</span>' : ''}`;
      $('btn-parking-change').textContent = this.showParkPick ? '닫기' : '바꾸기';
      $('parking-opts').hidden = !isCar || !this.showParkPick;
      $('parking-opts').innerHTML = [['auto', `잘 모르겠어요`, `${k.label}의 보통 주차장(${Kinds.PARKING[k.parking].label})으로 계산`]]
        .concat(Kinds.PARKING_IDS.map((id) => [id, Kinds.PARKING[id].label, Kinds.PARKING[id].desc]))
        .map(([id, label, desc]) => `<button class="option" type="button" role="radio" aria-checked="${(d.parking || 'auto') === id}" data-parking="${id}"><b>${label}</b><small>${desc}</small></button>`)
        .join('');

      // 이 장소에서 더해지는 시간 미리보기
      const oh = this.makeOverheadFn(this.isWeekend());
      const st = this.engineStop(d);
      const a = oh(st, mode, 'arrive', 600);
      const l = oh(st, mode, 'leave', 600);
      $('oh-note').innerHTML = `도착해서 볼일 시작까지 <b>${a.total}분</b>, 끝나고 출발까지 <b>${l.total}분</b>을 더해요${this.isWeekend() && k.busy && isCar ? ' (주말 혼잡)' : ''}<br><span class="muted">${a.parts.map(([x, m]) => `${x} ${m}분`).join(' · ')}</span>`;

      $('kind-select').value = d.kind;
    },

    saveStop() {
      const d = this.draft;
      const err = $('stop-error');
      if (this.apptType !== 'none') {
        const v = this.apptTF.get();
        if (!v) {
          err.textContent = '시각을 숫자로 넣어 주세요 (예: 오후 2시 30분)';
          err.hidden = false;
          this.apptTF.focus();
          return;
        }
        d[this.apptKey()] = v;
      }

      const stop = Store.cleanStop(Object.assign({}, d, { uid: this.editingUid || Store.newUid() }));
      if (!stop) return;
      if (this.editingUid) {
        const i = this.plan.stops.findIndex((s) => s.uid === this.editingUid);
        if (i >= 0) this.plan.stops[i] = stop;
        this.showToast('고쳤어요');
      } else {
        this.plan.stops.push(stop);
        track('stop_add', {
          category: stop.kind,
          mode: stop.mode || this.plan.mode,
          has_fixed: !!stop.fixedAt,
          has_pref: !!stop.prefAt,
          has_deadline: !!stop.deadline,
          parking: stop.parking,
        });
        this.showToast(`${stop.place.name} 넣었어요 · ${fmtMin(stop.stay)}`);
      }
      this.save();
      this.closeSheet($('stop-sheet'));
      this.render();
      if (this.fixFromResult) {
        this.fixFromResult = false;
        setTimeout(() => this.recompute(), 250);
      }
    },

    deleteStop() {
      const i = this.plan.stops.findIndex((s) => s.uid === this.editingUid);
      if (i < 0) return;
      const [removed] = this.plan.stops.splice(i, 1);
      this.save();
      this.closeSheet($('stop-sheet'));
      this.render();
      this.offerUndo(`${removed.place.name} 뺐어요`, () => {
        this.plan.stops.splice(i, 0, removed);
        this.save();
        this.render();
      });
    },

    // =================================================================
    // 끝나는 곳 시트
    // =================================================================
    wireEndSheet() {
      $('end-sheet').addEventListener('click', (e) => {
        const b = e.target.closest('[data-end]');
        if (!b) return;
        const type = b.dataset.end;
        if (type === 'place') {
          this.hideSheetNow($('end-sheet'));
          this.pickMode = 'end';
          this.openPlaceSheetReplace('end');
          return;
        }
        this.plan.end = { type, place: null };
        this.save();
        this.render();
        this.closeSheet($('end-sheet'));
      });
    },

    openPlaceSheetReplace(mode) {
      this.pickMode = mode;
      $('place-sheet-title').textContent = mode === 'end' ? '어디서 끝나요?' : '어디에 가세요?';
      $('place-input').value = '';
      $('place-clear').hidden = true;
      this.renderQuick();
      this.renderRecent();
      this.openSheet($('place-sheet'), { replace: true, focus: $('place-input') });
    },

    openEndSheet() {
      const e = this.plan.end;
      $('end-sheet').querySelectorAll('[data-end]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.end === e.type)));
      $('end-place-hint').textContent = e.type === 'place' && e.place ? `지금: ${e.place.name}` : '회사·약속 장소 등 정할 수 있어요';
      this.openSheet($('end-sheet'));
    },

    // =================================================================
    // 시트 공통 — 안드로이드 "뒤로" 버튼이 시트를 닫도록 방문 기록을 함께 관리
    // =================================================================
    wireSheets() {
      ['place-sheet', 'stop-sheet', 'end-sheet', 'time-sheet', 'result-sheet', 'date-sheet', 'me-sheet', 'run-sheet', 'routine-sheet', 'feedback-sheet', 'trip-sheet'].forEach((id) => {
        $(id).addEventListener('click', (e) => {
          if (e.target.closest('[data-close]')) this.closeSheet($(id));
        });
      });
      window.addEventListener('popstate', (e) => {
        const want = e.state && e.state.gsSheet;
        document.querySelectorAll('.sheet.is-open').forEach((s) => {
          if (s.id !== want) this.hideSheetNow(s);
        });
      });
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // 맨 위에 떠 있는 화면부터 닫기
        const open = Array.from(document.querySelectorAll('.sheet.is-open')).sort((a, b) => (Number(b.style.zIndex) || 0) - (Number(a.style.zIndex) || 0))[0];
        if (open) this.closeSheet(open);
      });
    },

    openSheet(sheet, { replace = false, focus = null } = {}) {
      sheet.hidden = false;
      // 나중에 연 화면이 항상 위에 오도록 (예: 결과 화면 위의 식당 찾기)
      this.zTop = (this.zTop || 40) + 1;
      sheet.style.zIndex = String(this.zTop);
      document.body.classList.add('has-sheet');
      try {
        if (replace && history.state && history.state.gsSheet) history.replaceState({ gsSheet: sheet.id }, '');
        else history.pushState({ gsSheet: sheet.id }, '');
      } catch (_) {}
      requestAnimationFrame(() => sheet.classList.add('is-open'));
      if (focus) setTimeout(() => focus.focus({ preventScroll: true }), 80);
    },

    closeSheet(sheet) {
      if (history.state && history.state.gsSheet === sheet.id) {
        history.back(); // popstate에서 닫힘
        return;
      }
      this.hideSheetNow(sheet);
    },

    hideSheetNow(sheet) {
      sheet.classList.remove('is-open');
      sheet.hidden = true;
      if (!document.querySelector('.sheet.is-open')) document.body.classList.remove('has-sheet');
    },

    // =================================================================
    // 토스트
    // =================================================================
    showToast(message, { actionLabel = null, duration = 2400, onAction = null } = {}) {
      const toast = $('toast');
      const act = $('toast-action');
      clearTimeout(this.toastTimer);
      $('toast-msg').textContent = message;
      act.hidden = !actionLabel;
      act.textContent = actionLabel || '';
      act.onclick = onAction
        ? () => {
            this.hideToast();
            onAction();
          }
        : null;
      toast.hidden = false;
      requestAnimationFrame(() => toast.classList.add('is-visible'));
      this.toastTimer = setTimeout(() => this.hideToast(), duration);
      const sr = $('sr-status');
      sr.textContent = '';
      setTimeout(() => (sr.textContent = message), 30);
    },

    hideToast() {
      const toast = $('toast');
      clearTimeout(this.toastTimer);
      toast.classList.remove('is-visible');
      this.toastTimer = setTimeout(() => {
        if (!toast.classList.contains('is-visible')) toast.hidden = true;
      }, 200);
    },

    offerUndo(message, undo) {
      this.showToast(message, { actionLabel: '되돌리기', duration: 6000, onAction: undo });
    },

    // =================================================================
    // PWA: 서비스워커 (새 버전 배포 시 한 번만 자동 새로고침)
    // =================================================================
    registerServiceWorker() {
      if (!('serviceWorker' in navigator)) return;
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloaded || document.querySelector('.sheet.is-open')) return;
        reloaded = true;
        window.location.reload();
      });
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').catch((err) => console.warn('[Getset] service worker 등록 실패:', err));
      });
    },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /** "14:30" → "오후 2:30" */
  function fmtTime(t) {
    const [h, m] = t.split(':').map(Number);
    const ap = h < 12 ? '오전' : '오후';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${ap} ${h12}:${String(m).padStart(2, '0')}`;
  }

  /** 90 → "1시간 30분", 60 → "1시간", 20 → "20분" */
  function fmtMin(m) {
    if (m < 60) return `${m}분`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}시간 ${r}분` : `${h}시간`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (_) {}
      ta.remove();
      return ok;
    }
  }

  function fmtDist(m) {
    return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}km`;
  }

  window.GetsetApp = App;
  App.init();
})();
