'use strict';

/**
 * Getset — 1단계: 오늘 볼일 입력 · 장소 검색 · 저장/복원
 *
 * 화면 흐름
 *   [볼일 추가] → 장소 찾기 시트(검색·최근 장소) → 볼일 상세 시트(종류·머무는 시간·옵션) → 목록
 *   [출발] → 장소 찾기 시트(현재 위치·집·검색)        [끝] → 끝나는 곳 시트
 *   [순서 추천받기] → 3단계(추천 엔진)에서 연결 예정
 *
 * 개인정보: 장소 정보는 이 기기(localStorage)에만 저장. 통계엔 종류·개수·이동수단만.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const Store = window.GetsetStore;
  const Kinds = window.GetsetKinds;
  const Places = window.GetsetPlaces;
  const track = (name, params) => {
    if (typeof window.pebbleTrack === 'function') window.pebbleTrack(name, params);
  };

  const MAX_STOPS = 12; // 설계문서 §6-2: 13곳 이상은 v1에서 제한
  const STAY_BASE = [10, 20, 30, 45, 60, 90];
  const QUICK_STAY = [10, 20, 30, 45, 60, 90]; // 빠른 추가 큰 버튼

  const ICON = {
    car: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" d="M5 16.5V12l1.8-4.6A2 2 0 0 1 8.7 6h6.6a2 2 0 0 1 1.9 1.4L19 12v4.5M5 12h14M4 16.5h16v1.8a.7.7 0 0 1-.7.7H17.5a.7.7 0 0 1-.7-.7v-1.1H7.2v1.1a.7.7 0 0 1-.7.7H4.7a.7.7 0 0 1-.7-.7z"/><circle cx="8" cy="14.3" r="1" fill="currentColor"/><circle cx="16" cy="14.3" r="1" fill="currentColor"/></svg>',
    walk: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="13" cy="4.6" r="1.9" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="m10.5 21 1.6-5.4-2.4-2.4.9-4.6M10.6 8.6 7.5 10.4l-.8 3.1M10.6 8.6l2.6.2 2 3 2.6.8M12.1 15.6l2.6 2 1 3.4"/></svg>',
    bike: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="6" cy="16" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="16" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m6 16 3.6-7h5.2L18 16M9.6 9l2.6 7h-6M12.6 6h2.4l1.2 3"/></svg>',
    transit: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="5" y="3.5" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M5 11h14" stroke="currentColor" stroke-width="1.9"/><circle cx="8.6" cy="14.2" r="1" fill="currentColor"/><circle cx="15.4" cy="14.2" r="1" fill="currentColor"/><path d="m8 17.5-1.6 3M16 17.5l1.6 3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  };
  const MODE_LABEL = { car: '자동차', walk: '도보', bike: '자전거', transit: '대중교통' };

  const App = {
    plan: null,
    places: null,
    saveWarned: false,

    // 장소 찾기 시트 상태
    pickMode: 'stop', // stop | start | end
    searchSeq: 0,
    searchTimer: null,

    // 볼일 상세 시트 상태
    draft: null, // 편집 중인 볼일 (새로 추가할 땐 uid 없음)
    editingUid: null,
    stayTouched: false,

    init() {
      this.plan = Store.loadPlan();
      this.places = Store.loadPlaces();

      this.wireTrip();
      this.wireStops();
      this.wirePlaceSheet();
      this.wireStopSheet();
      this.wireEndSheet();
      this.wireSheets();
      this.wireRestore();
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

      this.render();
      this.tickClock();
      setInterval(() => this.tickClock(), 30 * 1000);
      this.registerServiceWorker();
    },

    // =================================================================
    // 저장
    // =================================================================
    save() {
      this.plan.date = this.plan.date || Store.todayStr();
      const ok = Store.savePlan(this.plan);
      if (!ok && !this.saveWarned) {
        this.saveWarned = true;
        this.showToast('이 브라우저에선 저장이 안 돼요. 창을 닫으면 내용이 사라질 수 있어요.', { duration: 4500 });
      }
    },

    savePlaces() {
      Store.savePlaces(this.places);
    },

    // 지난 날짜의 계획이 남아 있으면 이어 쓸지 물어본다
    wireRestore() {
      const today = Store.todayStr();
      const banner = $('restore-banner');
      if (this.plan.date !== today && this.plan.stops.length) {
        const [y, m, d] = this.plan.date.split('-').map(Number);
        const then = new Date(y, m - 1, d);
        const diff = Math.round((new Date(today) - new Date(this.plan.date)) / 86400000);
        $('restore-date').textContent = diff === 1 ? '어제' : `${then.getMonth() + 1}월 ${then.getDate()}일에`;
        $('restore-count').textContent = `${this.plan.stops.length}개`;
        banner.hidden = false;
        window.scrollTo(0, 0);
      } else if (this.plan.date !== today) {
        this.plan.date = today;
        this.plan.startTime = 'now';
        this.save();
      }
      $('btn-restore-keep').addEventListener('click', () => {
        this.plan.date = today;
        this.plan.startTime = 'now'; // 지난 날 출발 시각은 오늘과 안 맞을 수 있음
        this.save();
        banner.hidden = true;
        this.render();
        this.showToast('지난 볼일을 그대로 가져왔어요');
      });
      $('btn-restore-new').addEventListener('click', () => {
        const snapshot = JSON.parse(JSON.stringify(this.plan));
        this.plan.date = today;
        this.plan.startTime = 'now';
        this.plan.stops = []; // 출발지·끝나는 곳·이동수단은 그대로 둔다
        this.save();
        banner.hidden = true;
        this.render();
        this.offerUndo('새로 시작했어요', () => {
          this.plan = snapshot;
          this.plan.date = today;
          this.save();
          this.render();
        });
      });
    },

    // =================================================================
    // 출발 정보 (출발지 · 시각 · 끝나는 곳 · 하루 기본 이동수단)
    // =================================================================
    wireTrip() {
      $('row-start').addEventListener('click', () => this.openPlaceSheet('start'));
      $('row-end').addEventListener('click', () => this.openEndSheet());

      $('row-time').addEventListener('click', () => this.openTimeSheet());
      $('time-options').addEventListener('click', (e) => {
        const b = e.target.closest('[data-time]');
        if (!b) return;
        this.setStartTime(b.dataset.time);
      });
      $('btn-time-ok').addEventListener('click', () => {
        const v = $('time-input').value;
        if (!Store.isTime(v)) {
          $('time-input').focus();
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

    /** 이동수단 선택 버튼 묶음 (하루 기본용 / 볼일별용) */
    renderModes(box, withDefault, onPick) {
      const items = withDefault ? [['', '기본']] : [];
      Store.MODES.forEach((m) => items.push([m, MODE_LABEL[m]]));
      box.innerHTML = items
        .map(
          ([m, label]) =>
            `<button class="mode" type="button" role="radio" data-mode="${m}">${m ? ICON[m] : ''}<span>${label}</span></button>`
        )
        .join('');
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-mode]');
        if (b) onPick(b.dataset.mode || null);
      });
    },

    setModeChecked(box, mode) {
      box.querySelectorAll('[data-mode]').forEach((b) => {
        const on = (b.dataset.mode || null) === (mode || null);
        b.setAttribute('aria-checked', String(on));
      });
    },

    tickClock() {
      this.renderTime();
    },

    /** 지금부터 n분 뒤를 5분 단위로 올린 "HH:MM" */
    suggestTime(after = 5) {
      const d = new Date(Date.now() + after * 60000);
      const m = Math.ceil(d.getMinutes() / 5) * 5;
      d.setMinutes(m, 0, 0);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },

    nowHHMM() {
      const d = new Date();
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },

    renderTime() {
      const t = this.plan.startTime;
      if (t === 'now') {
        $('time-name').textContent = `${fmtTime(this.nowHHMM())} 출발`;
        $('time-sub').textContent = '지금 시각 기준 · 눌러서 바꾸기';
      } else {
        $('time-name').textContent = `${fmtTime(t)} 출발`;
        $('time-sub').textContent = '눌러서 바꾸기';
      }
    },

    openTimeSheet() {
      const opts = [
        ['now', '지금 바로', `${fmtTime(this.nowHHMM())}`],
        [this.suggestTime(10), '10분 뒤', null],
        [this.suggestTime(30), '30분 뒤', null],
        [this.suggestTime(60), '1시간 뒤', null],
      ];
      const cur = this.plan.startTime;
      $('time-options').innerHTML = opts
        .map(([v, label, sub]) => {
          const on = v === cur;
          return `<button class="option option--row" type="button" role="radio" aria-checked="${on}" data-time="${v}"><b>${label}</b><small>${sub || fmtTime(v)}</small></button>`;
        })
        .join('');
      $('time-input').value = cur === 'now' ? this.suggestTime(60) : cur;
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
      const endName = $('end-name');
      const endSub = $('end-sub');
      if (e.type === 'place' && e.place) {
        endName.textContent = e.place.name;
        endSub.textContent = e.place.address;
        endSub.hidden = !e.place.address;
      } else {
        endName.textContent = e.type === 'none' ? '상관없어요 (마지막 볼일에서 끝)' : '출발지로 돌아오기';
        endSub.hidden = true;
      }

      this.renderTime();
      this.setModeChecked($('day-mode'), this.plan.mode);
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
      const parts = [`${fmtMin(s.stay)}`];
      if (s.fixedAt) parts.push(`<span class="tag tag--fixed">예약 ${fmtTime(s.fixedAt)}</span>`);
      if (s.deadline) parts.push(`<span class="tag">${fmtTime(s.deadline)}까지</span>`);
      if (s.order === 'first') parts.push('<span class="tag">제일 먼저</span>');
      if (s.order === 'last') parts.push('<span class="tag">제일 마지막</span>');
      if (s.mode && s.mode !== this.plan.mode) parts.push(`<span class="tag tag--mode">${ICON[s.mode]}${MODE_LABEL[s.mode]}</span>`);
      return parts.join('');
    },

    renderStops() {
      const stops = this.plan.stops;
      const list = $('stop-list');
      list.innerHTML = stops
        .map((s) => {
          const kind = Kinds.get(s.kind);
          return `<li>
            <button class="stop" type="button" data-uid="${s.uid}" aria-label="${esc(s.place.name)} 고치기">
              <span class="stop__body">
                <span class="stop__kind">${esc(kind.label)}</span>
                <span class="stop__name">${esc(s.place.name)}</span>
                <span class="stop__meta">${this.stopMeta(s)}</span>
              </span>
              <svg class="stop__chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
            </button>
          </li>`;
        })
        .join('');
      const n = stops.length;
      $('stops-empty').hidden = n > 0;
      $('stops-hint').hidden = n < 2;
      $('stops-count').hidden = n === 0;
      $('stops-count').textContent = `${n}개`;
      $('btn-clear').hidden = n === 0;
      $('btn-add').classList.toggle('add-btn--first', n === 0);
      $('btn-add').hidden = n >= MAX_STOPS;

      const btn = $('btn-plan');
      btn.disabled = n === 0;
      $('plan-meta').textContent = n ? `볼일 ${n}개` : '';
    },

    render() {
      this.renderTrip();
      this.renderStops();
    },

    // =================================================================
    // 순서 추천 (engine.js)
    // =================================================================
    toMin(hhmm) {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    },

    buildInput() {
      const now = new Date();
      const startIsNow = this.plan.startTime === 'now';
      const startMin = startIsNow ? now.getHours() * 60 + now.getMinutes() : this.toMin(this.plan.startTime);
      return {
        start: this.plan.start,
        startMin,
        startIsNow,
        end: this.plan.end,
        dayMode: this.plan.mode,
        kindOf: Kinds.get,
        stops: this.plan.stops.map((s) => ({
          place: s.place,
          kind: s.kind,
          stay: s.stay,
          fixedAt: s.fixedAt ? this.toMin(s.fixedAt) : null,
          deadline: s.deadline ? this.toMin(s.deadline) : null,
          order: s.order,
          mode: s.mode,
        })),
      };
    },

    onPlan() {
      if (!this.plan.start) {
        this.showToast('먼저 어디서 출발하는지 정해 주세요');
        this.openPlaceSheet('start');
        return;
      }
      const input = this.buildInput();
      const btn = $('btn-plan');
      btn.disabled = true;
      $('plan-meta').textContent = '계산 중…';
      track('plan_request', { stops: input.stops.length, modes: Array.from(new Set(input.stops.map((s) => s.mode || input.dayMode))).join(',') });
      // 화면이 "계산 중"을 그릴 틈을 준 뒤 계산
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

    renderResult() {
      const { input, result, tab } = this.result;
      const opt = result.options[tab];
      const sim = opt.sim;
      const fmt = window.GetsetEngine.fmt;
      const stops = input.stops;

      // 추천안 2개일 때 탭
      const tabs = $('result-tabs');
      tabs.hidden = result.options.length < 2;
      tabs.innerHTML = result.options
        .map((o, i) => `<button class="tab" type="button" role="tab" aria-selected="${i === tab}" data-tab="${i}"><b>${o.label}</b><small>${fmt(o.sim.doneAt)} 끝 · 이동 ${o.sim.travelSum}분</small></button>`)
        .join('');

      const endLabel = input.end.type === 'return' ? (this.isHome(this.plan.start) ? '집 도착' : '출발지 도착') : '도착';
      const head = `
        <section class="summary${result.ok || tab > 0 ? '' : ' summary--warn'}">
          <p class="summary__label">볼일이 모두 끝나는 시각</p>
          <p class="summary__time">${fmt(sim.doneAt)}</p>
          <p class="summary__meta">${fmt(input.startMin)} 출발 · 볼일 ${stops.length}곳${sim.endLeg ? ` · ${fmt(sim.endLeg.arrive)} ${endLabel}` : ''}</p>
          ${sim.waitSum > 0 ? `<p class="summary__slack">예약 전 여유 ${sim.waitSum}분</p>` : ''}
        </section>`;

      const warn = opt.warnings.length
        ? `<section class="alert" role="alert">
            <p class="alert__title">이대로는 시간이 모자라요</p>
            <ul>${opt.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
            ${result.suggestions.length ? `<p class="alert__sub">이렇게 해 보세요</p><ul class="alert__tips">${result.suggestions.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
          </section>`
        : '';

      const why = `<ul class="why">${opt.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;

      const leg = (mode, min, dist, opts = {}) => {
        const walkHint =
          mode === 'car' && dist >= 30 && dist < 800
            ? `<span class="leg__hint">가까워요 · 걸으면 약 ${Math.ceil((dist * 1.3) / 70)}분</span>`
            : '';
        const what = min === 0 ? '바로 옆이에요' : `${MODE_LABEL[mode]} ${min}분`;
        return `<li class="tl-leg">${ICON[mode]}<span class="leg__text">${what}<span class="leg__est">${dist >= 1000 ? (dist / 1000).toFixed(1) + 'km' : dist + 'm'} · 추정</span></span>${walkHint}${opts.extra || ''}</li>`;
      };

      const items = [];
      items.push(`<li class="tl-node tl-node--start"><span class="tl-dot"></span><div class="tl-body"><p class="tl-time">${fmt(input.startMin)} 출발</p><p class="tl-name">${esc(this.plan.start.name)}</p></div></li>`);
      sim.rows.forEach((row, p) => {
        const s = stops[row.i];
        const kind = Kinds.get(s.kind);
        items.push(leg(row.mode, row.travel, row.dist));
        const ohLabel = row.mode === 'car' ? '주차·걸어가기' : '들어가기·대기';
        const checks = [];
        if (s.fixedAt != null) checks.push(row.late && !s.deadline ? `<span class="badge badge--late">예약 ${fmt(s.fixedAt)} · ${row.late}분 늦음</span>` : `<span class="badge badge--ok">예약 ${fmt(s.fixedAt)} ✓</span>`);
        if (s.deadline != null) {
          const over = row.finish - s.deadline;
          checks.push(over > 0 ? `<span class="badge badge--late">${fmt(s.deadline)}까지 · ${over}분 늦음</span>` : `<span class="badge badge--ok">${fmt(s.deadline)} 전에 끝 ✓</span>`);
        }
        const next = p + 1 < sim.rows.length || sim.endLeg;
        items.push(`
          <li class="tl-node">
            <span class="tl-num">${p + 1}</span>
            <div class="tl-body">
              <p class="tl-name">${esc(s.place.name)}<span class="tl-kind">${esc(kind.label)}</span></p>
              <p class="tl-line">${fmt(row.arrive)} 도착${row.arriveOH ? ` · ${ohLabel} ${row.arriveOH}분` : ''}</p>
              ${row.wait ? `<p class="tl-line tl-line--wait">예약까지 ${row.wait}분 기다려요</p>` : ''}
              <p class="tl-main">${fmt(row.begin)} ~ ${fmt(row.finish)} <small>볼일 ${fmtMin(s.stay)}</small></p>
              ${checks.length ? `<p class="tl-badges">${checks.join('')}</p>` : ''}
              ${next && row.leaveOH ? `<p class="tl-line">${(p + 1 < sim.rows.length ? sim.rows[p + 1].mode : input.dayMode) === 'car' ? '차까지' : '나서기'} ${row.leaveOH}분</p>` : ''}
            </div>
          </li>`);
      });
      items.push(`<li class="tl-node tl-node--done"><span class="tl-dot tl-dot--done">✓</span><div class="tl-body"><p class="tl-time tl-time--done">${fmt(sim.doneAt)} 볼일 끝</p></div></li>`);
      if (sim.endLeg) {
        items.push(leg(sim.endLeg.mode, sim.endLeg.travel, sim.endLeg.dist));
        const endName = input.end.type === 'return' ? this.plan.start.name : input.end.place.name;
        items.push(`<li class="tl-node tl-node--start"><span class="tl-dot"></span><div class="tl-body"><p class="tl-time">${fmt(sim.endLeg.arrive)} ${endLabel}</p><p class="tl-name">${esc(endName)}</p></div></li>`);
      }

      const note = `<p class="result-note">이동 시간은 지금 <b>직선거리로 어림한 값(추정)</b>이에요. 자동차 실제 길찾기는 다음 단계에서 붙어요. 주차·대기 시간은 장소 종류별 보통 값이에요.${result.method === 'approx' ? ' 볼일이 많아서 빠른 계산으로 순서를 정했어요.' : ''}</p>`;

      $('result-title').textContent = opt.warnings.length && tab === 0 ? '가장 나은 순서예요' : '이 순서로 가면 돼요';
      $('result-body').innerHTML = head + warn + why + `<ol class="timeline">${items.join('')}</ol>` + note;
      $('result-body').scrollTop = 0;
    },

    wireResult() {
      $('result-tabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (!b || !this.result) return;
        this.result.tab = Number(b.dataset.tab);
        track('plan_adjust', { method: 'alt_tab', tab: this.result.result.options[this.result.tab].key });
        this.renderResult();
      });
      $('btn-go').addEventListener('click', () => {
        track('plan_start', { stops: this.plan.stops.length });
        this.showToast('출발 모드(도착·끝 누르기)는 다음 단계에서 붙어요. 지금은 순서·시간표까지 확인할 수 있어요.', { duration: 4500 });
      });
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
          : `<li class="results__hint">‘${esc(q)}’ 검색 결과가 없어요.<br>지점명이나 동네 이름을 함께 넣어 보세요.</li>`;
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
      if (place.id !== 'current') {
        Store.pushRecent(this.places, clean);
        this.savePlaces();
      }

      if (this.pickMode === 'stop') {
        // 장소 → 상세 입력으로 이어서 (뒤로가기 한 번이면 목록으로)
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
    // 볼일 상세 시트
    // =================================================================
    wireStopSheet() {
      const sel = $('kind-select');
      sel.innerHTML = Kinds.LIST.map((k) => `<option value="${k.id}">${k.label}</option>`).join('');
      sel.addEventListener('change', () => {
        this.draft.kind = sel.value;
        this.kindAuto = false;
        if (!this.stayTouched) this.draft.stay = Kinds.get(sel.value).stay;
        this.renderStopSheet();
      });

      // ① 빠른 추가: 누르는 순간 추가 끝
      $('quick-stay').addEventListener('click', (e) => {
        const b = e.target.closest('[data-stay]');
        if (!b) return;
        this.draft.stay = Number(b.dataset.stay);
        this.saveStop('quick');
      });
      $('btn-more').addEventListener('click', () => {
        this.stopView = 'detail';
        this.renderStopSheet();
        const sc = document.querySelector('#stop-sheet .sheet__scroll');
        if (sc) sc.scrollTop = 0;
      });

      // ② 자세히
      $('stay-chips').addEventListener('click', (e) => {
        const b = e.target.closest('[data-stay]');
        if (!b) return;
        this.stayTouched = true;
        if (b.dataset.stay === 'custom') {
          this.customStay = true;
          this.renderStopSheet();
          const inp = $('stay-input');
          inp.value = this.draft.stay;
          inp.focus();
          inp.select();
          return;
        }
        this.customStay = false;
        this.draft.stay = Number(b.dataset.stay);
        this.renderStopSheet();
      });
      $('stay-input').addEventListener('input', (e) => {
        const v = Math.round(Number(e.target.value));
        if (Number.isFinite(v) && v >= 1 && v <= 600) this.draft.stay = v;
        this.stayTouched = true;
      });

      $('appt-seg').addEventListener('click', (e) => {
        const b = e.target.closest('[data-appt]');
        if (!b) return;
        const kind = b.dataset.appt;
        const cur = this.draft.fixedAt || this.draft.deadline;
        this.draft.fixedAt = null;
        this.draft.deadline = null;
        if (kind === 'fixed') this.draft.fixedAt = cur || this.suggestTime(60);
        if (kind === 'deadline') this.draft.deadline = cur || '16:00';
        $('stop-error').hidden = true;
        this.renderStopSheet();
        if (kind !== 'none') setTimeout(() => $('appt-time').focus(), 0);
      });
      $('appt-time').addEventListener('change', (e) => {
        const v = Store.isTime(e.target.value) ? e.target.value : null;
        if (this.draft.fixedAt !== null) this.draft.fixedAt = v || '';
        else this.draft.deadline = v || '';
        $('stop-error').hidden = true;
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

      $('btn-stop-save').addEventListener('click', () => this.saveStop('detail'));
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
        this.stayTouched = true;
        this.kindAuto = false;
        this.stopView = 'detail';
      } else if (!opts.keepDraft) {
        const kind = Kinds.guess(opts.place);
        this.editingUid = null;
        this.draft = { place: opts.place, kind, stay: Kinds.get(kind).stay, fixedAt: null, deadline: null, order: 'any', mode: null };
        this.stayTouched = false;
        this.kindAuto = true;
        this.stopView = 'quick';
      } else if (!this.editingUid) {
        // 새 볼일을 만들던 중 장소만 바꾼 경우: 종류를 다시 추정
        const kind = Kinds.guess(this.draft.place);
        this.draft.kind = kind;
        if (!this.stayTouched) this.draft.stay = Kinds.get(kind).stay;
        this.kindAuto = true;
      }
      this.showModePick = false;
      this.customStay = !this.stayChoices().includes(this.draft.stay);
      $('stop-error').hidden = true;

      this.renderStopSheet();
      this.openSheet($('stop-sheet'), { replace: !!opts.replace });
      const scroller = document.querySelector('#stop-sheet .sheet__scroll');
      if (scroller) scroller.scrollTop = 0;
    },

    stayChoices() {
      const set = new Set(STAY_BASE);
      set.add(Kinds.get(this.draft.kind).stay);
      return Array.from(set).sort((a, b) => a - b);
    },

    renderStopSheet() {
      const d = this.draft;
      const detail = this.stopView === 'detail';
      $('stop-sheet-title').textContent = this.editingUid ? '볼일 고치기' : detail ? '자세히 정하기' : '얼마나 있을 거예요?';
      $('stop-quick').hidden = detail;
      $('stop-detail').hidden = !detail;
      $('stop-actions').hidden = !detail;
      $('btn-stop-save').textContent = this.editingUid ? '저장' : '추가하기';
      $('btn-stop-delete').hidden = !this.editingUid;

      $('picked-name').textContent = d.place.name;
      $('picked-addr').textContent = d.place.address || '';

      const def = Kinds.get(d.kind).stay;
      if (!detail) {
        // 큰 버튼 6개 — 이 장소 종류의 "보통" 시간과 가장 가까운 칸에 표시
        const near = QUICK_STAY.reduce((a, b) => (Math.abs(b - def) < Math.abs(a - def) ? b : a));
        $('quick-stay').innerHTML = QUICK_STAY.map(
          (m) => `<button class="big-btn${m === near ? ' is-usual' : ''}" type="button" data-stay="${m}"><b>${fmtMin(m)}</b>${m === near ? '<small>보통 이 정도예요</small>' : ''}</button>`
        ).join('');
        return;
      }

      $('stay-chips').innerHTML =
        this.stayChoices()
          .map((m) => {
            const on = !this.customStay && d.stay === m;
            return `<button class="chip" type="button" role="radio" aria-checked="${on}" data-stay="${m}">${fmtMin(m)}${m === def ? '<small>보통</small>' : ''}</button>`;
          })
          .join('') +
        `<button class="chip" type="button" role="radio" aria-checked="${!!this.customStay}" data-stay="custom">직접</button>`;
      $('stay-custom').hidden = !this.customStay;
      if (this.customStay && document.activeElement !== $('stay-input')) $('stay-input').value = d.stay;

      const appt = d.fixedAt !== null && d.fixedAt !== undefined ? 'fixed' : d.deadline !== null && d.deadline !== undefined ? 'deadline' : 'none';
      $('appt-seg').querySelectorAll('[data-appt]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.appt === appt)));
      $('appt-box').hidden = appt === 'none';
      if (appt !== 'none') {
        $('appt-help').textContent = appt === 'fixed' ? '몇 시에 도착해야 해요?' : '몇 시까지 끝내야 해요?';
        const v = appt === 'fixed' ? d.fixedAt : d.deadline;
        if (document.activeElement !== $('appt-time')) $('appt-time').value = v || '';
      }

      $('order-seg').querySelectorAll('[data-order]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.order === d.order)));

      const dayMode = MODE_LABEL[this.plan.mode];
      $('mode-line-text').innerHTML = d.mode ? `${ICON[d.mode]}<b>${MODE_LABEL[d.mode]}</b>로 가요` : `${ICON[this.plan.mode]}<b>${dayMode}</b> <span class="muted">(오늘 기본)</span>`;
      $('btn-mode-change').textContent = this.showModePick ? '닫기' : '바꾸기';
      $('stop-mode').hidden = !this.showModePick;
      this.setModeChecked($('stop-mode'), d.mode);
      const defBtn = $('stop-mode').querySelector('[data-mode=""] span');
      if (defBtn) defBtn.textContent = `오늘 기본(${dayMode})으로`;

      $('kind-select').value = d.kind;
      const cat = (d.place.categoryName || '').split('>').pop().trim();
      $('kind-note').textContent = this.kindAuto && cat ? `장소 정보(${cat})를 보고 골랐어요. 다르면 바꿔 주세요.` : '';
      $('kind-note').hidden = !$('kind-note').textContent;
    },

    saveStop(from) {
      const d = this.draft;
      const err = $('stop-error');
      if (from === 'detail') {
        if (d.fixedAt === '' || d.deadline === '') {
          err.textContent = '시간을 골라 주세요';
          err.hidden = false;
          return;
        }
        if (this.customStay) {
          const v = Math.round(Number($('stay-input').value));
          if (!Number.isFinite(v) || v < 1 || v > 600) {
            err.textContent = '머무는 시간을 1~600분 사이로 넣어 주세요';
            err.hidden = false;
            return;
          }
          d.stay = v;
        }
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
          has_deadline: !!stop.deadline,
          quick: from === 'quick',
        });
        this.showToast(`${stop.place.name} 넣었어요 · ${fmtMin(stop.stay)}`);
      }
      this.plan.date = Store.todayStr();
      this.save();
      this.closeSheet($('stop-sheet'));
      this.render();
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
      ['place-sheet', 'stop-sheet', 'end-sheet', 'time-sheet', 'result-sheet'].forEach((id) => {
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
        const open = document.querySelector('.sheet.is-open');
        if (open) this.closeSheet(open);
      });
    },

    openSheet(sheet, { replace = false, focus = null } = {}) {
      sheet.hidden = false;
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

  function fmtDist(m) {
    return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}km`;
  }

  window.GetsetApp = App;
  App.init();
})();
