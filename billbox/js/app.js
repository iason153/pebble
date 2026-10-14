'use strict';

/**
 * Billbox 화면 — 홈(이번 주 낼 것/안 낸 것) · 찍기 · 확인/입력 · 상세 · 설정
 * 시트·토스트·뒤로가기 처리는 Getset과 같은 방식(폰에서 검증됨).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const S = window.BillboxStore;
  const K = window.BillboxKinds;
  const track = (n, p) => window.pebbleTrack && window.pebbleTrack(n, p);
  const won = (n) => (n == null || isNaN(n) ? '' : Number(n).toLocaleString('ko-KR'));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
      this.render();
      this.registerSW();
      this.wirePrep();
      window.BillboxOCR.warmup();
      track('open', { items: S.load().length });
    },

    /** 사전 내려받기 배너: 처음 한 번 보이고, 준비되면 "찍을 준비 됐어요"로 바뀐 뒤 사라짐 */
    wirePrep() {
      const box = $('ocr-prep');
      let shownLoading = false;
      $('btn-prep-retry').addEventListener('click', () => {
        $('btn-prep-retry').hidden = true;
        window.BillboxOCR.ready(null).catch(() => {});
        track('ocr_prep_retry');
      });
      window.BillboxOCR.onState(({ state, msg, progress }) => {
        if (state === 'loading') {
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
        const badges = [it.tag ? `<span class="badge badge--red">${esc(it.tag)}</span>` : '', it.estimated ? '<span class="badge badge--ghost">예상</span>' : '', it.repeat && it.repeat !== 'none' ? `<span class="badge badge--mint">${esc(K.repeatById(it.repeat).label)}</span>` : ''].join('');
        return `<div class="item ${n < 0 ? 'item--overdue' : ''}" role="button" tabindex="0" data-item="${it.id}">
          <div class="item__emoji" aria-hidden="true">${k.emoji}</div>
          <div>
            <div class="item__name">${esc(it.name || k.label)} ${badges}</div>
            <div class="item__meta"><span class="item__amount">${it.amount != null ? won(it.amount) + '원' : '금액 미정'}</span> · ${fmtDate(it.due)}까지</div>
          </div>
          <div class="item__right">
            <span class="dday ${cls}">${dd}</span>
            <button type="button" class="btn btn--sm item__paid" data-paid="${it.id}">냈어요</button>
          </div>
        </div>`;
      };
      const group = (title, items, badgeCls) => (items.length ? `<section class="group"><div class="group__head">${title}<span class="badge ${badgeCls}">${items.length}</span></div>${items.map(card).join('')}</section>` : '');

      let html = group('🚨 마감 지남', g.overdue, 'badge--red') + group('📌 이번 주', g.week, 'badge--brass') + group('📅 다음에', g.later, '');
      if (!html) {
        html = `<div class="empty card card--tilt"><div class="empty__pic">📬</div><p><b>아직 비어 있어요.</b></p><p class="muted">아래 <b>고지서 찍기</b>를 눌러 보세요. 넷플릭스 같은 구독은 <b>직접 입력</b>으로.</p></div>`;
      }
      if (g.done.length) {
        html += `<details class="done"><summary>낸 것 ${g.done.length}건</summary>${g.done
          .map((it) => {
            const k = K.byId(it.kindId);
            return `<div class="item item--done" role="button" tabindex="0" data-item="${it.id}"><div class="item__emoji">${k.emoji}</div><div><div class="item__name">${esc(it.name || k.label)}</div><div class="item__meta">${it.amount != null ? won(it.amount) + '원 · ' : ''}${fmtDate(it.due)} 냄</div></div><div class="item__right"><span class="stamp">냄</span></div></div>`;
          })
          .join('')}</details>`;
      }
      list.innerHTML = html;
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
      this.render();
      window.BillboxPush.sync();
      track('paid', { kind: it.kindId, repeat: it.repeat });
      const msg = it.paidAt ? '냈어요! 🎉' : `냈어요! 다음은 ${fmtDate(it.due)}로 잡아 뒀어요`;
      this.showToast(msg, {
        actionLabel: '되돌리기',
        duration: 5000,
        onAction: () => {
          S.undoPaid(id);
          if (before && !before.paidAt) S.update(id, { paidAt: null });
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
          const f = e.target.files && e.target.files[0];
          e.target.value = '';
          if (f) this.scan(f, id === 'file-camera' ? 'camera_app' : 'album');
        });
      });
      $('btn-cam-open').addEventListener('click', () => this.openCam());
      $('btn-cam-cancel').addEventListener('click', () => {
        this.stopCam();
        $('scan-cam').hidden = true;
        $('scan-pick').hidden = false;
      });
      $('btn-cam-shot').addEventListener('click', () => this.shot());
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
        $('lbl-camera-app').hidden = false;
        $('btn-cam-open').hidden = true;
        $('file-camera').click();
        return;
      }
      $('scan-pick').hidden = true;
      $('scan-cam').hidden = false;
      try {
        this.camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
        const v = $('cam-video');
        v.srcObject = this.camStream;
        await v.play().catch(() => {});
        const track0 = this.camStream.getVideoTracks()[0];
        const caps = track0 && track0.getCapabilities ? track0.getCapabilities() : {};
        $('btn-cam-torch').hidden = !caps.torch;
        this.torchOn = false;
        track('cam_open', { ok: 1 });
      } catch (err) {
        track('cam_open', { ok: 0, reason: (err && err.name) || 'x' });
        this.stopCam();
        $('scan-cam').hidden = true;
        $('scan-pick').hidden = false;
        // 앱 안 카메라가 안 되면(권한 거부 등) 카메라 앱 방식으로
        $('lbl-camera-app').hidden = false;
        this.showToast(err && err.name === 'NotAllowedError' ? '카메라 권한이 꺼져 있어요. "카메라 앱으로 찍기"나 앨범을 써 주세요' : '앱 안 카메라를 못 열었어요. "카메라 앱으로 찍기"를 써 주세요', { duration: 4500 });
      }
    },

    stopCam() {
      if (this.camStream) {
        this.camStream.getTracks().forEach((t) => t.stop());
        this.camStream = null;
      }
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

    async shot() {
      const v = $('cam-video');
      if (!v.videoWidth) return;
      const max = 1600;
      const r = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * r);
      c.height = Math.round(v.videoHeight * r);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      this.stopCam();
      $('scan-cam').hidden = true;
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
      c.width = c.height = 0;
      if (blob) this.scan(blob, 'camera');
    },

    openScan() {
      const st = window.BillboxOCR.getState();
      if (st.state !== 'ready') this.showToast(st.state === 'error' ? '읽기 도구가 아직 준비 안 됐어요. 홈의 [다시 받기]를 눌러 주세요' : '아직 사전을 받는 중이에요. 찍으면 받은 뒤 이어서 읽어요', { duration: 4000 });
      $('scan-pick').hidden = false;
      $('scan-cam').hidden = true;
      $('scan-progress').hidden = true;
      $('scan-lost').hidden = true;
      this.openSheet($('scan-sheet'));
      track('scan_open');
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
      const got = (ex.amount ? 1 : 0) + (ex.due ? 1 : 0) + (ex.kind ? 1 : 0);
      track('scan_done', { got, kind: ex.kind ? ex.kind.id : 'none', ms: Math.round(res.ms / 1000), passes: res.passes, conf: Math.round(Math.max(...res.confidences)) });
      this.hideSheetNow($('scan-sheet'));
      if (got === 0) {
        this.openEdit('manual');
        this.showToast('글자를 못 읽었어요. 직접 적어 주세요 (금액·기한 부분을 크게 찍으면 더 잘 읽어요)', { duration: 5500 });
        return;
      }
      this.openEdit('photo', ex);
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
      });
      // 반복 칩
      const rep = $('f-repeat');
      rep.innerHTML = K.REPEATS.map((r) => `<button type="button" class="chip" role="radio" aria-checked="false" data-repeat="${r.id}">${r.label}</button>`).join('');
      rep.addEventListener('click', (e) => {
        const b = e.target.closest('[data-repeat]');
        if (b) this.setRepeat(b.dataset.repeat, null);
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
      });
      $('alt-dues').addEventListener('click', (e) => {
        const b = e.target.closest('[data-due]');
        if (!b) return;
        $('f-due').value = b.dataset.due;
        $('flag-due').hidden = true;
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
      $('f-due').addEventListener('change', () => this.updateRepeatHint());
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
      return { kindId, name: $('f-name').value.trim(), amount: amt ? Number(amt) : null, due: $('f-due').value, repeat, months: months && months.length ? months : null, note: $('f-note').value.trim() };
    },

    updateRepeatHint() {
      const f = this.readForm();
      const hint = $('repeat-hint');
      if (!f.due || f.repeat === 'none') {
        hint.textContent = f.repeat === 'none' ? '한 번 내면 끝. 반복 알림은 없어요.' : '';
        return;
      }
      const next = S.nextDue({ due: f.due, repeat: f.repeat, months: f.months });
      hint.textContent = next ? `냈어요를 누르면 다음 마감 ${fmtDate(next)}을 미리 잡아 둬요. 고지서를 안 찍어도 알려 드려요.` : '';
    },

    /**
     * @param {'photo'|'manual'|'edit'} mode
     * @param {object} [data] photo: extract 결과 / edit: item
     */
    openEdit(mode, data) {
      this.editMode = mode;
      this.repeatTouched = false;
      this.similar = null;
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

      if (mode === 'photo') {
        $('edit-title').textContent = '읽은 내용, 맞나요?';
        const lead = $('edit-lead');
        const miss = [];
        if (!data.amount) miss.push('금액');
        if (!data.due) miss.push('기한');
        if (!data.kind) miss.push('종류');
        lead.textContent = miss.length ? `${miss.join('·')}은(는) 못 읽었어요. 직접 적어 주세요.` : '빨간 "확인!"이 붙은 칸은 자신이 없어요. 고지서랑 한 번 맞춰 보세요.';
        lead.hidden = false;
        this.setKind(data.kind ? data.kind.id : 'etc', false);
        if (data.amount) $('f-amount').value = won(data.amount);
        if (data.due) $('f-due').value = data.due;
        $('flag-amount').hidden = !data.amount || data.sure.amount;
        $('flag-due').hidden = !data.due || data.sure.due;
        if (data.altAmounts.length) $('alt-amounts').innerHTML = `<span class="alts__label">혹시 이건가요?</span>` + data.altAmounts.map((a) => `<button type="button" class="chip" data-amt="${a}">${won(a)}원</button>`).join('');
        if (data.altDues.length) $('alt-dues').innerHTML = `<span class="alts__label">혹시 이건가요?</span>` + data.altDues.map((d) => `<button type="button" class="chip" data-due="${d}">${fmtDate(d)}</button>`).join('');
        if (data.tag) $('f-note').value = data.tag + ' 고지서';
        if (data.kind) this.setRepeat(data.kind.repeat, data.kind.months || null);
        this.collapseKinds(!!data.kind);
        if (data.due) {
          const sim = S.findSimilar(data.kind ? data.kind.id : null, data.due);
          if (sim) {
            this.similar = sim;
            $('similar-name').textContent = sim.name || K.byId(sim.kindId).label;
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
        this.setRepeat(data.repeat || 'none', data.months || null);
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
      this.openSheet($('edit-sheet'), { focus: mode === 'manual' ? $('f-name') : null });
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
      let item;
      if (id) {
        const prev = S.get(id) || {};
        item = S.update(id, Object.assign(f, { estimated: false, paidAt: null, tag, source: this.similar ? 'photo' : prev.source || 'manual' }));
      } else {
        item = S.add(Object.assign(f, { source: this.editMode === 'photo' ? 'photo' : 'manual', tag, estimated: false }));
      }
      track('save', { kind: f.kindId, repeat: f.repeat, source: id ? 'edit' : this.editMode, has_amount: f.amount != null ? 1 : 0 });
      this.closeSheet($('edit-sheet'));
      this.render();
      window.BillboxPush.sync();
      const n = S.daysLeft(item.due);
      const when = n < 0 ? '이미 지났어요! 서둘러요' : n === 0 ? '오늘까지예요!' : `${n}일 남았어요`;
      const pushOn = S.settings().push === 'on';
      this.showToast(`저장했어요. ${when}`, pushOn || !window.BillboxPush.supported() ? {} : { actionLabel: '알림 켜기', duration: 6000, onAction: () => this.openSettings() });
    },

    // =================================================================
    // 상세
    // =================================================================
    openDetail(id) {
      const it = S.get(id);
      if (!it) return;
      const k = K.byId(it.kindId);
      const n = S.daysLeft(it.due);
      const dd = it.paidAt ? '<span class="stamp">냄</span>' : n < 0 ? `<b style="color:var(--red)">${-n}일 지남</b>` : n === 0 ? '<b>오늘까지!</b>' : `<b>D-${n}</b>`;
      $('detail-title').textContent = it.name || k.label;
      $('detail-body').innerHTML = `
        <div class="detail__top"><span class="detail__emoji">${k.emoji}</span><div><div class="detail__name">${esc(it.name || k.label)}</div><div class="muted small">${esc(k.label)}${it.tag ? ` · <span class="badge badge--red">${esc(it.tag)}</span>` : ''}${it.estimated ? ' · <span class="badge badge--ghost">예상 마감</span>' : ''}</div></div></div>
        <div class="detail__amount">${it.amount != null ? won(it.amount) + '원' : '금액 미정'}<small>${it.paidAt ? '냈어요' : '낼 금액'}</small></div>
        <div class="detail__grid">
          <div class="detail__cell"><b>언제까지</b>${fmtDate(it.due)}<br>${dd}</div>
          <div class="detail__cell"><b>얼마나 자주</b>${esc(K.repeatById(it.repeat || 'none').label)}${it.months && it.months.length ? `<br><span class="small">${it.months.join('·')}월</span>` : ''}</div>
        </div>
        ${it.note ? `<p class="small" style="margin-bottom:12px">📝 ${esc(it.note)}</p>` : ''}
        <div class="detail__acts">
          ${it.paidAt ? `<button type="button" class="btn" data-act="unpay">아직 안 냈어요 (되돌리기)</button>` : `<button type="button" class="btn btn--big btn--brass" data-act="pay">✅ 냈어요</button>`}
          <div class="row2">
            <button type="button" class="btn" data-act="ics">📅 캘린더 알림</button>
            <button type="button" class="btn" data-act="edit">✏️ 고치기</button>
          </div>
          <button type="button" class="btn btn--ghost btn--sm" data-act="del">🗑 지우기</button>
        </div>
        ${it.history && it.history.length ? `<h3>낸 기록</h3><ul class="hist">${it.history.map((h) => `<li><span>${fmtDate(h.due)}</span><span>${h.amount != null ? won(h.amount) + '원' : ''}</span></li>`).join('')}</ul>` : ''}
        <p class="muted small" style="margin-top:12px">${it.estimated ? '지난 고지서로 예상한 마감이에요. 새 고지서를 찍으면 이 항목이 업데이트돼요.' : ''}</p>`;
      const body = $('detail-body');
      body.onclick = (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'pay') this.pay(id);
        else if (act === 'unpay') {
          S.update(id, { paidAt: null });
          this.render();
          window.BillboxPush.sync();
          this.closeSheet($('detail-sheet'));
        } else if (act === 'ics') this.exportIcs(it);
        else if (act === 'edit') {
          this.hideSheetNow($('detail-sheet'));
          this.openEdit('edit', it);
        } else if (act === 'del') {
          if (!confirm(`"${it.name || k.label}"을(를) 지울까요?`)) return;
          S.remove(id);
          track('delete', { kind: it.kindId });
          this.render();
          window.BillboxPush.sync();
          this.closeSheet($('detail-sheet'));
          this.showToast('지웠어요');
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
      $('s-hour').value = String(s.remindHour);
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
      window.addEventListener('popstate', () => {
        document.querySelectorAll('.sheet.is-open').forEach((sh) => this.hideSheetNow(sh));
      });
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const open = Array.from(document.querySelectorAll('.sheet.is-open')).pop();
        if (open) this.closeSheet(open);
      });
    },
    openSheet(sheet, { replace = false, focus = null } = {}) {
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
