'use strict';

/**
 * Getset 관리 페이지 (설계문서 v1.1 §11)
 *
 * ① 기본값: 주차장·장소 종류·혼잡·이동 어림·원하는 시간·식사·여유를 고치고
 *    → [이 폰에서 시험] 으로 이 기기 앱에만 먼저 적용해 보거나
 *    → [값 파일 내려받기] 로 model.json 을 받아 깃허브 getset/data 에 올리면 모두에게 적용
 * ② 현장 측정기: 주차장 진입부터 출차까지 단계 버튼을 눌러 실제 시간을 재고, 요약을 기본값에 반영
 * ③ 모두의 기록: 8단계(서버)에서 열림
 *
 * 비밀번호는 보안이 아니라 "실수로 들어오는 것" 방지용이다. 이 페이지는 값을 파일로 만들 뿐,
 * 사이트를 직접 바꾸지 못한다(깃허브에 올려야 바뀜).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const K = window.GetsetKinds;
  const E = window.GetsetEngine;
  const PASS_HASH = '1da58aa8532b0189a318e5208985902b0c544302b547b726d65b0b48cbe6e0a2';
  const DRAFT_KEY = 'getset:admin:draft:v1';
  const MEASURES_KEY = 'getset:admin:measures:v1';
  const RUN_KEY = 'getset:admin:measure-run:v1';

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const median = (arr) => {
    const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const r1 = (x) => Math.round(x * 10) / 10;
  const sumSteps = (arr) => (arr || []).reduce((a, [, m]) => a + Number(m || 0), 0);

  const A = {
    published: null, // 지금 깃허브에 올라가 있는 값 (data/model.json)
    draft: null, // 고치는 중인 값

    // =============================================================
    // 시작 · 비밀번호
    // =============================================================
    async init() {
      $('lock-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if ((await sha256($('lock-input').value.trim())) === PASS_HASH) {
          try {
            sessionStorage.setItem('getset:admin-ok', '1');
          } catch (_) {}
          this.open();
        } else {
          $('lock-error').hidden = false;
        }
      });
      let ok = false;
      try {
        ok = sessionStorage.getItem('getset:admin-ok') === '1';
      } catch (_) {}
      if (ok) this.open();
    },

    async open() {
      $('lock').hidden = true;
      $('admin').hidden = false;
      $('admin-bar').hidden = false;
      await K.ready;
      this.published = await this.loadPublished();
      let draft = null;
      try {
        draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      } catch (_) {}
      // 올린 값이 고치던 값보다 새 버전이면(업로드 끝) 고치던 값은 버림
      if (draft && K.validate(draft) && !(this.published.version >= draft.version && draft.exported)) this.draft = draft;
      else this.draft = clone(this.published);

      this.wireTabs();
      this.wireValues();
      this.wireMeasure();
      this.renderAll();
    },

    async loadPublished() {
      try {
        const res = await fetch('../data/model.json', { cache: 'no-cache' });
        if (res.ok) {
          const raw = await res.json();
          if (K.validate(raw)) return raw;
        }
      } catch (_) {}
      return clone(K.BUILTIN);
    },

    wireTabs() {
      document.querySelectorAll('.admin-tabs [data-tab]').forEach((b) =>
        b.addEventListener('click', () => this.showTab(b.dataset.tab))
      );
    },

    showTab(id) {
      document.querySelectorAll('.admin-tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
      ['values', 'measure', 'crowd'].forEach((t) => ($(`tab-${t}`).hidden = t !== id));
      $('admin-bar').hidden = id !== 'values';
      window.scrollTo(0, 0);
    },

    // =============================================================
    // ① 기본값 편집
    // =============================================================
    saveDraft() {
      this.draft.exported = false;
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(this.draft));
      } catch (_) {}
    },

    dirty() {
      const a = clone(this.draft);
      const b = clone(this.published);
      delete a.exported;
      delete b.exported;
      return JSON.stringify(a) !== JSON.stringify(b);
    },

    /** "parking.underground.find.0.1" 같은 경로에 값 넣기 */
    setPath(path, value) {
      const keys = path.split('.');
      let o = this.draft;
      for (let i = 0; i < keys.length - 1; i++) o = o[isNaN(keys[i]) ? keys[i] : Number(keys[i])];
      const last = keys[keys.length - 1];
      o[isNaN(last) ? last : Number(last)] = value;
    },

    wireValues() {
      const onInput = (e) => {
        const el = e.target.closest('[data-path]');
        if (!el) return;
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.dataset.type === 'num') {
          v = Number(el.value);
          if (!Number.isFinite(v)) return;
          v = Math.max(0, Math.min(600, v));
        } else v = el.value;
        this.setPath(el.dataset.path, v);
        this.saveDraft();
        clearTimeout(this.pvTimer);
        this.pvTimer = setTimeout(() => {
          this.renderPreview();
          this.renderStatus();
          this.renderSums();
        }, 150);
      };
      $('tab-values').addEventListener('input', onInput);
      $('tab-values').addEventListener('change', onInput);

      $('tab-values').addEventListener('click', (e) => {
        const add = e.target.closest('[data-add-step]');
        if (add) {
          const [pid, group] = add.dataset.addStep.split('|');
          this.draft.parking[pid][group].push(['새 단계', 1]);
          this.saveDraft();
          this.renderParking();
          this.renderPreview();
          return;
        }
        const del = e.target.closest('[data-del-step]');
        if (del) {
          const [pid, group, i] = del.dataset.delStep.split('|');
          this.draft.parking[pid][group].splice(Number(i), 1);
          this.saveDraft();
          this.renderParking();
          this.renderPreview();
          return;
        }
        const delP = e.target.closest('[data-del-parking]');
        if (delP) {
          const pid = delP.dataset.delParking;
          if (Object.keys(this.draft.parking).length <= 1) return;
          if (!confirm(`'${this.draft.parking[pid].label}' 종류를 지울까요?`)) return;
          delete this.draft.parking[pid];
          this.draft.kinds.forEach((k) => {
            if (k.parking === pid) k.parking = Object.keys(this.draft.parking)[0];
          });
          this.saveDraft();
          this.renderAll();
        }
      });

      $('btn-add-parking').addEventListener('click', () => {
        const id = 'p' + Date.now().toString(36).slice(-5);
        this.draft.parking[id] = { label: '새 주차장 종류', desc: '', find: [['자리 찾기', 3]], toDoor: [['입구까지', 2]], toCar: [['차까지', 2]], out: [['출차', 1]] };
        this.saveDraft();
        this.renderAll();
        toast('새 주차장 종류를 맨 아래에 추가했어요');
      });

      $('btn-try').addEventListener('click', () => {
        if (!K.setOverride(this.draft)) return toast('값이 올바르지 않아요. 빈 칸을 확인해 주세요');
        toast('이 폰의 앱이 지금 고친 값으로 계산해요. [앱으로]에서 확인해 보세요', 4500);
        this.renderStatus();
      });
      $('btn-untry').addEventListener('click', () => {
        K.clearOverride();
        toast('시험을 끝냈어요. 이 폰도 올린 값으로 계산해요');
        this.renderStatus();
      });
      $('btn-revert').addEventListener('click', () => {
        if (!confirm('고치던 내용을 버리고 올린 값으로 되돌릴까요?')) return;
        this.draft = clone(this.published);
        localStorage.removeItem(DRAFT_KEY);
        this.renderAll();
        toast('올린 값으로 되돌렸어요');
      });
      $('btn-import').addEventListener('click', () => $('import-file').click());
      $('import-file').addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
          const raw = JSON.parse(await f.text());
          if (!K.validate(raw)) throw new Error('bad');
          this.draft = raw;
          this.saveDraft();
          this.renderAll();
          toast('파일을 불러왔어요');
        } catch (_) {
          toast('값 파일 모양이 아니에요');
        }
        e.target.value = '';
      });

      $('btn-export').addEventListener('click', () => {
        $('export-note').value = '';
        $('export-error').hidden = true;
        openSheet($('export-sheet'));
        setTimeout(() => $('export-note').focus(), 100);
      });
      $('export-sheet').addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) closeSheet($('export-sheet'));
      });
      $('btn-export-go').addEventListener('click', () => this.exportFile());
    },

    exportFile() {
      const note = $('export-note').value.trim();
      if (!note) {
        $('export-error').hidden = false;
        return;
      }
      const out = clone(this.draft);
      delete out.exported;
      out.version = Math.max(Number(this.published.version) || 0, Number(out.version) || 0) + 1;
      out.updated = today();
      out.notes = [{ date: out.updated, version: out.version, text: note }].concat(Array.isArray(out.notes) ? out.notes : []).slice(0, 50);
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'model.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      this.draft = out;
      this.draft.exported = true;
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(this.draft));
      } catch (_) {}
      closeSheet($('export-sheet'));
      this.renderAll();
      toast(`v${out.version} 값 파일을 내려받았어요. 깃허브 getset/data 에 올려 주세요`, 5000);
    },

    renderAll() {
      this.renderStatus();
      this.renderParking();
      this.renderKinds();
      this.renderFields();
      this.renderNotes();
      this.renderPreview();
      this.renderMeasureSelects();
      this.renderMeasures();
    },

    renderStatus() {
      const src = { override: '이 폰은 <b>시험 값</b>으로 계산 중', file: '앱은 <b>올린 값 파일</b>로 계산 중', builtin: '앱은 <b>처음 값</b>으로 계산 중(값 파일 못 읽음)' }[K.source];
      const dirty = this.dirty();
      $('status').innerHTML = `
        <p class="status__line">올린 값: <b>v${esc(this.published.version)}</b> (${esc(this.published.updated || '')}) · ${src}</p>
        <p class="status__line ${dirty ? 'is-dirty' : ''}">${dirty ? (this.draft.exported ? `v${esc(this.draft.version)} 내려받음 — 깃허브에 올리면 적용돼요` : '고친 내용이 있어요 (아직 올리지 않음)') : '고친 내용 없음'}</p>`;
    },

    numInput(path, value, label, unit = '분', step = 1) {
      return `<label class="num"><span class="num__label">${esc(label)}</span><span class="num__box"><input class="input input--num" type="number" inputmode="decimal" min="0" max="600" step="${step}" data-type="num" data-path="${path}" value="${esc(value)}"><span class="num__unit">${unit}</span></span></label>`;
    },

    stepRows(pid, group, steps) {
      return (
        steps
          .map(
            ([l, m], i) => `<div class="step-row">
              <input class="input step-row__name" type="text" data-path="parking.${pid}.${group}.${i}.0" value="${esc(l)}" aria-label="단계 이름">
              <span class="num__box"><input class="input input--num" type="number" inputmode="decimal" min="0" max="120" step="0.5" data-type="num" data-path="parking.${pid}.${group}.${i}.1" value="${esc(m)}" aria-label="${esc(l)} 분"><span class="num__unit">분</span></span>
              <button class="icon-del" type="button" data-del-step="${pid}|${group}|${i}" aria-label="${esc(l)} 단계 지우기">×</button>
            </div>`
          )
          .join('') + `<button class="text-btn add-step" type="button" data-add-step="${pid}|${group}">+ 단계</button>`
      );
    },

    renderParking() {
      const used = new Set(this.draft.kinds.map((k) => k.parking));
      const G = [
        ['find', '① 자리 찾기 (도착)'],
        ['toDoor', '② 주차장 → 입구 (도착)'],
        ['toCar', '⑤ 입구 → 차 (나올 때)'],
        ['out', '⑥ 출차 (나올 때)'],
      ];
      $('parking-editor').innerHTML = Object.keys(this.draft.parking)
        .map((pid) => {
          const p = this.draft.parking[pid];
          return `<div class="pcard">
            <div class="pcard__head">
              <input class="input pcard__name" type="text" data-path="parking.${pid}.label" value="${esc(p.label)}" aria-label="주차장 이름">
              <span class="pcard__sum" data-sum="${pid}"></span>
            </div>
            <input class="input pcard__desc" type="text" data-path="parking.${pid}.desc" value="${esc(p.desc)}" placeholder="설명 (사용자에게 보임)" aria-label="설명">
            ${G.map(([g, label]) => `<div class="pgroup"><p class="pgroup__label">${label}</p>${this.stepRows(pid, g, p[g] || [])}</div>`).join('')}
            ${used.has(pid) ? '<p class="field__note">장소 종류의 "보통 주차장"으로 쓰는 중이라 지울 수 없어요</p>' : `<button class="text-btn danger" type="button" data-del-parking="${pid}">이 종류 지우기</button>`}
          </div>`;
        })
        .join('');
      this.renderSums();
    },

    renderSums() {
      document.querySelectorAll('[data-sum]').forEach((el) => {
        const p = this.draft.parking[el.dataset.sum];
        if (!p) return;
        el.textContent = `도착 ${r1(sumSteps(p.find) + sumSteps(p.toDoor))}분 · 나올 때 ${r1(sumSteps(p.toCar) + sumSteps(p.out))}분`;
      });
    },

    renderKinds() {
      const popts = (sel) => Object.keys(this.draft.parking).map((id) => `<option value="${id}"${id === sel ? ' selected' : ''}>${esc(this.draft.parking[id].label)}</option>`).join('');
      $('kind-editor').innerHTML = this.draft.kinds
        .map(
          (k, i) => `<div class="kcard">
            <div class="kcard__head"><input class="input kcard__name" type="text" data-path="kinds.${i}.label" value="${esc(k.label)}" aria-label="장소 종류 이름">${k.hidden ? '<span class="tag">첫 실행용</span>' : ''}</div>
            <div class="kgrid">
              ${this.numInput(`kinds.${i}.stay`, k.stay, '머무는 시간 보통')}
              ${this.numInput(`kinds.${i}.inside.0`, k.inside[0], '③ 들어갈 때', '분', 0.5)}
              <label class="txt"><span class="num__label">③ 이름</span><input class="input" type="text" data-path="kinds.${i}.insideLabel" value="${esc(k.insideLabel)}"></label>
              ${this.numInput(`kinds.${i}.inside.1`, k.inside[1], '④ 나올 때', '분', 0.5)}
              <label class="txt"><span class="num__label">④ 이름</span><input class="input" type="text" data-path="kinds.${i}.outsideLabel" value="${esc(k.outsideLabel)}"></label>
              <label class="txt"><span class="num__label">보통 주차장</span><select class="select select--sm" data-path="kinds.${i}.parking">${popts(k.parking)}</select></label>
            </div>
            <label class="toggle-row"><input type="checkbox" data-path="kinds.${i}.busy"${k.busy ? ' checked' : ''}><span class="toggle-row__text"><b>주말에 붐빔</b><small>주말엔 자리 찾기 시간에 혼잡 배수를 곱해요</small></span></label>
          </div>`
        )
        .join('');
    },

    renderFields() {
      const d = this.draft;
      const tf = (path, value, label) => `<label class="txt"><span class="num__label">${esc(label)}</span><input class="input" type="text" inputmode="numeric" placeholder="HH:MM" data-path="${path}" value="${esc(value)}"></label>`;
      $('busy-editor').innerHTML =
        this.numInput('busy.weekendFactor', d.busy.weekendFactor, '주말 배수 (붐비는 곳)', '배', 0.1) +
        this.numInput('busy.lunchFactor', d.busy.lunchFactor, '평일 점심 배수 (음식점)', '배', 0.1) +
        tf('busy.lunchFrom', d.busy.lunchFrom, '점심 시작') +
        tf('busy.lunchTo', d.busy.lunchTo, '점심 끝');
      const t = d.travel;
      $('travel-editor').innerHTML =
        this.numInput('travel.walkMpm', t.walkMpm, '걷는 속도', 'm/분') +
        this.numInput('travel.bikeMpm', t.bikeMpm, '자전거 속도', 'm/분') +
        this.numInput('travel.detour', t.detour, '걷기·자전거 길 돌아가는 정도', '배', 0.05) +
        this.numInput('travel.carBase', t.carBase, '자동차 기본(출발·신호)', '분', 0.5) +
        this.numInput('travel.carDetour', t.carDetour, '자동차 길 돌아가는 정도', '배', 0.05) +
        this.numInput('travel.carCityMpm', t.carCityMpm, '자동차 3km 미만', 'm/분', 10) +
        this.numInput('travel.carMidMpm', t.carMidMpm, '자동차 3~15km', 'm/분', 10) +
        this.numInput('travel.carFarMpm', t.carFarMpm, '자동차 15km 이상', 'm/분', 10) +
        this.numInput('travel.transitWait', t.transitWait, '대중교통 기다리기') +
        this.numInput('travel.transitAccess', t.transitAccess, '정류장까지 걷기') +
        this.numInput('travel.transitKmh', t.transitKmh, '대중교통 속도', 'km/h') +
        this.numInput('travel.transitDetour', t.transitDetour, '대중교통 돌아가는 정도', '배', 0.05);
      const b = d.buffer;
      $('etc-editor').innerHTML =
        '<p class="pgroup__label">원하는 시간</p>' +
        this.numInput('pref.tolerance', d.pref.tolerance, '늦어도 괜찮은 정도') +
        this.numInput('pref.weight', d.pref.weight, '그보다 늦을 때 손해', '배', 0.5) +
        '<p class="pgroup__label">식사 제안</p>' +
        tf('meals.lunch.from', d.meals.lunch.from, '점심 시작') +
        tf('meals.lunch.to', d.meals.lunch.to, '점심 끝') +
        this.numInput('meals.lunch.stay', d.meals.lunch.stay, '점심 먹는 시간') +
        tf('meals.dinner.from', d.meals.dinner.from, '저녁 시작') +
        tf('meals.dinner.to', d.meals.dinner.to, '저녁 끝') +
        this.numInput('meals.dinner.stay', d.meals.dinner.stay, '저녁 먹는 시간') +
        '<p class="pgroup__label">여유 설정</p>' +
        ['relaxed', 'normal', 'tight']
          .map((id) => this.numInput(`buffer.${id}.travelPct`, b[id].travelPct, `${b[id].label}: 이동 더하기`, '%') + this.numInput(`buffer.${id}.perStop`, b[id].perStop, `${b[id].label}: 볼일마다 더하기`))
          .join('') +
        '<p class="pgroup__label">집 들르기 자동 제안</p>' +
        this.numInput('homeSuggest.minRest', d.homeSuggest.minRest, '집에서 쉴 수 있는 최소 시간');
    },

    renderNotes() {
      const notes = Array.isArray(this.draft.notes) ? this.draft.notes : [];
      $('notes').innerHTML = `<h2 class="card__title">변경 이력</h2>` + (notes.length ? `<ul class="notes__list">${notes.map((n) => `<li><b>v${esc(n.version)}</b> ${esc(n.date)} — ${esc(n.text)}</li>`).join('')}</ul>` : '<p class="card__desc">아직 없어요</p>');
    },

    // 예시 일정으로 "끝나는 시각"이 어떻게 바뀌는지 바로 보여줌
    renderPreview() {
      const draftV = K.validate(this.draft);
      const pubV = K.validate(this.published) || K.BUILTIN;
      if (!draftV) {
        $('preview').innerHTML = '<p class="form-error">값에 빈 칸이나 잘못된 숫자가 있어요</p>';
        return;
      }
      const base = { lat: 37.3595, lng: 126.932 };
      const stops = () => [
        { place: { name: '군포시청', lat: 37.3617, lng: 126.9352 }, kind: 'gov', parking: 'auto', stay: 20, fixedAt: null, prefAt: null, deadline: null, order: 'any', mode: null },
        { place: { name: '은행', lat: 37.3583, lng: 126.9326 }, kind: 'bank', parking: 'auto', stay: 20, fixedAt: null, prefAt: null, deadline: 960, order: 'any', mode: null },
        { place: { name: '병원', lat: 37.3601, lng: 126.9312 }, kind: 'hospital', parking: 'auto', stay: 40, fixedAt: null, prefAt: null, deadline: null, order: 'any', mode: null },
        { place: { name: '대형마트', lat: 37.358, lng: 126.9283 }, kind: 'mart', parking: 'auto', stay: 45, fixedAt: null, prefAt: null, deadline: null, order: 'last', mode: null },
      ];
      const run = (model, weekend) => {
        const r = E.plan({
          start: base,
          startMin: 540,
          end: { type: 'return' },
          dayMode: 'car',
          stops: stops(),
          overheadFn: (st, mode, which, at) => K.overhead(st, mode, which, { weekend, atMin: at }, model),
          travelParams: model.travel,
          pref: model.pref,
        });
        return r.options[0].sim;
      };
      const diff = (a, b) => {
        const d = a - b;
        return d === 0 ? '<span class="pv-same">올린 값과 같음</span>' : `<span class="${d > 0 ? 'pv-up' : 'pv-down'}">올린 값보다 ${d > 0 ? '+' : ''}${d}분</span>`;
      };
      const wd = run(draftV, false);
      const we = run(draftV, true);
      const wd0 = run(pubV, false);
      const we0 = run(pubV, true);
      const ex = (pid, kind) => {
        const st = { kind, parking: pid };
        return `${K.overhead(st, 'car', 'arrive', {}, draftV).total}/${K.overhead(st, 'car', 'leave', {}, draftV).total}`;
      };
      $('preview').innerHTML = `
        <h2 class="card__title">미리보기 — 예시 일정</h2>
        <p class="card__desc">오전 9시 집 출발 → 구청·은행·병원·대형마트(마지막) → 집, 자동차</p>
        <div class="pv-grid">
          <div class="pv"><span class="pv__label">평일</span><b class="pv__time">${E.fmt(wd.doneAt)}</b> 끝 ${diff(wd.doneAt, wd0.doneAt)}</div>
          <div class="pv"><span class="pv__label">주말</span><b class="pv__time">${E.fmt(we.doneAt)}</b> 끝 ${diff(we.doneAt, we0.doneAt)}</div>
        </div>
        <table class="pv-table"><thead><tr><th>주차장</th><th>은행</th><th>병원</th><th>마트</th></tr></thead><tbody>
          ${Object.keys(draftV.parking).map((pid) => `<tr><td>${esc(draftV.parking[pid].label)}</td><td>${ex(pid, 'bank')}</td><td>${ex(pid, 'hospital')}</td><td>${ex(pid, 'mart')}</td></tr>`).join('')}
        </tbody></table>
        <p class="field__note">표: 도착 후 / 나올 때 (분), 평일 기준</p>`;
    },

    // =============================================================
    // ② 현장 측정기
    // =============================================================
    STEPS: [
      { id: 'enter', label: '주차장 들어감', btn: '주차장 들어가요' },
      { id: 'parked', label: '주차 끝', btn: '주차 끝났어요' },
      { id: 'elev', label: '엘리베이터 탐', btn: '엘리베이터 탔어요', optional: true },
      { id: 'door', label: '입구(매장) 도착', btn: '입구에 도착했어요' },
      { id: 'start', label: '볼일 시작', btn: '볼일 시작 (접수·카트 끝)' },
      { id: 'finish', label: '볼일 끝', btn: '볼일 끝났어요' },
      { id: 'exit', label: '건물 밖으로 나옴', btn: '건물 밖으로 나왔어요', optional: true },
      { id: 'car', label: '차 도착', btn: '차에 탔어요' },
      { id: 'out', label: '출차 끝', btn: '주차장을 나왔어요' },
    ],

    loadRun() {
      try {
        return JSON.parse(localStorage.getItem(RUN_KEY) || 'null');
      } catch (_) {
        return null;
      }
    },
    saveRun(run) {
      if (run) localStorage.setItem(RUN_KEY, JSON.stringify(run));
      else localStorage.removeItem(RUN_KEY);
    },
    loadMeasures() {
      try {
        return JSON.parse(localStorage.getItem(MEASURES_KEY) || '[]');
      } catch (_) {
        return [];
      }
    },
    saveMeasures(list) {
      localStorage.setItem(MEASURES_KEY, JSON.stringify(list));
    },

    wireMeasure() {
      const input = $('m-place');
      const search = async () => {
        const q = input.value.trim();
        if (!q) return;
        $('m-results').innerHTML = '<li class="results__hint">찾는 중…</li>';
        try {
          const list = await window.GetsetPlaces.search(q, null);
          this.mResults = list;
          $('m-results').innerHTML = list.length
            ? list.slice(0, 8).map((p, i) => `<li><button class="result" type="button" data-mi="${i}"><span class="result__name">${esc(p.name)}</span><span class="result__addr">${esc(p.address)}</span></button></li>`).join('')
            : '<li class="results__hint">결과가 없어요. 이름만 적고 측정해도 돼요</li>';
        } catch (_) {
          $('m-results').innerHTML = '<li class="results__hint">장소 검색을 못 했어요(이 주소에선 카카오 검색이 막혀 있을 수 있어요). 이름만 적고 측정해도 돼요</li>';
        }
      };
      $('m-search-btn').addEventListener('click', search);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          search();
        }
      });
      input.addEventListener('input', () => {
        this.mPlace = null;
        $('m-picked').textContent = '';
      });
      $('m-results').addEventListener('click', (e) => {
        const b = e.target.closest('[data-mi]');
        if (!b) return;
        const p = this.mResults[Number(b.dataset.mi)];
        this.mPlace = p;
        input.value = p.name;
        $('m-results').innerHTML = '';
        $('m-picked').textContent = `${p.address} · ${(p.categoryName || '').split('>').pop().trim()}`;
        $('m-kind').value = K.guess(p);
        $('m-parking').value = K.get($('m-kind').value).parking;
      });
      $('m-kind').addEventListener('change', () => ($('m-parking').value = this.draftKind($('m-kind').value).parking));

      $('m-start').addEventListener('click', () => {
        const name = input.value.trim();
        if (!name) {
          toast('장소 이름을 적어 주세요');
          input.focus();
          return;
        }
        const run = {
          place: this.mPlace ? { id: this.mPlace.id, name: this.mPlace.name, address: this.mPlace.address } : { id: '', name, address: '' },
          kind: $('m-kind').value,
          parking: $('m-parking').value,
          memo: $('m-memo').value.trim(),
          marks: { enter: Date.now() },
          idx: 1,
        };
        this.saveRun(run);
        this.renderRun();
      });
      $('m-next').addEventListener('click', () => this.markStep());
      $('m-skip').addEventListener('click', () => this.markStep(true));
      $('m-undo').addEventListener('click', () => {
        const run = this.loadRun();
        if (!run || run.idx <= 1) return;
        run.idx--;
        while (run.idx > 0 && !run.marks[this.STEPS[run.idx].id] && this.STEPS[run.idx].optional) run.idx--;
        delete run.marks[this.STEPS[run.idx].id];
        this.saveRun(run);
        this.renderRun();
      });
      $('m-cancel').addEventListener('click', () => {
        if (!confirm('이번 측정을 버릴까요?')) return;
        this.saveRun(null);
        this.renderRun();
      });
      $('m-list').addEventListener('click', (e) => {
        const b = e.target.closest('[data-del-m]');
        if (!b || !confirm('이 기록을 지울까요?')) return;
        const list = this.loadMeasures();
        list.splice(Number(b.dataset.delM), 1);
        this.saveMeasures(list);
        this.renderMeasures();
      });
      $('m-csv').addEventListener('click', () => this.exportCsv());
      $('m-apply').addEventListener('click', () => this.applyMeasures());

      setInterval(() => this.tickRun(), 1000);
      this.renderRun();
    },

    draftKind(id) {
      return this.draft.kinds.find((k) => k.id === id) || this.draft.kinds.find((k) => k.id === 'etc');
    },

    renderMeasureSelects() {
      $('m-kind').innerHTML = this.draft.kinds.map((k) => `<option value="${k.id}">${esc(k.label)}</option>`).join('');
      $('m-parking').innerHTML = Object.keys(this.draft.parking).map((id) => `<option value="${id}">${esc(this.draft.parking[id].label)}</option>`).join('');
      $('m-parking').value = this.draftKind($('m-kind').value).parking;
    },

    markStep(skip) {
      const run = this.loadRun();
      if (!run) return;
      const step = this.STEPS[run.idx];
      if (skip && !step.optional) return;
      if (!skip) run.marks[step.id] = Date.now();
      run.idx++;
      if (run.idx >= this.STEPS.length) {
        this.finishRun(run);
        return;
      }
      this.saveRun(run);
      this.renderRun();
      if (navigator.vibrate) navigator.vibrate(30);
    },

    finishRun(run) {
      const m = run.marks;
      const min = (a, b) => (m[a] && m[b] ? r1((m[b] - m[a]) / 60000) : null);
      const d = new Date(m.enter);
      const seg = {
        find: min('enter', 'parked'),
        toDoor: min('parked', 'door'),
        elevWait: m.elev ? min('parked', 'elev') : null,
        elevRide: m.elev ? min('elev', 'door') : null,
        inside: min('door', 'start'),
        stay: min('start', 'finish'),
        outside: m.exit ? min('finish', 'exit') : null,
        toCar: m.exit ? min('exit', 'car') : null,
        finishToCar: min('finish', 'car'),
        out: min('car', 'out'),
      };
      const list = this.loadMeasures();
      list.unshift({
        at: m.enter,
        weekend: d.getDay() === 0 || d.getDay() === 6,
        hour: d.getHours(),
        place: run.place,
        kind: run.kind,
        parking: run.parking,
        memo: run.memo,
        seg,
      });
      this.saveMeasures(list);
      this.saveRun(null);
      this.renderRun();
      this.renderMeasures();
      toast('측정을 저장했어요');
    },

    renderRun() {
      const run = this.loadRun();
      $('m-setup').hidden = !!run;
      $('m-run').hidden = !run;
      if (!run) return;
      const step = this.STEPS[run.idx];
      $('m-run-place').textContent = `${run.place.name} · ${this.draftKind(run.kind).label} · ${(this.draft.parking[run.parking] || {}).label || ''}`;
      $('m-run-step').textContent = `${run.idx + 1}/${this.STEPS.length} — 다음: ${step.label}`;
      $('m-next').textContent = step.btn;
      $('m-skip').hidden = !step.optional;
      $('m-undo').disabled = run.idx <= 1;
      const fmt = (t) => {
        const d = new Date(t);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      };
      $('m-log').innerHTML = this.STEPS.slice(0, run.idx)
        .map((s) => `<li class="${run.marks[s.id] ? '' : 'is-skip'}"><span>${s.label}</span><b>${run.marks[s.id] ? fmt(run.marks[s.id]) : '건너뜀'}</b></li>`)
        .join('');
      this.tickRun();
    },

    tickRun() {
      const run = this.loadRun();
      if (!run || $('m-run').hidden) return;
      const last = Math.max(...Object.values(run.marks));
      const s = Math.max(0, Math.floor((Date.now() - last) / 1000));
      $('m-run-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    },

    renderMeasures() {
      const list = this.loadMeasures();
      const segLine = (s) =>
        [
          ['자리', s.find],
          ['입구까지', s.toDoor],
          ['건물 안', s.inside],
          ['볼일', s.stay],
          ['나오기', s.outside],
          ['차까지', s.toCar != null ? s.toCar : s.finishToCar],
          ['출차', s.out],
        ]
          .filter(([, v]) => v != null)
          .map(([l, v]) => `${l} ${v}`)
          .join(' · ');
      $('m-list').innerHTML = list.length
        ? list
            .map((x, i) => {
              const d = new Date(x.at);
              return `<li class="m-item"><div><b>${esc(x.place.name)}</b><span class="m-item__meta">${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${x.weekend ? '주말' : '평일'} · ${esc(this.draftKind(x.kind).label)} · ${esc((this.draft.parking[x.parking] || {}).label || x.parking)}</span><span class="m-item__seg">${segLine(x.seg)} (분)</span>${x.memo ? `<span class="m-item__meta">${esc(x.memo)}</span>` : ''}</div><button class="icon-del" type="button" data-del-m="${i}" aria-label="기록 지우기">×</button></li>`;
            })
            .join('')
        : '<li class="results__hint">아직 측정 기록이 없어요</li>';

      // 요약: 주차장 종류별 / 장소 종류별 가운데값
      const byP = {};
      const byK = {};
      list.forEach((x) => {
        (byP[x.parking] = byP[x.parking] || []).push(x.seg);
        (byK[x.kind] = byK[x.kind] || []).push(x.seg);
      });
      const med = (arr, key) => {
        const v = median(arr.map((s) => s[key]).filter((n) => n != null));
        return v == null ? '–' : r1(v);
      };
      const pRows = Object.keys(byP)
        .map((pid) => {
          const a = byP[pid];
          return `<tr><td>${esc((this.draft.parking[pid] || {}).label || pid)}</td><td>${a.length}</td><td>${med(a, 'find')}</td><td>${med(a, 'toDoor')}</td><td>${med(a, 'toCar')}</td><td>${med(a, 'out')}</td></tr>`;
        })
        .join('');
      const kRows = Object.keys(byK)
        .map((kid) => {
          const a = byK[kid];
          return `<tr><td>${esc(this.draftKind(kid).label)}</td><td>${a.length}</td><td>${med(a, 'inside')}</td><td>${med(a, 'outside')}</td><td>${med(a, 'stay')}</td></tr>`;
        })
        .join('');
      $('m-summary').innerHTML = list.length
        ? `<p class="pgroup__label">주차장 종류별 (가운데값, 분)</p>
           <table class="pv-table"><thead><tr><th>주차장</th><th>건</th><th>자리</th><th>입구까지</th><th>차까지</th><th>출차</th></tr></thead><tbody>${pRows}</tbody></table>
           <p class="pgroup__label">장소 종류별 (가운데값, 분)</p>
           <table class="pv-table"><thead><tr><th>장소</th><th>건</th><th>들어가서</th><th>나오기</th><th>볼일</th></tr></thead><tbody>${kRows}</tbody></table>`
        : '<p class="card__desc">측정하면 여기에 가운데값이 모여요. 같은 종류를 3번 이상 재면 믿을 만해져요.</p>';
      $('m-apply').disabled = !list.length;
    },

    /** 측정 요약(가운데값)을 고치는 중인 값에 넣음 → 기본값 탭에서 확인 후 내려받기 */
    applyMeasures() {
      const list = this.loadMeasures();
      if (!list.length) return;
      const withStay = $('m-apply-stay').checked;
      const scale = (steps, total) => {
        if (total == null || !steps.length) return;
        const cur = sumSteps(steps);
        if (steps.length === 1 || cur === 0) {
          steps[0][1] = Math.round(total * 2) / 2;
          for (let i = 1; i < steps.length; i++) steps[i][1] = 0;
          return;
        }
        steps.forEach((s) => (s[1] = Math.round(((s[1] / cur) * total) * 2) / 2));
      };
      const changed = [];
      const byP = {};
      const byK = {};
      list.forEach((x) => {
        (byP[x.parking] = byP[x.parking] || []).push(x.seg);
        (byK[x.kind] = byK[x.kind] || []).push(x.seg);
      });
      Object.keys(byP).forEach((pid) => {
        const p = this.draft.parking[pid];
        if (!p) return;
        const a = byP[pid];
        const m = (k) => median(a.map((s) => s[k]).filter((n) => n != null));
        scale(p.find, m('find'));
        const ew = m('elevWait');
        const er = m('elevRide');
        if (ew != null && er != null && p.toDoor.length === 2) {
          p.toDoor[0][1] = Math.round(ew * 2) / 2;
          p.toDoor[1][1] = Math.round(er * 2) / 2;
        } else scale(p.toDoor, m('toDoor'));
        scale(p.toCar, m('toCar'));
        scale(p.out, m('out'));
        changed.push(p.label);
      });
      Object.keys(byK).forEach((kid) => {
        const k = this.draft.kinds.find((x) => x.id === kid);
        if (!k) return;
        const a = byK[kid];
        const m = (key) => median(a.map((s) => s[key]).filter((n) => n != null));
        if (m('inside') != null) k.inside[0] = Math.round(m('inside') * 2) / 2;
        if (m('outside') != null) k.inside[1] = Math.round(m('outside') * 2) / 2;
        if (withStay && m('stay') != null) k.stay = Math.max(5, Math.round(m('stay') / 5) * 5);
        changed.push(k.label);
      });
      this.saveDraft();
      this.renderAll();
      this.showTab('values');
      toast(`${changed.join(', ')}에 측정값을 넣었어요. 미리보기를 확인하고 내려받으세요`, 5000);
    },

    exportCsv() {
      const list = this.loadMeasures();
      const head = ['날짜시각', '평일주말', '장소', '장소ID', '장소종류', '주차장', '자리찾기', '입구까지', '엘베대기', '엘베탑승', '건물안', '볼일', '나오기', '차까지', '끝→차', '출차', '메모'];
      const rows = list.map((x) => {
        const d = new Date(x.at);
        const s = x.seg;
        return [
          `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
          x.weekend ? '주말' : '평일',
          x.place.name,
          x.place.id,
          this.draftKind(x.kind).label,
          (this.draft.parking[x.parking] || {}).label || x.parking,
          s.find, s.toDoor, s.elevWait, s.elevRide, s.inside, s.stay, s.outside, s.toCar, s.finishToCar, s.out,
          x.memo,
        ].map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`);
      });
      const csv = '﻿' + [head.join(','), ...rows.map((r) => r.join(','))].join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `getset-측정-${today()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
  };

  // ---------------------------------------------------------------
  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function openSheet(s) {
    s.hidden = false;
    document.body.classList.add('has-sheet');
    requestAnimationFrame(() => s.classList.add('is-open'));
  }
  function closeSheet(s) {
    s.classList.remove('is-open');
    s.hidden = true;
    document.body.classList.remove('has-sheet');
  }
  let toastTimer;
  function toast(msg, ms = 2800) {
    const t = $('toast');
    $('toast-msg').textContent = msg;
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add('is-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('is-visible');
      setTimeout(() => (t.hidden = true), 200);
    }, ms);
  }

  window.GetsetAdmin = A;
  A.init();
})();
