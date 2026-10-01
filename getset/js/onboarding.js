'use strict';

/**
 * 첫 실행 — 집·집 주차·자주 가는 곳·이동수단·여유·기록 동의 (설계문서 v1.1 §8)
 * 모두 건너뛸 수 있고, 나중에 "내 정보"에서 같은 화면으로 고칠 수 있다.
 *
 * GetsetOnboard.open({ steps, onDone })   steps 생략 = 처음부터 전부
 */
window.GetsetOnboard = (function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ALL = ['welcome', 'home', 'homePark', 'places', 'mode', 'consent'];
  const MODE_LABEL = { car: '자동차', walk: '걸어서', bike: '자전거', transit: '대중교통' };

  let P = null; // 고치는 중인 프로필
  let steps = ALL;
  let idx = 0;
  let done = null;
  let sub = null; // 자주 가는 곳 추가 중 { label, place, parking, arriveMin }
  let results = [];
  let searchSeq = 0;

  // 주차장 종류별 "주차하고 안까지 / 나와서 출발까지" 기본 분 (값 파일에서 계산)
  function defaults(parking, kind) {
    const K = window.GetsetKinds;
    if (parking === 'none') return { a: 0, l: 0 };
    const st = { kind: kind || 'home', parking };
    return { a: K.overhead(st, 'car', 'arrive', {}).total, l: K.overhead(st, 'car', 'leave', {}).total };
  }

  function parkingOptions(selected, withNone) {
    const K = window.GetsetKinds;
    const ids = K.PARKING_IDS.slice();
    const items = ids.map((id) => [id, K.PARKING[id].label, K.PARKING[id].desc]);
    if (withNone) items.push(['none', '차를 안 써요', '걷거나 대중교통으로 다녀요']);
    return `<div class="options options--compact" role="radiogroup">${items
      .map(([id, l, d]) => `<button class="option" type="button" role="radio" aria-checked="${selected === id}" data-ob-park="${id}"><b>${esc(l)}</b><small>${esc(d)}</small></button>`)
      .join('')}</div>`;
  }

  function stepper(id, label, value) {
    return `<div class="field"><span class="field__label">${esc(label)}</span>
      <div class="stepper"><button class="stepper__btn" type="button" data-ob-step="${id}|-1" aria-label="1분 줄이기"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></button>
      <output class="stepper__value" id="ob-${id}">${value}분</output>
      <button class="stepper__btn" type="button" data-ob-step="${id}|1" aria-label="1분 늘리기"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></button></div></div>`;
  }

  function searchBox(ph) {
    return `<div class="ob-search">
      <form class="search" data-ob-search autocomplete="off"><svg class="search__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input id="ob-q" type="search" enterkeyhint="search" placeholder="${esc(ph)}" aria-label="장소 검색"></form>
      <ul id="ob-results" class="results ob-results"></ul></div>`;
  }

  function picked(place) {
    return place ? `<div class="picked"><div class="picked__text"><strong class="picked__name">${esc(place.name)}</strong><span class="picked__addr">${esc(place.address || '')}</span></div></div>` : '';
  }

  // ------------------------------------------------------------------
  function render() {
    const step = steps[idx];
    const body = $('ob-body');
    const next = $('ob-next');
    const back = $('ob-back');
    back.hidden = idx === 0 || !!sub;
    $('ob-skip').textContent = steps.length === ALL.length ? '나중에 할게요' : '닫기';
    $('ob-dots').innerHTML = steps.length > 1 ? steps.map((_, i) => `<span class="${i === idx ? 'is-on' : ''}"></span>`).join('') : '';
    next.hidden = false;
    next.disabled = false;

    if (sub) return renderSub();

    if (step === 'welcome') {
      body.innerHTML = `<div class="ob-hero"><img src="icons/icon.svg" alt="" width="84" height="84">
        <h2 class="ob-title">반가워요! Getset이에요</h2>
        <p class="ob-desc">볼일이 몰린 날, 갈 곳만 넣으면<br><b>어디부터 갈지</b>와 <b>실제로 끝나는 시각</b>을 정리해 드려요.</p>
        <p class="ob-desc">주차 자리 찾기·엘리베이터·접수처럼 내비가 빼먹는 시간까지 챙기려면, 처음 한 번만 몇 가지 알려 주세요. <b>1분이면 돼요.</b></p></div>`;
      next.textContent = '시작하기';
    } else if (step === 'home') {
      body.innerHTML = `<h2 class="ob-title">집은 어디예요?</h2>
        <p class="ob-desc">출발지로 쓰고, 중간에 집에 들를 때도 써요. 이 기기에만 저장돼요.</p>
        <button class="quick__btn ob-here" type="button" data-ob-here><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>지금 여기가 집이에요</button>
        ${searchBox('주소(고산로 600) 또는 아파트 이름')}
        ${picked(P.home && P.home.place)}`;
      next.textContent = P.home && P.home.place ? '다음' : '집은 나중에';
    } else if (step === 'homePark') {
      if (!(P.home && P.home.place)) return go(1); // 집을 건너뛰었으면 집 주차도 건너뜀
      const park = (P.home && P.home.parking) || 'pilotis';
      const d = defaults(park, 'home');
      const a = P.home && P.home.arriveMin != null ? P.home.arriveMin : d.a;
      const l = P.home && P.home.leaveMin != null ? P.home.leaveMin : d.l;
      body.innerHTML = `<h2 class="ob-title">집에 차를 어떻게 세워요?</h2>
        ${parkingOptions(park, true)}
        ${park === 'none' ? '' : stepper('ha', '주차하고 집 안까지 보통', a) + stepper('hl', '집에서 나와 차로 출발까지 보통', l)}`;
      next.textContent = steps.length === 2 && idx === 1 ? '저장' : '다음';
    } else if (step === 'places') {
      const list = P.places;
      body.innerHTML = `<h2 class="ob-title">자주 가는 곳이 있나요?</h2>
        <p class="ob-desc">회사·아이 학교처럼 자주 가는 곳의 주차를 알려 주면 시간이 더 정확해져요. 없으면 넘어가도 돼요.</p>
        <ul class="ob-list">${list
          .map((x, i) => `<li><div><b>${esc(x.label || x.place.name)}</b><small>${esc(x.place.name)} · ${esc(parkLabel(x.parking))}${x.arriveMin != null ? ` · 도착 후 ${x.arriveMin}분` : ''}</small></div><button class="icon-del" type="button" data-ob-del="${i}" aria-label="지우기">×</button></li>`)
          .join('')}</ul>
        <div class="ob-add">${['회사', '학교·학원', '자주 가는 곳'].map((l) => `<button class="btn-line" type="button" data-ob-add="${l}">+ ${l}</button>`).join('')}</div>`;
      next.textContent = steps.length === 1 ? '저장' : '다음';
    } else if (step === 'mode') {
      body.innerHTML = `<h2 class="ob-title">평소엔 어떻게 다녀요?</h2>
        <div class="grid-2">${window.GetsetStore.MODES.map((m) => `<button class="pick" type="button" role="radio" aria-checked="${P.mode === m}" data-ob-mode="${m}"><b>${MODE_LABEL[m]}</b></button>`).join('')}</div>
        <h2 class="ob-title ob-title--sub">얼마나 여유 있게 계산할까요?</h2>
        <div class="options" role="radiogroup">${[
          ['relaxed', '넉넉하게', '늦는 게 싫어요. 이동 시간에 여유를 더해요'],
          ['normal', '보통', '조금만 여유를 둬요'],
          ['tight', '딱 맞게', '계산한 그대로 보여 주세요'],
        ]
          .map(([id, l, d]) => `<button class="option" type="button" role="radio" aria-checked="${P.buffer === id}" data-ob-buffer="${id}"><b>${l}</b><small>${d}</small></button>`)
          .join('')}</div>`;
      next.textContent = steps.length === 1 ? '저장' : '다음';
    } else if (step === 'consent') {
      body.innerHTML = `<h2 class="ob-title">Getset을 함께 키워 주세요</h2>
        <p class="ob-desc">길에서 "도착 · 볼일 시작 · 끝 · 출발" 버튼을 누르면, 그 장소의 실제 주차·대기 시간을 배워요.</p>
        <div class="ob-consent">
          <p><b>모두의 기록에 보태면</b> 다른 사람들의 기록도 함께 쓰여서, 처음 가는 곳도 정확해져요.</p>
          <ul><li>보내는 것: 가게·기관의 장소 번호, 주차장 종류, 걸린 분, 평일·주말</li>
          <li><b>안 보내는 것</b>: 집·회사 등 내 장소, 현재 위치, 이름·연락처, 하루 동선</li>
          <li>언제든 "내 정보"에서 끌 수 있어요</li></ul>
        </div>
        <div class="ob-two">
          <button class="btn-soft" type="button" data-ob-consent="yes">기록 보태기</button>
          <button class="btn-line" type="button" data-ob-consent="no">안 보낼래요</button>
        </div>
        <p class="field__note">${P.consent === true ? '지금: 보태는 중' : P.consent === false ? '지금: 안 보냄' : ''}</p>`;
      next.hidden = true;
    }
  }

  function parkLabel(id) {
    const K = window.GetsetKinds;
    return id === 'auto' || !K.PARKING[id] ? '보통 주차' : K.PARKING[id].label;
  }

  function renderSub() {
    const body = $('ob-body');
    const next = $('ob-next');
    next.textContent = '저장';
    if (!sub.place) {
      body.innerHTML = `<h2 class="ob-title">${esc(sub.label)} 찾기</h2>${searchBox('이름으로 찾기')}`;
      next.disabled = true;
      setTimeout(() => $('ob-q') && $('ob-q').focus(), 50);
      return;
    }
    const d = defaults(sub.parking, sub.kind);
    if (sub.arriveMin == null) sub.arriveMin = d.a;
    body.innerHTML = `<h2 class="ob-title">${esc(sub.label)} 주차는 어때요?</h2>${picked(sub.place)}
      ${parkingOptions(sub.parking, false)}
      ${stepper('pa', '주차하고 자리(사무실·교실 앞)까지 보통', sub.arriveMin)}`;
  }

  async function search(q) {
    const seq = ++searchSeq;
    const ul = $('ob-results');
    if (!ul) return;
    ul.innerHTML = '<li class="results__hint">찾는 중…</li>';
    try {
      const near = P.home && P.home.place;
      results = await window.GetsetPlaces.search(q, near);
      if (seq !== searchSeq) return;
      ul.innerHTML = results.length
        ? results.slice(0, 8).map((p, i) => `<li><button class="result" type="button" data-ob-pick="${i}"><span class="result__name">${esc(p.name)}</span><span class="result__addr">${esc(p.address)}</span></button></li>`).join('')
        : '<li class="results__hint">검색 결과가 없어요.<br>도로명 주소(예: 고산로 600)나 동·번지(예: 산본동 1150)로 찾아보세요.<br>집에 있다면 위의 [지금 여기가 집이에요]가 가장 쉬워요.</li>';
    } catch (_) {
      if (seq === searchSeq) ul.innerHTML = '<li class="results__hint">검색을 못 했어요. 인터넷 연결을 확인해 주세요</li>';
    }
  }

  // ------------------------------------------------------------------
  function wire() {
    const root = $('onboard');
    root.addEventListener('submit', (e) => {
      if (e.target.closest('[data-ob-search]')) {
        e.preventDefault();
        const q = $('ob-q').value.trim();
        if (q) search(q);
        $('ob-q').blur();
      }
    });
    let t;
    root.addEventListener('input', (e) => {
      if (e.target.id !== 'ob-q') return;
      clearTimeout(t);
      const q = e.target.value.trim();
      if (q) t = setTimeout(() => search(q), 300);
    });
    root.addEventListener('click', async (e) => {
      const g = (sel) => e.target.closest(sel);
      let b;
      if ((b = g('[data-ob-pick]'))) {
        const place = window.GetsetStore.cleanPlace(results[Number(b.dataset.obPick)]);
        if (sub) {
          sub.place = place;
          sub.kind = window.GetsetKinds.guess(results[Number(b.dataset.obPick)]);
          sub.parking = window.GetsetKinds.get(sub.kind).parking;
          sub.arriveMin = null;
        } else {
          P.home = Object.assign({}, P.home || { parking: 'pilotis' }, { place, label: '집' });
        }
        render();
      } else if (g('[data-ob-here]')) {
        b = g('[data-ob-here]');
        b.disabled = true;
        b.lastChild.textContent = '위치 찾는 중…';
        try {
          const p = await window.GetsetPlaces.current();
          P.home = Object.assign({}, P.home || { parking: 'pilotis' }, { place: Object.assign({}, p, { id: '', name: '집' + (p.name.match(/\(.+\)/) ? ' ' + p.name.match(/\(.+\)/)[0] : '') }), label: '집' });
          render();
        } catch (err) {
          b.disabled = false;
          b.lastChild.textContent = '지금 여기가 집이에요';
          alert(err && err.message === 'denied' ? '위치 권한이 꺼져 있어요. 이름으로 찾아 주세요.' : '위치를 못 찾았어요. 이름으로 찾아 주세요.');
        }
      } else if ((b = g('[data-ob-park]'))) {
        const id = b.dataset.obPark;
        if (sub) {
          sub.parking = id;
          sub.arriveMin = null;
        } else {
          P.home.parking = id;
          P.home.arriveMin = null;
          P.home.leaveMin = null;
        }
        render();
      } else if ((b = g('[data-ob-step]'))) {
        const [id, dir] = b.dataset.obStep.split('|');
        const d = Number(dir);
        if (id === 'pa') sub.arriveMin = Math.max(0, Math.min(90, sub.arriveMin + d));
        else {
          const def = defaults(P.home.parking, 'home');
          if (id === 'ha') P.home.arriveMin = Math.max(0, Math.min(90, (P.home.arriveMin != null ? P.home.arriveMin : def.a) + d));
          if (id === 'hl') P.home.leaveMin = Math.max(0, Math.min(90, (P.home.leaveMin != null ? P.home.leaveMin : def.l) + d));
        }
        const out = $(`ob-${id}`);
        if (out) out.textContent = `${id === 'pa' ? sub.arriveMin : id === 'ha' ? P.home.arriveMin : P.home.leaveMin}분`;
      } else if ((b = g('[data-ob-add]'))) {
        sub = { label: b.dataset.obAdd, place: null, parking: 'outdoor', arriveMin: null };
        render();
      } else if ((b = g('[data-ob-del]'))) {
        P.places.splice(Number(b.dataset.obDel), 1);
        render();
      } else if ((b = g('[data-ob-mode]'))) {
        P.mode = b.dataset.obMode;
        render();
      } else if ((b = g('[data-ob-buffer]'))) {
        P.buffer = b.dataset.obBuffer;
        render();
      } else if ((b = g('[data-ob-consent]'))) {
        P.consent = b.dataset.obConsent === 'yes';
        go(1);
      }
    });
    $('ob-next').addEventListener('click', () => {
      if (sub) {
        if (!sub.place) return;
        const my = window.GetsetProfile.cleanMy(sub);
        if (my) P.places = P.places.filter((x) => x.key !== my.key).concat(my);
        sub = null;
        render();
        return;
      }
      go(1);
    });
    $('ob-back').addEventListener('click', () => go(-1));
    $('ob-skip').addEventListener('click', () => {
      if (sub) {
        sub = null;
        render();
        return;
      }
      finish(steps.length === ALL.length); // 처음 실행에서 "나중에" = 지금까지 입력한 것만 저장
    });
  }

  function go(d) {
    idx += d;
    if (idx >= steps.length) return finish(false);
    if (idx < 0) idx = 0;
    render();
    $('ob-body').scrollTop = 0;
  }

  function finish(skipped) {
    P.onboarded = true;
    if (P.home && P.home.place) P.home = window.GetsetProfile.cleanMy(P.home);
    window.GetsetProfile.save(P);
    $('onboard').hidden = true;
    document.body.classList.remove('has-sheet');
    if (done) done(P, { skipped });
  }

  let wired = false;
  /**
   * @param {{steps?:string[], onDone?:Function}} opts
   */
  function open(opts = {}) {
    if (!wired) {
      wire();
      wired = true;
    }
    P = window.GetsetProfile.load();
    steps = opts.steps || ALL;
    idx = 0;
    sub = null;
    done = opts.onDone || null;
    $('onboard').hidden = false;
    document.body.classList.add('has-sheet');
    render();
  }

  return { open };
})();
