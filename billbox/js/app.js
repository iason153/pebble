'use strict';

/**
 * Billbox 화면 — 홈(이번 주 낼 것/안 낸 것) · 찍기 · 확인/입력 · 상세 · 설정
 * 시트·토스트·뒤로가기 처리는 Getset과 같은 방식(폰에서 검증됨).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const S = window.BillboxStore;
  const K = window.BillboxKinds;
  const G = window.BillboxGuide;
  const track = (n, p) => window.pebbleTrack && window.pebbleTrack(n, p);
  const won = (n) => (n == null || isNaN(n) ? '' : Number(n).toLocaleString('ko-KR'));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inDays = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const fmtDate = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    const wd = '일월화수목금토'[new Date(y, m - 1, d).getDay()];
    return `${m}월 ${d}일 (${wd})`;
  };

  const App = {
    env: null,
    editMode: null, // 'photo' | 'manual' | 'edit'
    similar: null,
    scanToken: 0,

    init() {
      this.wireSheets();
      this.wireHome();
      this.wireScan();
      this.wireEdit();
      this.wireSettings();
      this.env = window.BillboxInstall.init({
        appName: 'Billbox',
        track,
        showToast: (m, o) => this.showToast(m, o),
        openSheet: (s) => this.openSheet(s),
        closeSheet: (s) => this.closeSheet(s),
      });
      $('about-ver').textContent = (window.BILLBOX_CONFIG || {}).VERSION || '';
      if (!S.settings().introSeen) $('intro').hidden = false;
      this.wireMoney();
      this.wireSwipe();
      this.wireDelete();
      S.fixTaggedRepeat();
      this.autopayRoll();
      this.render();
      this.registerSW();
      this.wirePrep();
      this.wireStack();
      if (window.BillboxAI.mode() === 'off') window.BillboxOCR.warmup(); // AI로 읽으면 폰 사전은 폴백용 — 필요할 때만 받음
      this.cleanupPhotos();
      this.checkShared();
      this.renderStackBadge();
      this.pumpStack();
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          // 화면을 껐다 켜거나 다른 앱에 갔다 오면, 그 순간부터 이어서 읽는다
          this.pumpStack();
          this.renderStackBadge();
        }
      });
      track('open', { items: S.load().length });
    },

    /** 사전 내려받기 배너: 처음 한 번 보이고, 준비되면 "찍을 준비 됐어요"로 바뀐 뒤 사라짐 */
    wirePrep() {
      const box = $('ocr-prep');
      let shownLoading = false;
      $('btn-prep-retry').addEventListener('click', () => {
        $('btn-prep-retry').hidden = true;
        window.BillboxOCR.retry().catch(() => {});
        track('ocr_prep_retry');
      });
      window.BillboxOCR.onState(({ state, msg, progress }) => {
        if (state === 'loading') {
          // 이미 받아 둔 폰에서 엔진을 다시 올릴 땐 배너를 띄우지 않음(찍기 화면 진행 표시로 충분)
          if (window.BillboxOCR.isCached() && !shownLoading) return;
          shownLoading = true;
          box.hidden = false;
          box.classList.remove('is-ready', 'is-error');
          $('prep-icon').textContent = '📥';
          $('prep-msg').textContent = msg || '읽기 준비 중';
          $('prep-fill').style.width = Math.max(3, Math.round(progress * 100)) + '%';
          $('btn-prep-retry').hidden = true;
        } else if (state === 'ready') {
          if (!shownLoading) return; // 이미 받아 둔 경우엔 배너 자체를 안 보여 줌
          box.classList.add('is-ready');
          $('prep-icon').textContent = '✅';
          $('prep-msg').textContent = '찍을 준비 됐어요! 이제 바로 읽어요';
          $('prep-fill').style.width = '100%';
          $('prep-sub').textContent = '사전은 폰에 저장돼서 다음부터는 안 받아요.';
          track('ocr_prep_done');
          setTimeout(() => (box.hidden = true), 6000);
        } else if (state === 'error') {
          box.hidden = false;
          box.classList.add('is-error');
          $('prep-icon').textContent = '⚠️';
          $('prep-msg').textContent = msg || '읽기 도구를 준비하지 못했어요';
          $('prep-sub').textContent = '인터넷 연결을 확인하고 다시 받아 주세요. 그동안은 "직접 입력"으로 쓸 수 있어요.';
          $('btn-prep-retry').hidden = false;
          track('ocr_prep_fail');
        }
      });
    },

    /** 알림 문구용 사본을 폰 저장소에(서비스워커가 금액을 붙일 때 씀). 서버로는 안 감 */
    mirror() {
      const items = S.load()
        .filter((x) => !x.paidAt)
        .map((x) => ({ id: x.id, name: x.name || K.byId(x.kindId).label, kindId: x.kindId, emoji: K.byId(x.kindId).emoji, amount: x.amount, estimated: !!x.estimated, due: x.due, repeat: x.repeat, auto: x.auto ? 1 : 0 }));
      window.BillboxDB.putMirror(items);
    },

    /** 사진 보관 기간 정리: 낸 지 30일 지난 사진·지워진 항목의 사진 삭제 */
    async cleanupPhotos() {
      const keep = S.settings().photoKeep || 'paid30';
      const all = await window.BillboxDB.allPhotos();
      const ids = new Set(S.load().map((x) => x.id));
      const now = Date.now();
      let removed = 0;
      for (const [id, rec] of all) {
        let del = !ids.has(id) || keep === 'off';
        if (!del && rec && rec.paidAt) {
          if (keep === 'paid0') del = true;
          else if (keep === 'paid30' && now - rec.paidAt > 30 * 86400000) del = true;
        }
        if (del) {
          await window.BillboxDB.delPhoto(id);
          removed++;
        }
      }
      return { total: all.length - removed, removed };
    },

    /** 카톡·갤러리 "공유 → Billbox"로 들어온 사진 */
    async checkShared() {
      const q = new URLSearchParams(location.search);
      if (!q.has('shared')) return;
      try {
        history.replaceState(history.state, '', location.pathname);
      } catch (_) {}
      const blob = await window.BillboxDB.takeInbox();
      if (blob && /^text\//.test(blob.type || '')) {
        track('share_in', { type: 'text' });
        this.readText(await blob.text(), 'share');
        return;
      }
      if (blob) {
        // 옛 서비스워커가 사진을 inbox에 둔 경우
        track('share_in');
        this.stackAdd([blob], 'share');
        return;
      }
      const rows = await window.BillboxDB.stackAll();
      if (rows.length) {
        track('share_in', { n: rows.length });
        this.openStack();
        this.pumpStack();
      } else this.showToast('공유한 사진을 못 받았어요. 앨범에서 골라 주세요', { duration: 4000 });
    },

    addSamples() {
      const add = (o) => S.add(Object.assign({ sample: true, source: 'manual' }, o));
      add({ name: '도시가스', kindId: 'gas', amount: 48210, due: inDays(3), repeat: 'monthly' });
      add({ name: '건강보험', kindId: 'health', amount: 44740, due: inDays(-2), repeat: 'monthly', tag: '독촉' });
      add({ name: '넷플릭스', kindId: 'subscribe', amount: 17000, due: inDays(12), repeat: 'monthly' });
      add({ name: '자동차세', kindId: 'cartax', amount: 129870, due: inDays(40), repeat: 'half', months: [6, 12] });
      track('sample_add');
      this.render();
    },
    removeSamples() {
      S.save(S.load().filter((x) => !x.sample));
      this.render();
      window.BillboxPush.sync();
    },

    // =================================================================
    // 나갈 돈
    // =================================================================
    wireMoney() {
      $('btn-money').addEventListener('click', (e) => {
        e.stopPropagation();
        this.openMoney('cur');
      });
      $('money-body').addEventListener('click', (e) => {
        const b = e.target.closest('[data-month]');
        if (b) this.openMoney(b.dataset.month, true);
      });
    },
    openMoney(which, refresh) {
      const M = S.money();
      const key = which === 'next' ? M.next : M.cur;
      const box = M.months[key];
      const prevBox = M.months[which === 'next' ? M.cur : M.prev];
      const label = (ym) => `${Number(ym.slice(5))}월`;
      const diff = box.total - prevBox.total;
      const maxG = Math.max(1, ...M.groups.map((g) => box.groups[g.id]));
      const overdue = S.groups().overdue;
      const overSum = overdue.reduce((a, b) => a + (b.amount || 0), 0);
      $('money-body').innerHTML = `
        <div class="money-tabs">
          <button type="button" class="chip ${which !== 'next' ? 'is-on' : ''}" data-month="cur">이번 달 (${label(M.cur)})</button>
          <button type="button" class="chip ${which === 'next' ? 'is-on' : ''}" data-month="next">다음 달 (${label(M.next)})</button>
        </div>
        <div class="money-big"><small>${label(key)}에 나갈 돈${box.approx ? ' (어림 포함)' : ''}</small><b>${box.approx ? '약 ' : ''}${won(box.total)}원</b><small>${box.count}건${box.unknown ? ` · 금액 모르는 것 ${box.unknown}건` : ''}</small></div>
        <div class="money-row2">
          <div class="money-cell"><span>${which === 'next' ? '확정(고지서 찍은 것)' : '이미 낸 것'}</span><b>${won(which === 'next' ? box.total - box.approxAmt : box.paid)}원</b></div>
          <div class="money-cell"><span>${which === 'next' ? '어림(지난번 금액)' : '아직 남은 것'}</span><b>${which === 'next' ? '약 ' + won(box.approxAmt) : won(box.left)}원</b></div>
        </div>
        ${`<p class="small" style="margin-bottom:12px">${prevBox.total > 0 ? `${label(which === 'next' ? M.cur : M.prev)}보다 <span class="${diff > 0 ? 'diff-up' : 'diff-down'}">${diff > 0 ? '+' : ''}${won(diff)}원</span>` : `${label(which === 'next' ? M.cur : M.prev)} 기록이 쌓이면 비교해 드려요`}${which !== 'next' && overdue.length ? ` · <b style="color:var(--red)">밀린 것 ${overdue.length}건 ${won(overSum)}원</b>` : ''}</p>`}
        <h3 style="margin-bottom:8px">어디에 나가나</h3>
        <div class="bars">${M.groups
          .filter((g) => box.groups[g.id] > 0)
          .map((g) => `<div><div class="bar__top"><span>${g.emoji} ${g.label}</span><span>${won(box.groups[g.id])}원</span></div><div class="bar__track"><div class="bar__fill" style="width:${Math.round((box.groups[g.id] / maxG) * 100)}%"></div></div></div>`)
          .join('') || '<p class="muted small">아직 금액이 있는 항목이 없어요.</p>'}</div>
        <div class="card" style="box-shadow:var(--shadow-sm)">
          <h3>🔁 매달 나가는 돈 (고정 지출)</h3>
          <p style="font-size:1.4rem;font-weight:900;margin:4px 0 8px">약 ${won(M.fixed)}원</p>
          <ul class="fixed-list">${M.fixedList.map((f) => `<li><span>${K.byId(f.kindId).emoji} ${esc(f.name)}</span><span>${won(f.perMonth)}원${f.repeat !== 'monthly' ? ' <span class="muted small">(월로 환산)</span>' : ''}</span></li>`).join('') || '<li class="muted">반복 항목이 없어요</li>'}</ul>
          <p class="muted small" style="margin-top:8px">6개월·1년마다 내는 것은 한 달 몫으로 나눠 더했어요. 금액이 바뀌면 고지서를 찍어 맞춰 주세요.</p>
        </div>`;
      if (!refresh) {
        this.openSheet($('money-sheet'));
        track('money_open');
      }
    },

    // =================================================================
    // 밀어서 냈어요
    // =================================================================
    wireSwipe() {
      const list = $('list');
      let st = null;
      list.addEventListener('pointerdown', (e) => {
        const el = e.target.closest('.item[data-item], .frow[data-item]');
        if (el && el.classList.contains('frow')) return (st = null);
        if (!el || el.classList.contains('item--done') || el.classList.contains('item--fixed') || el.classList.contains('item--auto') || e.target.closest('button')) return;
        st = { el, x: e.clientX, y: e.clientY, dx: 0, on: false };
      });
      list.addEventListener('pointermove', (e) => {
        if (!st) return;
        const dx = e.clientX - st.x;
        const dy = e.clientY - st.y;
        if (!st.on) {
          if (Math.abs(dy) > 12) return (st = null);
          if (dx > 14 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            st.on = true;
            st.el.classList.add('is-swiping');
          } else return;
        }
        st.dx = Math.max(0, dx);
        st.el.style.transform = `translateX(${st.dx}px) rotate(0deg)`;
        st.el.style.background = st.dx > 100 ? 'var(--green-lt)' : '';
      });
      const end = () => {
        if (!st) return;
        const { el, dx, on } = st;
        st = null;
        if (!on) return;
        el.classList.remove('is-swiping');
        el.style.background = '';
        if (dx > 100) {
          el.style.transform = 'translateX(110%)';
          this.suppressClick = true;
          setTimeout(() => this.pay(el.dataset.item), 160);
          track('paid_swipe');
        } else el.style.transform = '';
        if (dx > 10) {
          this.suppressClick = true;
          setTimeout(() => (this.suppressClick = false), 300);
        }
      };
      list.addEventListener('pointerup', end);
      list.addEventListener('pointercancel', end);
      list.addEventListener('click', (e) => {
        if (this.suppressClick) {
          e.stopPropagation();
          e.preventDefault();
        }
      }, true);
    },

    /** 지우기: 반복 항목이면 "이번 차례만 건너뛰기 / 반복까지 모두 지우기" 중 고르게 */
    wireDelete() {
      $('del-sheet').addEventListener('click', (e) => {
        const b = e.target.closest('[data-del]');
        if (!b || !this.delTarget) return;
        const it = this.delTarget;
        const k = K.byId(it.kindId);
        if (b.dataset.del === 'skip') {
          const nx = S.skip(it.id);
          window.BillboxDB.delPhoto(it.id);
          track('skip_once', { kind: it.kindId });
          this.showToast(nx ? '이번 고지서만 지웠어요. 고정지출 장부에는 남아 있어요' : '지웠어요', { duration: 4000 });
        } else if (b.dataset.del === 'all') {
          S.remove(it.id);
          window.BillboxDB.delPhoto(it.id);
          track('delete', { kind: it.kindId, all: 1 });
          this.showToast(`"${it.name || k.label}" 고정지출을 통째로 없앴어요`, { duration: 3500 });
        } else return this.closeSheet($('del-sheet'));
        this.delTarget = null;
        this.render();
        window.BillboxPush.sync();
        this.hideSheetNow($('del-sheet'));
        this.hideSheetNow($('detail-sheet'));
        try {
          history.go(-2);
        } catch (_) {}
      });
    },
    askDelete(it) {
      this.delTarget = it;
      const k = K.byId(it.kindId);
      const rep = it.repeat && it.repeat !== 'none' && !it.paidAt;
      $('del-title').textContent = `"${it.name || k.label}" 지우기`;
      $('del-body').innerHTML = rep
        ? `<p style="margin-bottom:12px">${esc(K.repeatById(it.repeat).label)} 나가는 고정지출이에요. 어떻게 할까요?</p>
           <button type="button" class="btn btn--big btn--block btn--stack" data-del="skip" style="margin-bottom:10px">이번 고지서만 지우기<span class="small muted" style="font-weight:600">고정지출 장부에는 남아요 · 다음 알림 ${fmtDate(S.nextDue(it) || it.due)}</span></button>
           <button type="button" class="btn btn--big btn--block btn--danger btn--stack" data-del="all" style="margin-bottom:10px">고정지출 자체를 없애기<span class="small muted" style="font-weight:600">알림·사진·낸 기록까지 전부 끝</span></button>
           <button type="button" class="btn btn--block btn--ghost" data-del="cancel">그만두기</button>`
        : `<p style="margin-bottom:12px">이 항목과 저장된 고지서 사진이 지워져요.</p>
           <button type="button" class="btn btn--big btn--block btn--danger" data-del="all" style="margin-bottom:10px">지우기</button>
           <button type="button" class="btn btn--block btn--ghost" data-del="cancel">그만두기</button>`;
      this.openSheet($('del-sheet'));
    },

    registerSW() {
      if (!('serviceWorker' in navigator)) return;
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    },

    // =================================================================
    // 홈
    // =================================================================
    wireHome() {
      $('btn-intro-ok').addEventListener('click', () => {
        $('intro').hidden = true;
        S.saveSettings({ introSeen: true });
      });
      $('btn-settings').addEventListener('click', () => this.openSettings());
      $('btn-share').addEventListener('click', () => window.BillboxShare.share('header'));
      $('btn-scan').addEventListener('click', () => this.openScan());
      $('btn-manual').addEventListener('click', () => this.openEdit('manual'));
      $('list').addEventListener('click', (e) => {
        if (e.target.closest('[data-sample-add]')) return this.addSamples();
        if (e.target.closest('[data-sample-del]')) return this.removeSamples();
        const paid = e.target.closest('[data-paid]');
        if (paid) {
          e.stopPropagation();
          this.pay(paid.dataset.paid);
          return;
        }
        const it = e.target.closest('[data-item]');
        if (it) this.openDetail(it.dataset.item);
      });
    },

    render() {
      const g = S.groups();
      // v2: 반복 항목의 "예상" 차례는 고지서가 아니라 고정지출 → 아래 따로 보여 준다(마감 지난 건 그대로 잔소리)
      const isFixedRow = (it) => it.estimated && it.repeat && it.repeat !== 'none' && !it.tag && S.daysLeft(it.due) >= 0;
      const fixedUp = [...g.week, ...g.later].filter(isFixedRow);
      g.week = g.week.filter((it) => !isFixedRow(it));
      g.later = g.later.filter((it) => !isFixedRow(it));
      const list = $('list');
      const total = g.overdue.length + g.week.length;
      const sumAmt = [...g.overdue, ...g.week].reduce((a, b) => a + (b.amount || 0), 0);
      $('sum-count').textContent = total;
      $('summary').classList.toggle('is-alert', g.overdue.length > 0);
      if (g.overdue.length) {
        $('sum-title').textContent = `${g.overdue.length}건이 마감을 지났어요`;
        $('sum-sub').textContent = `이번 주까지 ${total}건 · ${won(sumAmt)}원`;
      } else if (total) {
        $('sum-title').textContent = '이번 주에 낼 것';
        $('sum-sub').textContent = `${won(sumAmt)}원 · 지난 건 없어요 👍`;
      } else {
        $('sum-title').textContent = '이번 주에 낼 것';
        $('sum-sub').textContent = S.load().length ? '이번 주는 낼 게 없어요 👍' : '아직 등록한 게 없어요';
      }

      const card = (it) => {
        const k = K.byId(it.kindId);
        const n = S.daysLeft(it.due);
        let dd;
        let cls = '';
        if (n < 0) {
          dd = `${-n}일 지남`;
          cls = 'dday--over';
        } else if (n === 0) {
          dd = '오늘!';
          cls = 'dday--today';
        } else {
          dd = `D-${n}`;
          cls = n > 7 ? 'dday--far' : '';
        }
        const badges = [it.tag ? `<span class="badge badge--red">${esc(it.tag)}</span>` : '', it.auto ? '<span class="badge badge--mint">🏦 자동이체</span>' : '', it.estimated ? '<span class="badge badge--ghost">예상</span>' : '', it.repeat && it.repeat !== 'none' ? `<span class="badge badge--mint">${esc(K.repeatById(it.repeat).label)}</span>` : ''].join('');
        const lf = n < 0 || it.tag ? G.lateFee(it.kindId, it.amount, Math.max(0, -n)) : null;
        const amtTxt = it.amount == null ? '금액 미정' : it.estimated ? `약 ${won(it.amount)}원` : `${won(it.amount)}원`;
        return `<div class="item ${n < 0 ? 'item--overdue' : ''} ${it.auto ? 'item--auto' : ''}" role="button" tabindex="0" data-item="${it.id}">
          <div class="item__emoji" aria-hidden="true">${k.emoji}</div>
          <div>
            <div class="item__name">${esc(it.name || k.label)} ${badges}</div>
            <div class="item__meta"><span class="item__amount">${amtTxt}</span> · ${fmtDate(it.due)}까지</div>
            ${it.note ? `<div class="item__note">📝 ${esc(it.note)}</div>` : ''}
            ${it.estimated && !it.paidAt ? '<div class="item__est">고지서 오면 찍어서 금액 맞추기</div>' : ''}
            ${lf && lf.short ? `<div class="item__late">늦으면 ${esc(lf.short)}</div>` : ''}
          </div>
          <div class="item__right">
            <span class="dday ${cls}">${dd}</span>
            ${it.auto ? '<span class="badge badge--ghost">자동 완료</span>' : `<button type="button" class="btn btn--sm item__paid" data-paid="${it.id}">냈어요</button>`}
          </div>
        </div>`;
      };
      const group = (title, items, badgeCls) => (items.length ? `<section class="group"><div class="group__head">${title}<span class="badge ${badgeCls}">${items.length}</span></div>${items.map(card).join('')}</section>` : '');

      let html = group('🚨 마감 지남', g.overdue, 'badge--red') + group('📌 이번 주', g.week, 'badge--brass') + group('📅 다음에', g.later, '');
      // 고정지출: 고지서 카드와 헷갈리지 않게, 접히는 "장부" 모양(한 줄짜리)
      const fixedRow = (it) => {
        const k = K.byId(it.kindId);
        const day = it.day || Number(it.due.slice(8, 10));
        return `<div class="frow" role="button" tabindex="0" data-item="${it.id}">
          <span class="frow__emoji">${k.emoji}</span>
          <span class="frow__name">${esc(it.name || k.label)}${it.note ? ` <small class="frow__note">${esc(it.note)}</small>` : ''}</span>
          <span class="frow__meta">${esc(K.repeatById(it.repeat).label)} ${day}일쯤${it.auto ? ' · 🏦자동' : ''}</span>
          <span class="frow__amt">${it.amount != null ? `약 ${won(it.amount)}원` : '-'}</span>
        </div>`;
      };
      if (fixedUp.length) {
        const sum = fixedUp.reduce((a, b) => a + (b.amount || 0), 0);
        html += `<details class="fixedbox" id="fixedbox"${this.fixedOpen ? ' open' : ''}>
          <summary>📌 고정지출 장부 <b>${fixedUp.length}건</b>${sum ? ` · 약 ${won(sum)}원` : ''}<span class="fixedbox__arrow">▾</span></summary>
          <p class="fixedbox__cap">여기는 고지서가 아니라 <b>등록된 반복 지출 목록</b>이에요. 때 되면 알림이 가고, 고지서를 찍으면 위에 실제 금액으로 올라와요.</p>
          ${fixedUp.map(fixedRow).join('')}
        </details>`;
      }
      if (!html) {
        html = `<div class="empty card card--tilt"><div class="empty__pic">📬</div><p><b>아직 비어 있어요.</b></p><p class="muted">아래 <b>고지서 찍기</b>를 눌러 보세요. 넷플릭스 같은 구독은 <b>직접 입력</b>으로.</p><button type="button" class="btn btn--sm" data-sample-add style="margin-top:10px">👀 예시 넣어 보기</button></div>`;
      }
      if (S.load().some((x) => x.sample)) html = `<div class="sample-bar"><span>지금 보이는 건 예시예요. 마음껏 눌러 보세요.</span><button type="button" class="btn btn--sm" data-sample-del>예시 지우기</button></div>` + html;
      if (g.overdue.length + g.week.length + g.later.length) html += `<p class="muted small" style="text-align:center;margin:8px 0 0">카드를 오른쪽으로 밀면 <b>냈어요</b>예요(지우기 아님) 👉 지우기는 카드를 눌러 맨 아래에서</p>`;
      if (g.done.length) {
        html += `<details class="done"><summary>낸 것 ${g.done.length}건</summary>${g.done
          .map((it) => {
            const k = K.byId(it.kindId);
            return `<div class="item item--done" role="button" tabindex="0" data-item="${it.id}"><div class="item__emoji">${k.emoji}</div><div><div class="item__name">${esc(it.name || k.label)}</div><div class="item__meta">${it.amount != null ? won(it.amount) + '원 · ' : ''}${fmtDate(it.due)} 냄</div></div><div class="item__right"><span class="stamp">냄</span></div></div>`;
          })
          .join('')}</details>`;
      }
      list.innerHTML = html;
      const fb = $('fixedbox');
      if (fb) fb.addEventListener('toggle', () => (this.fixedOpen = fb.open));
      this.mirror();
      list.querySelectorAll('[data-item]').forEach((el) =>
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.openDetail(el.dataset.item);
          }
        })
      );
    },

    pay(id) {
      const before = S.get(id);
      const it = S.markPaid(id);
      if (!it) return;
      window.BillboxDB.patchPhoto(id, { paidAt: Date.now() }).then(() => this.cleanupPhotos());
      this.render();
      window.BillboxPush.sync();
      track('paid', { kind: it.kindId, repeat: it.repeat });
      const msg = it.paidAt ? '냈어요! 🎉' : it.repeat && it.repeat !== 'none' ? `냈어요! 다음 차례는 고정지출 장부에 있어요 (${fmtDate(it.due)}쯤 알림)` : '냈어요! 🎉';
      this.showToast(msg, {
        actionLabel: '되돌리기',
        duration: 5000,
        onAction: () => {
          S.undoPaid(id);
          if (before && !before.paidAt) S.update(id, { paidAt: null });
          window.BillboxDB.patchPhoto(id, { paidAt: null });
          this.render();
          window.BillboxPush.sync();
        },
      });
      if (!$('detail-sheet').hidden) this.closeSheet($('detail-sheet'));
    },

    // =================================================================
    // 찍기
    // =================================================================
    wireScan() {
      ['file-camera', 'file-album'].forEach((id) => {
        const input = $(id);
        // 사진 고르는 앱으로 넘어가기 전에: 엔진을 메모리에서 내리고, "고르는 중" 표시를 남김(크롬이 꺼졌다 돌아오면 안내용)
        input.addEventListener('click', () => {
          window.BillboxOCR.release();
          try {
            sessionStorage.setItem('billbox:picking', String(Date.now()));
          } catch (_) {}
        });
        input.addEventListener('change', (e) => {
          try {
            sessionStorage.removeItem('billbox:picking');
          } catch (_) {}
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          if (files.length) this.stackAdd(files, id === 'file-camera' ? 'camera_app' : 'album');
        });
      });
      $('btn-cam-open').addEventListener('click', () => this.openCam());
      $('btn-cam-cancel').addEventListener('click', () => {
        this.stopCam();
        $('scan-cam').hidden = true;
        $('scan-pick').hidden = false;
      });
      $('btn-cam-shot').addEventListener('click', () => this.shot());
      $('btn-retry-tap').addEventListener('click', () => {
        const f = this.lastFailed;
        if (!f) return;
        this.hideSheetNow($('scan-sheet'));
        this.pendingPhoto = f.photo;
        this.pendingSource = f.source;
        this.openEdit('photo', f.ex);
        track('tap_from_fail');
      });
      // 카톡·문자 고지서: 글을 붙여 넣으면 사진보다 정확(같은 읽기 규칙 사용)
      $('btn-paste-open').addEventListener('click', () => {
        const box = $('paste-box');
        box.hidden = !box.hidden;
        $('btn-paste-open').setAttribute('aria-expanded', String(!box.hidden));
        if (!box.hidden) $('paste-text').focus();
      });
      $('btn-paste-clip').addEventListener('click', async () => {
        try {
          const t = await navigator.clipboard.readText();
          if (t) $('paste-text').value = t;
          else this.showToast('복사한 글이 없어요');
        } catch (_) {
          this.showToast('글 칸을 길게 눌러 "붙여넣기"를 골라 주세요', { duration: 3500 });
          $('paste-text').focus();
        }
      });
      $('btn-paste-read').addEventListener('click', () => {
        const t = $('paste-text').value.trim();
        if (!t) {
          this.showToast('먼저 고지서 글을 붙여 넣어 주세요');
          return;
        }
        this.hideSheetNow($('scan-sheet'));
        this.readText(t, 'paste');
      });
      $('btn-retry-manual').addEventListener('click', () => {
        this.hideSheetNow($('scan-sheet'));
        this.openEdit('manual');
      });
      $('btn-cam-torch').addEventListener('click', () => this.toggleTorch());
      // 시트를 닫으면 카메라도 끔
      const obs = new MutationObserver(() => {
        if ($('scan-sheet').hidden) this.stopCam();
      });
      obs.observe($('scan-sheet'), { attributes: true, attributeFilter: ['hidden'] });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.stopCam();
      });
      this.checkLostPhoto();
      $('btn-scan-cancel').addEventListener('click', () => {
        this.scanToken++;
        this.hideSheetNow($('scan-sheet'));
        this.openEdit('manual');
      });
    },

    /** 카메라 앱·앨범에 갔다가 크롬이 꺼져서 돌아온 경우 안내 */
    checkLostPhoto() {
      let t = 0;
      try {
        t = Number(sessionStorage.getItem('billbox:picking') || 0);
        sessionStorage.removeItem('billbox:picking');
      } catch (_) {}
      if (!t || Date.now() - t > 10 * 60 * 1000) return;
      track('scan_lost');
      setTimeout(() => {
        this.openScan();
        $('scan-lost').hidden = false;
      }, 300);
    },

    camSupported() {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    },

    async openCam() {
      if (!this.camSupported()) {
        $('btn-cam-open').hidden = true;
        $('file-camera').click();
        return;
      }
      $('scan-pick').hidden = true;
      $('scan-cam').hidden = false;
      $('cam-hint').textContent = '고지서를 테두리 안에 맞추고, 흔들리지 않게 잡아 주세요';
      try {
        // 미리보기는 크게 요청(지원하는 만큼). 실제 사진은 아래 takePhoto로 카메라 원래 화질로 찍는다
        this.camStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
          audio: false,
        });
        const v = $('cam-video');
        v.srcObject = this.camStream;
        await v.play().catch(() => {});
        const t = this.camStream.getVideoTracks()[0];
        const caps = t && t.getCapabilities ? t.getCapabilities() : {};
        // 계속 초점 맞추기(지원 폰만)
        if (caps.focusMode && caps.focusMode.includes('continuous')) t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        $('btn-cam-torch').hidden = !caps.torch;
        this.torchOn = false;
        this.imageCapture = 'ImageCapture' in window && t ? new window.ImageCapture(t) : null;
        const st = t && t.getSettings ? t.getSettings() : {};
        track('cam_open', { ok: 1, w: st.width || 0, h: st.height || 0, ic: this.imageCapture ? 1 : 0 });
      } catch (err) {
        track('cam_open', { ok: 0, reason: (err && err.name) || 'x' });
        this.stopCam();
        $('scan-cam').hidden = true;
        $('scan-pick').hidden = false;
        this.showToast(err && err.name === 'NotAllowedError' ? '카메라 권한이 꺼져 있어요. "📸 고지서 찍기"나 앨범을 써 주세요' : '앱 안 카메라를 못 열었어요. "📸 고지서 찍기"를 써 주세요', { duration: 4500 });
      }
    },

    stopCam() {
      if (this.camStream) {
        this.camStream.getTracks().forEach((t) => t.stop());
        this.camStream = null;
      }
      this.imageCapture = null;
      const v = $('cam-video');
      if (v) v.srcObject = null;
    },

    async toggleTorch() {
      const t = this.camStream && this.camStream.getVideoTracks()[0];
      if (!t) return;
      this.torchOn = !this.torchOn;
      try {
        await t.applyConstraints({ advanced: [{ torch: this.torchOn }] });
      } catch (_) {}
    },

    /**
     * 찍기: ① ImageCapture.takePhoto — 카메라 원래 화질(초점·노출 자동), 카메라 앱과 비슷
     *       ② 안 되면 미리보기 화면에서 테두리 안쪽만 잘라 씀(글자가 커지게)
     */
    async shot() {
      const v = $('cam-video');
      if (!v.videoWidth || this.shooting) return;
      this.shooting = true;
      $('cam-hint').textContent = '찰칵! 그대로 잠깐만요…';
      let blob = null;
      let method = 'frame';
      try {
        if (this.imageCapture && this.imageCapture.takePhoto) {
          let opts = {};
          try {
            const pc = await this.imageCapture.getPhotoCapabilities();
            if (pc && pc.imageWidth && pc.imageWidth.max) opts = { imageWidth: pc.imageWidth.max, imageHeight: pc.imageHeight.max };
            if (this.torchOn && pc.fillLightMode && pc.fillLightMode.includes('flash')) opts.fillLightMode = 'flash';
          } catch (_) {}
          blob = await Promise.race([this.imageCapture.takePhoto(opts), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000))]);
          method = 'photo';
        }
      } catch (_) {
        blob = null;
      }
      if (!blob) {
        // 미리보기 화면에서 테두리(가로 8%~92%, 세로 12%~88%) 안쪽만 — 화면 표시(object-fit: cover)와 영상 좌표를 맞춰 계산
        const vw = v.videoWidth, vh = v.videoHeight;
        const r = v.getBoundingClientRect();
        const sc = Math.max(r.width / vw, r.height / vh);
        const offX = (vw * sc - r.width) / 2, offY = (vh * sc - r.height) / 2;
        const gx = (r.width * 0.05 + offX) / sc, gy = (r.height * 0.08 + offY) / sc;
        const gw = (r.width * 0.9) / sc, gh = (r.height * 0.84) / sc;
        const c = document.createElement('canvas');
        c.width = Math.round(gw);
        c.height = Math.round(gh);
        c.getContext('2d').drawImage(v, gx, gy, gw, gh, 0, 0, c.width, c.height);
        blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
        c.width = c.height = 0;
      }
      const st = this.camStream ? this.camStream.getVideoTracks()[0].getSettings() : {};
      track('cam_shot', { method, w: st.width || 0, h: st.height || 0 });
      this.stopCam();
      this.shooting = false;
      $('scan-cam').hidden = true;
      if (blob) this.stackAdd([blob], method === 'photo' ? 'camera' : 'camera_frame');
    },

    openScan() {
      if ($('btn-retry-tap')) $('btn-retry-tap').hidden = true;
      if (!window.BillboxAI.available()) {
        const st = window.BillboxOCR.getState();
        if (st.state !== 'ready') this.showToast(st.state === 'error' ? '읽기 도구가 아직 준비 안 됐어요. 홈의 [다시 받기]를 눌러 주세요' : '아직 사전을 받는 중이에요. 찍으면 받은 뒤 이어서 읽어요', { duration: 4000 });
      }
      $('scan-pick').hidden = false;
      $('scan-cam').hidden = true;
      $('scan-progress').hidden = true;
      $('scan-lost').hidden = true;
      $('scan-retry').hidden = true;
      this.openSheet($('scan-sheet'));
      track('scan_open');
    },

    // =================================================================
    // 정리함 — 찍기=담기(1초), 읽기는 뒤에서, 확인은 나중에 톡톡
    // =================================================================
    /** 사진 여러 장을 정리함에. 담는 즉시 종이는 버려도 됨(사진은 폰 저장소에) */
    async stackAdd(files, from) {
      let n = 0;
      for (const f of files) {
        if (!f || !f.size) continue;
        const id = await window.BillboxDB.stackAdd(f, from);
        if (id) n++;
      }
      if (!n) {
        this.showToast('사진을 담지 못했어요. 다시 골라 주세요');
        return;
      }
      track('stack_add', { n, from });
      this.hideSheetNow($('scan-sheet'));
      this.showToast(`${n}장 담았어요 — 종이는 버리셔도 돼요 🗑️`, { duration: 3000 });
      await this.openStack();
      this.renderStackBadge();
      this.pumpStack();
    },

    wireStack() {
      $('btn-stack').addEventListener('click', () => this.openStack());
      $('btn-stack-go').addEventListener('click', () => this.nextConfirm());
      $('stack-list').addEventListener('click', (e) => {
        const del = e.target.closest('[data-sdel]');
        if (del) {
          window.BillboxDB.stackDel(del.dataset.sdel).then(() => {
            this.renderStack(true);
            this.renderStackBadge();
          });
          return;
        }
        const go = e.target.closest('[data-sconfirm]');
        if (go) this.openConfirm(go.dataset.sconfirm);
      });
      $('btn-ai-on').addEventListener('click', () => this.aiChoose('on'));
      $('btn-ai-off').addEventListener('click', () => this.aiChoose('off'));
      // 고르지 않고 닫으면: 이번만 폰 읽기(저장 안 함 → 다음에 다시 물어봄)
      new MutationObserver(() => {
        if ($('ai-sheet').hidden && this.aiResolve) {
          const r = this.aiResolve;
          this.aiResolve = null;
          r(S.settings().aiRead === 'on' ? 'on' : 'off');
        }
      }).observe($('ai-sheet'), { attributes: true, attributeFilter: ['hidden'] });
    },
    aiChoose(v) {
      S.saveSettings({ aiRead: v });
      track('ai_choice', { on: v === 'on' ? 1 : 0 });
      if (v === 'off') window.BillboxOCR.warmup();
      const r = this.aiResolve;
      this.aiResolve = null;
      this.closeSheet($('ai-sheet'));
      if (r) r(v);
    },
    /** 처음 한 번: 사진을 AI로 읽을지 묻는다 */
    ensureAiChoice() {
      const m = S.settings().aiRead;
      if (m === 'on' || m === 'off') return Promise.resolve(m);
      return new Promise((res) => {
        this.aiResolve = res;
        this.openSheet($('ai-sheet'));
      });
    },

    async openStack() {
      await this.renderStack(true);
      if ($('stack-sheet').hidden) this.openSheet($('stack-sheet'));
    },
    async renderStackBadge() {
      const rows = await window.BillboxDB.stackAll();
      const b = $('btn-stack');
      b.hidden = !rows.length;
      if (!rows.length) return;
      const done = rows.filter(([, r]) => r.status === 'read' || r.status === 'fail').length;
      b.innerHTML = `🗂️ 정리함 ${rows.length}장 <small>${done === rows.length ? '모두 읽었어요 — 눌러서 확인하세요' : done ? `${done}장 읽음 · 마저 읽는 중…` : '읽는 중… 다른 걸 하셔도 돼요'}</small>`;
    },
    async renderStack(force) {
      if ($('stack-sheet').hidden && !force) return;
      const rows = await window.BillboxDB.stackAll();
      (this.stackUrls || []).forEach((u) => URL.revokeObjectURL(u));
      this.stackUrls = [];
      const row = ([id, r]) => {
        const url = URL.createObjectURL(r.blob);
        this.stackUrls.push(url);
        let name = '';
        let meta = '';
        let cls = '';
        let btns = '';
        if (r.status === 'read' && r.ex) {
          const k = r.ex.kindId ? K.byId(r.ex.kindId) : null;
          name = `${k ? k.emoji + ' ' : ''}${esc(r.ex.name || (k ? k.label : '읽었어요'))}`;
          meta = [r.ex.amount != null ? won(r.ex.amount) + '원' : null, r.ex.due ? fmtDate(r.ex.due) + '까지' : null].filter(Boolean).join(' · ') || '내용을 확인해 주세요';
          btns = `<button type="button" class="btn btn--sm btn--brass" data-sconfirm="${id}">확인</button>`;
        } else if (r.status === 'fail') {
          cls = 'srow--fail';
          name = '🤔 못 읽었어요';
          meta = r.note === 'notbill' ? '고지서가 아닌 것 같아요' : '사진을 보며 직접 적을 수 있어요';
          btns = `<button type="button" class="btn btn--sm" data-sconfirm="${id}">직접 확인</button><button type="button" class="btn btn--sm btn--ghost" data-sdel="${id}">지우기</button>`;
        } else {
          cls = 'srow--reading';
          name = '📥 읽는 중…';
          meta = '잠깐이면 돼요';
        }
        return `<div class="srow ${cls}"><img class="srow__thumb" src="${url}" alt=""><div class="srow__txt"><div class="srow__name">${name}</div><div class="srow__meta">${meta}</div></div><div class="srow__btns">${btns}</div></div>`;
      };
      $('stack-list').innerHTML = rows.length ? rows.map(row).join('') : '<p class="muted" style="text-align:center;padding:20px 0">비어 있어요. 고지서를 찍으면 여기 쌓여요 📬</p>';
      const ready = rows.filter(([, r]) => r.status === 'read' || r.status === 'fail').length;
      $('btn-stack-go').hidden = ready === 0;
      if (ready) $('btn-stack-go').textContent = `✅ 하나씩 확인하기 (${ready}장)`;
    },

    /** 정리함의 안 읽은 사진을 한 장씩 읽는다(AI 먼저, 안 되면 폰에서) */
    async pumpStack() {
      if (this.pumping) return;
      this.pumping = true;
      try {
        const rows = await window.BillboxDB.stackAll();
        const todo = rows.filter(([, r]) => r.status === 'new' || r.status === 'reading');
        if (!todo.length) return;
        const choice = await this.ensureAiChoice();
        for (const [id] of todo) {
          const rec = await window.BillboxDB.stackGet(id);
          if (!rec || (rec.status !== 'new' && rec.status !== 'reading')) continue;
          await window.BillboxDB.stackPatch(id, { status: 'reading' });
          this.renderStack();
          let plain = null;
          let src = 'ai';
          if (choice === 'on') {
            try {
              const r = await window.BillboxAI.read(rec.blob);
              if (r.notBill) plain = { notBill: true };
              else if (!r.fallback) plain = this.exToPlain(r);
              else track('ai_fallback', { reason: r.reason });
            } catch (_) {}
          }
          if (!plain) {
            src = 'local';
            try {
              plain = await this.readLocalPlain(rec.blob);
            } catch (_) {
              plain = null;
            }
          }
          if (plain && !plain.notBill && (plain.amount != null || plain.due || plain.kindId)) {
            await window.BillboxDB.stackPatch(id, { status: 'read', ex: plain, source: src });
            track('stack_read', { ok: 1, src });
          } else {
            await window.BillboxDB.stackPatch(id, { status: 'fail', ex: plain && !plain.notBill ? plain : null, note: plain && plain.notBill ? 'notbill' : '' });
            track('stack_read', { ok: 0, src });
          }
          this.renderStack();
          this.renderStackBadge();
        }
        // 다 읽었고 정리함을 보고 있으면 바로 확인 시작(톡톡 리듬)
        if (!$('stack-sheet').hidden && $('edit-sheet').hidden) this.nextConfirm();
      } finally {
        this.pumping = false;
      }
    },

    /** 폰 안 읽기(AI 끔·실패·한도 초과일 때) */
    async readLocalPlain(blob) {
      const res = await window.BillboxOCR.readBill(blob, () => {}, (texts) => {
        const ex = window.BillboxExtract.extract(texts);
        return !!(ex.amount && ex.due && ex.sure.amount && ex.sure.due);
      });
      const ex = window.BillboxExtract.extract(res.texts);
      ex.accounts = window.BillboxExtract.accounts(res.texts);
      ex.usage = window.BillboxExtract.usage(res.texts);
      ex.source = 'local';
      ex.autopay = /자동\s*이체|자동\s*납부|출금\s*예정|인출\s*예정/.test(res.texts.join(' '));
      return this.exToPlain(ex);
    },
    exToPlain(ex) {
      return {
        source: ex.source || 'ai',
        kindId: ex.kind ? ex.kind.id : null,
        name: ex.name || '',
        tag: ex.tag || '',
        amount: ex.amount != null ? ex.amount : null,
        due: ex.due || null,
        altAmounts: ex.altAmounts || [],
        altDues: ex.altDues || [],
        sure: ex.sure || { amount: false, due: false },
        accounts: ex.accounts || [],
        usage: ex.usage || null,
        amountLate: ex.amountLate || null,
        autopay: !!ex.autopay,
        unit: ex.unit || null,
      };
    },
    plainToEx(p) {
      return Object.assign({}, p, { kind: p.kindId ? K.byId(p.kindId) : null, altAmounts: p.altAmounts || [], altDues: p.altDues || [], sure: p.sure || { amount: false, due: false }, accounts: p.accounts || [] });
    },
    /** 저장용 사진(1700px)으로 줄이기 */
    async shrinkPhoto(blob) {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const sc = Math.min(1, 1700 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * sc));
      c.height = Math.max(1, Math.round(bmp.height * sc));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      const out = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
      c.width = c.height = 0;
      return out || blob;
    },

    /** 정리함 카드 1장 → 확인 화면(사진 썸네일 + 읽은 값, 맞으면 저장 → 다음 장) */
    async openConfirm(stackId) {
      const rec = await window.BillboxDB.stackGet(stackId);
      if (!rec) return this.renderStack(true);
      const ex = this.plainToEx(rec.ex || { sure: { amount: false, due: false }, altAmounts: [], altDues: [], accounts: [] });
      this.pendingSource = rec.blob;
      this.pendingPhoto = await this.shrinkPhoto(rec.blob).catch(() => rec.blob);
      this.hideSheetNow($('stack-sheet'));
      this.openEdit('photo', ex);
      this.confirmStack = stackId;
      if (ex.name) {
        $('f-name').value = ex.name;
        $('f-name').dataset.auto = '0';
      }
      const rows = await window.BillboxDB.stackAll();
      const left = rows.filter(([i]) => i !== stackId).length;
      if (left > 0) $('edit-title').textContent = `읽은 내용, 맞나요? (남은 ${left}장)`;
    },
    async nextConfirm() {
      this.renderStackBadge();
      const rows = await window.BillboxDB.stackAll();
      const next = rows.find(([, r]) => r.status === 'read') || rows.find(([, r]) => r.status === 'fail');
      if (next) return this.openConfirm(next[0]);
      if (!rows.length) {
        if (!$('stack-sheet').hidden) this.closeSheet($('stack-sheet'));
        this.showToast('정리 끝! 📬 마감은 알림이 챙길게요', { duration: 3500 });
      } else this.openStack();
    },

    /** 자동이체는 날짜가 지나면 자동 "냈어요"(통장에서 알아서 나가니까 누를 필요 없음) */
    autopayRoll() {
      let n = 0;
      for (const b of S.load()) {
        if (!b.auto) continue;
        let cur = S.get(b.id);
        let guard = 0;
        while (cur && !cur.paidAt && S.daysLeft(cur.due) < 0 && guard++ < 12) {
          S.markPaid(cur.id);
          cur = S.get(b.id);
          n++;
        }
      }
      if (n) {
        this.mirror();
        window.BillboxPush.sync();
        track('autopay_roll', { n });
      }
      return n;
    },

    async scan(file, from) {
      const token = ++this.scanToken;
      $('scan-pick').hidden = true;
      $('scan-cam').hidden = true;
      $('scan-progress').hidden = false;
      const prog = (p, msg) => {
        if (token !== this.scanToken) return;
        $('progress-fill').style.width = Math.round(p * 100) + '%';
        if (msg) $('progress-msg').textContent = msg;
      };
      prog(0.02, '사진을 여는 중');
      track('scan_start', { from });
      const started = Date.now();
      const tick = setInterval(() => {
        if (token !== this.scanToken) return clearInterval(tick);
        const sec = Math.round((Date.now() - started) / 1000);
        $('progress-sec').textContent = sec >= 3 ? `${sec}초째 · 화면을 켜 두세요` : '';
      }, 1000);
      let res;
      try {
        res = await window.BillboxOCR.readBill(file, prog, (texts) => {
          const ex = window.BillboxExtract.extract(texts);
          return !!(ex.amount && ex.due && ex.sure.amount && ex.sure.due);
        });
      } catch (err) {
        clearInterval(tick);
        if (token !== this.scanToken) return;
        track('scan_fail', { reason: 'engine' });
        this.hideSheetNow($('scan-sheet'));
        this.openEdit('manual');
        this.showToast(`읽기 도구를 준비하지 못했어요 (${err.message || '네트워크'}). 직접 입력해 주세요`, { duration: 5000 });
        return;
      }
      clearInterval(tick);
      if (token !== this.scanToken) return;
      const ex = window.BillboxExtract.extract(res.texts);
      ex.accounts = window.BillboxExtract.accounts(res.texts);
      ex.usage = window.BillboxExtract.usage(res.texts);
      this.pendingPhoto = res.photo || null;
      this.pendingSource = res.source || res.photo || null; // 콕 찍기는 원본(큰 사진)에서 읽어야 정확
      const got = (ex.amount ? 1 : 0) + (ex.due ? 1 : 0) + (ex.kind ? 1 : 0);
      this.lastFailed = null;
      track('scan_done', { got, kind: ex.kind ? ex.kind.id : 'none', ms: Math.round(res.ms / 1000), passes: res.passes, conf: Math.round(Math.max(...res.confidences)) });
      this.hideSheetNow($('scan-sheet'));
      if (got === 0 || (!ex.amount && !ex.due)) {
        // 금액·기한을 하나도 못 읽음 → 바로 직접 입력으로 보내지 말고 다시 찍을 기회를 줌
        this.openScan();
        $('scan-retry').hidden = false;
        // 자동으로 못 읽어도, 사진은 그대로 두고 손가락으로 금액·날짜를 콕 찍어 읽게
        this.lastFailed = { ex, photo: this.pendingPhoto, source: this.pendingSource };
        $('btn-retry-tap').hidden = !this.pendingSource;
        $('scan-retry-msg').textContent = from === 'album' || from === 'share' ? '이 사진에서는 금액·기한을 못 읽었어요.' : '금액·기한을 못 읽었어요. 조금 더 가까이, 밝은 곳에서 다시 찍어 볼까요?';
        return;
      }
      this.openEdit('photo', ex);
    },

    /** 카톡·문자 고지서 글 읽기(사진 없이). 줄 단위로 사진 읽기와 같은 규칙 */
    readText(text, from) {
      const lines = String(text).replace(/\r/g, '').split('\n');
      const texts = [lines.join('\n')];
      const ex = window.BillboxExtract.extract(texts);
      ex.accounts = window.BillboxExtract.accounts(texts);
      ex.usage = window.BillboxExtract.usage(texts);
      this.pendingPhoto = null;
      this.pendingSource = null;
      track('text_done', { from, got: (ex.amount ? 1 : 0) + (ex.due ? 1 : 0) + (ex.kind ? 1 : 0) });
      this.openEdit('photo', ex);
      if (!ex.amount && !ex.due) $('edit-lead').textContent = '글에서 금액·기한을 못 찾았어요. 직접 적어 주세요.';
    },

    // =================================================================
    // 확인 · 입력
    // =================================================================
    wireEdit() {
      // 종류 칩
      const kinds = $('f-kinds');
      kinds.innerHTML = K.KINDS.map((k) => `<button type="button" class="chip" role="radio" aria-checked="false" data-kind="${k.id}">${k.emoji} ${k.label}</button>`).join('');
      kinds.addEventListener('click', (e) => {
        const b = e.target.closest('[data-kind]');
        if (!b) return;
        this.setKind(b.dataset.kind, true);
        this.setOk('kind', true);
      });
      // 반복 칩
      const rep = $('f-repeat');
      rep.innerHTML = K.REPEATS.map((r) => `<button type="button" class="chip" role="radio" aria-checked="false" data-repeat="${r.id}">${r.label}</button>`).join('');
      rep.addEventListener('click', (e) => {
        const b = e.target.closest('[data-repeat]');
        if (!b) return;
        this.repeatTouched = true;
        this.setRepeat(b.dataset.repeat, null);
      });
      $('f-months').innerHTML = Array.from({ length: 12 }, (_, i) => `<button type="button" class="chip" data-month="${i + 1}">${i + 1}월</button>`).join('');
      $('f-months').addEventListener('click', (e) => {
        const b = e.target.closest('[data-month]');
        if (!b) return;
        b.classList.toggle('is-on');
        this.updateRepeatHint();
      });
      // 금액 쉼표
      $('f-amount').addEventListener('input', (e) => {
        const digits = e.target.value.replace(/[^\d]/g, '').slice(0, 9);
        e.target.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
      });
      // 후보 칩
      $('alt-amounts').addEventListener('click', (e) => {
        const b = e.target.closest('[data-amt]');
        if (!b) return;
        $('f-amount').value = Number(b.dataset.amt).toLocaleString('ko-KR');
        $('flag-amount').hidden = true;
        $('alt-amounts').querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-picked', c === b));
        this.setOk('amount', true);
      });
      $('alt-dues').addEventListener('click', (e) => {
        const b = e.target.closest('[data-due]');
        if (!b) return;
        $('f-due').value = b.dataset.due;
        $('flag-due').hidden = true;
        $('alt-dues').querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-picked', c === b));
        this.setOk('due', true);
        this.updateRepeatHint();
      });
      $('f-quickdue').addEventListener('click', (e) => {
        const b = e.target.closest('[data-days]');
        if (!b) return;
        const d = new Date();
        d.setDate(d.getDate() + Number(b.dataset.days));
        $('f-due').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        this.updateRepeatHint();
      });
      $('f-auto').addEventListener('change', () => this.updateRepeatHint());
      $('f-due').addEventListener('change', () => {
        this.updateRepeatHint();
        this.setOk('due', true);
      });
      // ✅ 확인 버튼
      $('edit-form').addEventListener('click', (e) => {
        const b = e.target.closest('[data-ok]');
        if (!b) return;
        this.setOk(b.dataset.ok, b.getAttribute('aria-pressed') !== 'true');
      });
      $('f-amount').addEventListener('change', () => this.setOk('amount', !!$('f-amount').value));
      $('f-name').addEventListener('change', () => this.setOk('kind', true));
      // 계좌 후보
      $('alt-accounts').addEventListener('click', (e) => {
        const b = e.target.closest('[data-acct]');
        if (!b) return;
        $('alt-accounts').querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-picked', c === b));
        $('f-account').value = b.dataset.acct;
        this.setOk('account', false); // 계좌는 바꿨으면 다시 눈으로 확인해야 함
      });
      // 계좌를 직접 고치면 확인을 풀고 다시 ✓ 받기
      $('f-account').addEventListener('input', () => this.setOk('account', false));
      $('btn-repeat-change').addEventListener('click', () => {
        $('repeat-auto').hidden = true;
        $('repeat-pick').hidden = false;
        this.repeatTouched = true;
      });
      $('edit-form').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tap]');
        if (b) this.tapRead(b.dataset.tap);
      });
      $('edit-thumb').addEventListener('click', () => {
        const blob = this.editPhoto;
        if (blob) window.BillboxViewer.open(blob, '찍은 고지서', (sh) => this.openSheet(sh));
      });
      $('btn-kind-change').addEventListener('click', () => this.collapseKinds(false));
      $('btn-similar-update').addEventListener('click', () => {
        if (!this.similar) return;
        $('f-id').value = this.similar.id;
        this.editMode = 'edit';
        $('edit-similar').hidden = true;
        $('edit-title').textContent = `${esc(this.similar.name || K.byId(this.similar.kindId).label)} 업데이트`;
      });
      $('btn-similar-new').addEventListener('click', () => {
        $('edit-similar').hidden = true;
      });
      $('edit-form').addEventListener('submit', (e) => {
        e.preventDefault();
        this.save();
      });
    },

    /** ✅ 확인 상태 켜기/끄기 (사진으로 읽었을 때만 보임) */
    setOk(key, on) {
      const btn = document.querySelector(`[data-ok="${key}"]`);
      if (!btn || btn.hidden) return;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const fs = document.querySelector(`[data-check="${key}"]`);
      if (fs) fs.classList.toggle('is-ok', on);
      if (on && key === 'amount') $('flag-amount').hidden = true;
      if (on && key === 'due') $('flag-due').hidden = true;
      if (key === 'account') $('flag-account').hidden = on || !$('f-account').value.trim();
      this.updateSaveLabel();
    },
    updateSaveLabel() {
      if (this.editMode !== 'photo') return;
      if (!document.querySelector('[data-ok="account"]')) return;
      const keys = ['kind', 'amount', 'due'].concat($('f-account').value.trim() ? ['account'] : []);
      const all = keys.every((k) => (document.querySelector(`[data-ok="${k}"]`) || {}).getAttribute?.('aria-pressed') === 'true');
      $('btn-save').textContent = all ? '✅ 모두 확인, 저장' : '맞아요, 저장';
    },
    /** 종류에 정해진 주기가 있으면 질문 대신 "매월 자동 등록 ✓"만 보여 줌 */
    showRepeatAuto() {
      const f = this.readForm();
      const k = K.byId(f.kindId);
      const auto = !this.repeatTouched && k.repeat && k.repeat !== 'none' && f.repeat === k.repeat;
      $('repeat-auto').hidden = !auto;
      $('repeat-pick').hidden = !!auto;
      if (auto) {
        const r = K.repeatById(k.repeat);
        const ms = f.months && f.months.length ? ` (${f.months.join('·')}월)` : '';
        $('repeat-auto-txt').textContent = `🔁 ${r.label}${ms} 자동 등록 ✓`;
      }
    },

    /** 사진으로 읽었을 때는 종류 14개를 다 펼치지 않고 고른 것만 보여 준다(금액·기한이 먼저 보이게) */
    collapseKinds(on) {
      $('f-kind-picked').hidden = !on;
      $('f-kinds').hidden = on;
      if (on) {
        const k = K.byId((($('f-kinds').querySelector('.is-on') || {}).dataset || {}).kind || 'etc');
        $('f-kind-picked-chip').textContent = `${k.emoji} ${k.label}`;
      }
    },

    setKind(id, userPicked) {
      $('f-kinds').querySelectorAll('[data-kind]').forEach((b) => {
        const on = b.dataset.kind === id;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      const k = K.byId(id);
      const name = $('f-name');
      if (!name.value || name.dataset.auto === '1') {
        name.value = k.id === 'etc' ? '' : k.label;
        name.dataset.auto = '1';
      }
      if (userPicked || !this.repeatTouched) this.setRepeat(k.repeat, k.months || null);
      this.showRepeatAuto();
    },

    setRepeat(id, months) {
      $('f-repeat').querySelectorAll('[data-repeat]').forEach((b) => {
        const on = b.dataset.repeat === id;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      const wrap = $('f-months-wrap');
      wrap.hidden = !(id === 'half' || id === 'yearly');
      if (months !== null) $('f-months').querySelectorAll('[data-month]').forEach((b) => b.classList.toggle('is-on', months.includes(Number(b.dataset.month))));
      else if (!wrap.hidden && !$('f-months').querySelector('.is-on')) {
        const due = $('f-due').value;
        if (due) {
          const m = Number(due.split('-')[1]);
          const ms = id === 'half' ? [m, ((m + 5) % 12) + 1] : [m];
          $('f-months').querySelectorAll('[data-month]').forEach((b) => b.classList.toggle('is-on', ms.includes(Number(b.dataset.month))));
        }
      }
      this.updateRepeatHint();
    },

    readForm() {
      const kindId = ($('f-kinds').querySelector('.is-on') || {}).dataset ? $('f-kinds').querySelector('.is-on').dataset.kind : 'etc';
      const repeat = ($('f-repeat').querySelector('.is-on') || { dataset: { repeat: 'none' } }).dataset.repeat;
      const months = $('f-months-wrap').hidden ? null : Array.from($('f-months').querySelectorAll('.is-on')).map((b) => Number(b.dataset.month));
      const amt = $('f-amount').value.replace(/[^\d]/g, '');
      return { kindId, name: $('f-name').value.trim(), amount: amt ? Number(amt) : null, due: $('f-due').value, repeat, months: months && months.length ? months : null, note: $('f-note').value.trim(), account: $('f-account').value.trim(), auto: $('f-auto').checked };
    },

    updateRepeatHint() {
      const f = this.readForm();
      const hint = $('repeat-hint');
      if (!f.due || f.repeat === 'none') {
        const tagged = /독촉|압류예고/.test($('f-note').value);
        hint.textContent = f.repeat === 'none' ? (tagged ? '독촉·압류예고는 밀린 돈을 한 번 내는 고지서라 반복하지 않아요. 매달 오는 고지서는 따로 찍어 주세요.' : '한 번 내면 끝. 반복 알림은 없어요.') : '';
        return;
      }
      const next = S.nextDue({ due: f.due, repeat: f.repeat, months: f.months });
      hint.textContent = f.auto
        ? `자동이체라 전날 "잔액 확인" 알림만 오고, 날짜가 지나면 자동 완료돼요. 다음은 ${next ? fmtDate(next) : '-'}.`
        : next
          ? `냈어요를 누르면 다음 마감 ${fmtDate(next)}을 미리 잡아 둬요. 고지서를 안 찍어도 알려 드려요.`
          : '';
    },

    /**
     * @param {'photo'|'manual'|'edit'} mode
     * @param {object} [data] photo: extract 결과 / edit: item
     */
    openEdit(mode, data) {
      this.editMode = mode;
      this.repeatTouched = false;
      this.similar = null;
      this.confirmStack = null;
      const form = $('edit-form');
      form.reset();
      $('f-id').value = '';
      $('f-name').dataset.auto = '1';
      $('flag-amount').hidden = true;
      $('flag-due').hidden = true;
      $('alt-amounts').innerHTML = '';
      $('alt-dues').innerHTML = '';
      $('edit-similar').hidden = true;
      $('edit-lead').hidden = true;
      $('f-months').querySelectorAll('.is-on').forEach((b) => b.classList.remove('is-on'));
      this.collapseKinds(false);
      $('alt-accounts').innerHTML = '';
      $('flag-account').hidden = true;
      $('edit-usage').hidden = true;
      $('f-auto').checked = false;
      this.editUsage = null;
      $('edit-thumb').hidden = true;
      this.editPhoto = null;
      document.querySelectorAll('[data-ok]').forEach((b) => {
        b.hidden = mode !== 'photo';
        b.setAttribute('aria-pressed', 'false');
      });
      document.querySelectorAll('[data-check]').forEach((f) => f.classList.remove('is-ok'));
      $('f-quickdue-wrap').hidden = mode === 'photo';
      document.querySelectorAll('[data-tap]').forEach((b) => (b.hidden = true));
      if (mode !== 'photo') {
        this.pendingPhoto = null;
        this.pendingSource = null;
      }

      this.tapHints = null;
      if (mode === 'photo') {
        // 콕 찍기 때 참고할 후보(전체 읽기에서 나온 값들)
        this.tapHints = {
          amount: [data.amount, ...(data.altAmounts || [])].filter((x) => x != null),
          due: [data.due, ...(data.altDues || [])].filter(Boolean),
          account: (data.accounts || []).map((a) => a.number),
        };
        $('edit-title').textContent = '읽은 내용, 맞나요?';
        const lead = $('edit-lead');
        const miss = [];
        if (!data.amount) miss.push('금액');
        if (!data.due) miss.push('기한');
        if (!data.kind) miss.push('종류');
        lead.textContent = miss.length ? `${miss.join('·')}은(는) 못 읽었어요. ${this.pendingSource ? '칸 아래 📍 콕 찍기로 사진에서 그 숫자를 누르거나, ' : ''}직접 적어 주세요.` : '빨간 "확인!"이 붙은 칸은 자신이 없어요. 고지서랑 한 번 맞춰 보세요.';
        lead.hidden = false;
        this.setKind(data.kind ? data.kind.id : 'etc', false);
        if (data.amount) $('f-amount').value = won(data.amount);
        if (data.due) $('f-due').value = data.due;
        $('flag-amount').hidden = !data.amount || data.sure.amount;
        $('flag-due').hidden = !data.due || data.sure.due;
        if (data.altAmounts.length) $('alt-amounts').innerHTML = `<span class="alts__label">혹시 이건가요?</span>` + data.altAmounts.map((a) => `<button type="button" class="chip" data-amt="${a}">${won(a)}원</button>`).join('');
        if (data.altDues.length) $('alt-dues').innerHTML = `<span class="alts__label">혹시 이건가요?</span>` + data.altDues.map((d) => `<button type="button" class="chip" data-due="${d}">${fmtDate(d)}</button>`).join('');
        if (data.tag || data.unit) $('f-note').value = [data.unit, data.tag ? data.tag + ' 고지서' : ''].filter(Boolean).join(' · ');
        if (this.pendingPhoto && S.settings().photoKeep !== 'off') this.showThumb(this.pendingPhoto);
        if (this.pendingSource) document.querySelectorAll('[data-tap]').forEach((b) => (b.hidden = false));
        if (data.accounts && data.accounts.length) {
          // 제일 잘 읽힌 계좌 하나를 칸에 넣고, 나머지는 "다른 계좌" 후보로
          const [best, ...rest] = data.accounts;
          $('f-account').value = `${best.bank ? best.bank + ' ' : ''}${best.number}`;
          $('flag-account').hidden = false;
          if (rest.length) $('alt-accounts').innerHTML = `<span class="alts__label">다른 계좌</span>` + rest.map((a) => `<button type="button" class="chip" data-acct="${esc((a.bank ? a.bank + ' ' : '') + a.number)}">${esc((a.bank ? a.bank + ' ' : '') + a.number)}</button>`).join('');
        }
        if (data.usage) {
          this.editUsage = data.usage;
          $('edit-usage').textContent = `📊 사용량 ${data.usage.value.toLocaleString('ko-KR')}${data.usage.unit} 읽음 — 다음 고지서와 비교해 드려요 (시험 기능)`;
          $('edit-usage').hidden = false;
        }
        if (data.autopay) {
          // 고지서에 "자동이체·출금예정" 표시가 있으면 자동이체로 미리 체크(사용자가 끌 수 있음)
          $('f-auto').checked = true;
        }
        if (data.tag) {
          // 독촉·압류예고 = 밀린 돈을 한 번 내는 고지서. 매달 오는 정기 고지서와 따로, 반복 없이
          this.setRepeat('none', null);
          this.repeatTouched = true;
        } else if (data.kind) this.setRepeat(data.kind.repeat, data.kind.months || null);
        this.collapseKinds(!!data.kind);
        if (data.due) {
          const bestAcct = data.accounts && data.accounts.length ? data.accounts[0].number : '';
          const sim = S.findSimilar(data.kind ? data.kind.id : null, data.due, data.tag || '', { account: bestAcct, unit: data.unit || '' });
          if (sim) {
            this.similar = sim;
            $('similar-name').textContent = (sim.name || K.byId(sim.kindId).label) + (sim.note ? ' · ' + sim.note : '');
            $('similar-due').textContent = fmtDate(sim.due) + (sim.estimated ? ' 예상' : '');
            $('edit-similar').hidden = false;
          }
        }
        $('btn-save').textContent = '맞아요, 저장';
      } else if (mode === 'edit') {
        $('edit-title').textContent = '고치기';
        $('f-id').value = data.id;
        this.setKind(data.kindId, false);
        $('f-name').value = data.name || '';
        $('f-name').dataset.auto = '0';
        $('f-amount').value = data.amount != null ? won(data.amount) : '';
        $('f-due').value = data.due;
        $('f-note').value = data.note || '';
        $('f-account').value = data.account || '';
        $('f-auto').checked = !!data.auto;
        if (data.account && !data.accountChecked) {
          // 확인 안 한 계좌는 고치기 화면에서도 ✓로 확인할 수 있게
          const ab = document.querySelector('[data-ok="account"]');
          ab.hidden = false;
          $('flag-account').hidden = false;
        }
        this.setRepeat(data.repeat || 'none', data.months || null);
        this.showRepeatAuto();
        window.BillboxDB.getPhoto(data.id).then((rec) => rec && rec.blob && this.showThumb(rec.blob, true));
        $('btn-save').textContent = '저장';
      } else {
        $('edit-title').textContent = '직접 입력';
        $('edit-lead').textContent = '구독·자동이체·대출 상환처럼 고지서가 없는 것도 여기서. 이름·금액·날짜만 적으면 똑같이 알려 드려요.';
        $('edit-lead').hidden = false;
        this.setKind('etc', false);
        $('f-due').value = S.todayStr();
        $('btn-save').textContent = '저장하고 알림 받기';
      }
      this.updateRepeatHint();
      this.showRepeatAuto();
      this.updateSaveLabel();
      this.openSheet($('edit-sheet'), { focus: mode === 'manual' ? $('f-name') : null });
    },

    /** 사진에서 콕 찍어 읽기: 사진을 크게 띄우고, 누른 곳만 확대해 숫자 전용으로 다시 읽어 칸에 넣는다 */
    tapRead(field) {
      const src = this.pendingSource || this.editPhoto;
      if (!src) return;
      const label = { amount: '금액', due: '납부기한(날짜)', account: '계좌번호' }[field];
      track('tap_open', { field });
      window.BillboxViewer.open(this.editPhoto || this.pendingPhoto || src, `${label} 콕 찍기`, (sh) => this.openSheet(sh), {
        hint: `${label}이 적힌 곳을 손가락으로 톡 누르세요 · 두 손가락으로 키울 수 있어요`,
        onPick: async (nx, ny) => {
          if (this.tapBusy) return;
          this.tapBusy = true;
          window.BillboxViewer.setBusy('읽는 중… 잠깐만요');
          let r = null;
          // AI가 켜져 있으면 누른 곳 조각을 AI로(수도요금 같은 색칸도 읽힘). 안 되면 폰 엔진으로
          if (window.BillboxAI.mode() === 'on') {
            try {
              const a = await window.BillboxAI.readField(src, nx, ny, field);
              if (!a.fallback) r = a;
            } catch (_) {}
          }
          if (!r || r.value == null) {
            try {
              r = await window.BillboxOCR.readRegion(src, nx, ny, field, this.tapHints && this.tapHints[field]);
            } catch (_) {}
          }
          this.tapBusy = false;
          const v = r && r.value;
          track('tap_read', { field, ok: v != null ? 1 : 0 });
          if (v == null) {
            window.BillboxViewer.setBusy('못 읽었어요. 숫자 한가운데를 다시 톡 눌러 보세요');
            window.BillboxViewer.hideMark();
            return;
          }
          if (field === 'amount') {
            $('f-amount').value = Number(v).toLocaleString('ko-KR');
            this.setOk('amount', false);
            $('flag-amount').hidden = false;
          } else if (field === 'due') {
            $('f-due').value = v;
            this.setOk('due', false);
            $('flag-due').hidden = false;
            this.updateRepeatHint();
          } else {
            const bank = ($('f-account').value.match(/^[^\d]+/) || [''])[0].trim();
            $('f-account').value = (bank ? bank + ' ' : '') + v;
            this.setOk('account', false);
          }
          this.closeSheet($('viewer'));
          const shown = field === 'amount' ? `${Number(v).toLocaleString('ko-KR')}원` : field === 'due' ? fmtDate(v) : v;
          this.showToast(`읽었어요: ${shown} — 맞으면 ✓를 눌러 주세요`, { duration: 4000 });
        },
      });
    },

    showThumb(blob) {
      this.editPhoto = blob;
      document.querySelectorAll('[data-tap]').forEach((b) => (b.hidden = false));
      if (this.thumbUrl) URL.revokeObjectURL(this.thumbUrl);
      this.thumbUrl = URL.createObjectURL(blob);
      $('edit-thumb-img').src = this.thumbUrl;
      $('edit-thumb').hidden = false;
    },

    save() {
      const f = this.readForm();
      if (!f.due) {
        $('flag-due').hidden = false;
        $('f-due').focus();
        this.showToast('언제까지인지 날짜를 골라 주세요');
        return;
      }
      if (!f.name) f.name = K.byId(f.kindId).label;
      const id = $('f-id').value;
      const tag = ($('f-note').value.match(/독촉|압류예고/) || [''])[0];
      if (this.editUsage) f.usage = this.editUsage;
      const acctBtn = document.querySelector('[data-ok="account"]');
      if (f.account) {
        if (this.editMode === 'photo') f.accountChecked = acctBtn.getAttribute('aria-pressed') === 'true';
        else if (this.editMode === 'manual') f.accountChecked = true; // 직접 적은 건 본인이 쓴 것
        else if (!acctBtn.hidden) f.accountChecked = acctBtn.getAttribute('aria-pressed') === 'true';
        else {
          const prev = S.get($('f-id').value) || {};
          f.accountChecked = prev.account === f.account ? !!prev.accountChecked : true;
        }
      } else f.accountChecked = false;
      let item;
      if (id) {
        const prev = S.get(id) || {};
        item = S.update(id, Object.assign(f, { estimated: false, paidAt: null, tag, source: this.similar ? 'photo' : prev.source || 'manual' }));
      } else {
        item = S.add(Object.assign(f, { source: this.editMode === 'photo' ? 'photo' : 'manual', tag, estimated: false }));
      }
      // 고지서 사진: 폰 안에만. 같은 항목의 이전 사진은 새 사진으로 교체
      if (this.pendingPhoto && (this.editMode === 'photo' || this.similar) && S.settings().photoKeep !== 'off') {
        window.BillboxDB.putPhoto(item.id, { blob: this.pendingPhoto, due: item.due, savedAt: Date.now(), paidAt: null });
      }
      this.pendingPhoto = null;
      const oks = ['kind', 'amount', 'due', 'account'].filter((k) => (document.querySelector(`[data-ok="${k}"]`) || {}).getAttribute?.('aria-pressed') === 'true').length;
      track('save', { kind: f.kindId, repeat: f.repeat, source: id ? 'edit' : this.editMode, has_amount: f.amount != null ? 1 : 0, checked: oks, has_account: f.account ? 1 : 0 });
      this.closeSheet($('edit-sheet'));
      this.render();
      window.BillboxPush.sync();
      if (this.confirmStack) {
        // 정리함에서 온 장이면: 그 장은 끝 → 다음 장으로 톡톡
        const sid = this.confirmStack;
        this.confirmStack = null;
        window.BillboxDB.stackDel(sid).then(() => this.nextConfirm());
      }
      const n = S.daysLeft(item.due);
      const when = n < 0 ? '이미 지났어요! 서둘러요' : n === 0 ? '오늘까지예요!' : `${n}일 남았어요`;
      const pushOn = S.settings().push === 'on';
      this.showToast(`저장했어요. ${when}`, pushOn || !window.BillboxPush.supported() ? {} : { actionLabel: '알림 켜기', duration: 6000, onAction: () => this.openSettings() });
    },

    // =================================================================
    // 상세
    // =================================================================
    async openDetail(id) {
      const it = S.get(id);
      if (!it) return;
      const G = window.BillboxGuide;
      const k = K.byId(it.kindId);
      const n = S.daysLeft(it.due);
      const dd = it.paidAt ? '<span class="stamp">냄</span>' : n < 0 ? `<b style="color:var(--red)">${-n}일 지남</b>` : n === 0 ? '<b>오늘까지!</b>' : `<b>D-${n}</b>`;
      const photo = await window.BillboxDB.getPhoto(id);
      const photoLabel = photo ? (photo.due === it.due ? '🧾 고지서 보기' : `🧾 지난 고지서 보기 (${fmtDate(photo.due)}분)`) : '';
      // 늦으면·단계 설명서
      const stage = it.paidAt ? null : G.stageCard(it, n);
      const lf = it.paidAt ? null : G.lateFee(it.kindId, it.amount, Math.max(0, -n));
      const tips = G.saveTips(it.kindId).filter((t) => !(S.settings().tipsDone || []).includes(t.id));
      // 사용량 비교
      let usageTxt = '';
      const prevU = (it.history || []).find((h) => h.usage && it.usage && h.usage.unit === it.usage.unit);
      if (it.usage) {
        usageTxt = `📊 사용량 ${it.usage.value.toLocaleString('ko-KR')}${it.usage.unit}`;
        if (prevU) {
          const d = ((it.usage.value - prevU.usage.value) / prevU.usage.value) * 100;
          usageTxt += ` · 지난번보다 <span class="${d > 0 ? 'diff-up' : 'diff-down'}">${d > 0 ? '+' : ''}${d.toFixed(0)}%</span>`;
        }
      }
      const amtBig = it.amount == null ? '금액 미정' : `${it.estimated && !it.paidAt ? '약 ' : ''}${won(it.amount)}원`;
      const amtSub = it.paidAt ? '냈어요' : it.estimated ? '지난번 금액으로 어림 · 고지서 오면 찍어 주세요' : '낼 금액';
      $('detail-title').textContent = it.name || k.label;
      $('detail-body').innerHTML = `
        <div class="detail__top"><span class="detail__emoji">${k.emoji}</span><div><div class="detail__name">${esc(it.name || k.label)}</div><div class="muted small">${esc(k.label)}${it.tag ? ` · <span class="badge badge--red">${esc(it.tag)}</span>` : ''}${it.estimated ? ' · <span class="badge badge--ghost">예상 마감</span>' : ''}</div></div></div>
        <div class="detail__amount">${amtBig}<small>${amtSub}</small></div>
        <div class="detail__grid">
          <div class="detail__cell"><b>언제까지</b>${fmtDate(it.due)}<br>${dd}</div>
          <div class="detail__cell"><b>얼마나 자주</b>${esc(K.repeatById(it.repeat || 'none').label)}${it.months && it.months.length ? `<br><span class="small">${it.months.join('·')}월</span>` : ''}</div>
        </div>
        ${photo ? `<button type="button" class="btn btn--big photo-btn" data-act="photo" style="margin-bottom:12px">${photoLabel}</button>` : ''}
        ${it.account ? `<div class="acct"><span>🏦 ${esc(it.account)}${it.accountChecked ? ' <span class="badge badge--mint">✓ 확인함</span>' : ' <span class="badge badge--red">확인 안 함</span>'}</span><button type="button" class="btn btn--sm btn--brass" data-act="copy">복사</button></div>${it.accountChecked ? '' : '<p class="small" style="margin:-6px 0 12px;color:var(--red)">사진에서 읽은 계좌예요. 보내기 전에 [고지서 보기]로 한 자리씩 맞춰 보세요. [✏️ 고치기]에서 ✓로 확인할 수 있어요.</p>'}` : ''}
        ${usageTxt ? `<p class="usage-line" style="margin:0 0 12px">${usageTxt}</p>` : ''}
        ${it.note ? `<p class="small" style="margin-bottom:12px">📝 ${esc(it.note)}</p>` : ''}
        ${stage ? `<div class="guide guide--${stage.tone}"><h3>${stage.title}</h3><ul>${stage.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${lf ? `<p style="margin-top:8px"><b>늦으면:</b> ${esc(lf.text)}</p>` : ''}<p class="guide__fine">참고용 안내예요. 고지서에 적힌 내용이 우선이에요.</p></div>` : ''}
        <div class="detail__acts">
          ${it.paidAt ? `<button type="button" class="btn" data-act="unpay">아직 안 냈어요 (되돌리기)</button>` : `<button type="button" class="btn btn--big btn--brass" data-act="pay">✅ 냈어요</button>`}
          <div class="row2">
            <button type="button" class="btn" data-act="ics">📅 캘린더 알림</button>
            <button type="button" class="btn" data-act="edit">✏️ 고치기</button>
          </div>
        </div>
        ${!stage && lf && !it.paidAt ? `<details class="tips-box"><summary>⏰ 늦으면 어떻게 돼요?</summary><p class="small" style="padding:6px 0 4px">${esc(lf.text)}</p><p class="guide__fine">참고용 안내예요. 고지서에 적힌 내용이 우선이에요.</p></details>` : ''}
        ${tips.length ? `<details class="tips-box"><summary>💡 이렇게 하면 깎여요 (${tips.length})</summary>${tips.map((t) => `<div class="tip"><b>${esc(t.title)}</b><p>${esc(t.text)}</p><p class="tip__where">📍 ${esc(t.where)} · ${esc(t.checked)}</p><button type="button" class="btn btn--sm" data-tip-done="${t.id}">했어요, 그만 보기</button></div>`).join('')}</details>` : ''}
        ${it.history && it.history.length ? `<h3>낸 기록</h3><ul class="hist">${it.history.map((h) => `<li><span>${fmtDate(h.due)}</span><span>${h.amount != null ? won(h.amount) + '원' : ''}${h.usage ? ` · ${h.usage.value}${h.usage.unit}` : ''}</span></li>`).join('')}</ul>` : ''}
        <div class="row" style="margin-top:12px">
          ${it.repeat && it.repeat !== 'none' && !it.paidAt ? `<button type="button" class="btn btn--ghost btn--sm" data-act="stoprepeat">🔁 반복 그만하기</button>` : ''}
          <button type="button" class="btn btn--ghost btn--sm" data-act="del">🗑 지우기</button>
        </div>`;
      const body = $('detail-body');
      body.onclick = async (e) => {
        const td = e.target.closest('[data-tip-done]');
        if (td) {
          const done = new Set(S.settings().tipsDone || []);
          done.add(td.dataset.tipDone);
          S.saveSettings({ tipsDone: [...done] });
          td.closest('.tip').remove();
          track('tip_done', { tip: td.dataset.tipDone });
          return;
        }
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'pay') this.pay(id);
        else if (act === 'photo') {
          track('photo_view', { kind: it.kindId });
          window.BillboxViewer.open(photo.blob, it.name || k.label, (sh) => this.openSheet(sh));
        } else if (act === 'copy') {
          const num = (it.account.match(/[\d-]{8,}/) || [it.account])[0];
          let ok = false;
          try {
            await navigator.clipboard.writeText(num);
            ok = true;
          } catch (_) {}
          track('account_copy', { ok: ok ? 1 : 0 });
          this.showToast((ok ? `계좌번호를 복사했어요: ${num}` : `길게 눌러 복사해 주세요: ${num}`) + (it.accountChecked ? '' : ' · 고지서와 꼭 맞춰 보세요'), { duration: 4500 });
        } else if (act === 'unpay') {
          S.update(id, { paidAt: null });
          window.BillboxDB.patchPhoto(id, { paidAt: null });
          this.render();
          window.BillboxPush.sync();
          this.closeSheet($('detail-sheet'));
        } else if (act === 'ics') this.exportIcs(it);
        else if (act === 'edit') {
          this.hideSheetNow($('detail-sheet'));
          this.openEdit('edit', it);
        } else if (act === 'del') {
          this.askDelete(it);
        } else if (act === 'stoprepeat') {
          if (it.estimated) {
            if (!confirm(`"${it.name || k.label}" 반복을 그만할까요? 다음 차례로 잡아 둔 이 예상 카드도 없어져요. 낸 기록은 지워지지 않아요.`)) return;
            S.remove(id);
            window.BillboxDB.delPhoto(id);
          } else {
            if (!confirm(`"${it.name || k.label}" 반복을 그만할까요? 이번 것만 남고 다음 달부터는 안 생겨요.`)) return;
            S.update(id, { repeat: 'none', months: null });
          }
          track('repeat_stop', { kind: it.kindId });
          this.render();
          window.BillboxPush.sync();
          this.closeSheet($('detail-sheet'));
          this.showToast('반복을 그만했어요');
        }
      };
      this.openSheet($('detail-sheet'));
    },

    /** 캘린더 파일 — Getset exportIcs와 같은 구조(VALARM 3일 전·당일 아침) */
    exportIcs(it) {
      const k = K.byId(it.kindId);
      const escI = (v) => String(v).replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
      const p2 = (n) => String(n).padStart(2, '0');
      const d = new Date();
      const now = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}00`;
      const s = S.settings();
      const hour = p2(s.remindHour || 9);
      const ymd = it.due.replace(/-/g, '');
      const name = it.name || k.label;
      const amt = it.amount != null ? ` ${won(it.amount)}원` : '';
      const days = (s.remindDays && s.remindDays.length ? s.remindDays : [3, 0]).sort((a, b) => b - a);
      const alarms = days
        .map((n) =>
          ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escI(n === 0 ? `오늘까지! ${name}${amt}` : `${n}일 뒤 마감 · ${name}${amt}`)}`, `TRIGGER:-P${n}DT0H0M0S`.replace('-P0DT0H0M0S', 'PT0M'), 'END:VALARM'].join('\r\n')
        )
        .join('\r\n');
      const ev = [
        'BEGIN:VEVENT',
        `UID:billbox-${it.id}-${ymd}@pebbleitgo.com`,
        `DTSTAMP:${now}`,
        `DTSTART;TZID=Asia/Seoul:${ymd}T${hour}0000`,
        `DTEND;TZID=Asia/Seoul:${ymd}T${hour}3000`,
        `SUMMARY:${escI(`💸 ${name}${amt} 납부 마감`)}`,
        `DESCRIPTION:${escI(`Billbox · ${k.label}${it.note ? ' · ' + it.note : ''}`)}`,
        alarms,
        'END:VEVENT',
      ].join('\r\n');
      const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pebble//Billbox//KO', 'CALSCALE:GREGORIAN', ev, 'END:VCALENDAR'].join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
      a.download = `billbox-${it.due}.ics`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      track('calendar_export', { kind: it.kindId });
      this.showToast('파일을 받았어요. [열기]를 눌러 캘린더에 저장하면 마감 전에 알림이 와요', { duration: 5500 });
    },

    // =================================================================
    // 설정
    // =================================================================
    wireSettings() {
      const sel = $('s-hour');
      sel.innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}시</option>`).join('');
      sel.addEventListener('change', () => {
        S.saveSettings({ remindHour: Number(sel.value) });
        window.BillboxPush.sync();
        track('settings_hour', { hour: Number(sel.value) });
      });
      $('s-days').addEventListener('click', (e) => {
        const b = e.target.closest('[data-day]');
        if (!b) return;
        b.classList.toggle('is-on');
        const days = Array.from($('s-days').querySelectorAll('.is-on')).map((x) => Number(x.dataset.day));
        if (!days.length) {
          b.classList.add('is-on');
          this.showToast('하나는 골라 주세요');
          return;
        }
        S.saveSettings({ remindDays: days });
        window.BillboxPush.sync();
      });
      $('btn-push-on').addEventListener('click', async () => {
        const btn = $('btn-push-on');
        btn.disabled = true;
        btn.textContent = '켜는 중…';
        try {
          await window.BillboxPush.enable();
          track('push_on');
          this.showToast('알림을 켰어요! 마감 전에 이 폰으로 알려 드려요', { duration: 4000 });
        } catch (err) {
          track('push_fail');
          this.showToast(err.message || '알림을 켜지 못했어요', { duration: 5000 });
        }
        btn.disabled = false;
        btn.textContent = '알림 켜기';
        this.renderSettings();
      });
      $('btn-push-off').addEventListener('click', async () => {
        await window.BillboxPush.disable();
        track('push_off');
        this.renderSettings();
        this.showToast('알림을 껐어요');
      });
      $('btn-push-test').addEventListener('click', async () => {
        try {
          await window.BillboxPush.test();
          this.showToast('시험 알림을 보냈어요. 잠시 뒤 알림이 오면 성공!', { duration: 4000 });
        } catch (_) {
          this.showToast('시험 알림을 보내지 못했어요');
        }
      });
      $('s-ai').addEventListener('change', () => {
        const v = $('s-ai').value === 'off' ? 'off' : 'on';
        S.saveSettings({ aiRead: v });
        track('settings_ai', { on: v === 'on' ? 1 : 0 });
        if (v === 'off') window.BillboxOCR.warmup();
        this.showToast(v === 'on' ? 'AI 읽기를 켰어요 — 빠르고 정확해요' : '껐어요. 사진은 폰 밖으로 안 나가요(읽기는 느려져요)', { duration: 3500 });
      });
      $('s-photo').addEventListener('change', async () => {
        S.saveSettings({ photoKeep: $('s-photo').value });
        track('settings_photo', { keep: $('s-photo').value });
        await this.cleanupPhotos();
        this.renderSettings();
      });
      $('btn-photo-clear').addEventListener('click', async () => {
        if (!confirm('저장된 고지서 사진을 모두 지울까요? 목록은 그대로예요.')) return;
        await window.BillboxDB.clearPhotos();
        this.renderSettings();
        this.showToast('사진을 모두 지웠어요');
      });
      $('btn-export').addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([S.exportJson()], { type: 'application/json' }));
        a.download = `billbox-backup-${S.todayStr()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        track('backup_export', { items: S.load().length });
        this.showToast('백업 파일을 받았어요. 새 폰에서 "파일 불러오기"로 되살릴 수 있어요', { duration: 5000 });
      });
      $('file-import').addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!f) return;
        try {
          const n = S.importJson(await f.text());
          this.render();
          window.BillboxPush.sync();
          track('backup_import', { items: n });
          this.showToast(`${n}건을 불러왔어요`);
        } catch (err) {
          this.showToast(err.message || '불러오지 못했어요');
        }
      });
    },

    openSettings() {
      this.renderSettings();
      this.openSheet($('settings-sheet'));
      track('settings_open');
    },

    renderSettings() {
      const s = S.settings();
      $('s-ai').value = s.aiRead === 'off' ? 'off' : 'on';
      $('s-hour').value = String(s.remindHour);
      $('s-photo').value = s.photoKeep || 'paid30';
      window.BillboxDB.allPhotos().then((a) => ($('photo-count').textContent = `지금 ${a.length}장 저장됨`));
      $('s-days').querySelectorAll('[data-day]').forEach((b) => b.classList.toggle('is-on', (s.remindDays || [3, 0]).includes(Number(b.dataset.day))));
      const sup = window.BillboxPush.supported();
      const on = s.push === 'on' && sup;
      $('btn-push-on').hidden = on || !sup;
      $('btn-push-off').hidden = !on;
      $('btn-push-test').hidden = !on;
      $('push-ios').hidden = !window.BillboxPush.iosNeedsInstall(this.env);
      if (!sup) $('push-desc').innerHTML = '이 브라우저는 푸시 알림을 지원하지 않아요. 상세 화면의 <b>📅 캘린더 알림</b>을 써 주세요.' + (this.env && this.env.inApp ? ' 크롬으로 열면 푸시도 돼요.' : '');
    },

    // =================================================================
    // 시트 · 토스트 (Getset과 동일)
    // =================================================================
    wireSheets() {
      document.querySelectorAll('.sheet').forEach((sh) => {
        sh.addEventListener('click', (e) => {
          if (e.target === sh || e.target.closest('[data-close]')) this.closeSheet(sh);
        });
      });
      // 뒤로가기: 맨 위 화면만 닫는다(사진 보기 → 상세로 돌아오게). 쌓인 순서는 sheetStack으로 기억
      window.addEventListener('popstate', () => {
        const keep = history.state && history.state.bbSheet;
        const stack = this.sheetStack || [];
        while (stack.length && stack[stack.length - 1] !== keep) {
          const id = stack.pop();
          const sh = $(id);
          if (sh && !sh.hidden) this.hideSheetNow(sh);
        }
        // 기록에 없는데 열려 있는 화면(예: 직접 닫지 않은 것)이 있으면 함께 정리
        if (!keep) document.querySelectorAll('.sheet.is-open').forEach((sh) => this.hideSheetNow(sh));
      });
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const open = Array.from(document.querySelectorAll('.sheet.is-open')).pop();
        if (open) this.closeSheet(open);
      });
    },
    openSheet(sheet, { replace = false, focus = null } = {}) {
      this.sheetStack = (this.sheetStack || []).filter((id) => id !== sheet.id && !$(id).hidden);
      this.sheetStack.push(sheet.id);
      sheet.hidden = false;
      this.zTop = (this.zTop || 40) + 1;
      sheet.style.zIndex = String(this.zTop);
      document.body.classList.add('has-sheet');
      try {
        if (replace && history.state && history.state.bbSheet) history.replaceState({ bbSheet: sheet.id }, '');
        else history.pushState({ bbSheet: sheet.id }, '');
      } catch (_) {}
      requestAnimationFrame(() => sheet.classList.add('is-open'));
      if (focus) setTimeout(() => focus.focus({ preventScroll: true }), 80);
    },
    closeSheet(sheet) {
      if (history.state && history.state.bbSheet === sheet.id) {
        history.back();
        return;
      }
      this.hideSheetNow(sheet);
    },
    hideSheetNow(sheet) {
      if (this.sheetStack) this.sheetStack = this.sheetStack.filter((id) => id !== sheet.id);
      sheet.classList.remove('is-open');
      sheet.hidden = true;
      if (!document.querySelector('.sheet.is-open')) document.body.classList.remove('has-sheet');
    },
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
      toast.classList.remove('is-visible');
      setTimeout(() => (toast.hidden = true), 200);
    },
  };

  window.BillboxApp = App;
  document.addEventListener('DOMContentLoaded', () => App.init());
})();
