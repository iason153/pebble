'use strict';

/**
 * Seal — 앱 동작
 *  홈 → [사진 지키기: 점검(가리기) → 도장 → 내보내기] / [내 사진인지 확인: 찾기 → 신고 카드]
 *  원칙: 사진·열쇠·장부는 이 기기 안에만. 서버 없음, 로그인 없음.
 *  무거운 계산(도장 심기·찾기)은 js/seal-worker.js에서 돌린다.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const cfg = window.SEAL_CONFIG || {};
  const track = (name, params) => { if (typeof window.pebbleTrack === 'function') window.pebbleTrack(name, params); };

  const SY = 0.6, SC = 2.0;                 // 도장 세기(사전 시험으로 확정)
  const TH_SURE = 9, TH_WEAK = 7.5;         // 판정 기준
  const MAX_EDIT = 4096;                    // 편집 때 긴 변 상한(폰 메모리)
  const MAX_FIND = 1400;                    // 찾기 때 긴 변 상한(속도)
  const MATCH_TH = 0.55;                    // 장부 대조(참고) 닮은 정도 기준

  // =================================================================
  // 공통 UI: 시트 · 토스트
  // =================================================================
  const App = {
    zTop: 40,
    openSheet(sheet, { focus = null } = {}) {
      sheet.hidden = false;
      sheet.style.zIndex = String(++this.zTop);
      document.body.classList.add('has-sheet');
      try { history.pushState({ sealSheet: sheet.id }, ''); } catch (_) {}
      requestAnimationFrame(() => sheet.classList.add('is-open'));
      if (focus) setTimeout(() => focus.focus({ preventScroll: true }), 80);
    },
    closeSheet(sheet) {
      if (history.state && history.state.sealSheet === sheet.id) { history.back(); return; }
      this.hideSheetNow(sheet);
    },
    hideSheetNow(sheet) {
      sheet.classList.remove('is-open');
      sheet.hidden = true;
      if (!document.querySelector('.sheet.is-open')) document.body.classList.remove('has-sheet');
    },
    showToast(message, { actionLabel = null, duration = 2400, onAction = null } = {}) {
      const toast = $('toast'), act = $('toast-action');
      clearTimeout(this.toastTimer);
      $('toast-msg').textContent = message;
      act.hidden = !actionLabel; act.textContent = actionLabel || '';
      act.onclick = onAction ? () => { this.hideToast(); onAction(); } : null;
      toast.hidden = false;
      requestAnimationFrame(() => toast.classList.add('is-visible'));
      this.toastTimer = setTimeout(() => this.hideToast(), duration);
    },
    hideToast() { const t = $('toast'); t.classList.remove('is-visible'); setTimeout(() => { t.hidden = true; }, 200); },
  };
  window.SealApp = App;
  window.SealDebug = { matchLedger: (c) => matchLedger(c), Ledger: () => Ledger };

  window.addEventListener('popstate', () => {
    document.querySelectorAll('.sheet.is-open').forEach((s) => {
      if (!(history.state && history.state.sealSheet === s.id)) App.hideSheetNow(s);
    });
  });
  document.querySelectorAll('.sheet').forEach((sheet) => {
    sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) App.closeSheet(sheet); });
  });

  // =================================================================
  // 열쇠 (이 폰에만 저장, 백업 코드 8자리 = 16진수)
  // =================================================================
  const Key = {
    value: 0,
    load() {
      let k = null;
      try { k = localStorage.getItem('seal:key'); } catch (_) {}
      if (!(k && /^[0-9a-f]{8}$/.test(k))) {
        const a = new Uint32Array(1);
        (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : (a[0] = (Math.random() * 4294967296) >>> 0);
        k = a[0].toString(16).padStart(8, '0');
        try { localStorage.setItem('seal:key', k); } catch (_) {}
      }
      this.value = parseInt(k, 16) >>> 0;
      return this.value;
    },
    code() { return this.value.toString(16).padStart(8, '0'); },
    set(code) {
      const v = (code || '').trim().toLowerCase();
      if (!/^[0-9a-f]{8}$/.test(v)) return false;
      this.value = parseInt(v, 16) >>> 0;
      try { localStorage.setItem('seal:key', v); } catch (_) {}
      return true;
    },
  };

  // =================================================================
  // 도장 장부 (IndexedDB) — 도장 찍은 사진의 작은 축소본 + 날짜
  // =================================================================
  const Ledger = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res) => {
        if (!window.indexedDB) return res(null);
        const r = indexedDB.open('seal', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('ledger', { keyPath: 'id', autoIncrement: true }); };
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => res(null);
      });
    },
    async add(entry) {
      const db = await this.open(); if (!db) return;
      await new Promise((res) => { const t = db.transaction('ledger', 'readwrite'); t.objectStore('ledger').add(entry); t.oncomplete = res; t.onerror = res; });
    },
    async all() {
      const db = await this.open(); if (!db) return [];
      return new Promise((res) => { const r = db.transaction('ledger').objectStore('ledger').getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
    },
    async clear() {
      const db = await this.open(); if (!db) return;
      await new Promise((res) => { const t = db.transaction('ledger', 'readwrite'); t.objectStore('ledger').clear(); t.oncomplete = res; t.onerror = res; });
    },
  };

  // 장부 대조용 작은 회색 그림 (긴 변 L). 캡처 안에 내 사진이 축소·잘림 상태로 들어 있어도 찾도록 템플릿 매칭을 쓴다.
  function grayPlane(canvas, L) {
    const s = L / Math.max(canvas.width, canvas.height), w = Math.max(2, Math.round(canvas.width * s)), h = Math.max(2, Math.round(canvas.height * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(canvas, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data, out = new Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
    return { w, h, g: out };
  }
  // 템플릿(장부 축소본)을 여러 크기로 캡처 위에서 미끄러뜨리며 가장 닮은 정도(0~1)를 찾는다
  function matchScore(S, T0, base, stepDiv) {
    let best = -1;
    for (let sc = 1.0; sc >= 0.18; sc *= 0.92) {
      const L = Math.round(base * sc), k = L / Math.max(T0.w, T0.h), tw = Math.max(6, Math.round(T0.w * k)), th = Math.max(6, Math.round(T0.h * k));
      if (tw > S.w || th > S.h) continue;
      const T = new Float32Array(tw * th); let tm = 0;
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const v = T0.g[Math.min(T0.h - 1, (y / k) | 0) * T0.w + Math.min(T0.w - 1, (x / k) | 0)]; T[y * tw + x] = v; tm += v; }
      tm /= tw * th; let tv = 0; for (let i = 0; i < tw * th; i++) { T[i] -= tm; tv += T[i] * T[i]; } tv = Math.sqrt(tv) + 1e-6;
      const step = Math.max(1, Math.floor(tw / stepDiv));
      for (let oy = 0; oy + th <= S.h; oy += step) for (let ox = 0; ox + tw <= S.w; ox += step) {
        let sm = 0; for (let y = 0; y < th; y++) { const r = (oy + y) * S.w + ox; for (let x = 0; x < tw; x++) sm += S.g[r + x]; } sm /= tw * th;
        let num = 0, sv = 0; for (let y = 0; y < th; y++) { const r = (oy + y) * S.w + ox; for (let x = 0; x < tw; x++) { const d = S.g[r + x] - sm; num += d * T[y * tw + x]; sv += d * d; } }
        const c = num / ((Math.sqrt(sv) + 1e-6) * tv); if (c > best) best = c;
      }
    }
    return best;
  }
  async function matchLedger(suspect) {
    const all = await Ledger.all(); if (!all.length) return null;
    // 1차: 거칠게 전부 훑어 후보 3장 → 2차: 촘촘하게
    const S1 = grayPlane(suspect, 64), S2 = grayPlane(suspect, 128);
    const cand = all.slice(-60).filter((e) => e.gray).map((e) => ({ e, c: matchScore(S1, { w: e.gw, h: e.gh, g: e.gray }, 64, 8) })).sort((a, b) => b.c - a.c).slice(0, 3);
    let best = null;
    cand.forEach(({ e }) => { const c = matchScore(S2, { w: e.gw, h: e.gh, g: e.gray }, 128, 24); if (!best || c > best.c) best = { c, e }; });
    return best;
  }

  // =================================================================
  // 워커
  // =================================================================
  const Worker_ = {
    w: null, seq: 0, jobs: new Map(),
    get() {
      if (this.w) return this.w;
      this.w = new Worker('js/seal-worker.js');
      this.w.onmessage = (e) => {
        const m = e.data, j = this.jobs.get(m.id); if (!j) return;
        if (m.progress !== undefined) { j.onProgress && j.onProgress(m.progress); return; }
        this.jobs.delete(m.id);
        if (m.error) j.reject(new Error(m.error)); else j.resolve(m);
      };
      this.w.onerror = (e) => { this.jobs.forEach((j) => j.reject(new Error(e.message || 'worker'))); this.jobs.clear(); };
      return this.w;
    },
    run(msg, transfer, onProgress) {
      return new Promise((resolve, reject) => {
        const id = ++this.seq; this.jobs.set(id, { resolve, reject, onProgress });
        this.get().postMessage(Object.assign({ id }, msg), transfer || []);
      });
    },
  };

  // =================================================================
  // 그림 도구
  // =================================================================
  function loadImage(file, maxSide) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), im = new Image();
      im.onload = () => {
        let w = im.naturalWidth, h = im.naturalHeight;
        if (!w || !h) { URL.revokeObjectURL(url); return rej(new Error('사진 크기를 읽을 수 없어요')); }
        const s = Math.min(1, maxSide / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(im, 0, 0, w, h);
        URL.revokeObjectURL(url); res(c);
      };
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('이 파일은 사진으로 열 수 없어요')); };
      im.src = url;
    });
  }
  function toBlob(canvas, q = 0.92) { return new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', q)); }
  function thumbOf(canvas, size) {
    const s = size / Math.max(canvas.width, canvas.height);
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(canvas.width * s)); c.height = Math.max(1, Math.round(canvas.height * s));
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }
  function fmtDate(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
  function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; }

  async function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  async function shareBlob(blob, name, title) {
    const file = new File([blob], name, { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title }); return 'shared'; }
      catch (err) { return err && err.name === 'AbortError' ? 'cancel' : 'fail'; }
    }
    return 'unsupported';
  }

  // JPEG 안에 위치 정보(GPS)·촬영 정보가 들어 있는지만 본다 (값은 읽지 않고, 내보낼 때 어차피 지워짐)
  async function scanExif(file) {
    const out = { gps: false, exif: false };
    try {
      const buf = await file.slice(0, 256 * 1024).arrayBuffer(); const v = new DataView(buf);
      if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return out;
      let off = 2;
      while (off + 4 <= v.byteLength) {
        if (v.getUint8(off) !== 0xFF) break;
        const marker = v.getUint8(off + 1), len = v.getUint16(off + 2);
        if (marker === 0xE1 && v.getUint32(off + 4) === 0x45786966) { // "Exif"
          const t = off + 10, le = v.getUint16(t) === 0x4949;
          const u16 = (p) => v.getUint16(p, le), u32 = (p) => v.getUint32(p, le);
          const ifd0 = t + u32(t + 4); const n = u16(ifd0); out.exif = n > 0;
          for (let i = 0; i < n; i++) { const tag = u16(ifd0 + 2 + i * 12); if (tag === 0x8825) out.gps = true; }
          break;
        }
        if (marker === 0xDA) break;
        off += 2 + len;
      }
    } catch (_) {}
    return out;
  }

  // =================================================================
  // 화면 전환
  // =================================================================
  function show(view) {
    ['view-home', 'view-protect', 'view-verify'].forEach((id) => { $(id).hidden = id !== view; });
    window.scrollTo({ top: 0 });
  }

  // =================================================================
  // 사진 지키기
  // =================================================================
  const Protect = {
    canvas: $('canvas'), ctx: null, src: null,     // src: 편집 중 사진
    undo: [], brushOn: false, brushSize: 'm', strokeSrc: null, bbox: null,
    boxes: [], exif: null, ocr: null, out: null, outBlob: null, tagPos: 'corner', step: 1,

    init() {
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      $('btn-start-protect').addEventListener('click', () => { track('protect_pick_open'); $('file-protect').click(); });
      $('file-protect').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.start(f); });
      $('btn-back-protect').addEventListener('click', () => this.leave());
      $('btn-restart').addEventListener('click', () => { track('protect_restart'); $('file-protect').click(); });

      $('btn-brush').addEventListener('click', () => this.setBrush(!this.brushOn));
      document.querySelectorAll('#brush-row [data-size]').forEach((b) => b.addEventListener('click', () => {
        document.querySelectorAll('#brush-row [data-size]').forEach((x) => x.classList.toggle('is-on', x === b)); this.brushSize = b.dataset.size;
      }));
      $('btn-undo').addEventListener('click', () => this.doUndo());
      $('btn-ocr').addEventListener('click', () => this.runOcr());
      $('btn-hide-all').addEventListener('click', () => { const n = this.boxes.length; this.boxes.slice().forEach((b) => this.hideBox(b)); track('ocr_hide_all', { count: n }); });

      const st = $('stage');
      st.addEventListener('pointerdown', (e) => this.pDown(e));
      st.addEventListener('pointermove', (e) => this.pMove(e));
      st.addEventListener('pointerup', (e) => this.pUp(e));
      st.addEventListener('pointercancel', (e) => this.pUp(e));

      $('btn-to-stamp').addEventListener('click', () => this.goStep(2));
      $('btn-back-check').addEventListener('click', () => this.goStep(1));
      $('sw-stamp').addEventListener('click', (e) => this.toggle(e.currentTarget));
      $('sw-tag').addEventListener('click', (e) => { this.toggle(e.currentTarget); $('tag-opts').hidden = e.currentTarget.getAttribute('aria-checked') !== 'true'; if (!$('tag-opts').hidden) $('tag-text').focus(); });
      $('sw-resize').addEventListener('click', (e) => this.toggle(e.currentTarget));
      document.querySelectorAll('[data-tagpos]').forEach((b) => b.addEventListener('click', () => {
        document.querySelectorAll('[data-tagpos]').forEach((x) => x.classList.toggle('is-on', x === b)); this.tagPos = b.dataset.tagpos;
      }));
      $('btn-do-stamp').addEventListener('click', () => this.finish());
      $('btn-save').addEventListener('click', () => this.save());
      $('btn-share-photo').addEventListener('click', () => this.sharePhoto());
    },
    toggle(btn) { btn.setAttribute('aria-checked', btn.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); },
    on(id) { return $(id).getAttribute('aria-checked') === 'true'; },

    async start(file) {
      show('view-protect'); this.goStep(1);
      $('stage-busy').hidden = false; $('stage-busy').textContent = '사진을 여는 중…';
      this.undo = []; this.boxes = []; this.clearBoxes(); this.setBrush(false); $('btn-undo').disabled = true; $('ocr-note').hidden = true; $('btn-hide-all').hidden = true;
      try {
        const [c, exif] = await Promise.all([loadImage(file, MAX_EDIT), scanExif(file)]);
        this.src = c; this.exif = exif;
        this.canvas.width = c.width; this.canvas.height = c.height; this.ctx.drawImage(c, 0, 0);
        const chips = [];
        chips.push(exif.gps ? '<span class="info-chip info-chip--warn">위치 정보 있음 → 내보낼 때 지워요</span>' : '<span class="info-chip info-chip--ok">위치 정보 없음</span>');
        if (exif.exif) chips.push('<span class="info-chip">촬영 정보(기종·시각) → 지워요</span>');
        chips.push(`<span class="info-chip">${c.width}×${c.height}</span>`);
        $('exif-chips').innerHTML = chips.join('');
        this.hint('번호판·문패가 보이면 "손으로 가리기"를 켜고 문질러 주세요');
        track('protect_start', { gps: exif.gps, mp: Math.round(c.width * c.height / 1e5) / 10 });
      } catch (err) {
        App.showToast(err.message || '사진을 열 수 없어요', { duration: 3500 }); show('view-home');
      }
      $('stage-busy').hidden = true;
    },
    leave() { show('view-home'); this.src = null; this.out = null; this.outBlob = null; this.canvas.width = this.canvas.height = 1; },
    hint(text) { const h = $('stage-hint'); h.textContent = text || ''; h.hidden = !text; clearTimeout(this.hintTimer); if (text) this.hintTimer = setTimeout(() => { h.hidden = true; }, 3500); },

    goStep(n) {
      this.step = n;
      document.querySelectorAll('.step').forEach((s) => { const k = +s.dataset.step; s.classList.toggle('is-on', k === n); s.classList.toggle('is-done', k < n); });
      $('panel-check').hidden = n !== 1; $('panel-stamp').hidden = n !== 2; $('panel-export').hidden = n !== 3;
      if (n !== 1) { this.setBrush(false); this.clearBoxes(); }
      if (n === 2) track('protect_step_stamp');
      window.scrollTo({ top: 0 });
    },

    // ── 화면 좌표 ↔ 사진 좌표 (object-fit: contain 고려)
    map(e) {
      const r = this.canvas.getBoundingClientRect(), W = this.canvas.width, H = this.canvas.height;
      const s = Math.min(r.width / W, r.height / H), ox = (r.width - W * s) / 2, oy = (r.height - H * s) / 2;
      return { x: (e.clientX - r.left - ox) / s, y: (e.clientY - r.top - oy) / s, s, ox: r.left - $('stage').getBoundingClientRect().left + ox, oy: r.top - $('stage').getBoundingClientRect().top + oy };
    },

    // ── 손으로 가리기(모자이크 브러시)
    setBrush(on) {
      this.brushOn = on; $('btn-brush').classList.toggle('is-on', on); $('stage').classList.toggle('is-brush', on); $('brush-row').hidden = !on;
      if (on) this.hint('손가락으로 문지르면 모자이크가 돼요. 다 했으면 다시 눌러 꺼요.');
    },
    radius() { const base = Math.max(this.canvas.width, this.canvas.height) / 40; return base * ({ s: 0.6, m: 1, l: 1.7 })[this.brushSize]; },
    pDown(e) {
      if (!this.brushOn || this.step !== 1 || e.target.closest('.stage__box')) return;
      e.preventDefault(); $('stage').setPointerCapture(e.pointerId);
      this.strokeSrc = document.createElement('canvas'); this.strokeSrc.width = this.canvas.width; this.strokeSrc.height = this.canvas.height;
      this.strokeSrc.getContext('2d').drawImage(this.canvas, 0, 0);
      this.bbox = null; this.drawing = true; this.dab(this.map(e));
    },
    pMove(e) { if (!this.drawing) return; e.preventDefault(); this.dab(this.map(e)); },
    pUp() {
      if (!this.drawing) return; this.drawing = false;
      if (this.bbox) {
        const b = this.bbox, sctx = this.strokeSrc.getContext('2d');
        this.pushUndo({ x: b.x, y: b.y, w: b.w, h: b.h, data: sctx.getImageData(b.x, b.y, b.w, b.h) });
        track('mask_stroke', { size: this.brushSize });
      }
      this.strokeSrc = null;
    },
    dab(p) {
      const r = this.radius(), W = this.canvas.width, H = this.canvas.height;
      const x0 = Math.max(0, Math.floor(p.x - r)), y0 = Math.max(0, Math.floor(p.y - r));
      const x1 = Math.min(W, Math.ceil(p.x + r)), y1 = Math.min(H, Math.ceil(p.y + r));
      if (x1 <= x0 || y1 <= y0) return;
      const block = Math.max(8, Math.round(Math.max(W, H) / 60));
      const bx0 = Math.floor(x0 / block) * block, by0 = Math.floor(y0 / block) * block;
      const bw = Math.ceil((x1 - bx0) / block), bh = Math.ceil((y1 - by0) / block);
      const tmp = this.tmp || (this.tmp = document.createElement('canvas')); tmp.width = bw; tmp.height = bh;
      const tg = tmp.getContext('2d'); tg.imageSmoothingEnabled = true;
      tg.drawImage(this.strokeSrc, bx0, by0, bw * block, bh * block, 0, 0, bw, bh);
      const ctx = this.ctx; ctx.save(); ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.clip();
      ctx.imageSmoothingEnabled = false; ctx.drawImage(tmp, 0, 0, bw, bh, bx0, by0, bw * block, bh * block); ctx.restore();
      ctx.imageSmoothingEnabled = true;
      const nb = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      this.bbox = this.bbox ? union(this.bbox, nb) : nb;
    },
    pushUndo(item) { this.undo.push(item); if (this.undo.length > 12) this.undo.shift(); $('btn-undo').disabled = false; },
    doUndo() {
      const u = this.undo.pop(); if (!u) return;
      this.ctx.putImageData(u.data, u.x, u.y);
      if (u.box) { this.boxes.push(u.box); this.renderBoxes(); }
      $('btn-undo').disabled = this.undo.length === 0; track('mask_undo');
    },
    hideRect(x, y, w, h) {
      const W = this.canvas.width, H = this.canvas.height;
      x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y)); w = Math.min(W - x, Math.ceil(w)); h = Math.min(H - y, Math.ceil(h));
      if (w <= 0 || h <= 0) return null;
      const before = this.ctx.getImageData(x, y, w, h);
      const block = Math.max(8, Math.round(Math.max(W, H) / 60), Math.round(h / 2.5));
      const tmp = document.createElement('canvas'); tmp.width = Math.max(1, Math.ceil(w / block)); tmp.height = Math.max(1, Math.ceil(h / block));
      tmp.getContext('2d').drawImage(this.canvas, x, y, w, h, 0, 0, tmp.width, tmp.height);
      this.ctx.imageSmoothingEnabled = false; this.ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h); this.ctx.imageSmoothingEnabled = true;
      return { x, y, w, h, data: before };
    },

    // ── 글자 자동 찾기 (Tesseract.js, 눌렀을 때만 불러옴)
    async runOcr() {
      if (this.ocrBusy) return;
      this.ocrBusy = true; const btn = $('btn-ocr'); btn.disabled = true;
      $('stage-busy').hidden = false; $('stage-busy').textContent = '글자 인식 준비 중… (처음엔 몇 MB를 내려받아요)';
      track('ocr_start');
      try {
        const base = new URL(cfg.OCR_BASE || 'vendor/tesseract/', location.href).toString();
        if (!window.Tesseract) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = base + 'tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('글자 인식 파일을 내려받지 못했어요. 인터넷 연결을 확인해 주세요.')); document.head.appendChild(s); });
        if (!this.ocr) { this.ocr = await Tesseract.createWorker(cfg.OCR_LANG || 'eng', 1, { workerPath: base + 'worker.min.js', corePath: base, langPath: base, gzip: true, logger: (m) => { if (m.status === 'recognizing text') $('stage-busy').textContent = `글자를 찾는 중… ${Math.round((m.progress || 0) * 100)}%`; } });
          await this.ocr.setParameters({ tessedit_pageseg_mode: '11' }); }
        $('stage-busy').textContent = '글자를 찾는 중…';
        const small = thumbOf(this.canvas, 1600), k = this.canvas.width / small.width;
        const { data } = await this.ocr.recognize(small);
        const words = (data.words || []).filter((w) => {
          const t = (w.text || '').trim(), digits = (t.match(/\d/g) || []).length;
          return (digits >= 2 && t.length >= 3 && w.confidence > 35) || (t.length >= 4 && w.confidence > 70 && /[A-Za-z]/.test(t));
        });
        this.boxes = words.map((w, i) => { const b = w.bbox, pad = 6 * k; return { id: i, x: b.x0 * k - pad, y: b.y0 * k - pad, w: (b.x1 - b.x0) * k + 2 * pad, h: (b.y1 - b.y0) * k + 2 * pad, text: w.text }; });
        this.renderBoxes();
        const note = $('ocr-note'); note.hidden = false;
        note.textContent = this.boxes.length
          ? `숫자·영문이 들어간 글자 ${this.boxes.length}곳을 찾았어요. 네모를 누르면 가려져요. 작거나 비스듬한 글자, 한글은 놓칠 수 있으니 눈으로도 확인해 주세요.`
          : '번호판·전화번호처럼 생긴 글자를 찾지 못했어요. 작거나 비스듬한 글자, 한글은 놓칠 수 있어요. 보이는 게 있으면 손으로 가려 주세요.';
        $('btn-hide-all').hidden = this.boxes.length === 0;
        track('ocr_done', { found: this.boxes.length });
      } catch (err) {
        App.showToast(err.message || '글자 찾기에 실패했어요', { duration: 4000 }); track('ocr_fail');
      }
      $('stage-busy').hidden = true; btn.disabled = false; this.ocrBusy = false;
    },
    renderBoxes() {
      const layer = $('box-layer'); layer.innerHTML = '';
      if (!this.boxes.length) return;
      const r = this.canvas.getBoundingClientRect(), st = $('stage').getBoundingClientRect();
      const W = this.canvas.width, H = this.canvas.height, s = Math.min(r.width / W, r.height / H);
      const ox = r.left - st.left + (r.width - W * s) / 2, oy = r.top - st.top + (r.height - H * s) / 2;
      this.boxes.forEach((b) => {
        const el = document.createElement('button'); el.type = 'button'; el.className = 'stage__box';
        el.style.left = `${ox + b.x * s}px`; el.style.top = `${oy + b.y * s}px`; el.style.width = `${b.w * s}px`; el.style.height = `${b.h * s}px`;
        el.setAttribute('aria-label', `찾은 글자 가리기`);
        el.addEventListener('click', (e) => { e.stopPropagation(); this.hideBox(b); track('ocr_hide_one'); });
        layer.appendChild(el);
      });
    },
    hideBox(b) {
      const u = this.hideRect(b.x, b.y, b.w, b.h);
      this.boxes = this.boxes.filter((x) => x !== b);
      if (u) { u.box = b; this.pushUndo(u); }
      this.renderBoxes(); $('btn-hide-all').hidden = this.boxes.length === 0;
    },
    clearBoxes() { this.boxes = []; $('box-layer').innerHTML = ''; $('btn-hide-all').hidden = true; },

    // ── 도장 찍고 내보내기
    async finish() {
      if (!this.src) return;
      const useStamp = this.on('sw-stamp'), useTag = this.on('sw-tag'), useResize = this.on('sw-resize');
      const tagText = ($('tag-text').value || '').trim();
      if (useTag && !tagText) { $('tag-text').focus(); App.showToast('이름표에 넣을 글자를 적어 주세요'); return; }
      $('btn-do-stamp').disabled = true; $('stage-busy').hidden = false; $('stage-busy').textContent = '도장을 심는 중…';
      try {
        let out = this.canvas;
        if (useResize && Math.max(out.width, out.height) > 2048) out = thumbOf(out, 2048);
        else { const c = document.createElement('canvas'); c.width = out.width; c.height = out.height; c.getContext('2d').drawImage(out, 0, 0); out = c; }
        if (useTag) this.drawTag(out, tagText, this.tagPos);
        if (useStamp) {
          const g = out.getContext('2d'), id = g.getImageData(0, 0, out.width, out.height);
          const r = await Worker_.run({ type: 'embed', buf: id.data.buffer, w: out.width, h: out.height, key: Key.value, sy: SY, sc: SC }, [id.data.buffer]);
          g.putImageData(new ImageData(new Uint8ClampedArray(r.buf), out.width, out.height), 0, 0);
        }
        this.out = out; this.outBlob = await toBlob(out, 0.92);
        this.canvas.width = out.width; this.canvas.height = out.height; this.ctx.drawImage(out, 0, 0);
        const items = [
          `<li>${this.exif && this.exif.gps ? '위치 정보를 지웠어요' : '위치·촬영 정보 없이 내보내요'}</li>`,
          `<li class="${useStamp ? '' : 'is-off'}">${useStamp ? '보이지 않는 도장을 심었어요' : '보이지 않는 도장은 끔'}</li>`,
          `<li class="${useTag ? '' : 'is-off'}">${useTag ? `이름표 "${escapeHtml(tagText)}"를 넣었어요` : '보이는 이름표는 끔'}</li>`,
          `<li>${out.width}×${out.height} · ${Math.round(this.outBlob.size / 1024)}KB</li>`,
        ];
        if (useStamp) {
          const th = thumbOf(out, 160);
          const gp = grayPlane(out, 48);
          await Ledger.add({ date: Date.now(), w: out.width, h: out.height, thumb: th.toDataURL('image/jpeg', 0.8), gw: gp.w, gh: gp.h, gray: gp.g, keyCode: Key.code() });
          items.push('<li>도장 장부에 날짜와 작은 축소본을 남겼어요</li>');
        }
        $('done-list').innerHTML = items.join('');
        this.goStep(3);
        track('protect_done', { stamp: useStamp, tag: useTag, tagpos: useTag ? this.tagPos : 'none', resize: useResize, masked: this.undo.length > 0 });
      } catch (err) {
        App.showToast('처리에 실패했어요: ' + (err.message || err), { duration: 4000 }); track('protect_fail');
      }
      $('stage-busy').hidden = true; $('btn-do-stamp').disabled = false;
    },
    drawTag(c, text, pos) {
      const g = c.getContext('2d'), W = c.width, H = c.height, base = Math.min(W, H);
      g.save();
      if (pos === 'corner') {
        const fs = Math.max(14, Math.round(base * 0.032)); g.font = `700 ${fs}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
        g.textBaseline = 'bottom'; g.textAlign = 'right';
        g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = fs * 0.35; g.fillStyle = 'rgba(255,255,255,0.9)';
        g.fillText(text, W - fs * 0.9, H - fs * 0.7);
      } else {
        const fs = Math.max(20, Math.round(base * 0.075)); g.font = `800 ${fs}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
        g.textBaseline = 'middle'; g.textAlign = 'center'; g.globalAlpha = 0.22;
        g.translate(W / 2, H / 2); g.rotate(-Math.PI / 9);
        g.fillStyle = '#fff'; g.fillText(text, 0, 0); g.globalAlpha = 0.12; g.fillStyle = '#000'; g.fillText(text, fs * 0.04, fs * 0.04);
      }
      g.restore();
    },
    async save() {
      if (!this.outBlob) return;
      await saveBlob(this.outBlob, `seal-${stamp()}.jpg`); track('photo_save');
      App.showToast('저장했어요. 갤러리(다운로드)에서 찾아 올려 주세요.', { duration: 3500 });
    },
    async sharePhoto() {
      if (!this.outBlob) return;
      const r = await shareBlob(this.outBlob, `seal-${stamp()}.jpg`, 'Seal로 지킨 사진'); track('photo_share', { outcome: r });
      if (r === 'unsupported') { await this.save(); App.showToast('이 브라우저는 사진 공유가 안 돼서 저장했어요.', { duration: 3500 }); }
      else if (r === 'fail') App.showToast('공유가 안 됐어요. 저장해서 올려 주세요.');
    },
  };
  function union(a, b) { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; }
  function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  // =================================================================
  // 내 사진인지 확인
  // =================================================================
  const Verify = {
    canvas: $('verify-canvas'), result: null, suspect: null, matched: null, cardBlob: null,
    init() {
      $('btn-start-verify').addEventListener('click', () => { show('view-verify'); this.reset(); track('verify_open'); });
      $('btn-pick-verify').addEventListener('click', () => $('file-verify').click());
      $('btn-verify-again').addEventListener('click', () => $('file-verify').click());
      $('file-verify').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.run(f); });
      $('btn-back-verify').addEventListener('click', () => show('view-home'));
      $('btn-make-card').addEventListener('click', () => this.makeCard());
      $('btn-card-save').addEventListener('click', async () => { if (this.cardBlob) { await saveBlob(this.cardBlob, `seal-card-${stamp()}.jpg`); track('card_save'); App.showToast('신고 카드를 저장했어요.'); } });
      $('btn-card-share').addEventListener('click', async () => { if (!this.cardBlob) return; const r = await shareBlob(this.cardBlob, `seal-card-${stamp()}.jpg`, 'Seal 확인 결과'); track('card_share', { outcome: r }); if (r === 'unsupported') { await saveBlob(this.cardBlob, `seal-card-${stamp()}.jpg`); App.showToast('이 브라우저는 공유가 안 돼서 저장했어요.'); } });
    },
    reset() { $('verify-intro').hidden = false; $('verify-run').hidden = true; $('verify-result').hidden = true; $('card-wrap').hidden = true; this.cardBlob = null; },

    async run(file) {
      show('view-verify'); $('verify-intro').hidden = true; $('verify-result').hidden = true; $('verify-run').hidden = false; $('card-wrap').hidden = true; this.cardBlob = null;
      const bar = $('verify-bar'), status = $('verify-status'); bar.style.width = '0'; status.textContent = '사진을 준비하고 있어요…';
      const t0 = performance.now();
      try {
        const c = await loadImage(file, MAX_FIND); this.suspect = c;
        this.canvas.width = c.width; this.canvas.height = c.height; this.canvas.getContext('2d').drawImage(c, 0, 0);
        const planesOf = (cv) => { const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data; return SealCore.planesOf(d, cv.width, cv.height); };
        const detect = (cv, label, from, to) => {
          const pl = planesOf(cv);
          return Worker_.run({ type: 'detect', planes: pl.map((p) => p.buffer), w: cv.width, h: cv.height, keys: [Key.value], opt: {} }, pl.map((p) => p.buffer),
            (p) => { bar.style.width = `${Math.round((from + (to - from) * p) * 100)}%`; status.textContent = `${label} ${Math.round(p * 100)}%`; });
        };
        let r = await detect(c, '도장을 찾는 중', 0, 0.5); let flipped = false;
        if (r.z[0] < TH_WEAK) {
          const f = document.createElement('canvas'); f.width = c.width; f.height = c.height; const g = f.getContext('2d'); g.translate(c.width, 0); g.scale(-1, 1); g.drawImage(c, 0, 0);
          const r2 = await detect(f, '좌우가 뒤집힌 사진인지 한 번 더 확인 중', 0.5, 1); if (r2.z[0] > r.z[0]) { r = r2; flipped = true; }
        }
        bar.style.width = '100%';
        const sec = (performance.now() - t0) / 1000, z = r.z[0];
        this.result = { z, p: r.p, sec, flipped, w: c.width, h: c.height };
        await this.showResult();
        track('verify_result', { verdict: z >= TH_SURE ? 'sure' : z >= TH_WEAK ? 'weak' : 'none', score: Math.round(z), seconds: Math.round(sec), flipped, matched: !!this.matched });
      } catch (err) {
        App.showToast('확인에 실패했어요: ' + (err.message || err), { duration: 4000 }); this.reset(); track('verify_fail');
      }
    },
    async showResult() {
      const { z, p, sec, flipped } = this.result;
      const v = $('verdict'); v.className = 'verdict ' + (z >= TH_SURE ? '' : z >= TH_WEAK ? 'verdict--weak' : 'verdict--none');
      $('verdict-title').textContent = z >= TH_SURE ? '내 도장이 있어요' : z >= TH_WEAK ? '내 도장이 약하게 보여요' : '내 도장을 찾지 못했어요';
      $('verdict-sub').textContent = z >= TH_SURE ? (flipped ? '좌우를 뒤집어 올린 사진이에요. 이 열쇠로 찍은 도장이 확실해요.' : '이 폰의 열쇠로 찍은 도장이 확실하게 나왔어요.')
        : z >= TH_WEAK ? '도장이 있을 가능성이 높지만 확실하진 않아요. 더 큰 화면의 캡처로 다시 해 보세요.'
        : '잘리거나 축소된 정도로는 보통 찾아요. 기울어졌거나 너무 작은 사진, 다른 열쇠로 찍은 사진, 도장 없이 올린 사진일 수 있어요.';
      $('stat-score').textContent = z.toFixed(1); $('stat-time').textContent = `${sec.toFixed(0)}초`; $('stat-tile').textContent = z >= TH_WEAK ? `약 ${Math.round(p)}px` : '–';
      // 장부 대조(참고)
      this.matched = null; $('match').hidden = true;
      if (z >= TH_WEAK) {
        const best = await matchLedger(this.suspect); this.lastMatch = best;
        if (best && best.c > MATCH_TH) {
          this.matched = best.e; $('match').hidden = false; $('match-img').src = best.e.thumb;
          $('match-sub').textContent = `${fmtDate(new Date(best.e.date))}에 도장을 찍은 사진과 비슷해요 (참고용)`;
        }
      }
      $('btn-make-card').hidden = z < TH_WEAK;
      $('verify-run').hidden = true; $('verify-result').hidden = false; window.scrollTo({ top: 0 });
    },

    // 신고 카드: 캡처 · 내 사진(장부) · 드러낸 도장 · 점수 · 날짜
    async makeCard() {
      const { z, p, flipped } = this.result, c = $('card-canvas'), g = c.getContext('2d'), W = 1080, H = 1350;
      const F = '-apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';
      g.fillStyle = '#FDF8F3'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#B04A62'; g.fillRect(0, 0, W, 150);
      g.fillStyle = '#FFFFFF'; g.font = `800 44px ${F}`; g.textBaseline = 'middle'; g.fillText('Seal 확인 결과', 48, 62);
      g.fillStyle = 'rgba(255,255,255,0.8)'; g.font = `500 26px ${F}`; g.fillText(`확인 시각 ${fmtDate(new Date())}  ·  열쇠 ${Key.code().slice(0, 4)}****`, 48, 110);
      // 사진 두 장
      const fit = (img, x, y, w, h) => { const s = Math.min(w / img.width, h / img.height), dw = img.width * s, dh = img.height * s; g.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); };
      const colW = 492, top = 220, boxH = 520;
      g.fillStyle = '#2B2628'; g.font = `800 28px ${F}`; g.textBaseline = 'alphabetic';
      g.fillText('의심 계정 캡처', 48, top - 18); g.fillText('내 사진 (도장 장부)', 48 + colW + 48, top - 18);
      g.fillStyle = '#FBE9E8'; g.fillRect(48, top, colW, boxH); g.fillRect(48 + colW + 48, top, colW, boxH);
      fit(this.suspect, 48, top, colW, boxH);
      if (this.matched) {
        const im = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = this.matched.thumb; });
        if (im) fit(im, 48 + colW + 48, top, colW, boxH);
        g.fillStyle = '#7D7175'; g.font = `500 24px ${F}`; g.fillText(`도장 찍은 날짜 ${fmtDate(new Date(this.matched.date))}`, 48 + colW + 48, top + boxH + 36);
      } else {
        g.fillStyle = '#7D7175'; g.font = `500 26px ${F}`; g.textAlign = 'center';
        g.fillText('장부에 같은 사진이 없어요', 48 + colW + 48 + colW / 2, top + boxH / 2 - 10); g.fillText('(다른 폰에서 찍었거나 장부를 비움)', 48 + colW + 48 + colW / 2, top + boxH / 2 + 30); g.textAlign = 'left';
      }
      // 드러낸 도장: 캡처 위에 찾은 크기로 열쇠 무늬를 진하게 겹침
      const ry = top + boxH + 70, rh = 330;
      g.fillStyle = '#2B2628'; g.font = `800 28px ${F}`; g.fillText('캡처 속 숨은 도장을 드러낸 모습', 48, ry - 18);
      const rev = document.createElement('canvas'); rev.width = this.suspect.width; rev.height = this.suspect.height; const rg = rev.getContext('2d'); rg.drawImage(this.suspect, 0, 0);
      const tsize = Math.max(16, Math.round(p)), tile = SealCore.tilePreview(Key.value, 64), tc = document.createElement('canvas'); tc.width = tc.height = 64;
      const tid = tc.getContext('2d').createImageData(64, 64);
      for (let i = 0; i < 4096; i++) { const v = Math.max(0, Math.min(255, 128 + tile[i] * 70)); tid.data[i * 4] = v; tid.data[i * 4 + 1] = v; tid.data[i * 4 + 2] = v; tid.data[i * 4 + 3] = 255; }
      tc.getContext('2d').putImageData(tid, 0, 0);
      rg.globalCompositeOperation = 'overlay'; rg.globalAlpha = 0.85;
      for (let y = 0; y < rev.height; y += tsize) for (let x = 0; x < rev.width; x += tsize) rg.drawImage(tc, x, y, tsize, tsize);
      rg.globalCompositeOperation = 'source-over'; rg.globalAlpha = 1;
      g.fillStyle = '#FBE9E8'; g.fillRect(48, ry, W - 96, rh); fit(rev, 48, ry, W - 96, rh);
      // 점수·판정
      const sy = ry + rh + 60;
      g.fillStyle = z >= TH_SURE ? '#B04A62' : '#8A6A1F'; g.font = `800 40px ${F}`;
      g.fillText(z >= TH_SURE ? `일치 점수 ${z.toFixed(1)} — 내 도장이 있음` : `일치 점수 ${z.toFixed(1)} — 도장이 약하게 보임`, 48, sy);
      g.fillStyle = '#7D7175'; g.font = `500 24px ${F}`;
      g.fillText(`점수 9 이상 확실 · 7.5~9 약함 · 도장 없는 사진 5,670회 대조에서 7.5 초과 0건${flipped ? ' · 좌우 반전 상태로 발견' : ''}`, 48, sy + 44);
      g.fillText('이 카드는 신고할 때 붙이는 참고 자료이며 법적 증거가 아닙니다. pebbleitgo.com/seal', 48, sy + 84);
      $('card-wrap').hidden = false; this.cardBlob = await toBlob(c, 0.9);
      track('card_made', { matched: !!this.matched }); c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  };

  // =================================================================
  // 설정 시트 · 사용법 · 헤더
  // =================================================================
  function renderKey() { $('key-code').textContent = Key.code(); }
  async function renderLedgerInfo() {
    const all = await Ledger.all();
    $('ledger-info').textContent = all.length ? `도장 찍은 사진 ${all.length}장의 축소본과 날짜가 이 폰에 있어요. 확인할 때 어느 사진인지 맞추는 데 써요.` : '아직 도장 찍은 사진이 없어요. 도장을 찍으면 작은 축소본과 날짜를 이 폰에 남겨요.';
  }
  function initHeader() {
    $('btn-home').addEventListener('click', () => { if (!$('view-home').hidden) return; if (Protect.src) Protect.leave(); else show('view-home'); });
    $('btn-guide').addEventListener('click', () => { track('guide_open'); App.openSheet($('guide-sheet')); });
    $('btn-share').addEventListener('click', () => window.SealShare.share('header'));
    $('btn-settings').addEventListener('click', async () => { renderKey(); $('key-msg').textContent = ''; $('key-input').value = ''; await renderLedgerInfo(); track('settings_open'); App.openSheet($('settings-sheet')); });
    $('btn-copy-key').addEventListener('click', async () => { const ok = await window.SealShare.copy(Key.code()); $('btn-copy-key').textContent = ok ? '복사됨' : '길게 눌러 복사'; setTimeout(() => { $('btn-copy-key').textContent = '복사'; }, 1800); track('key_copy', { ok }); });
    $('btn-set-key').addEventListener('click', () => {
      const v = $('key-input').value;
      if (Key.set(v)) { renderKey(); $('key-input').value = ''; $('key-msg').textContent = '열쇠를 바꿨어요. 이제 이 코드로 찍은 사진을 확인할 수 있어요.'; track('key_set'); }
      else $('key-msg').textContent = '백업 코드는 0~9, a~f로 된 8자리예요. 다시 확인해 주세요.';
    });
    $('btn-ledger-clear').addEventListener('click', async () => { await Ledger.clear(); await renderLedgerInfo(); App.showToast('장부를 비웠어요.'); track('ledger_clear'); });
  }

  // 홈: 도장 전후 비교 슬라이더
  function initCompare() {
    const r = $('compare-range'); if (!r) return;
    const set = (v) => { $('compare-after').style.clipPath = `inset(0 0 0 ${v}%)`; $('compare-bar').style.left = `${v}%`; $('compare-knob').style.left = `${v}%`; };
    r.addEventListener('input', () => set(r.value)); set(50);
    let moved = false; r.addEventListener('change', () => { if (!moved) { moved = true; track('compare_used'); } });
  }

  // 공유 메뉴로 받은 캡처 (설치된 Seal, 갤럭시)
  async function takeSharedPhoto() {
    if (!new URLSearchParams(location.search).has('shared') || !window.caches) return;
    try {
      const c = await caches.open('seal-share'), res = await c.match('shared-photo');
      if (res) { const blob = await res.blob(); await c.delete('shared-photo'); track('share_target_received'); Verify.run(new File([blob], 'shared.jpg', { type: blob.type || 'image/jpeg' })); }
    } catch (_) {}
    try { history.replaceState(null, '', location.pathname); } catch (_) {}
  }

  // =================================================================
  // 시작
  // =================================================================
  function init() {
    Key.load();
    Protect.init(); Verify.init(); initHeader(); initCompare();
    window.SealInstall.init({ appName: 'Seal', track, showToast: (m, o) => App.showToast(m, o), openSheet: (s) => App.openSheet(s), closeSheet: (s) => App.closeSheet(s) });
    window.addEventListener('resize', () => { if (Protect.boxes.length) Protect.renderBoxes(); });
    takeSharedPhoto();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
    }
    track('app_open', { source: new URLSearchParams(location.search).get('source') || 'direct' });
  }
  init();
})();
