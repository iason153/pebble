'use strict';

/**
 * Getset — 화면 동작 (v1.2: "몇 시에 나가야 하는지" 중심)
 *
 * 화면 흐름
 *   [오늘][내일][달력] → 그날 일정 (날짜마다 따로 저장)
 *   [갈 곳 넣기] 장소 찾기 → "몇 시까지 가요?" → 목록에
 *   [할 일 넣기] 약국·주유… 고르면 가는 길에 가장 덜 돌아가는 곳을 앱이 골라 넣음
 *   [나갈 시간 보기] → engine.js → "○시 ○분에 나가세요" + 식사·빈 시간·주차장 카드 + 알림·가족에게 보내기
 *   다녀온 뒤: "시간 맞았어요?" 한 번 묻고 → 다음 계산에 반영 (learn.js)
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
  const Tasks = window.GetsetTasks;
  const Engine = window.GetsetEngine;
  const track = (name, params) => {
    if (typeof window.pebbleTrack === 'function') window.pebbleTrack(name, params);
  };

  const MAX_STOPS = 12;
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  const DEFAULT_START = 9 * 60; // 약속 시간이 하나도 없는 날(오늘 말고)은 오전 9시에 나가는 걸로

  const ICON = {
    car: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" d="M5 16.5V12l1.8-4.6A2 2 0 0 1 8.7 6h6.6a2 2 0 0 1 1.9 1.4L19 12v4.5M5 12h14M4 16.5h16v1.8a.7.7 0 0 1-.7.7H17.5a.7.7 0 0 1-.7-.7v-1.1H7.2v1.1a.7.7 0 0 1-.7.7H4.7a.7.7 0 0 1-.7-.7z"/><circle cx="8" cy="14.3" r="1" fill="currentColor"/><circle cx="16" cy="14.3" r="1" fill="currentColor"/></svg>',
    walk: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="13" cy="4.6" r="1.9" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="m10.5 21 1.6-5.4-2.4-2.4.9-4.6M10.6 8.6 7.5 10.4l-.8 3.1M10.6 8.6l2.6.2 2 3 2.6.8M12.1 15.6l2.6 2 1 3.4"/></svg>',
    bike: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="6" cy="16" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="16" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m6 16 3.6-7h5.2L18 16M9.6 9l2.6 7h-6M12.6 6h2.4l1.2 3"/></svg>',
    transit: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="5" y="3.5" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M5 11h14" stroke="currentColor" stroke-width="1.9"/><circle cx="8.6" cy="14.2" r="1" fill="currentColor"/><circle cx="15.4" cy="14.2" r="1" fill="currentColor"/><path d="m8 17.5-1.6 3M16 17.5l1.6 3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    cal: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    minus: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 12h12" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 6v12M6 12h12" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M7 7l10 10M17 7 7 17"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  const MODE_LABEL = { car: '자동차', walk: '도보', bike: '자전거', transit: '대중교통' };
  const MODE_VERB = { car: '운전', walk: '걷기', bike: '자전거', transit: '대중교통' };
  const PUBLIC_LOT = /(공영|공용|시영|구영|군영|노상|환승|공공|주민센터|행정복지|구청|시청|군청|도서관|체육)/;

  const App = {
    plans: null, // 날짜별 계획
    date: null, // 지금 보고 있는 날짜
    places: null,
    saveWarned: false,

    pickMode: 'stop', // 장소 찾기: stop | start | end | meal | cafe | taskpick
    searchSeq: 0,
    searchTimer: null,

    draft: null, // 자세히 고치기 시트에서 고치는 중인 일정
    editingUid: null,
    apptType: 'none',

    nearCache: new Map(), // 근처 검색 결과 (할 일 넣기)
    dismissed: new Set(), // 닫은 제안 카드 (날짜|종류)

    get plan() {
      return this.plans[this.date];
    },

    init() {
      this.plans = Store.loadPlans();
      this.places = Store.loadPlaces();
      this.profile = Profile.load();
      this.syncHome();
      // 저녁 6시가 넘었고 오늘 넣은 일정이 없으면 "내일"부터 보여 줌
      const today = Store.todayStr();
      const late = new Date().getHours() >= 18 && !(this.plans[today] && this.plans[today].stops.length);
      this.date = late ? Store.addDays(today, 1) : today;
      this.ensurePlan(this.date);

      this.startTF = window.GetsetTimeField($('start-tf'), { onChange: () => ($('time-error').hidden = true) });
      this.whenTF = window.GetsetTimeField($('when-tf'), { onChange: () => ($('when-error').hidden = true) });
      this.apptTF = window.GetsetTimeField($('appt-tf'), {
        onChange: (v) => {
          if (this.draft && this.apptType !== 'none') this.draft[this.apptKey()] = v;
          $('stop-error').hidden = true;
        },
      });

      this.wireDate();
      this.wireTrip();
      this.wireStops();
      this.wireWhen();
      this.wireTasks();
      this.wirePlaceSheet();
      this.wireStopSheet();
      this.wireEndSheet();
      this.wireSheets();
      this.wireResult();
      this.wireAsk();
      $('btn-share').addEventListener('click', () => window.GetsetShare.share('header'));
      $('btn-plan').addEventListener('click', () => this.showPlan());
      window.GetsetInstall.init({
        appName: 'Getset',
        track,
        showToast: (m, o) => this.showToast(m, o),
        openSheet: (s) => this.openSheet(s),
        closeSheet: (s) => this.closeSheet(s),
      });

      this.wireMe();
      this.refreshDone();
      this.render();
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
      // 다른 앱에 다녀와도 그대로: 돌아오면 지난 일정만 "다녀옴"으로 정리하고 다시 그림
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (this.refreshDone()) this.save();
        this.render();
      });
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

    /** 그 날짜 계획을 만들고, 출발지가 비어 있으면 집으로 */
    ensurePlan(date) {
      const p = Store.planFor(this.plans, date);
      if (!p.start && this.profile.home && this.profile.home.place) p.start = this.profile.home.place;
      return p;
    },

    // =================================================================
    // 날짜 — 오늘 / 내일 / 달력
    // =================================================================
    isToday(date = this.date) {
      return date === Store.todayStr();
    },

    isWeekend(date = this.date) {
      const d = Store.parseDate(date).getDay();
      return d === 0 || d === 6;
    },

    /** "오늘" / "내일" / "모레" / "어제" / "" */
    relDay(date) {
      const diff = Math.round((Store.parseDate(date) - Store.parseDate(Store.todayStr())) / 86400000);
      return diff === 0 ? '오늘' : diff === 1 ? '내일' : diff === 2 ? '모레' : diff === -1 ? '어제' : '';
    },

    /** "10월 3일 (토)" */
    fullDay(date) {
      const d = Store.parseDate(date);
      return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;
    },

    /** "10/3 토" */
    shortDay(date) {
      const d = Store.parseDate(date);
      return `${d.getMonth() + 1}/${d.getDate()} ${WEEK[d.getDay()]}`;
    },

    dayName(date = this.date) {
      return this.relDay(date) || this.fullDay(date);
    },

    wireDate() {
      $('day-tabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-day]');
        if (!b) return;
        if (b.dataset.day === 'cal') this.openDateSheet();
        else if (b.dataset.day !== this.date) this.selectDate(b.dataset.day);
      });
      $('btn-home').addEventListener('click', () => this.restart());
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
      track('calendar_open', {});
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

    /** 달력 + 그 아래 "넣어 둔 일정" 한눈에 보기 */
    renderCalendar() {
      const today = Store.todayStr();
      $('date-quick').innerHTML = [0, 1, 2]
        .map((n) => {
          const d = Store.addDays(today, n);
          const on = d === this.date;
          return `<button class="date-quick__btn" type="button" data-date="${d}" aria-pressed="${on}"><b>${this.relDay(d)}</b><small>${this.shortDay(d)}</small>${this.hasStops(d) ? '<span class="cal__dot"></span>' : ''}</button>`;
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
        const n = this.hasStops(d) ? this.plans[d].stops.length : 0;
        cells.push(
          `<button class="${cls.join(' ')}" type="button" data-date="${d}" ${past ? 'disabled' : ''} aria-label="${this.fullDay(d)}${n ? `, 일정 ${n}개` : ''}"${d === this.date ? ' aria-current="date"' : ''}>${day}${n ? '<span class="cal__dot"></span>' : ''}</button>`
        );
      }
      $('cal-grid').innerHTML = cells.join('');

      // 넣어 둔 일정 한눈에 (오늘부터)
      const dates = Object.keys(this.plans).filter((d) => d >= today && this.hasStops(d)).sort();
      $('agenda').innerHTML = dates.length
        ? `<p class="agenda__title">넣어 둔 일정</p>` +
          dates
            .map((d) => {
              const items = this.plans[d].stops
                .slice()
                .sort((a, b) => (this.stopTime(a) || '99') .localeCompare(this.stopTime(b) || '99'))
                .map((s) => `<li>${this.stopTime(s) ? `<b>${fmtTime(this.stopTime(s))}</b> ` : ''}${esc(this.stopTitle(s))}</li>`)
                .join('');
              return `<button class="agenda__day${d === this.date ? ' is-on' : ''}" type="button" data-date="${d}"><span class="agenda__date"><b>${this.relDay(d) || this.shortDay(d)}</b>${this.relDay(d) ? `<small>${this.shortDay(d)}</small>` : ''}</span><ul class="agenda__items">${items}</ul></button>`;
            })
            .join('')
        : '<p class="agenda__empty">아직 넣어 둔 일정이 없어요.<br>날짜를 누르면 그날 일정을 넣을 수 있어요.</p>';
    },

    /** 맨 위: [오늘] [내일] [달력] — 다른 날을 골랐으면 달력 칸에 그 날짜가 보임 */
    renderDayTabs() {
      const today = Store.todayStr();
      const tom = Store.addDays(today, 1);
      const tab = (d, label) => {
        const on = d === this.date;
        return `<button class="day-tab${on ? ' is-on' : ''}" type="button" data-day="${d}" aria-pressed="${on}"><b>${label}</b><small>${this.shortDay(d)}</small>${this.hasStops(d) && !on ? '<span class="cal__dot"></span>' : ''}</button>`;
      };
      const other = this.date !== today && this.date !== tom;
      const others = Object.keys(this.plans).some((d) => d > tom && this.hasStops(d));
      $('day-tabs').innerHTML =
        tab(today, '오늘') +
        tab(tom, '내일') +
        `<button class="day-tab day-tab--cal${other ? ' is-on' : ''}" type="button" data-day="cal" aria-pressed="${other}" aria-label="달력 열기">${ICON.cal}<small>${other ? this.shortDay(this.date) : '달력'}</small>${others && !other ? '<span class="cal__dot"></span>' : ''}</button>`;
      $('day-q').textContent = `${this.relDay(this.date) || this.fullDay(this.date)} 뭐 있어요?`;
    },

    /**
     * 로고를 누르면: 오늘로 돌아가서 넣던 일정을 비우고 처음부터 (되돌리기 가능)
     * 다른 날짜에 넣어 둔 계획·내 정보·기록은 건드리지 않음
     */
    restart() {
      document.querySelectorAll('.sheet.is-open').forEach((sh) => this.hideSheetNow(sh));
      window.scrollTo({ top: 0, behavior: 'smooth' });
      const today = Store.todayStr();
      const plan = this.plans[today];
      const hadStops = plan && plan.stops.length;
      this.date = today;
      this.ensurePlan(today);
      this.result = null;
      if (!hadStops) {
        this.render();
        return;
      }
      const snapshot = JSON.parse(JSON.stringify(this.plans[today]));
      Object.assign(this.plans[today], { stops: [], startTime: 'auto', sched: null, asked: {}, done: [] });
      if (this.profile.home && this.profile.home.place) this.plans[today].start = this.profile.home.place;
      this.save();
      this.render();
      track('restart', { stops: snapshot.stops.length });
      this.offerUndo('오늘 일정을 비웠어요', () => {
        this.plans[today] = snapshot;
        this.date = today;
        this.save();
        this.render();
      });
    },

    selectDate(date) {
      this.date = date;
      this.ensurePlan(date);
      this.result = null;
      this.save();
      if (!$('date-sheet').hidden) this.closeSheet($('date-sheet'));
      this.render();
      track('date_select', { days_ahead: Math.round((Store.parseDate(date) - Store.parseDate(Store.todayStr())) / 86400000) });
    },

    // =================================================================
    // 출발 정보 (출발지 · 나가는 시각 · 끝나는 곳 · 그날 기본 이동수단)
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
        this.replanIfOpen();
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

    nowMin() {
      const d = new Date();
      return d.getHours() * 60 + d.getMinutes();
    },

    /** 목록 아래 한 줄: "집에서 출발 · 자동차 · 끝나면 집으로" */
    renderTripLine() {
      const st = this.plan.start;
      const from = !st ? '<b class="is-empty">출발지 정하기</b>' : this.isHome(st) ? '집에서 출발' : `${esc(st.name.length > 10 ? st.name.slice(0, 9) + '…' : st.name)}에서 출발`;
      const t = this.plan.startTime;
      const e = this.plan.end;
      const end = e.type === 'none' ? '' : e.type === 'place' && e.place ? ` · 끝나면 ${esc(e.place.name.length > 8 ? e.place.name.slice(0, 7) + '…' : e.place.name)}` : this.isHome(st) ? ' · 끝나면 집으로' : ' · 끝나면 돌아오기';
      $('trip-line-text').innerHTML = `${from}${t !== 'auto' ? ` · <b>${fmtTime(t)}</b>` : ''} · ${MODE_LABEL[this.plan.mode]}${end}`;
    },

    renderTime() {
      const t = this.plan.startTime;
      $('time-name').textContent = t === 'auto' ? '약속 시간에 맞춰 알아서' : `${fmtTime(t)}에 나가기`;
      $('time-sub').textContent = t === 'auto' ? '약속이 없으면 오늘은 지금, 다른 날은 오전 9시' : '눌러서 바꾸기';
    },

    openTimeSheet() {
      const opts = [['auto', '알아서 맞추기', '약속 시간에 맞춰요']].concat(
        this.isToday()
          ? [[this.suggestTime(10), '10분 뒤'], [this.suggestTime(30), '30분 뒤'], [this.suggestTime(60), '1시간 뒤']]
          : [['08:00'], ['09:00'], ['10:00'], ['13:00'], ['14:00']]
      );
      const cur = this.plan.startTime;
      $('time-options').classList.toggle('time-chips--2', opts.length === 4);
      $('time-options').innerHTML = opts
        .map(([v, label, sub]) => {
          const on = v === cur;
          const t = v === 'auto' ? sub : fmtTime(v);
          return `<button class="time-chip" type="button" aria-pressed="${on}" data-time="${v}">${label ? `<b>${label}</b><small>${t}</small>` : `<b>${t}</b>`}</button>`;
        })
        .join('');
      this.startTF.set(cur === 'auto' ? null : cur);
      $('time-error').hidden = true;
      this.openSheet($('time-sheet'));
    },

    setStartTime(v) {
      this.plan.startTime = v === 'auto' ? 'auto' : v;
      this.save();
      this.render();
      this.closeSheet($('time-sheet'));
      this.showToast(v === 'auto' ? '약속 시간에 맞춰 나갈 시간을 알려 줄게요' : `${fmtTime(v)}에 나가는 걸로 계산해요`);
      setTimeout(() => this.replanIfOpen(), 250);
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
        $('end-name').textContent = e.type === 'none' ? '상관없어요 (마지막 일정에서 끝)' : '출발지로 돌아오기';
        $('end-sub').hidden = true;
      }
      this.renderTime();
      this.setModeChecked($('day-mode'), this.plan.mode);
      this.renderTripLine();
      this.renderDayTabs();
    },

    // =================================================================
    // 일정 목록 — 이름 · 시간 · [−]20분[+] · ✕ 만 보임 (숨은 설정 없음)
    // =================================================================
    wireStops() {
      $('btn-add-place').addEventListener('click', () => this.startAddPlace());
      $('btn-add-task').addEventListener('click', () => this.startAddTask());
      $('stop-list').addEventListener('click', (e) => {
        const st = e.target.closest('[data-stay-step]');
        if (st) {
          const [uid, dir] = st.dataset.stayStep.split('|');
          this.stepStay(uid, Number(dir));
          return;
        }
        const w = e.target.closest('[data-when]');
        if (w) return this.editWhen(w.dataset.when);
        const d = e.target.closest('[data-del]');
        if (d) return this.removeStop(d.dataset.del);
        const u = e.target.closest('[data-undone]');
        if (u) {
          this.plan.done = this.plan.done.filter((x) => x !== u.dataset.undone);
          this.save();
          this.render();
          return;
        }
        const b = e.target.closest('[data-uid]');
        if (b) this.openDetail(b.dataset.uid);
      });
      $('btn-clear').addEventListener('click', () => {
        const snap = JSON.parse(JSON.stringify(this.plan));
        const date = this.date;
        Object.assign(this.plan, { stops: [], sched: null, asked: {}, done: [] });
        this.result = null;
        this.save();
        this.render();
        this.offerUndo('일정을 모두 지웠어요', () => {
          this.plans[date] = snap;
          this.save();
          this.render();
        });
      });
    },

    tooMany() {
      if (this.plan.stops.length < MAX_STOPS) return false;
      this.showToast(`하루에 ${MAX_STOPS}개까지 넣을 수 있어요`);
      return true;
    },

    startAddPlace() {
      if (this.tooMany()) return;
      this.editingUid = null;
      this.draft = null;
      this.openPlaceSheet('stop');
    },

    startAddTask() {
      if (this.tooMany()) return;
      this.openSheet($('task-sheet'));
    },

    /** 목록·달력에 보이는 이름 */
    stopTitle(s) {
      if (s.block) return `${s.place.name} (시간만 비움)`;
      const t = s.task && Tasks.get(s.task);
      return t ? t.label : s.place.name;
    },

    /** 시간 약속이 있으면 "HH:MM" */
    stopTime(s) {
      return s.fixedAt || s.prefAt || s.deadline || null;
    },

    whenText(s) {
      if (s.fixedAt) return `${fmtTime(s.fixedAt)}까지`;
      if (s.prefAt) return `${fmtTime(s.prefAt)}쯤`;
      if (s.deadline) return `${fmtTime(s.deadline)} 전에 끝`;
      return '아무 때나';
    },

    renderStops() {
      const stops = this.plan.stops;
      const done = new Set(this.plan.done || []);
      $('stop-list').innerHTML = stops
        .map((s) => {
          const t = s.task && Tasks.get(s.task);
          const kind = Kinds.get(s.kind);
          const isDone = done.has(s.uid);
          const ico = s.block ? '🍚' : t ? t.icon : '';
          const sub = s.block ? '어디서든 · 이 시간만 비워 둬요' : t ? `→ ${s.place.name}${s.pinned ? '' : ' (가는 길에 맞춰 골라요)'}` : kind.label;
          const hrs = !s.block && !s.ignoreHours ? this.hoursFor(s.kind, this.date) : null;
          const closed = hrs && hrs.closed ? `<span class="item__warn">${esc(hrs.closedNote)}</span>` : '';
          if (isDone) {
            return `<li class="item item--done"><div class="item__top"><span class="item__name"><span class="item__title">${ico ? ico + ' ' : ''}${esc(this.stopTitle(s))}</span><span class="item__sub">다녀온 걸로 봤어요</span></span><button class="btn-line btn-line--sm" type="button" data-undone="${s.uid}">다시 넣기</button></div></li>`;
          }
          return `<li class="item${s.block ? ' item--block' : ''}" data-item="${s.uid}">
            <div class="item__top">
              <button class="item__name" type="button" data-uid="${s.uid}" aria-label="${esc(this.stopTitle(s))} 자세히 고치기">
                <span class="item__title">${ico ? ico + ' ' : ''}${esc(this.stopTitle(s))}</span>
                <span class="item__sub">${esc(sub)}</span>
              </button>
              <button class="item__del" type="button" data-del="${s.uid}" aria-label="${esc(this.stopTitle(s))} 빼기">${ICON.x}</button>
            </div>
            ${closed}
            <div class="item__row">
              <button class="item__when${this.stopTime(s) ? ' is-set' : ''}" type="button" data-when="${s.uid}" aria-label="시간 정하기: ${this.whenText(s)}">${ICON.clock}<span>${this.whenText(s)}</span></button>
              <div class="item__stay" role="group" aria-label="머무는 시간">
                <button class="item__btn" type="button" data-stay-step="${s.uid}|-1" aria-label="머무는 시간 줄이기"${s.stay <= Store.STAY_MIN ? ' disabled' : ''}>${ICON.minus}</button>
                <span class="item__min">${fmtMin(s.stay)}</span>
                <button class="item__btn" type="button" data-stay-step="${s.uid}|1" aria-label="머무는 시간 늘리기"${s.stay >= Store.STAY_MAX ? ' disabled' : ''}>${ICON.plus}</button>
              </div>
            </div>
          </li>`;
        })
        .join('');
      const n = stops.length;
      const live = stops.filter((s) => !done.has(s.uid)).length;
      $('stops-empty').hidden = n > 0;
      $('trip-line').hidden = n === 0;
      $('btn-clear').hidden = n === 0;
      $('btn-plan').disabled = live === 0;
      $('plan-label').textContent = live ? '나갈 시간 보기' : n ? '남은 일정이 없어요' : '일정을 먼저 넣어요';
      $('plan-meta').textContent = live ? `일정 ${live}개` : '';
    },

    /** 새 일정 넣기 (갈 곳) */
    addStop(place, extra = {}) {
      const kind = this.kindFor(place);
      const my = Profile.findMy(this.profile, place);
      const stop = Store.cleanStop(
        Object.assign(
          { place, kind, stay: Kinds.get(kind).stay, order: 'any', mode: null, parking: my && my.parking !== 'auto' && kind !== 'home' ? my.parking : 'auto' },
          extra
        )
      );
      if (!stop) return null;
      const hint = Learn.stayHint(Profile.placeKey(place));
      if (hint && extra.stay == null) stop.stay = Math.max(Store.STAY_MIN, Math.round(hint.median / 5) * 5);
      this.plan.stops.push(stop);
      this.save();
      this.render();
      track('stop_add', { category: stop.kind, mode: this.plan.mode, has_fixed: !!stop.fixedAt, has_pref: !!stop.prefAt, task: stop.task || '' });
      const li = document.querySelector(`#stop-list [data-item="${stop.uid}"]`);
      if (li) {
        li.classList.add('is-new');
        li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      return stop;
    },

    /** 목록에서 바로 머무는 시간 조절: 20분까지 5분, 그 위로 10분씩 */
    stepStay(uid, dir) {
      const st = this.plan.stops.find((x) => x.uid === uid);
      if (!st) return;
      const v = st.stay;
      const d = v < 20 || (v === 20 && dir < 0) ? 5 : 10;
      st.stay = Math.min(Store.STAY_MAX, Math.max(Store.STAY_MIN, v + dir * d));
      this.save();
      this.renderStops();
    },

    removeStop(uid) {
      const i = this.plan.stops.findIndex((s) => s.uid === uid);
      if (i < 0) return;
      const [removed] = this.plan.stops.splice(i, 1);
      this.save();
      this.render();
      this.replanIfOpen();
      this.offerUndo(`${this.stopTitle(removed)} 뺐어요`, () => {
        this.plan.stops.splice(i, 0, removed);
        this.save();
        this.render();
        this.replanIfOpen();
      });
    },

    /** 이름을 누르면: 시간만 비운 칸은 시간 고치기, 나머지는 자세히 고치기(주차·영업시간 등) */
    openDetail(uid) {
      const s = this.plan.stops.find((x) => x.uid === uid);
      if (!s) return;
      if (s.block) return this.editWhen(uid);
      this.openStopSheet(s);
    },

    render() {
      this.renderTrip();
      this.renderStops();
      this.renderAsk();
    },

    // =================================================================
    // "몇 시까지 가요?" — 갈 곳을 고른 바로 다음, 그리고 목록의 시간 버튼
    // =================================================================
    wireWhen() {
      $('btn-when-ok').addEventListener('click', () => {
        const v = this.whenTF.get();
        if (!v) {
          $('when-error').textContent = '시와 분을 숫자로 넣어 주세요 (예: 오후 2시 30분)';
          $('when-error').hidden = false;
          this.whenTF.focus();
          return;
        }
        this.finishWhen(v);
      });
      $('btn-when-any').addEventListener('click', () => this.finishWhen(null));
    },

    /** @param {{place?:object, uid?:string}} ctx */
    openWhen(ctx, { replace = false } = {}) {
      const s = ctx.uid ? this.plan.stops.find((x) => x.uid === ctx.uid) : null;
      const soft = !!(s && (s.block || s.prefAt)); // 식사처럼 "그쯤"이면 되는 일
      this.whenCtx = Object.assign({ soft }, ctx);
      const name = s ? this.stopTitle(s) : ctx.place.name;
      $('when-title').textContent = soft ? '몇 시쯤 해요?' : '몇 시까지 가요?';
      $('when-place').textContent = name;
      $('when-help').textContent = soft ? '이 시각쯤에 하도록 맞춰요. 꼭은 아니에요.' : '이 시각에 맞춰 도착하도록, 나갈 시간을 알려 줘요.';
      $('btn-when-ok').textContent = soft ? '이 시간쯤 할게요' : '이 시간까지 갈게요';
      this.whenTF.set(s ? this.stopTime(s) : null);
      $('when-error').hidden = true;
      this.openSheet($('when-sheet'), { replace });
      if (!s || !this.stopTime(s)) {
        setTimeout(() => {
          if (!$('when-tf').contains(document.activeElement)) this.whenTF.focus();
        }, 120);
      }
    },

    editWhen(uid) {
      const s = this.plan.stops.find((x) => x.uid === uid);
      if (!s) return;
      if (s.deadline) return this.openStopSheet(s); // "문 닫기 전"은 자세히 고치기에서
      this.openWhen({ uid });
    },

    finishWhen(v) {
      const ctx = this.whenCtx;
      if (!ctx) return;
      this.whenCtx = null;
      this.closeSheet($('when-sheet'));
      if (ctx.uid) {
        const s = this.plan.stops.find((x) => x.uid === ctx.uid);
        if (!s) return;
        s.fixedAt = s.prefAt = s.deadline = null;
        if (v) s[ctx.soft ? 'prefAt' : 'fixedAt'] = v;
        this.save();
        this.render();
      } else {
        const stop = this.addStop(ctx.place, v ? { fixedAt: v } : {});
        if (!stop) return;
        const hrs = this.hoursFor(stop.kind, this.date);
        this.showToast(hrs && hrs.closed ? `${stop.place.name}: ${hrs.closedNote}` : `${stop.place.name} 넣었어요${v ? ` · ${fmtTime(v)}까지` : ''}`);
      }
      setTimeout(() => this.replanIfOpen(), 250);
    },

    // =================================================================
    // 할 일 넣기 — 장소는 앱이 "가는 길에 가장 덜 돌아가는 곳"으로 고름
    // =================================================================
    wireTasks() {
      $('task-grid').innerHTML = Tasks.LIST.map((t) => `<button class="task" type="button" data-task="${t.id}"><span class="task__ico" aria-hidden="true">${t.icon}</span><b>${t.label}</b></button>`).join('');
      $('task-grid').addEventListener('click', (e) => {
        const b = e.target.closest('[data-task]');
        if (b) this.addTask(b.dataset.task);
      });
      $('cand-list').addEventListener('click', (e) => {
        const b = e.target.closest('[data-cand]');
        if (!b) return;
        const s = this.plan.stops.find((x) => x.uid === this.candUid);
        const c = this.candShown[Number(b.dataset.cand)];
        if (!s || !c) return;
        this.setTaskPlace(s, c);
        this.closeSheet($('cand-sheet'));
      });
      $('btn-cand-search').addEventListener('click', () => {
        this.hideSheetNow($('cand-sheet'));
        this.pickMode = 'taskpick';
        this.openPlaceSheetReplace('taskpick');
      });
      $('lot-list').addEventListener('click', (e) => {
        const b = e.target.closest('[data-lot]');
        if (!b) return;
        const s = this.plan.stops.find((x) => x.uid === this.lotUid);
        if (!s) return;
        if (b.dataset.lot === 'none') s.lot = null;
        else {
          const l = this.lotShown[Number(b.dataset.lot)];
          s.lot = { place: Store.cleanPlace(l.place), pub: l.pub, walk: l.walk };
          track('lot_pick', { public: l.pub, walk: l.walk });
        }
        this.save();
        this.closeSheet($('lot-sheet'));
        setTimeout(() => this.showPlan({ keepScroll: true }), 250);
      });
    },

    /** 근처 검색의 기준점: 출발지 + 장소가 정해진 일정들 (최대 5곳) */
    taskPoints() {
      const pts = [];
      const add = (p) => {
        if (p && Number.isFinite(p.lat) && !pts.some((q) => Engine.distM(p, q) < 300)) pts.push(p);
      };
      add(this.plan.start);
      const done = new Set(this.plan.done || []);
      this.plan.stops.forEach((s) => {
        if (!s.block && !s.task && !done.has(s.uid)) add(s.place);
      });
      if (this.plan.end.type === 'place') add(this.plan.end.place);
      return pts.slice(0, 5);
    },

    /** 그 분류의 근처 장소를 기준점마다 찾아 합침 (같은 검색은 기억해 둠). 실패한 기준점은 건너뜀 */
    async nearbyAll(cat, pts) {
      const lists = await Promise.all(
        pts.map((p) => {
          const key = `${cat}|${p.lat.toFixed(3)}|${p.lng.toFixed(3)}`;
          if (this.nearCache.has(key)) return this.nearCache.get(key);
          return Places.nearby(cat, p, 2000)
            .then((r) => {
              this.nearCache.set(key, r);
              return r;
            })
            .catch(() => []);
        })
      );
      const seen = new Map();
      lists.flat().forEach((p) => {
        const c = Store.cleanPlace(p);
        if (c && !seen.has(c.id || c.name)) seen.set(c.id || c.name, c);
      });
      const near = (c) => Math.min(...pts.map((p) => Engine.distM(p, c)));
      return Array.from(seen.values())
        .sort((a, b) => near(a) - near(b))
        .slice(0, 15);
    },

    withTimeout(promise, ms) {
      return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
    },

    async addTask(id) {
      const t = Tasks.get(id);
      if (!t) return;
      this.closeSheet($('task-sheet'));
      const pts = this.taskPoints();
      if (!pts.length) {
        this.showToast('먼저 어디서 출발하는지 정해 주세요');
        this.openPlaceSheet('start');
        return;
      }
      this.showToast(`가까운 ${t.label} 찾는 중…`, { duration: 6000 });
      const list = (await this.withTimeout(this.nearbyAll(t.cat, pts), 7000)) || [];
      if (!list.length) {
        this.showToast(`근처에서 ${t.label} 장소를 못 찾았어요. 이름으로 찾아 넣어 주세요`, { duration: 4500 });
        setTimeout(() => {
          this.startAddPlace();
          $('place-input').value = t.label;
          $('place-input').dispatchEvent(new Event('input'));
        }, 300);
        return;
      }
      const place = list[0];
      const kind = t.kind && Kinds.get(t.kind).id === t.kind ? t.kind : this.kindFor(place);
      const extra = { task: id, cands: list, kind, stay: t.stay || Kinds.get(kind).stay };
      if (id === 'meal') {
        const now = this.isToday() ? this.nowMin() : 0;
        const at = now <= 13 * 60 ? '12:00' : now <= 19 * 60 ? '18:30' : null;
        if (at) extra.prefAt = at;
      }
      const stop = this.addStop(place, extra);
      if (!stop) return;
      this.showToast(`${t.label} 넣었어요 · 가는 길에 가까운 곳으로 골라요`, { duration: 3200 });
      setTimeout(() => this.replanIfOpen(), 250);
    },

    setTaskPlace(s, place) {
      const t = Tasks.get(s.task);
      s.place = Store.cleanPlace(place);
      s.pinned = true;
      if (t && !t.kind) s.kind = this.kindFor(s.place);
      this.save();
      this.render();
      this.replanIfOpen();
    },

    /** 계산 전: 할 일들의 후보 장소를 지금 동선 기준으로 새로 찾음 (실패해도 넘어감) */
    async refreshTasks() {
      const done = new Set(this.plan.done || []);
      const list = this.plan.stops.filter((s) => s.task && !s.pinned && !done.has(s.uid) && Tasks.get(s.task));
      if (!list.length) return;
      const pts = this.taskPoints();
      if (!pts.length) return;
      await Promise.all(
        list.map(async (s) => {
          const found = await this.nearbyAll(Tasks.get(s.task).cat, pts);
          if (found.length) s.cands = found;
        })
      );
    },

    /**
     * 추천 순서에서 각 할 일의 앞·뒤 장소를 보고, 가장 덜 돌아가는 후보로 바꿈
     * @returns {boolean} 하나라도 바뀌었는지
     */
    pickBestCands(out) {
      const { input, result } = out;
      const sim = result.options[0].sim;
      const real = sim.rows.filter((r) => !r.anywhere);
      const endPlace = input.end.type === 'return' ? input.start : input.end.type === 'place' ? input.end.place : null;
      let changed = false;
      real.forEach((r, p) => {
        const es = input.stops[r.i];
        const s = this.plan.stops.find((x) => x.uid === es.uid);
        if (!s || !s.task || s.pinned || s.cands.length < 2) return;
        const prev = p === 0 ? input.start : input.stops[real[p - 1].i].place;
        const next = p + 1 < real.length ? input.stops[real[p + 1].i].place : endPlace;
        const best = this.sortCands(s.cands, prev, next, r.mode, input.travelFn)[0];
        if (best && Profile.placeKey(best) !== Profile.placeKey(s.place)) {
          s.place = best;
          const t = Tasks.get(s.task);
          if (t && !t.kind) s.kind = this.kindFor(best);
          changed = true;
        }
      });
      if (changed) this.save();
      return changed;
    },

    /** 덜 돌아가는 순서로 */
    sortCands(cands, prev, next, mode, travelFn) {
      const cost = (c) => {
        const a = travelFn(prev, c, mode);
        const b = next ? travelFn(c, next, mode) : { min: 0, dist: 0 };
        return a.min + b.min + (a.dist + b.dist) / 1e5;
      };
      return cands
        .map((c) => ({ c, v: cost(c) }))
        .sort((x, y) => x.v - y.v)
        .map((x) => x.c);
    },

    /** 할 일의 "다른 곳" 고르기 */
    openCands(uid) {
      const s = this.plan.stops.find((x) => x.uid === uid);
      if (!s) return;
      this.candUid = uid;
      let list = s.cands.slice();
      let detour = null;
      if (this.result) {
        const { input, result } = this.result;
        const real = result.options[0].sim.rows.filter((r) => !r.anywhere);
        const p = real.findIndex((r) => input.stops[r.i].uid === uid);
        if (p >= 0) {
          const endPlace = input.end.type === 'return' ? input.start : input.end.type === 'place' ? input.end.place : null;
          const prev = p === 0 ? input.start : input.stops[real[p - 1].i].place;
          const next = p + 1 < real.length ? input.stops[real[p + 1].i].place : endPlace;
          list = this.sortCands(list, prev, next, real[p].mode, input.travelFn);
          const direct = next ? input.travelFn(prev, next, real[p].mode).min : 0;
          detour = (c) => input.travelFn(prev, c, real[p].mode).min + (next ? input.travelFn(c, next, real[p].mode).min : 0) - direct;
        }
      }
      this.candShown = list;
      const t = Tasks.get(s.task);
      $('cand-title').textContent = `${t ? t.label : '할 일'} — 다른 곳으로`;
      $('cand-list').innerHTML = list.length
        ? list
            .map((c, i) => {
              const on = Profile.placeKey(c) === Profile.placeKey(s.place);
              return `<li class="lot${on ? ' is-on' : ''}"><div class="lot__text"><b>${esc(c.name)}</b><span>${detour ? `${Math.max(0, detour(c))}분 돌아가요 · ` : ''}${esc(c.address)}</span></div><button class="${on ? 'btn-line' : 'btn-soft'} btn-line--sm" type="button" data-cand="${i}">${on ? '지금 여기' : '여기로'}</button></li>`;
            })
            .join('')
        : '<li class="results__hint">근처 후보를 못 찾았어요. 이름으로 직접 찾아 주세요.</li>';
      this.openSheet($('cand-sheet'));
    },

    // =================================================================
    // 엔진에 넘길 값 만들기
    // =================================================================
    toMin(hhmm) {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    },

    hhmm(min) {
      const m = ((Math.round(min) % 1440) + 1440) % 1440;
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
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

    /** 엔진에 넘길 일정 하나 (분 단위 시각, 내 장소·학습 열쇠, 영업시간, 고른 주차장 포함) */
    engineStop(s) {
      const my = s.block ? null : Profile.findMy(this.profile, s.place);
      const isHome = s.kind === 'home';
      const out = {
        uid: s.uid,
        place: s.place,
        kind: s.kind,
        anywhere: !!s.block,
        parking: isHome ? (this.profile.home && this.profile.home.parking) || 'auto' : s.parking && s.parking !== 'auto' ? s.parking : my && my.parking !== 'auto' ? my.parking : 'auto',
        lkey: s.block ? '' : Profile.placeKey(s.place),
        myArrive: my && my.arriveMin != null ? my.arriveMin : null,
        myLeave: my && my.leaveMin != null ? my.leaveMin : null,
        lotWalk: s.lot ? s.lot.walk : null,
        stay: s.stay,
        fixedAt: s.fixedAt ? this.toMin(s.fixedAt) : null,
        prefAt: s.prefAt ? this.toMin(s.prefAt) : null,
        deadline: s.deadline ? this.toMin(s.deadline) : null,
        order: s.order,
        mode: s.mode,
      };
      const h = !s.ignoreHours && !isHome && !s.block ? this.hoursFor(s.kind, this.date) : null;
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
     * 도착 후·출발 전 실질 시간
     *   값 파일(주차장·장소 종류·혼잡) → 근처 주차장을 골랐으면 거기서 걸어오는 시간 → 내 장소에서 정한 분
     *   → 다녀온 뒤 답한 내 기록으로 보정 → 여유
     * 순서 계산 때 수만 번 불리므로 결과를 기억해 둔다
     */
    makeOverheadFn(weekend) {
      const buf = (Kinds.model.buffer || {})[this.profile.buffer] || { perStop: 0 };
      const lotM = Kinds.model.lot || { find: 3, out: 2 };
      const memo = new WeakMap();
      const lotMemo = new WeakMap();
      const finish = (st, mode, which, base, parts0, parking) => {
        let parts = parts0.slice();
        const L = Learn.estimate(st.lkey, st.kind, mode, which === 'arrive' ? 'a' : 'l', base);
        let total = L.total;
        if (total !== base) parts.push([`내 기록 반영(${L.n || L.kn}회)`, total - base]);
        if (which === 'arrive' && buf.perStop) {
          total += buf.perStop;
          parts.push(['여유', buf.perStop]);
        }
        return { total, parts, parking, learned: L.n, learnedKind: L.kn };
      };
      return (st, mode, which, at) => {
        if (st.lotWalk != null && mode === 'car') {
          let m = lotMemo.get(st);
          if (!m) lotMemo.set(st, (m = {}));
          if (!m[which]) {
            const k = Kinds.get(st.kind);
            const parts =
              which === 'arrive'
                ? [['주차장에 자리 찾아 주차', lotM.find], ['주차장에서 걸어가기', st.lotWalk], [k.insideLabel || '건물 안 이동', k.inside[0]]]
                : [[k.outsideLabel || '건물 밖으로', k.inside[1]], ['주차장까지 걷기', st.lotWalk], ['정산·출차', lotM.out]];
            const p = parts.filter(([, x]) => x > 0);
            m[which] = finish(st, mode, which, p.reduce((a, [, x]) => a + x, 0), p, 'lot');
          }
          return m[which];
        }
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
        const res = finish(st, mode, which, base, parts, inner.parking);
        memo.set(inner, res);
        return res;
      };
    },

    /** 집의 "나와서 차까지" / "주차하고 집 안까지" */
    homeOverhead(overheadFn, which) {
      const h = this.profile.home;
      if (!h || !h.place) return null;
      const st = this.engineStop(Store.cleanStop({ place: h.place, kind: 'home', stay: 30, order: 'any', mode: null, parking: 'auto' }));
      return overheadFn(st, 'car', which, 0);
    },

    /** 오늘 이미 다녀온 일정이 있으면: 지금 있는 곳(위치를 알면) 또는 마지막으로 다녀온 곳에서 출발 */
    startPlace() {
      const done = this.plan.done || [];
      if (!this.isToday() || !done.length) return this.plan.start;
      if (this.here && Date.now() - this.here.at < 20 * 60000) return this.here.place;
      const rows = (this.plan.sched && this.plan.sched.rows) || {};
      const last = done
        .map((uid) => ({ s: this.plan.stops.find((x) => x.uid === uid), f: rows[uid] ? rows[uid].finish : 0 }))
        .filter((x) => x.s && !x.s.block)
        .sort((a, b) => b.f - a.f)[0];
      return last ? last.s.place : this.plan.start;
    },

    buildInput() {
      const weekend = this.isWeekend();
      const tp = Kinds.travelParams;
      const pct = ((Kinds.model.buffer || {})[this.profile.buffer] || { travelPct: 0 }).travelPct || 0;
      const done = new Set(this.plan.done || []);
      const overheadFn = this.makeOverheadFn(weekend);
      const start = this.startPlace();
      const road = {};
      Store.MODES.forEach((m) => (road[m] = Learn.roadFactor(m)));
      return {
        start,
        startMin: 0,
        startIsNow: false,
        weekend,
        // 중간에 다시 계산할 때(지금 있는 곳에서 출발)도 "돌아오기"는 원래 출발지(집)로
        end: this.plan.end.type === 'return' && start !== this.plan.start && this.plan.start ? { type: 'place', place: this.plan.start } : this.plan.end,
        dayMode: this.plan.mode,
        overheadFn,
        startOH: this.isHome(start) ? this.homeOverhead(overheadFn, 'leave') : null,
        travelParams: tp,
        travelFn: (a, b, m) => {
          const r = Engine.travel(a, b, m, tp);
          const f = (1 + pct / 100) * (road[m] || 1);
          return f !== 1 ? { min: Math.ceil(r.min * f), dist: r.dist } : r;
        },
        pref: Kinds.prefParams,
        stops: this.plan.stops.filter((s) => !done.has(s.uid)).map((s) => this.engineStop(s)),
      };
    },

    /**
     * 순서 그대로 두고 출발만 늦춰 보며, 약속을 다 지키는 "가장 늦게 나가도 되는 시각"을 찾는다
     * (원하는 시간도 지켜지는 범위에서)
     */
    latestFit(input, order) {
      const base = Engine.evaluate(input, order).sim;
      if (base.lateness > 0) return null;
      const ok = (k) => {
        const s = Engine.evaluate(Object.assign({}, input, { startMin: input.startMin + k }), order).sim;
        return s.lateness === 0 && s.soft <= base.soft + 1e-9;
      };
      let lo = 0;
      let hi = 1;
      while (hi <= 960 && ok(hi)) {
        lo = hi;
        hi *= 2;
      }
      hi = Math.min(hi, 961);
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ok(mid)) lo = mid;
        else hi = mid;
      }
      return input.startMin + lo;
    },

    /**
     * 계산 — "몇 시에 나가야 하나"
     *   나가는 시각을 직접 정했으면 그 시각.
     *   아니면(자동): 시간 약속이 있으면 약속을 지키는 가장 늦은 시각(5분 단위로 내림),
     *                 없으면 오늘은 지금, 다른 날은 오전 9시.
     * @returns {{input, result, startKind}|null}  startKind: fit | set | now | default
     */
    computePlan() {
      const base = this.buildInput();
      if (!base.start || !base.stops.length) return null;
      const today = this.isToday();
      const now = this.nowMin();
      const mid = today && (this.plan.done || []).length > 0;
      const anchors = base.stops.filter((s) => !s.anywhere && (s.fixedAt != null || s.prefAt != null || s.deadline != null));
      let startMin;
      let kind;
      let first = null;
      if (this.plan.startTime !== 'auto' && !mid) {
        startMin = this.toMin(this.plan.startTime);
        kind = 'set';
        if (today && startMin < now) {
          startMin = now;
          kind = 'now';
        }
      } else if (mid || !anchors.length) {
        startMin = today ? now : DEFAULT_START;
        kind = today ? 'now' : 'default';
      } else {
        const firstAt = Math.min(...anchors.map((s) => (s.fixedAt != null ? s.fixedAt : s.prefAt != null ? s.prefAt : s.deadline)));
        const s0 = today ? now : Math.max(0, Math.min(6 * 60, firstAt - 240));
        first = Engine.plan(Object.assign({}, base, { startMin: s0, startIsNow: today }));
        if (!first || first.tooMany) return null;
        const L = first.ok ? this.latestFit(Object.assign({}, base, { startMin: s0 }), first.options[0].sim.order) : null;
        if (L != null && L - s0 >= 5) {
          startMin = Math.max(s0, Math.floor(L / 5) * 5);
          kind = 'fit';
        } else {
          startMin = s0;
          kind = today ? 'now' : 'fit';
        }
      }
      const input = Object.assign({}, base, { startMin, startIsNow: kind === 'now' });
      let result = Engine.plan(input);
      if (!result || result.tooMany) return null;
      if (kind === 'fit' && !result.ok && first && first.ok) {
        // 드물게(9곳 이상 근사) 늦춘 출발에서 더 나쁜 순서가 나오면 처음 순서를 그대로 씀
        const ev = Engine.evaluate(input, first.options[0].sim.order);
        if (ev.sim.lateness === 0) result = { ok: true, options: [{ key: 'fast', label: '', sim: ev.sim, reasons: first.options[0].reasons, warnings: [], latest: null }], suggestions: [], method: first.method };
      }
      return { input, result, startKind: kind, tab: 0 };
    },

    /** 실제로 걸어 나오는 시각: 일찍 도착해 기다리는 대신 그만큼 늦게 나감 */
    outOf(row) {
      return row.late ? row.outAt : row.outAt + row.wait;
    },

    /** 마지막으로 계산한 시간표를 저장 (다녀온 뒤 묻기·한 군데 더에 씀). 이미 다녀온 일정의 기록은 지킴 */
    saveSched(out) {
      const { input, result } = out;
      const sim = result.options[0].sim;
      const keep = {};
      const old = (this.plan.sched && this.plan.sched.rows) || {};
      (this.plan.done || []).forEach((uid) => {
        if (old[uid]) keep[uid] = old[uid];
      });
      sim.rows.forEach((r) => {
        const s = input.stops[r.i];
        keep[s.uid] = { out: this.outOf(r), begin: r.begin, finish: r.finish, travel: r.travel, arriveOH: r.arriveOH, startOH: r.startOH || 0, mode: r.mode || input.dayMode };
      });
      this.plan.sched = { at: Date.now(), rows: keep };
      this.save();
    },

    /** 오늘 계산해 둔 시간표에서 끝난 시각이 지난 일정은 "다녀옴"으로 */
    refreshDone() {
      const today = Store.todayStr();
      const p = this.plans[today];
      if (!p || !p.sched || !p.sched.rows) return false;
      const now = this.nowMin();
      let changed = false;
      p.done = (p.done || []).filter((uid) => p.stops.some((s) => s.uid === uid));
      p.stops.forEach((s) => {
        const r = p.sched.rows[s.uid];
        if (r && r.finish <= now && !p.done.includes(s.uid) && !(p.asked[s.uid] && p.asked[s.uid].r === 'nogo')) {
          p.done.push(s.uid);
          changed = true;
        }
      });
      return changed;
    },

    // =================================================================
    // 나갈 시간 보기
    // =================================================================
    async showPlan({ keepScroll = false } = {}) {
      if (!this.plan.start) {
        this.showToast('먼저 어디서 출발하는지 정해 주세요');
        this.openPlaceSheet('start');
        return;
      }
      if (this.planning) return;
      this.planning = true;
      $('btn-plan').disabled = true;
      $('plan-meta').textContent = '계산 중…';
      try {
        if (this.refreshDone()) this.save();
        await this.withTimeout(this.refreshTasks().catch(() => {}), 5000);
        let out = this.computePlan();
        for (let k = 0; out && k < 2; k++) {
          if (!this.pickBestCands(out)) break;
          out = this.computePlan();
        }
        this.render();
        if (!out) {
          const left = this.plan.stops.length - (this.plan.done || []).length;
          this.showToast(left <= 0 ? '오늘 넣은 일정은 모두 지난 시간이에요' : '계산하지 못했어요. 다시 시도해 주세요.');
          if (!$('result-sheet').hidden) this.closeSheet($('result-sheet'));
          return;
        }
        this.result = out;
        this.saveSched(out);
        const sim = out.result.options[0].sim;
        track('plan_result', {
          stops: out.input.stops.length,
          start_kind: out.startKind,
          end_minutes: sim.finishAll - out.input.startMin,
          warnings: out.result.options[0].warnings.length,
          tasks: this.plan.stops.filter((s) => s.task).length,
          method: out.result.method,
        });
        const body = $('result-body');
        const top = body.scrollTop;
        this.renderResult();
        if ($('result-sheet').hidden) this.openSheet($('result-sheet'));
        body.scrollTop = keepScroll ? top : 0;
      } catch (err) {
        console.error(err);
        this.showToast('계산하지 못했어요. 다시 시도해 주세요.');
      } finally {
        this.planning = false;
        this.renderStops();
      }
    },

    /** 결과 화면이 열려 있으면 다시 계산 (일정을 고쳤을 때) */
    replanIfOpen() {
      if (!$('result-sheet').hidden) this.showPlan({ keepScroll: true });
    },

    renderResult() {
      const { input, result, startKind } = this.result;
      const opt = result.options[0];
      const sim = opt.sim;
      const fmt = Engine.fmt;
      const stops = input.stops;
      const t = (m) => fmt(m).replace('오전 ', '').replace('오후 ', '');
      const real = sim.rows.filter((r) => !r.anywhere);
      const first = real[0] || sim.rows[0];
      const firstStop = this.plan.stops.find((x) => x.uid === stops[first.i].uid);
      const outAt = first.anywhere ? first.begin : this.outOf(first);
      const fromHome = this.isHome(input.start);
      const rel = this.relDay(this.date);
      const dayText = rel ? `${rel} · ${this.fullDay(this.date)}` : this.fullDay(this.date);
      const now = this.nowMin();

      // 집에 들어오는 시각 (주차하고 집 안까지 포함)
      let backText = '';
      if (sim.endLeg) {
        const target = input.end.type === 'return' ? input.start : input.end.place;
        const toHome = this.isHome(target);
        const homeIn = toHome && sim.endLeg.mode === 'car' ? this.homeOverhead(input.overheadFn, 'arrive') : null;
        const at = sim.endLeg.arrive + (homeIn ? homeIn.total : 0);
        backText = toHome ? `${fmt(at)}쯤 집에 들어와요` : input.end.type === 'return' ? `${fmt(at)}쯤 출발지로 돌아와요` : `${fmt(at)}쯤 ${esc(short(target.name))} 도착`;
        this.backAt = at;
      } else {
        backText = `${fmt(sim.doneAt)}쯤 모두 끝나요`;
        this.backAt = sim.doneAt;
      }

      const urgent = startKind === 'now' && outAt <= input.startMin + 5; // 지금 바로 나가야 하는 경우만
      const lateNow = urgent && opt.warnings.length > 0;
      const untilOut = this.isToday() ? outAt - now : null;
      const head = `
        <section class="go${opt.warnings.length ? ' go--warn' : ''}">
          <p class="go__label">${dayText} · ${fromHome ? '집에서' : esc(short(input.start.name)) + '에서'}</p>
          <p class="go__time"><b>${urgent ? '지금' : fmt(outAt)}</b><span>${urgent ? (lateNow ? ' 바로 나가야 해요' : ' 나가면 돼요') : '에 나가세요'}</span></p>
          <p class="go__meta">${urgent ? `${fmt(outAt)} 출발 기준 · ` : untilOut != null && untilOut > 0 ? `<b>${fmtMin(untilOut)} 뒤</b> · ` : ''}${firstStop ? `먼저 ${esc(short(firstStop.place.name))}` : ''}</p>
          <p class="go__back">${backText}</p>
          <p class="go__incl">주차·엘리베이터·접수 시간까지 넣었어요${this.learnedCount(sim) ? ` · 내 기록 ${this.learnedCount(sim)}곳 반영` : ''}</p>
        </section>`;

      const note0 =
        startKind === 'default'
          ? `<p class="start-note">시간 약속이 없어서 <b>${fmt(input.startMin)}</b>에 나가는 걸로 계산했어요. <button class="link-btn" type="button" data-act="time">나가는 시각 바꾸기</button></p>`
          : startKind === 'set'
          ? `<p class="start-note">직접 정한 시각(<b>${fmt(input.startMin)}</b>)에 나가는 걸로 계산했어요. <button class="link-btn" type="button" data-act="time">바꾸기</button></p>`
          : '';

      const warn = opt.warnings.length
        ? `<section class="alert" role="alert">
            <p class="alert__title">이대로는 시간이 모자라요</p>
            <ul>${opt.warnings.slice(0, 3).map((w) => `<li>${esc(w)}</li>`).join('')}${opt.warnings.length > 3 ? `<li>그 밖에 ${opt.warnings.length - 3}곳도 시간이 안 맞아요</li>` : ''}</ul>
            ${result.suggestions.length ? `<p class="alert__sub">이렇게 해 보세요</p><ul class="alert__tips">${result.suggestions.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
          </section>`
        : '';

      this.cards = this.cardsFor(input, sim);
      const cards = this.cards
        .slice(0, 2)
        .map(
          (g, i) => `<section class="sug"><p class="sug__text">${g.icon ? `<span aria-hidden="true">${g.icon}</span> ` : ''}${esc(g.text)}</p><div class="sug__actions">${g.actions
            .map((a, j) => `<button class="${j === 0 ? 'btn-soft' : 'btn-line'} btn-line--sm" type="button" data-card="${i}|${j}">${esc(a.label)}</button>`)
            .join('')}</div></section>`
        )
        .join('');

      const items = [];
      sim.rows.forEach((row) => {
        const es = stops[row.i];
        const s = this.plan.stops.find((x) => x.uid === es.uid);
        if (!s) return;
        if (row.anywhere) {
          items.push(`<li class="tl tl--block">
            <div class="tl__box">
              <p class="tl__name">🍚 ${esc(s.place.name)} <small>시간만 비움</small></p>
              <p class="tl__time">${t(row.begin)} ~ ${t(row.finish)} · ${fmtMin(es.stay)}</p>
              <div class="tl__acts"><button class="tl__act" type="button" data-fix="${s.uid}">시간 고치기</button><button class="tl__act" type="button" data-act="meal-find" data-at="${row.begin}" data-uid="${s.uid}">근처 식당 찾기</button></div>
            </div>
          </li>`);
          return;
        }
        const task = s.task && Tasks.get(s.task);
        const kind = Kinds.get(es.kind);
        const out = this.outOf(row);
        const aSum = row.arriveOH;
        const how = [];
        if (row.startOH) how.push([row.mode === 'car' ? '나와서 차까지' : '나오기', row.startOH]);
        how.push([row.travel === 0 ? '바로 옆' : MODE_VERB[row.mode], row.travel]);
        if (aSum) how.push([this.arriveLabel(row, es), aSum]);
        const total = how.reduce((a, [, m]) => a + m, 0);
        const detail = []
          .concat((row.startParts || []).map(([l, m]) => `<li><span>${esc(l)}</span><b>${m}분</b></li>`))
          .concat([`<li><span>${MODE_LABEL[row.mode]}로 이동 (${fmtDist(row.dist)})</span><b>${row.travel}분</b></li>`])
          .concat((row.arriveParts || []).map(([l, m]) => `<li><span>${esc(l)}</span><b>${m > 0 ? m : `−${-m}`}분</b></li>`));

        const badges = [];
        if (es.fixedAt != null) badges.push(row.late && es.deadline == null ? `<span class="badge badge--late">${t(es.fixedAt)}까지인데 ${row.late}분 늦어요</span>` : `<span class="badge badge--ok">✓ ${t(es.fixedAt)}까지 도착</span>`);
        if (es.prefAt != null) badges.push(row.prefLate > Kinds.prefParams.tolerance ? `<span class="badge badge--soft">${t(es.prefAt)}쯤 원했는데 ${row.prefLate}분 늦어요</span>` : `<span class="badge badge--ok">✓ ${t(es.prefAt)}쯤</span>`);
        const dl = Math.min(es.deadline != null ? es.deadline : Infinity, es.closeAt != null ? es.closeAt : Infinity);
        if (dl !== Infinity) {
          const over = row.finish - dl;
          if (over > 0) badges.push(`<span class="badge badge--late">${t(dl)}에 문 닫는데 ${over}분 늦게 끝나요</span>`);
          else if (es.deadline != null) badges.push(`<span class="badge badge--ok">✓ ${t(es.deadline)} 전에 끝</span>`);
        }
        if (es.closed) badges.push(`<span class="badge badge--late">${esc(es.closedNote)}</span>`);
        if (row.wait >= 15 && row.outAt !== out && row !== real[0]) badges.push(`<span class="badge badge--soft">앞 일정 뒤 ${fmtMin(row.wait)} 여유</span>`);

        const acts = [];
        if (task) acts.push(`<button class="tl__act" type="button" data-cands="${s.uid}">다른 곳</button>`);
        if (row.mode === 'car' && es.kind !== 'home' && es.kind !== 'gas') acts.push(`<button class="tl__act" type="button" data-lots="${s.uid}">🅿 ${s.lot ? '주차장 바꾸기' : '주차장 찾기'}</button>`);
        acts.push(`<a class="tl__act" href="${this.mapUrl(s.lot ? s.lot.place : s.place)}" target="_blank" rel="noopener">길찾기</a>`);
        acts.push(`<button class="tl__act" type="button" data-fix="${s.uid}">고치기</button>`);

        items.push(`<li class="tl">
          <div class="tl__out"><b>${fmt(out)}</b><span>에 나가요</span></div>
          <details class="tl__how">
            <summary><span class="tl__sum">${how.map(([l, m]) => `${esc(l)} ${m}분`).join(' + ')}</span><span class="tl__total">= ${total}분</span></summary>
            <ul class="tl__parts">${detail.join('')}</ul>
          </details>
          <div class="tl__box${row.late ? ' tl__box--late' : ''}">
            <p class="tl__name">${task ? `${task.icon} ` : ''}${esc(s.place.name)}${task ? ` <small>${esc(task.label)}</small>` : ` <small>${esc(kind.label)}</small>`}</p>
            <p class="tl__time">${t(row.begin)} ~ ${t(row.finish)} · ${fmtMin(es.stay)}</p>
            ${s.lot ? `<p class="tl__lot">🅿 ${esc(s.lot.place.name)}${s.lot.pub ? ' (공영)' : ''}에 세우고 걸어서 ${s.lot.walk}분</p>` : ''}
            ${badges.length ? `<p class="tl__badges">${badges.join('')}</p>` : ''}
            <div class="tl__acts">${acts.join('')}</div>
          </div>
        </li>`);
      });
      if (sim.endLeg) {
        const last = real[real.length - 1];
        const lo = sim.endLeg.outAt != null ? sim.endLeg.outAt : last.finish;
        items.push(`<li class="tl tl--end"><div class="tl__out"><b>${fmt(lo)}</b><span>에 나와요</span></div><p class="tl__endline">🏠 ${backText}</p></li>`);
      } else {
        items.push(`<li class="tl tl--end"><p class="tl__endline">✓ ${backText}</p></li>`);
      }

      const why = real.length > 1 && opt.reasons.length ? `<p class="why-line">${esc(opt.reasons[0])}</p>` : '';
      const more = `<div class="more-row"><p class="more-row__label">${this.isToday() ? '갑자기 들를 곳이 생겼나요?' : '더 넣을 일정이 있나요?'}</p><div class="more-row__btns"><button class="btn-line" type="button" data-act="more-place">📍 갈 곳 더</button><button class="btn-line" type="button" data-act="more-task">✅ 할 일 더</button></div></div>`;
      const road = Store.MODES.some((m) => Learn.roadFactor(m) !== 1);
      const note = `<p class="result-note">이동 시간은 아직 직선거리로 어림한 값이에요(실제 길찾기는 준비 중). 각 줄을 누르면 주차·엘리베이터·접수 시간이 하나씩 보여요.${input.weekend ? ' 주말 혼잡을 반영했어요.' : ''}${road ? ' 길 시간은 내 답을 반영했어요.' : ''}</p>`;

      $('result-title').textContent = `${rel || this.shortDay(this.date)} 나갈 시간`;
      $('result-body').innerHTML = head + note0 + warn + cards + `<ol class="tl-list">${items.join('')}</ol>` + why + more + note;
    },

    /** "주차·엘리베이터·접수"처럼 그 장소에서 실제로 드는 것만 이어 붙인 이름 */
    arriveLabel(row, es) {
      if (row.mode !== 'car') return '들어가서 준비';
      const txt = (row.arriveParts || []).map(([l]) => l).join(' ');
      const names = [];
      if (/주차|자리|입고|세우/.test(txt)) names.push('주차');
      if (/엘리베이터/.test(txt)) names.push('엘리베이터');
      else if (/걷|걸어|입구|현관/.test(txt)) names.push('걷기');
      if (/접수|번호표|창구|카트|차례|자리 잡기|대기/.test(txt)) names.push(/접수/.test(txt) ? '접수' : /카트/.test(txt) ? '카트' : '대기');
      return names.length ? names.join('·') : es.kind === 'home' ? '집 안까지' : '도착 후 준비';
    },

    learnedCount(sim) {
      return sim.rows.filter((r) => (r.arriveParts || []).some(([l]) => l.startsWith('내 기록'))).length;
    },

    mapUrl(place) {
      return `https://map.kakao.com/link/to/${encodeURIComponent(place.name.replace(/,/g, ' '))},${place.lat},${place.lng}`;
    },

    // ---- 상황 카드: 식사 · 빈 시간 · 주차장 · 장보기는 마지막에 --------------------
    cardsFor(input, sim) {
      const out = [];
      const key = (k) => `${this.date}|${k}`;
      const off = (k) => this.dismissed.has(key(k));
      const dismiss = (k) => () => {
        this.dismissed.add(key(k));
        this.renderResult();
      };
      const stops = input.stops;
      const M = Kinds.model;
      const rows = sim.rows;
      const real = rows.filter((r) => !r.anywhere);
      const end = sim.endLeg ? sim.endLeg.arrive : sim.doneAt;

      // ① 식사: 일정이 식사 시간대에 30분 넘게 걸쳐 있는데 밥 먹는 일정이 없을 때
      for (const [id, name] of [['lunch', '점심'], ['dinner', '저녁']]) {
        const w = M.meals && M.meals[id];
        if (!w || off(id)) continue;
        const from = this.toMin(w.from);
        const to = this.toMin(w.to);
        const out0 = this.outOf(real[0] || rows[0]);
        // 식사 시간대의 가운데(예: 12:15~13:00)를 밖에서 보낼 때만 물어봄 — 12:45에 나가는 날은 먹고 나가는 걸로 봄
        const overlap = out0 <= from + 45 && end >= to - 30 ? Math.min(end, to) - Math.max(out0, from) : 0;
        const hasMeal = rows.some((r) => {
          const s = stops[r.i];
          return (s.kind === 'food' || s.kind === 'home' || s.anywhere) && Math.min(r.finish, to) - Math.max(r.begin, from) >= 20;
        });
        if (overlap >= 30 && !hasMeal) {
          const at = this.toMin(id === 'lunch' ? '12:00' : '18:30');
          out.push({
            type: 'meal',
            icon: '🍚',
            text: `${name}시간이 끼어 있어요. ${name}은 어떻게 할까요?`,
            actions: [
              { label: '근처 식당 찾기', run: () => this.findNear('FD6', this.placeAt(sim, input, at), 'meal', { prefAt: this.hhmm(at), stay: w.stay }, '근처 식당') },
              { label: '시간만 비우기', run: () => this.addBlock(id, name, this.hhmm(at), w.stay) },
              { label: '괜찮아요', run: dismiss(id) },
            ],
          });
          break;
        }
      }

      // ② 빈 시간: 다음 일정까지 30분 넘게 남을 때
      if (!off('gap')) {
        const p = real.findIndex((r, i) => i > 0 && r.wait >= 30);
        if (p > 0) {
          const r = real[p];
          const prev = stops[real[p - 1].i];
          const free = r.wait;
          out.push({
            type: 'gap',
            icon: '☕',
            text: `${short(prev.place.name)} 끝나고 ${fmtMin(free)}쯤 비어요.`,
            actions: [
              { label: '근처 카페 찾기', run: () => this.findNear('CE7', prev.place, 'cafe', { prefAt: this.hhmm(real[p - 1].finish + 5), stay: Math.max(15, Math.min(60, Math.floor((free - 15) / 5) * 5)) }, '근처 카페') },
              { label: '할 일 넣기', run: () => this.startAddTask() },
              { label: '괜찮아요', run: dismiss('gap') },
            ],
          });
        }
      }

      // ③ 주차장: 차로 가는데 전용 주차장이 없을 것 같은 곳
      if (!off('lot')) {
        const r = real.find((x) => {
          const es = stops[x.i];
          const s = this.plan.stops.find((y) => y.uid === es.uid);
          return x.mode === 'car' && x.parking === 'street' && s && !s.lot && !['home', 'gas', 'pickup'].includes(es.kind) && es.myArrive == null;
        });
        if (r) {
          const es = stops[r.i];
          out.push({
            type: 'lot',
            icon: '🅿',
            text: `${short(es.place.name)}: 전용 주차장이 없을 수 있어요. 근처 주차장을 찾아볼까요?`,
            actions: [
              { label: '주차장 찾기', run: () => this.openLots(es.uid) },
              { label: '괜찮아요', run: dismiss('lot') },
            ],
          });
        }
      }

      // ④ 장 본 걸 들고 다니지 않게
      if (!off('mart') && real.length > 1) {
        const order = real.map((r) => stops[r.i]);
        const idx = order.findIndex((s) => s.kind === 'mart' && s.order === 'any');
        if (idx >= 0 && order.slice(idx + 1).some((s) => s.kind !== 'home')) {
          const s = order[idx];
          out.push({
            type: 'mart',
            icon: '🛒',
            text: `장 본 걸 들고 다니지 않게 ${Engine.josa(short(s.place.name), '을', '를')} 마지막에 갈까요?`,
            actions: [
              { label: '마지막으로', run: () => this.updateStop(s.uid, { order: 'last' }) },
              { label: '괜찮아요', run: dismiss('mart') },
            ],
          });
        }
      }
      return out;
    },

    /** 그 시각쯤 있을 곳 */
    placeAt(sim, input, at) {
      let near = input.start;
      for (const r of sim.rows) if (!r.anywhere && r.begin <= at) near = input.stops[r.i].place;
      return near;
    },

    updateStop(uid, patch) {
      const i = this.plan.stops.findIndex((s) => s.uid === uid);
      if (i < 0) return;
      this.plan.stops[i] = Store.cleanStop(Object.assign({}, this.plan.stops[i], patch));
      this.save();
      this.render();
      this.showPlan({ keepScroll: true });
    },

    /** 시간만 비우기 — 장소 없이 그 시간대만 잡아 둠 */
    addBlock(id, name, at, stay) {
      if (this.tooMany()) return;
      const stop = Store.cleanStop({ block: id, place: { name }, kind: 'etc', stay, prefAt: at, order: 'any', mode: null });
      this.plan.stops.push(stop);
      this.save();
      this.render();
      track('block_add', { type: id });
      this.showPlan({ keepScroll: true });
    },

    /** 근처 식당·카페 찾기 → 고르면 그 시간쯤으로 넣고 다시 계산 */
    async findNear(cat, near, mode, plan, title) {
      this.nearPlan = plan;
      this.pickMode = mode;
      $('place-sheet-title').textContent = title;
      $('place-input').value = '';
      $('place-clear').hidden = true;
      $('place-quick').hidden = true;
      $('place-status').textContent = '찾는 중…';
      $('place-results').innerHTML = '';
      this.openSheet($('place-sheet'));
      const miss = `<li class="results__hint">${title}을 못 찾았어요. 이름으로 찾아 주세요</li>`;
      try {
        const list = await Places.nearby(cat, near, 1500);
        this.shownPlaces = list;
        $('place-status').textContent = list.length ? '가까운 순 · 이름으로 찾아도 돼요' : '';
        $('place-results').innerHTML = list.length ? list.map((p, i) => this.placeItem(p, i)).join('') : miss;
      } catch (_) {
        $('place-status').textContent = '';
        $('place-results').innerHTML = miss;
      }
    },

    // ---- 근처 주차장 (공영 / 민영) ---------------------------------------------
    async openLots(uid) {
      const s = this.plan.stops.find((x) => x.uid === uid);
      if (!s) return;
      this.lotUid = uid;
      $('lot-title').textContent = '근처 주차장';
      $('lot-desc').innerHTML = `<b>${esc(s.place.name)}</b>에서 가까운 순이에요. 고르면 <b>주차장에서 걸어가는 시간</b>까지 넣어 다시 계산해요.`;
      $('lot-list').innerHTML = '<li class="results__hint">찾는 중…</li>';
      this.openSheet($('lot-sheet'));
      track('lot_open', {});
      let list = [];
      let failed = false;
      try {
        list = await Places.nearby('PK6', s.place, 700);
      } catch (_) {
        failed = true;
      }
      const tp = Kinds.travelParams;
      this.lotShown = list
        .map((p) => {
          const dist = Number.isFinite(p.distance) && p.distance != null ? p.distance : Engine.distM(s.place, p);
          return { place: p, dist, pub: PUBLIC_LOT.test(`${p.name} ${p.categoryName}`), walk: Math.max(1, Math.ceil((dist * (tp.detour || 1.3)) / (tp.walkMpm || 70))) };
        })
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 12);
      const rows = this.lotShown.map(
        (l, i) => `<li class="lot${s.lot && Profile.placeKey(s.lot.place) === Profile.placeKey(l.place) ? ' is-on' : ''}">
          <div class="lot__text"><b>${esc(l.place.name)}</b><span><em class="lot__tag${l.pub ? ' lot__tag--pub' : ''}">${l.pub ? '공영' : '민영(유료)'}</em>걸어서 ${l.walk}분 · ${fmtDist(l.dist)}</span></div>
          ${l.place.id ? `<a class="lot__map" href="https://place.map.kakao.com/${encodeURIComponent(l.place.id)}" target="_blank" rel="noopener" aria-label="${esc(l.place.name)} 지도에서 요금 보기">지도</a>` : ''}
          <button class="btn-soft btn-line--sm" type="button" data-lot="${i}">여기 세워요</button>
        </li>`
      );
      if (s.lot) rows.unshift(`<li class="lot lot--none"><div class="lot__text"><b>주차장 지정 빼기</b><span>지금: ${esc(s.lot.place.name)}</span></div><button class="btn-line btn-line--sm" type="button" data-lot="none">빼기</button></li>`);
      $('lot-list').innerHTML = rows.length
        ? rows.join('')
        : `<li class="results__hint">${failed ? '주차장 검색을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.' : '700m 안에서 주차장을 못 찾았어요.'}<br><a class="map-link" href="https://map.kakao.com/link/search/${encodeURIComponent(s.place.name + ' 주차장')}" target="_blank" rel="noopener">카카오맵에서 찾아보기</a></li>`;
    },

    wireResult() {
      $('result-body').addEventListener('click', (e) => {
        const fx = e.target.closest('[data-fix]');
        if (fx) {
          const stop = this.plan.stops.find((x) => x.uid === fx.dataset.fix);
          if (!stop) return;
          if (stop.block) return this.editWhen(stop.uid);
          this.fixFromResult = true;
          this.openStopSheet(stop, { precise: true });
          return;
        }
        const lt = e.target.closest('[data-lots]');
        if (lt) return this.openLots(lt.dataset.lots);
        const cd = e.target.closest('[data-cands]');
        if (cd) return this.openCands(cd.dataset.cands);
        const sg = e.target.closest('[data-card]');
        if (sg) {
          const [i, j] = sg.dataset.card.split('|').map(Number);
          const g = this.cards[i];
          track('card_action', { type: g.type, action: j });
          g.actions[j].run();
          return;
        }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const a = act.dataset.act;
        if (a === 'time') this.openTimeSheet();
        else if (a === 'more-place' || a === 'more-task') this.addMore(a === 'more-task');
        else if (a === 'meal-find') {
          // 시간만 비운 칸을 실제 식당으로 바꾸기
          const s = this.plan.stops.find((x) => x.uid === act.dataset.uid);
          const { input, result } = this.result;
          this.swapBlock = s ? s.uid : null;
          this.findNear('FD6', this.placeAt(result.options[0].sim, input, Number(act.dataset.at)), 'meal', { prefAt: s && s.prefAt, stay: s ? s.stay : 50 }, '근처 식당');
        }
      });
      $('btn-alarm').addEventListener('click', () => this.openAlarm());
      $('btn-ics').addEventListener('click', () => this.exportIcs());
      $('btn-share-plan').addEventListener('click', () => this.sharePlan());
    },

    /**
     * 한 군데 더 — 오늘이면 이미 지난 일정은 "다녀옴"으로 두고, 지금 있는 곳에서 다시 계산
     * (위치 권한을 주면 현재 위치, 아니면 마지막으로 다녀온 곳)
     */
    addMore(isTask) {
      track('add_more', { task: !!isTask, today: this.isToday() });
      if (this.isToday()) {
        if (this.refreshDone()) this.save();
        if ((this.plan.done || []).length) {
          Places.current()
            .then((p) => {
              this.here = { place: Store.cleanPlace(p), at: Date.now() };
            })
            .catch(() => {});
        }
      }
      if (isTask) this.startAddTask();
      else this.startAddPlace();
    },

    // ---- 알림 받기 (캘린더) · 가족에게 보내기 --------------------------------------
    /** 알림·공유에 쓸 줄들: 실제 장소는 "나갈 시간", 시간만 비운 칸은 그 시간 */
    planEvents() {
      if (!this.result) return [];
      const { input, result } = this.result;
      const sim = result.options[0].sim;
      return sim.rows.map((r) => {
        const es = input.stops[r.i];
        const s = this.plan.stops.find((x) => x.uid === es.uid) || { place: es.place };
        const task = s.task && Tasks.get(s.task);
        return { name: (task ? `${task.label} · ` : '') + s.place.name, place: s.place, block: !!r.anywhere, out: r.anywhere ? r.begin : this.outOf(r), begin: r.begin, finish: r.finish, fixedAt: es.fixedAt };
      });
    },

    stamp(min) {
      const d = Store.parseDate(this.date);
      const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
      x.setMinutes(Math.round(min));
      const p = (n) => String(n).padStart(2, '0');
      return `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}T${p(x.getHours())}${p(x.getMinutes())}00`;
    },

    openAlarm() {
      if (!this.result) return;
      const fmt = Engine.fmt;
      const ev = this.planEvents().filter((e) => !e.block);
      $('alarm-links').innerHTML = ev
        .map((e) => {
          const title = `${fmt(e.out)} 나가기 → ${e.name}`;
          const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${this.stamp(e.out)}/${this.stamp(e.finish)}&ctz=Asia/Seoul&details=${encodeURIComponent(`Getset 계산 · ${fmt(e.begin)}~${fmt(e.finish)} (주차·엘리베이터 시간 포함)`)}&location=${encodeURIComponent(e.place.address || e.place.name)}`;
          return `<a class="alarm-link" href="${url}" target="_blank" rel="noopener"><span><b>${fmt(e.out)}</b> 나가기</span><small>${esc(e.name)}</small></a>`;
        })
        .join('');
      this.openSheet($('alarm-sheet'));
      track('alarm_open', { stops: ev.length });
    },

    exportIcs() {
      if (!this.result) return;
      const fmt = Engine.fmt;
      const escI = (v) => String(v).replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const now = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}00`;
      const events = this.planEvents();
      const ev = events.map((e, p) => {
        const lines = [
          'BEGIN:VEVENT',
          `UID:getset-${this.date}-${p}-${Date.now()}@pebbleitgo.com`,
          `DTSTAMP:${now}`,
          `DTSTART;TZID=Asia/Seoul:${this.stamp(e.out)}`,
          `DTEND;TZID=Asia/Seoul:${this.stamp(e.finish)}`,
          `SUMMARY:${escI(e.block ? `${e.name} (시간 비움)` : `${fmt(e.out)} 나가기 → ${e.name}`)}`,
        ];
        if (!e.block) {
          lines.push(
            `LOCATION:${escI(e.place.address || e.place.name)}`,
            `DESCRIPTION:${escI(`Getset 계산 · ${fmt(e.begin)}~${fmt(e.finish)} (주차·엘리베이터 시간 포함)`)}`,
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            `DESCRIPTION:${escI(`10분 뒤 ${e.name}(으)로 나갈 시간`)}`,
            'TRIGGER:-PT10M',
            'END:VALARM',
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            `DESCRIPTION:${escI(`지금 ${e.name}(으)로 나갈 시간`)}`,
            'TRIGGER:PT0M',
            'END:VALARM'
          );
        }
        lines.push('END:VEVENT');
        return lines.join('\r\n');
      });
      const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pebble//Getset//KO', 'CALSCALE:GREGORIAN', ...ev, 'END:VCALENDAR'].join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
      a.download = `getset-${this.date}.ics`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      track('calendar_export', { stops: events.length });
      this.showToast('파일을 받았어요. [열기]를 눌러 캘린더에 저장하면 나갈 시간에 알림이 와요', { duration: 5500 });
    },

    planText() {
      if (!this.result) return '';
      const { input } = this.result;
      const fmt = Engine.fmt;
      const ev = this.planEvents();
      const first = ev.find((e) => !e.block) || ev[0];
      const rel = this.relDay(this.date);
      const lines = [`[${rel ? rel + ' ' : ''}${this.shortDay(this.date)} 일정]`, `⏰ ${fmt(first.out)} ${this.isHome(input.start) ? '집에서' : input.start.name + '에서'} 출발`];
      const num = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫'];
      ev.forEach((e, i) => {
        lines.push(`${num[i] || i + 1 + '.'} ${fmt(e.begin)} ${e.name}${e.block ? '' : ` (~${fmt(e.finish).replace(/오[전후] /, '')})`}`);
      });
      const back = $('result-body').querySelector('.go__back');
      if (back) lines.push(`🏠 ${back.textContent}`);
      return lines.join('\n');
    },

    async sharePlan() {
      const text = this.planText() + '\n\nGetset으로 계산 (주차·엘리베이터 시간 포함)\nhttps://pebbleitgo.com/getset/';
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
      this.showToast(ok ? '일정을 복사했어요. 카톡에 붙여넣어 보내세요' : '복사하지 못했어요');
    },

    // =================================================================
    // 다녀온 뒤 한 번 묻기 → 내 기록(learn.js)에 반영
    // =================================================================
    /** 물어볼 일정 하나 (최근 3일, 하루 최대 3곳, 약속 시간이 있던 곳부터) */
    findAsk() {
      const today = Store.todayStr();
      const now = this.nowMin();
      const dates = Object.keys(this.plans)
        .filter((d) => d <= today && d >= Store.addDays(today, -3))
        .sort()
        .reverse();
      for (const d of dates) {
        const p = this.plans[d];
        if (!p.sched || !p.sched.rows || p.asked._stop) continue;
        if (Object.keys(p.asked).length >= 3) continue;
        const list = p.stops
          .filter((s) => !s.block && s.kind !== 'home' && p.sched.rows[s.uid] && !p.asked[s.uid] && (d < today || p.sched.rows[s.uid].finish <= now - 5))
          .sort((a, b) => Number(!!b.fixedAt) - Number(!!a.fixedAt) || p.sched.rows[a.uid].finish - p.sched.rows[b.uid].finish);
        if (list.length) return { date: d, stop: list[0], row: p.sched.rows[list[0].uid] };
      }
      return null;
    },

    renderAsk() {
      const box = $('ask');
      const q = this.findAsk();
      if (!q) {
        box.hidden = true;
        this.askState = null;
        return;
      }
      if (!this.askState || this.askState.uid !== q.stop.uid) this.askState = { uid: q.stop.uid, date: q.date, step: 0 };
      const st = this.askState;
      const when = q.date === Store.todayStr() ? '아까' : this.relDay(q.date) || this.shortDay(q.date);
      const name = esc(short(q.stop.place.name));
      let html = '';
      if (st.step === 0) {
        html = `<p class="ask__q">${when} <b>${name}</b>, 시간 맞았어요?</p>
          <div class="ask__btns ask__btns--3">
            <button class="ask__btn" type="button" data-ask="ok">딱 맞았어요</button>
            <button class="ask__btn" type="button" data-ask="early">일찍 도착</button>
            <button class="ask__btn" type="button" data-ask="late">늦었어요</button>
          </div>
          <div class="ask__foot"><button class="link-btn" type="button" data-ask="nogo">안 갔어요</button><button class="link-btn" type="button" data-ask="stop">그만 묻기</button></div>`;
      } else if (st.step === 1) {
        html = `<p class="ask__q"><b>${name}</b>: 몇 분쯤 ${st.dir === 'late' ? '늦었어요' : '일찍 도착했어요'}?</p>
          <div class="ask__btns ask__btns--4">${[5, 10, 15, 20].map((m) => `<button class="ask__btn" type="button" data-ask-min="${m}">${m === 20 ? '20분+' : m + '분'}</button>`).join('')}</div>`;
      } else {
        html = `<p class="ask__q">어디서 ${st.dir === 'late' ? '더' : '덜'} 걸렸어요?</p>
          <div class="ask__btns ask__btns--2">
            <button class="ask__btn" type="button" data-ask-where="road">길 (${MODE_VERB[q.row.mode] || '이동'})</button>
            <button class="ask__btn" type="button" data-ask-where="park">주차</button>
            <button class="ask__btn" type="button" data-ask-where="elev">엘리베이터·걷기</button>
            <button class="ask__btn" type="button" data-ask-where="desk">접수·대기</button>
          </div>
          <div class="ask__foot"><button class="link-btn" type="button" data-ask-where="unknown">잘 모르겠어요</button></div>`;
      }
      box.innerHTML = `<p class="ask__tag">답하면 다음부터 더 정확해져요</p>${html}`;
      box.hidden = false;
    },

    wireAsk() {
      $('ask').addEventListener('click', (e) => {
        const st = this.askState;
        if (!st) return;
        const a = e.target.closest('[data-ask]');
        const m = e.target.closest('[data-ask-min]');
        const w = e.target.closest('[data-ask-where]');
        if (a) {
          const v = a.dataset.ask;
          if (v === 'early' || v === 'late') {
            st.dir = v;
            st.step = 1;
            this.renderAsk();
          } else if (v === 'stop') {
            this.plans[st.date].asked._stop = true;
            this.save();
            this.renderAsk();
          } else this.applyAsk(v, 0, null);
        } else if (m) {
          st.min = Number(m.dataset.askMin);
          st.step = 2;
          this.renderAsk();
        } else if (w) this.applyAsk(st.dir, st.min, w.dataset.askWhere);
      });
    },

    applyAsk(r, min, where) {
      const st = this.askState;
      const p = this.plans[st.date];
      const stop = p.stops.find((s) => s.uid === st.uid);
      const row = p.sched.rows[st.uid];
      if (!stop || !row) return;
      p.asked[st.uid] = { r, m: min || 0, w: where || '' };
      const key = Profile.placeKey(stop.place);
      const mode = row.mode || p.mode;
      const d = r === 'late' ? min : r === 'early' ? -min : 0;
      let msg = '고마워요! 기록해 둘게요';
      if (r === 'nogo') {
        p.done = (p.done || []).filter((u) => u !== st.uid);
        msg = '알겠어요. 기록에서 뺐어요';
      } else if (r === 'ok') {
        Learn.add({ key, kind: stop.kind, mode, arrive: row.arriveOH });
        Learn.addRoad(mode, 1);
        msg = '좋아요! 이대로 계속 계산할게요';
      } else {
        const roadPart = where === 'road' ? d : where === 'unknown' ? d / 2 : 0;
        const herePart = d - roadPart;
        if (roadPart) Learn.addRoad(mode, (row.travel + roadPart) / Math.max(row.travel, 3));
        if (herePart) Learn.add({ key, kind: stop.kind, mode, arrive: Math.max(0, row.arriveOH + herePart) });
        msg = d > 0 ? `고마워요! 다음엔 ${where === 'road' ? '길 시간을' : short(stop.place.name) + '에서'} 더 넉넉히 잡을게요` : '고마워요! 다음엔 조금 덜 잡을게요';
      }
      this.save();
      track('visit_feedback', { result: r, minutes: min || 0, where: where || '', kind: stop.kind, mode });
      this.askState = null;
      this.render();
      this.showToast(msg, { duration: 3200 });
    },

    // =================================================================
    // 내 정보 · 첫 실행 · 의견
    // =================================================================
    openOnboarding(steps, after, first) {
      window.GetsetOnboard.open({
        steps,
        first,
        onDone: (p, info) => {
          this.profile = Profile.load();
          this.syncHome();
          this.savePlaces();
          if (!steps || steps.includes('home')) {
            // 집을 (다시) 알려 줬으면 출발지가 비어 있는 날은 집으로
            Object.keys(this.plans).forEach((d) => {
              if (!this.plans[d].start && this.profile.home) this.plans[d].start = this.profile.home.place;
            });
          }
          if (!steps || first) {
            if (!this.plan.stops.length) this.plan.mode = this.profile.mode;
            this.save();
            track('onboarding_done', { home: !!this.profile.home, places: this.profile.places.length, skipped: !!(info && info.skipped) });
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
        else if (a === 'redo') this.openOnboarding(['home', 'homePark', 'places', 'mode']);
        else if (a === 'feedback') this.openFeedback('me');
        else if (a === 'learn-clear') {
          if (!confirm('내 기록(다녀온 뒤 답한 것)을 모두 지울까요?')) return;
          Learn.clear();
          this.renderMe();
          this.showToast('내 기록을 지웠어요');
        }
      });
      $('btn-feedback-2').addEventListener('click', () => this.openFeedback('footer'));
      $('feedback-chips').addEventListener('click', (e) => {
        const b = e.target.closest('[data-fb]');
        if (!b) return;
        const ta = $('feedback-text');
        ta.value = (ta.value ? ta.value + '\n' : '') + b.dataset.fb;
        ta.focus();
      });
      $('btn-feedback-send').addEventListener('click', () => this.sendFeedback());
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
          <div class="me-row me-row--static"><span class="me-row__label">내 기록</span><span class="me-row__value"><b>${ls.visits}번 답함 · ${ls.places}곳</b><small>다녀온 뒤 "시간 맞았어요?"에 답할수록 정확해져요</small></span>${ls.visits ? '<button class="btn-line btn-line--sm" type="button" data-me="learn-clear">지우기</button>' : ''}</div>
        </div>
        <div class="me-actions">
          <button class="btn-soft" type="button" data-me="feedback">의견 보내기</button>
          <button class="btn-line" type="button" data-me="redo">처음 설정 다시 하기</button>
        </div>
        <p class="result-note">모든 정보는 이 기기에만 저장돼요. 값 파일 v${esc(K.model.version)}${K.source === 'override' ? ' (관리자 시험 값)' : ''}</p>`;
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
        const ctx = this.result ? this.planText() : `${this.fullDay(this.date)} 일정: ${this.plan.stops.map((s) => s.place.name).join(', ') || '없음'}`;
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

    pickPlace(place) {
      if (!place) return;
      const clean = Store.cleanPlace(place);
      if (!clean) return;
      const mode = this.pickMode;
      if (mode === 'meal' || mode === 'cafe') {
        // 식사·빈 시간 카드에서 고른 곳: 그 시간쯤으로 넣고 바로 다시 계산
        const np = this.nearPlan || {};
        if (this.swapBlock) {
          this.plan.stops = this.plan.stops.filter((s) => s.uid !== this.swapBlock);
          this.swapBlock = null;
        }
        const stop = Store.cleanStop({ place: clean, kind: 'food', stay: np.stay || 50, prefAt: np.prefAt || null, order: 'any', mode: null, parking: 'auto' });
        this.plan.stops.push(stop);
        this.save();
        this.closeSheet($('place-sheet'));
        this.render();
        track('card_done', { type: mode });
        setTimeout(() => this.showPlan({ keepScroll: true }), 250);
        return;
      }
      if (mode === 'taskpick') {
        const s = this.plan.stops.find((x) => x.uid === this.candUid);
        this.closeSheet($('place-sheet'));
        if (s) setTimeout(() => this.setTaskPlace(s, clean), 250);
        return;
      }
      if (place.id !== 'current') {
        Store.pushRecent(this.places, clean);
        this.savePlaces();
      }

      if (mode === 'stop' && !this.draft) {
        // 새로 갈 곳: 고르면 바로 "몇 시까지 가요?"
        this.hideSheetNow($('place-sheet'));
        this.openWhen({ place: clean }, { replace: true });
        return;
      }
      if (mode === 'stop') {
        // 자세히 고치기에서 장소만 바꾼 경우
        this.hideSheetNow($('place-sheet'));
        this.draft.place = clean;
        this.openStopSheet(null, { replace: true, keepDraft: true });
        return;
      }

      this.closeSheet($('place-sheet'));
      if (mode === 'start') {
        this.plan.start = clean;
        this.save();
        this.render();
        if (clean.id !== 'current' && !this.isHome(clean)) this.showToast(`출발지: ${clean.name}`);
      } else if (mode === 'end') {
        this.plan.end = { type: 'place', place: clean };
        this.save();
        this.render();
      }
      setTimeout(() => this.replanIfOpen(), 250);
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
      const titles = { stop: '어디에 가요?', start: '어디서 출발해요?', end: '어디서 끝나요?' };
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
      $('stop-sheet-title').textContent = d.kind === 'home' ? '집 들르기' : '자세히 고치기';
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

      if (this.editingUid && d.task) {
        // 할 일의 장소를 직접 바꿨으면 그 뒤로는 자동으로 바꾸지 않음
        const o = this.plan.stops.find((s) => s.uid === this.editingUid);
        if (o && Profile.placeKey(o.place) !== Profile.placeKey(d.place)) d.pinned = true;
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
      this.fixFromResult = false;
      setTimeout(() => this.replanIfOpen(), 250);
    },

    deleteStop() {
      const i = this.plan.stops.findIndex((s) => s.uid === this.editingUid);
      if (i < 0) return;
      const [removed] = this.plan.stops.splice(i, 1);
      this.save();
      this.closeSheet($('stop-sheet'));
      this.render();
      setTimeout(() => this.replanIfOpen(), 250);
      this.offerUndo(`${removed.place.name} 뺐어요`, () => {
        this.plan.stops.splice(i, 0, removed);
        this.save();
        this.render();
        this.replanIfOpen();
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
        setTimeout(() => this.replanIfOpen(), 250);
      });
    },

    openPlaceSheetReplace(mode) {
      this.pickMode = mode;
      $('place-sheet-title').textContent = mode === 'end' ? '어디서 끝나요?' : mode === 'taskpick' ? '어디로 바꿀까요?' : '어디에 가요?';
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
      ['place-sheet', 'stop-sheet', 'end-sheet', 'time-sheet', 'result-sheet', 'date-sheet', 'me-sheet', 'feedback-sheet', 'trip-sheet', 'when-sheet', 'task-sheet', 'lot-sheet', 'cand-sheet', 'alarm-sheet'].forEach((id) => {
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

  /** 긴 이름 줄이기 */
  function short(name) {
    const n = String(name || '');
    return n.length > 12 ? n.slice(0, 11) + '…' : n;
  }

  function fmtDist(m) {
    return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}km`;
  }

  window.GetsetApp = App;
  App.init();
})();
