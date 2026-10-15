'use strict';

/**
 * Seal — 앱 동작
 *  홈 → [사진 지키기: 점검(가리기) → 도장 → 저장·공유] / [내 사진인지 확인: 찾기 → 신고 카드]
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
  const MATCH_TH = 0.62;                    // 장부 대조(참고) 닮은 정도 기준(실제 폰 사진 기준 상향)
  const LEDGER_MAX = 500;                   // 장부 기록(날짜·축소본) 최대 수
  const LEDGER_MB_DEFAULT = 150;            // 완전한 사진을 보관하는 용량 한도(MB) 기본값
  const ledgerLimit = () => { try { const v = +localStorage.getItem('seal:ledgerMB'); return [50, 150, 400].includes(v) ? v : LEDGER_MB_DEFAULT; } catch (_) { return LEDGER_MB_DEFAULT; } };

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
    async put(entry) {
      const db = await this.open(); if (!db) return;
      await new Promise((res) => { const t = db.transaction('ledger', 'readwrite'); t.objectStore('ledger').put(entry); t.oncomplete = res; t.onerror = res; });
    },
    /** 기록은 LEDGER_MAX까지, 완전한 사진은 용량 한도(MB)까지만. 한도를 넘으면 오래된 사진의 큰 파일만 지우고 축소본·날짜는 남긴다. 반환: 큰 파일을 지운 수 */
    async prune(maxCount, maxMB) {
      const db = await this.open(); if (!db) return 0;
      let all = await this.all(), dropped = 0;
      if (all.length > maxCount) {
        const drop = all.slice(0, all.length - maxCount).map((e) => e.id);
        await new Promise((res) => { const t = db.transaction('ledger', 'readwrite'); drop.forEach((id) => t.objectStore('ledger').delete(id)); t.oncomplete = res; t.onerror = res; });
        all = all.slice(all.length - maxCount);
      }
      let bytes = all.reduce((s, e) => s + ((e.photo && e.photo.size) || 0), 0);
      const limit = maxMB * 1048576, shrink = [];
      for (const e of all) { if (bytes <= limit) break; if (e.photo) { bytes -= e.photo.size; e.photo = null; e.photoDropped = true; shrink.push(e); dropped++; } }
      if (shrink.length) await new Promise((res) => { const t = db.transaction('ledger', 'readwrite'); shrink.forEach((e) => t.objectStore('ledger').put(e)); t.oncomplete = res; t.onerror = res; });
      return dropped;
    },
    async dropPhotos() { // 큰 사진만 비우기(기록 유지)
      const db = await this.open(); if (!db) return;
      const all = (await this.all()).filter((e) => e.photo); all.forEach((e) => { e.photo = null; e.photoDropped = true; });
      await new Promise((res) => { const t = db.transaction('ledger', 'readwrite'); all.forEach((e) => t.objectStore('ledger').put(e)); t.oncomplete = res; t.onerror = res; });
    },
    async usage() { const all = await this.all(); return { count: all.length, photos: all.filter((e) => e.photo).length, bytes: all.reduce((s, e) => s + ((e.photo && e.photo.size) || 0), 0), midBytes: all.reduce((s, e) => s + ((e.mid && e.mid.size) || 0), 0) }; },
  };
  // 장부의 보관 사진(blob)을 그림으로
  function blobToImage(blob) { return new Promise((res) => { if (!blob) return res(null); const url = URL.createObjectURL(blob), i = new Image(); i.onload = () => { URL.revokeObjectURL(url); res(i); }; i.onerror = () => { URL.revokeObjectURL(url); res(null); }; i.src = url; }); }
  // 이름표 즐겨찾기(최근 5개, 이 폰에만)
  const Tags = {
    list() { try { const v = JSON.parse(localStorage.getItem('seal:tags') || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } },
    remember(t) { const l = [t].concat(this.list().filter((x) => x !== t)).slice(0, 5); try { localStorage.setItem('seal:tags', JSON.stringify(l)); } catch (_) {} },
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
    const fine = cand.map(({ e }) => ({ e, c: matchScore(S2, { w: e.gw, h: e.gh, g: e.gray }, 128, 24) })).sort((a, b) => b.c - a.c);
    const best = fine[0] || null; if (best) best.margin = fine.length > 1 ? best.c - fine[1].c : 1;
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
  // 고른 파일을 즉시 메모리로 복사. 안드로이드는 몇 초 뒤 다시 읽으면 접근이 끊길 수 있어(갤러리 파일 두 번 읽기 실패) 한 번만 읽고 복사본을 쓴다.
  async function snapshotFile(file) {
    try { const buf = await file.arrayBuffer(); return new File([buf], file.name || 'photo', { type: file.type || 'image/jpeg', lastModified: file.lastModified || Date.now() }); }
    catch (err) {
      // 안드로이드 크롬: 크롬이 내려받은 파일을 갤러리로 고르면 권한 문제로 읽기가 거부될 수 있다
      App.showToast('파일을 읽지 못했어요. 고르기 창에서 갤러리 대신 "내 파일"(파일 앱)을 골라 Download 폴더에서 선택해 보세요.', { duration: 6000 });
      track('file_unreadable', { kind: (err && err.name) || 'unknown' });
      return null;
    }
  }
  // 사진 열기: createImageBitmap(방향 자동 보정·큰 사진에 강함) → 안 되면 <img>. HEIF 등 못 읽는 형식은 이유를 알려 준다.
  async function loadImage(file, maxSide) {
    const name = (file.name || '').toLowerCase(), type = file.type || '';
    const looksHeif = /\.(heic|heif)$/.test(name) || /hei[cf]/.test(type);
    const fail = (why) => new Error(`${why} (형식 ${type || name.split('.').pop() || '알 수 없음'}, ${Math.round(file.size / 1024)}KB)`);
    let bmp = null;
    if (window.createImageBitmap) {
      try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (_) { try { bmp = await createImageBitmap(file); } catch (_) { bmp = null; } }
    }
    let src = bmp, w = bmp ? bmp.width : 0, h = bmp ? bmp.height : 0;
    if (!bmp) {
      src = await new Promise((res, rej) => {
        const url = URL.createObjectURL(file), im = new Image();
        im.onload = () => { URL.revokeObjectURL(url); res(im); };
        im.onerror = () => { URL.revokeObjectURL(url); rej(fail(looksHeif ? '고효율 사진(HEIF)은 브라우저가 못 읽어요. 카메라 설정에서 "고효율 사진"을 끄고 다시 찍거나, 갤러리에서 JPG로 변환해 주세요' : '이 파일은 사진으로 열 수 없어요')); };
        im.src = url;
      });
      w = src.naturalWidth; h = src.naturalHeight;
    }
    if (!w || !h) throw fail('사진 크기를 읽을 수 없어요');
    const s = Math.min(1, maxSide / Math.max(w, h)), cw = Math.round(w * s), ch = Math.round(h * s);
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(src, 0, 0, cw, ch);
    if (bmp && bmp.close) bmp.close();
    return c;
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

  // JPEG의 EXIF에서 위치 정보(GPS)가 있는지, 있으면 위도·경도를 읽는다(표시용. 내보낼 때는 지워짐). 촬영 정보 유무도.
  async function scanExif(file) {
    const out = { gps: false, exif: false, lat: null, lon: null };
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
          const rat = (p) => { const n = u32(p), d = u32(p + 4); return d ? n / d : 0; };
          const ifd0 = t + u32(t + 4); const n = u16(ifd0); out.exif = n > 0;
          let gpsOff = 0;
          for (let i = 0; i < n; i++) { const e = ifd0 + 2 + i * 12; if (u16(e) === 0x8825) gpsOff = t + u32(e + 8); }
          if (gpsOff && gpsOff + 2 < v.byteLength) {
            out.gps = true;
            const g = {}; const gn = u16(gpsOff);
            for (let i = 0; i < gn && gpsOff + 2 + i * 12 + 12 <= v.byteLength; i++) {
              const e = gpsOff + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
              if (type === 2 && cnt <= 4) g[tag] = String.fromCharCode(v.getUint8(e + 8));           // N/S/E/W
              else if (type === 5 && cnt === 3) { const p = t + u32(e + 8); if (p + 24 <= v.byteLength) g[tag] = rat(p) + rat(p + 8) / 60 + rat(p + 16) / 3600; }
            }
            if (typeof g[2] === 'number' && typeof g[4] === 'number') { out.lat = (g[1] === 'S' ? -1 : 1) * g[2]; out.lon = (g[3] === 'W' ? -1 : 1) * g[4]; }
          }
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
    boxes: [], exif: null, ocr: null, out: null, outBlob: null, tagPos: 'corner', step: 1, hideStyle: 'mosaic',

    init() {
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      $('btn-start-protect').addEventListener('click', () => { track('protect_pick_open'); $('file-protect').click(); });
      $('file-protect').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; const s = await snapshotFile(f); if (s) this.start(s); });
      $('btn-back-protect').addEventListener('click', () => this.leave());
      $('btn-restart').addEventListener('click', () => { track('protect_restart'); $('file-protect').click(); });

      $('btn-brush').addEventListener('click', () => this.setBrush(!this.brushOn));
      $('btn-rect').addEventListener('click', () => this.setRect(!this.rectOn));
      document.querySelectorAll('#brush-row [data-size]').forEach((b) => b.addEventListener('click', () => {
        document.querySelectorAll('#brush-row [data-size]').forEach((x) => x.classList.toggle('is-on', x === b)); this.brushSize = b.dataset.size;
      }));
      $('btn-undo').addEventListener('click', () => this.doUndo());
      $('ocr-banner-close').addEventListener('click', () => this.banner(''));
      document.querySelectorAll('#hide-style [data-style]').forEach((b) => b.addEventListener('click', () => {
        document.querySelectorAll('#hide-style [data-style]').forEach((x) => x.classList.toggle('is-on', x === b)); this.hideStyle = b.dataset.style; track('hide_style', { style: this.hideStyle });
        if (this.brushOn) this.hint(this.hideStyle.startsWith('sticker:') ? '원하는 곳을 톡 누르면 스티커가 붙어요. 누른 채 끌면 자리를 잡을 수 있어요.' : '손가락으로 문지르면 가려져요.');
      }));
      $('btn-ocr').addEventListener('click', () => this.runOcr());
      $('btn-face').addEventListener('click', () => this.runFace());
      $('btn-hide-all').addEventListener('click', () => { const n = this.boxes.length; this.boxes.slice().forEach((b) => this.hideBox(b)); track('hide_all', { count: n }); });

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
      $('sw-story').addEventListener('click', (e) => this.toggle(e.currentTarget));
      document.querySelectorAll('[data-tagpos]').forEach((b) => b.addEventListener('click', () => {
        document.querySelectorAll('[data-tagpos]').forEach((x) => x.classList.toggle('is-on', x === b)); this.tagPos = b.dataset.tagpos;
      }));
      $('btn-do-stamp').addEventListener('click', () => this.finish());
      $('btn-save').addEventListener('click', () => this.save());
      $('btn-share-photo').addEventListener('click', () => this.sharePhoto());
    },
    toggle(btn) { btn.setAttribute('aria-checked', btn.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); if (btn.id === 'sw-stamp') this.renderStampNote(); },
    renderStampNote() {
      const on = this.on('sw-stamp'), n = $('stamp-note'); n.hidden = !on;
      n.textContent = `열쇠 ${Key.code().slice(0, 4)}****로 사진 전체에 숨겨요. 눈에는 안 보이고, 잘라 가거나 캡처해도 남아요. 같은 열쇠로만 찾을 수 있으니 백업 코드를 적어 두세요.`;
    },
    renderTagPresets() {
      const box = $('tag-presets'), list = Tags.list(); box.innerHTML = ''; box.hidden = list.length === 0;
      list.forEach((t) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'tag-chip' + ($('tag-text').value === t ? ' is-on' : ''); b.textContent = t;
        b.addEventListener('click', () => { $('tag-text').value = t; box.querySelectorAll('.tag-chip').forEach((x) => x.classList.toggle('is-on', x === b)); track('tag_preset_pick'); }); box.appendChild(b); });
    },
    on(id) { return $(id).getAttribute('aria-checked') === 'true'; },

    async start(file) {
      show('view-protect'); this.goStep(1);
      $('stage-busy').hidden = false; $('stage-busy').textContent = '사진을 여는 중…';
      this.undo = []; this.boxes = []; this.clearBoxes(); this.setBrush(false); this.setRect(false); this.banner(''); $('hide-style').hidden = false; this.faceBusy = false; $('btn-undo').disabled = true; $('ocr-note').hidden = true; $('btn-hide-all').hidden = true;
      try {
        const [c, exif] = await Promise.all([loadImage(file, MAX_EDIT), scanExif(file)]);
        this.src = c; this.exif = exif;
        this.canvas.width = c.width; this.canvas.height = c.height; this.ctx.drawImage(c, 0, 0);
        const chips = [];
        if (exif.gps) {
          const pos = exif.lat !== null ? ` · ${exif.lat >= 0 ? '북위' : '남위'} ${Math.abs(exif.lat).toFixed(4)}, ${exif.lon >= 0 ? '동경' : '서경'} ${Math.abs(exif.lon).toFixed(4)}` : '';
          chips.push(`<span class="info-chip info-chip--warn">촬영 위치가 들어 있어요${pos} → 내보낼 때 지워요</span>`);
          this.hint('이 사진엔 찍은 장소 좌표가 들어 있어요. 집·회사·아이 학교 근처라면 특히 조심하세요. Seal이 지워 드려요.');
        } else chips.push('<span class="info-chip info-chip--ok">위치 정보 없음 (폰이 미리 지웠을 수 있어요)</span>');
        if (exif.exif) chips.push('<span class="info-chip">촬영 정보(기종·시각) → 지워요</span>');
        chips.push(`<span class="info-chip">${c.width}×${c.height}</span>`);
        $('exif-chips').innerHTML = chips.join('');
        if (!exif.gps) this.hint('번호판·문패가 보이면 "손으로 가리기"를 켜고 문질러 주세요');
        track('protect_start', { gps: exif.gps, mp: Math.round(c.width * c.height / 1e5) / 10 });
      } catch (err) {
        App.showToast(err.message || '사진을 열 수 없어요', { duration: 3500 }); show('view-home');
      }
      $('stage-busy').hidden = true;
    },
    leave() { show('view-home'); this.src = null; this.out = null; this.outBlob = null; this.canvas.width = this.canvas.height = 1; },
    banner(title, sub) { const b = $('ocr-banner'); $('ocr-banner-title').textContent = title; $('ocr-banner-sub').textContent = sub || ''; b.hidden = !title; },
    hint(text) { const h = $('stage-hint'); h.textContent = text || ''; h.hidden = !text; clearTimeout(this.hintTimer); if (text) this.hintTimer = setTimeout(() => { h.hidden = true; }, 3500); },

    goStep(n) {
      this.step = n;
      document.querySelectorAll('.step').forEach((s) => { const k = +s.dataset.step; s.classList.toggle('is-on', k === n); s.classList.toggle('is-done', k < n); });
      $('panel-check').hidden = n !== 1; $('panel-stamp').hidden = n !== 2; $('panel-export').hidden = n !== 3;
      if (n !== 1) { this.setBrush(false); this.setRect(false); this.clearBoxes(); this.banner(''); } $('hide-style').hidden = n !== 1;
      if (n === 2) { track('protect_step_stamp'); this.renderStampNote(); this.renderTagPresets(); }
      window.scrollTo({ top: 0 });
    },

    // ── 화면 좌표 ↔ 사진 좌표 (object-fit: contain 고려)
    map(e) {
      const r = this.canvas.getBoundingClientRect(), W = this.canvas.width, H = this.canvas.height;
      const s = Math.min(r.width / W, r.height / H), ox = (r.width - W * s) / 2, oy = (r.height - H * s) / 2;
      return { x: (e.clientX - r.left - ox) / s, y: (e.clientY - r.top - oy) / s, s, ox: r.left - $('stage').getBoundingClientRect().left + ox, oy: r.top - $('stage').getBoundingClientRect().top + oy };
    },

    // ── 손으로 가리기: 방식(모자이크·흐림)은 문지르기, 스티커는 탭해서 붙이기(끌어서 자리 잡기)
    setBrush(on) {
      this.brushOn = on; if (on) this.setRect(false);
      $('btn-brush').classList.toggle('is-on', on); $('stage').classList.toggle('is-brush', on); $('brush-row').hidden = !on;
      if (on) this.hint(this.hideStyle.startsWith('sticker:') ? '원하는 곳을 톡 누르면 스티커가 붙어요. 누른 채 끌면 자리를 잡을 수 있어요.' : '손가락으로 문지르면 가려져요. 다 했으면 다시 눌러 꺼요.');
    },
    // ── 네모 그리기: 손가락으로 네모를 그리면 가릴 영역이 생김(옮기기·크기 조절 가능)
    setRect(on) {
      this.rectOn = on; if (on) this.setBrush(false);
      $('btn-rect').classList.toggle('is-on', on); $('stage').classList.toggle('is-brush', on || this.brushOn);
      if (on) this.hint('가리고 싶은 곳에 손가락으로 네모를 그려 주세요. 그린 네모를 누르면 가려져요.');
    },
    radius() { const base = Math.max(this.canvas.width, this.canvas.height) / 40; return base * ({ s: 0.6, m: 1, l: 1.7 })[this.brushSize]; },
    pDown(e) {
      if (this.step !== 1 || e.target.closest('.stage__box')) return;
      if (!this.brushOn && !this.rectOn) return;
      e.preventDefault(); $('stage').setPointerCapture(e.pointerId);
      const p = this.map(e); this.pStart = p; this.pLast = p;
      if (this.rectOn || this.hideStyle.startsWith('sticker:')) { this.ghost(p, p); this.drawing = 'ghost'; return; }
      this.strokeSrc = document.createElement('canvas'); this.strokeSrc.width = this.canvas.width; this.strokeSrc.height = this.canvas.height;
      this.strokeSrc.getContext('2d').drawImage(this.canvas, 0, 0);
      if (this.hideStyle === 'blur') { // 흐림 문지르기용: 미리 흐린 판
        const W = this.canvas.width, H = this.canvas.height, sm = thumbOf(this.canvas, Math.max(W, H) / 10);
        this.blurSrc = document.createElement('canvas'); this.blurSrc.width = W; this.blurSrc.height = H; const g = this.blurSrc.getContext('2d');
        g.filter = 'blur(' + Math.round(Math.max(W, H) / 120) + 'px)'; g.drawImage(sm, 0, 0, W, H); g.filter = 'none';
      }
      this.bbox = null; this.drawing = 'stroke'; this.dab(p);
    },
    pMove(e) { if (!this.drawing) return; e.preventDefault(); const p = this.map(e); this.pLast = p; if (this.drawing === 'ghost') this.ghost(this.pStart, p); else this.dab(p); },
    pUp() {
      if (!this.drawing) return; const mode = this.drawing; this.drawing = false;
      if (mode === 'ghost') {
        const g = $('ghost'); g.hidden = true; const W = this.canvas.width, H = this.canvas.height;
        if (this.rectOn) { // 네모 생성
          const x = Math.max(0, Math.min(this.pStart.x, this.pLast.x)), y = Math.max(0, Math.min(this.pStart.y, this.pLast.y));
          const w = Math.min(W - x, Math.abs(this.pLast.x - this.pStart.x)), h = Math.min(H - y, Math.abs(this.pLast.y - this.pStart.y));
          if (w < 12 || h < 12) { App.showToast('조금 더 크게 그려 주세요'); return; }
          const id = this.boxes.length ? Math.max(...this.boxes.map((b) => b.id)) + 1 : 0;
          this.boxes.push({ id, kind: 'manual', x, y, w, h }); this.renderBoxes(); $('btn-hide-all').hidden = false; track('rect_drawn');
        } else { // 스티커 붙이기
          const r = this.radius() * 1.3, cx = this.pLast.x, cy = this.pLast.y;
          const u = this.hideRect(cx - r, cy - r, r * 2, r * 2, this.hideStyle); if (u) this.pushUndo(u); track('sticker_place', { size: this.brushSize });
        }
        return;
      }
      if (this.bbox) {
        const b = this.bbox, sctx = this.strokeSrc.getContext('2d');
        this.pushUndo({ x: b.x, y: b.y, w: b.w, h: b.h, data: sctx.getImageData(b.x, b.y, b.w, b.h) });
        track('mask_stroke', { size: this.brushSize, style: this.hideStyle });
      }
      this.strokeSrc = null; this.blurSrc = null;
    },
    // 손가락을 따라다니는 미리보기(네모 또는 스티커 자리)
    ghost(p0, p1) {
      const g = $('ghost'), sc = this.boxScaleNow(); g.hidden = false;
      if (this.rectOn) { const x = Math.min(p0.x, p1.x), y = Math.min(p0.y, p1.y), w = Math.abs(p1.x - p0.x), h = Math.abs(p1.y - p0.y);
        g.className = 'stage__ghost'; g.textContent = ''; g.style.left = `${sc.ox + x * sc.s}px`; g.style.top = `${sc.oy + y * sc.s}px`; g.style.width = `${w * sc.s}px`; g.style.height = `${h * sc.s}px`; }
      else { const r = this.radius() * 1.3; g.className = 'stage__ghost stage__ghost--sticker'; g.textContent = this.hideStyle.slice(8);
        g.style.left = `${sc.ox + (p1.x - r) * sc.s}px`; g.style.top = `${sc.oy + (p1.y - r) * sc.s}px`; g.style.width = `${r * 2 * sc.s}px`; g.style.height = `${r * 2 * sc.s}px`; g.style.fontSize = `${r * 2 * sc.s * 0.98}px`; }
    },
    boxScaleNow() {
      const r = this.canvas.getBoundingClientRect(), st = $('stage').getBoundingClientRect(), W = this.canvas.width, H = this.canvas.height, s = Math.min(r.width / W, r.height / H);
      return { s, ox: r.left - st.left + (r.width - W * s) / 2, oy: r.top - st.top + (r.height - H * s) / 2 };
    },
    dab(p) {
      const r = this.radius(), W = this.canvas.width, H = this.canvas.height;
      const x0 = Math.max(0, Math.floor(p.x - r)), y0 = Math.max(0, Math.floor(p.y - r));
      const x1 = Math.min(W, Math.ceil(p.x + r)), y1 = Math.min(H, Math.ceil(p.y + r));
      if (x1 <= x0 || y1 <= y0) return;
      const ctx = this.ctx; ctx.save(); ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.clip();
      if (this.blurSrc) { ctx.drawImage(this.blurSrc, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0); }
      else {
        const block = Math.max(8, Math.round(Math.max(W, H) / 60));
        const bx0 = Math.floor(x0 / block) * block, by0 = Math.floor(y0 / block) * block;
        const bw = Math.ceil((x1 - bx0) / block), bh = Math.ceil((y1 - by0) / block);
        const tmp = this.tmp || (this.tmp = document.createElement('canvas')); tmp.width = bw; tmp.height = bh;
        const tg = tmp.getContext('2d'); tg.imageSmoothingEnabled = true;
        tg.drawImage(this.strokeSrc, bx0, by0, bw * block, bh * block, 0, 0, bw, bh);
        ctx.imageSmoothingEnabled = false; ctx.drawImage(tmp, 0, 0, bw, bh, bx0, by0, bw * block, bh * block);
      }
      ctx.restore(); ctx.imageSmoothingEnabled = true;
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
    hideRect(x, y, w, h, style) {
      const W = this.canvas.width, H = this.canvas.height;
      x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y)); w = Math.min(W - x, Math.ceil(w)); h = Math.min(H - y, Math.ceil(h));
      if (w <= 0 || h <= 0) return null;
      const before = this.ctx.getImageData(x, y, w, h);
      if (style === 'blur') { // 흐림: 작게 줄였다 키움
        const tmp = document.createElement('canvas'); tmp.width = Math.max(2, Math.ceil(w / 14)); tmp.height = Math.max(2, Math.ceil(h / 14));
        tmp.getContext('2d').drawImage(this.canvas, x, y, w, h, 0, 0, tmp.width, tmp.height);
        this.ctx.save(); this.ctx.beginPath(); this.ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); this.ctx.clip();
        this.ctx.imageSmoothingEnabled = true; this.ctx.filter = 'blur(' + Math.round(Math.max(w, h) / 40) + 'px)'; this.ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x - 4, y - 4, w + 8, h + 8); this.ctx.filter = 'none'; this.ctx.restore();
        return { x, y, w, h, data: before };
      }
      if (style && style.startsWith('sticker:')) { // 스티커: 폰 글꼴의 이모지를 네모 안에 꽉 차게 (되돌리기 영역은 네모보다 조금 넉넉히)
        const em = style.slice(8), size = Math.round(Math.min(w, h) * 0.98);
        const cx = x + w / 2, cy = y + h / 2; const px = Math.round(size * 0.15);
        x = Math.max(0, x - px); y = Math.max(0, y - px); w = Math.min(W - x, w + px * 2); h = Math.min(H - y, h + px * 2);
        const before2 = this.ctx.getImageData(x, y, w, h);
        this.ctx.save(); this.ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Samsung Color Emoji", sans-serif`;
        this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; this.ctx.fillText(em, cx, cy); this.ctx.restore();
        return { x, y, w, h, data: before2 };
      }
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
        const small = thumbOf(this.canvas, 2000), k = this.canvas.width / small.width;
        // 2회 인식: 원본 + 대비를 강하게 올린 흑백판(번호판·간판처럼 배경이 복잡한 글자용) → 합치고 겹침 제거
        const hc = document.createElement('canvas'); hc.width = small.width; hc.height = small.height; const hg = hc.getContext('2d');
        hg.filter = 'grayscale(1) contrast(1.8) brightness(1.05)'; hg.drawImage(small, 0, 0); hg.filter = 'none';
        const pick = (words) => (words || []).filter((w) => { const t = (w.text || '').trim(), digits = (t.match(/\d/g) || []).length; return (digits >= 2 && t.length >= 3 && w.confidence > 35) || (t.length >= 4 && w.confidence > 70 && /[A-Za-z]/.test(t)); });
        const r1 = await this.ocr.recognize(small); $('stage-busy').textContent = '글자를 한 번 더 찾는 중…';
        const r2 = await this.ocr.recognize(hc);
        const words = pick(r1.data.words).slice();
        pick(r2.data.words).forEach((w) => { const b = w.bbox; if (!words.some((o) => { const ob = o.bbox; const ix = Math.max(0, Math.min(b.x1, ob.x1) - Math.max(b.x0, ob.x0)), iy = Math.max(0, Math.min(b.y1, ob.y1) - Math.max(b.y0, ob.y0)); return ix * iy > 0.3 * Math.min((b.x1 - b.x0) * (b.y1 - b.y0), (ob.x1 - ob.x0) * (ob.y1 - ob.y0)); })) words.push(w); });
        const keep = this.boxes.filter((b) => b.kind === 'face'), base0 = keep.length ? Math.max(...keep.map((b) => b.id)) + 1 : 0;
        this.boxes = keep.concat(words.map((w, i) => { const b = w.bbox, pad = 6 * k; return { id: base0 + i, kind: 'text', x: b.x0 * k - pad, y: b.y0 * k - pad, w: (b.x1 - b.x0) * k + 2 * pad, h: (b.y1 - b.y0) * k + 2 * pad, text: w.text }; }));
        this.renderBoxes();
        const note = $('ocr-note'); note.hidden = true;
        const nText = this.boxes.filter((b) => b.kind === 'text').length;
        this.banner(nText ? `글자 ${nText}곳 찾음 · 네모를 눌러 가리기` : '번호판·전화번호 같은 글자를 찾지 못함',
          nText ? '작거나 비스듬한 글자, 한글은 놓칠 수 있어요. 눈으로도 확인해 주세요.' : '작거나 비스듬한 글자, 한글은 놓칠 수 있어요. 보이는 게 있으면 손으로 가려 주세요.');
        $('btn-hide-all').hidden = this.boxes.length === 0;
        track('ocr_done', { found: this.boxes.length });
      } catch (err) {
        App.showToast(err.message || '글자 찾기에 실패했어요', { duration: 4000 }); track('ocr_fail');
      }
      $('stage-busy').hidden = true; btn.disabled = false; this.ocrBusy = false;
    },
    // ── 얼굴 자동 찾기 (MediaPipe Face Detection full-range, 눌렀을 때만 약 7MB 내려받음. 기울인·돌린·먼 얼굴도 잡음)
    async runFace() {
      if (this.faceBusy) return;
      this.faceBusy = true; const btn = $('btn-face'); btn.disabled = true;
      $('stage-busy').hidden = false; $('stage-busy').textContent = '얼굴 찾기 준비 중… (처음엔 약 7MB를 내려받아요)';
      track('face_start');
      try {
        const base = new URL(cfg.FACE_BASE || 'vendor/mediapipe/', location.href).toString();
        if (!window.FaceDetection) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = base + 'face_detection.js'; s.onload = res; s.onerror = () => rej(new Error('얼굴 찾기 파일을 내려받지 못했어요. 인터넷 연결을 확인해 주세요.')); document.head.appendChild(s); });
        if (!this.fd) {
          const fd = new FaceDetection({ locateFile: (f) => base + f });
          fd.setOptions({ model: 'full', minDetectionConfidence: 0.5 });
          fd.onResults((r) => { if (this.fdResolve) { const f = this.fdResolve; this.fdResolve = null; f(r); } });
          await fd.initialize(); this.fd = fd;
        }
        $('stage-busy').textContent = '얼굴을 찾는 중…';
        const small = thumbOf(this.canvas, 1280), k = this.canvas.width / small.width, W = small.width, H = small.height;
        const r = await new Promise((res, rej) => { this.fdResolve = res; setTimeout(() => { if (this.fdResolve) { this.fdResolve = null; rej(new Error('얼굴 찾기가 응답하지 않아요. 이 브라우저에서는 지원되지 않을 수 있어요.')); } }, 20000); this.fd.send({ image: small }); });
        const faces = (r.detections || []).map((d) => { const b = d.boundingBox; return { x: (b.xCenter - b.width / 2) * W * k, y: (b.yCenter - b.height / 2) * H * k, w: b.width * W * k, h: b.height * H * k }; });
        const nextId = this.boxes.length ? Math.max(...this.boxes.map((b) => b.id)) + 1 : 0;
        this.boxes = this.boxes.filter((b) => b.kind !== 'face').concat(faces.map((f, i) => { const pad = Math.max(f.w, f.h) * 0.1; return { id: nextId + i, kind: 'face', x: f.x - pad, y: f.y - pad * 1.4, w: f.w + pad * 2, h: f.h + pad * 2.4 }; }));
        this.renderBoxes();
        this.banner(faces.length ? `얼굴 ${faces.length}곳 찾음 · 네모를 눌러 가리기 · 끌어서 옮기고 모서리로 크기 조절` : '얼굴을 찾지 못함',
          faces.length ? '가려진 얼굴은 놓칠 수 있고, 얼굴이 아닌 곳에 네모가 생길 수도 있어요(그냥 두면 돼요).' : '가려진 얼굴·아주 작은 얼굴은 놓칠 수 있어요. "네모 그리기"로 직접 가려 주세요.');
        $('btn-hide-all').hidden = this.boxes.length === 0;
        track('face_done', { found: faces.length });
      } catch (err) {
        App.showToast(err.message || '얼굴 찾기에 실패했어요', { duration: 4000 }); track('face_fail');
      }
      $('stage-busy').hidden = true; btn.disabled = false; this.faceBusy = false;
    },
    renderBoxes() {
      const layer = $('box-layer'); layer.innerHTML = '';
      if (!this.boxes.length) return;
      const r = this.canvas.getBoundingClientRect(), st = $('stage').getBoundingClientRect();
      const W = this.canvas.width, H = this.canvas.height, s = Math.min(r.width / W, r.height / H);
      const ox = r.left - st.left + (r.width - W * s) / 2, oy = r.top - st.top + (r.height - H * s) / 2;
      this.boxScale = { s, ox, oy };
      this.boxes.forEach((b) => {
        const el = document.createElement('div'); el.className = 'stage__box' + (b.kind === 'face' ? ' stage__box--face' : b.kind === 'manual' ? ' stage__box--manual' : '');
        el.setAttribute('role', 'button'); el.tabIndex = 0; el.setAttribute('aria-label', b.kind === 'face' ? '찾은 얼굴 가리기 (끌어서 옮기기)' : b.kind === 'manual' ? '그린 네모 가리기 (끌어서 옮기기)' : '찾은 글자 가리기');
        const place = () => { el.style.left = `${ox + b.x * s}px`; el.style.top = `${oy + b.y * s}px`; el.style.width = `${b.w * s}px`; el.style.height = `${b.h * s}px`; };
        place(); b._place = place;
        const handle = document.createElement('span'); handle.className = 'stage__box-handle'; handle.setAttribute('aria-hidden', 'true'); el.appendChild(handle);
        // 탭 = 가리기, 끌기 = 옮기기, 모서리 끌기 = 크기 조절
        let mode = null, sx = 0, sy = 0, bx = 0, by = 0, bw = 0, bh = 0, moved = false;
        el.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation(); ev.preventDefault(); el.setPointerCapture(ev.pointerId);
          mode = ev.target === handle ? 'resize' : 'move'; sx = ev.clientX; sy = ev.clientY; bx = b.x; by = b.y; bw = b.w; bh = b.h; moved = false;
        });
        el.addEventListener('pointermove', (ev) => {
          if (!mode) return; const dx = (ev.clientX - sx) / s, dy = (ev.clientY - sy) / s;
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) moved = true;
          if (mode === 'move') { b.x = Math.min(W - b.w, Math.max(0, bx + dx)); b.y = Math.min(H - b.h, Math.max(0, by + dy)); }
          else { b.w = Math.max(24, Math.min(W - b.x, bw + dx)); b.h = Math.max(24, Math.min(H - b.y, bh + dy)); }
          place();
        });
        const end = (ev) => { if (!mode) return; const m = mode; mode = null; try { el.releasePointerCapture(ev.pointerId); } catch (_) {}
          if (!moved) { this.hideBox(b); track(b.kind + '_hide_one'); } else track('box_adjust', { mode: m, kind: b.kind }); };
        el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
        el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.hideBox(b); } });
        layer.appendChild(el);
      });
    },
    hideBox(b) {
      const u = this.hideRect(b.x, b.y, b.w, b.h, b.kind === 'text' ? 'mosaic' : this.hideStyle);
      this.boxes = this.boxes.filter((x) => x !== b);
      if (u) { u.box = b; this.pushUndo(u); }
      this.renderBoxes(); $('btn-hide-all').hidden = this.boxes.length === 0;
    },
    clearBoxes() { this.boxes = []; $('box-layer').innerHTML = ''; $('btn-hide-all').hidden = true; },

    // ── 도장 찍고 내보내기
    async finish() {
      if (!this.src) return;
      const useStamp = this.on('sw-stamp'), useTag = this.on('sw-tag'), useResize = this.on('sw-resize'), useStory = this.on('sw-story');
      const tagText = ($('tag-text').value || '').trim();
      if (useTag && !tagText) { $('tag-text').focus(); App.showToast('이름표에 넣을 글자를 적어 주세요'); return; }
      $('btn-do-stamp').disabled = true; $('stage-busy').hidden = false; $('stage-busy').textContent = '도장을 심는 중…';
      try {
        let out = this.canvas;
        if (useStory) out = this.toStory(out);
        else if (useResize && Math.max(out.width, out.height) > 2048) out = thumbOf(out, 2048);
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
          `<li>${useStory ? '스토리 규격(1080×1920)으로 맞췄어요 · ' : ''}${out.width}×${out.height} · ${Math.round(this.outBlob.size / 1024)}KB</li>`,
        ];
        if (useTag) Tags.remember(tagText);
        if (useStamp) {
          const th = thumbOf(out, 320);
          const gp = grayPlane(out, 48);
          const mid = await toBlob(thumbOf(out, 1280), 0.82); // 큰 파일이 지워져도 카드에 쓸 중간본(장당 150~250KB)은 항상 남김
          const entry = { date: Date.now(), w: out.width, h: out.height, thumb: th.toDataURL('image/jpeg', 0.8), photo: this.outBlob, mid, gw: gp.w, gh: gp.h, gray: gp.g, keyCode: Key.code(), tag: useTag ? { text: tagText, pos: this.tagPos } : null };
          let note = '도장 장부에 사진과 날짜를 보관했어요 (이 폰에만)';
          try { await Ledger.add(entry); }
          catch (_) { entry.photo = null; entry.photoDropped = true; try { await Ledger.add(entry); } catch (_) { entry.mid = null; try { await Ledger.add(entry); } catch (_) {} } note = '폰 저장 공간이 부족해 장부에는 중간 크기 사진과 날짜만 남겼어요'; }
          const dropped = await Ledger.prune(LEDGER_MAX, ledgerLimit());
          if (dropped) note += ` · 한도(${ledgerLimit()}MB)를 넘어 오래된 사진 ${dropped}장은 중간 크기만 남겼어요`;
          items.push(`<li>${note}</li>`);
        }
        $('done-list').innerHTML = items.join('');
        this.goStep(3);
        track('protect_done', { stamp: useStamp, tag: useTag, tagpos: useTag ? this.tagPos : 'none', resize: useResize, story: useStory, masked: this.undo.length > 0 });
      } catch (err) {
        App.showToast('처리에 실패했어요: ' + (err.message || err), { duration: 4000 }); track('protect_fail');
      }
      $('stage-busy').hidden = true; $('btn-do-stamp').disabled = false;
    },
    // 스토리 규격: 1080×1920 세로 캔버스, 배경은 사진을 크게 늘려 흐리게, 그 위에 사진을 꽉 차게(contain)
    toStory(src) {
      const W = 1080, H = 1920, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
      const cover = Math.max(W / src.width, H / src.height), cw = src.width * cover, ch = src.height * cover;
      const small = thumbOf(src, 64); g.filter = 'blur(28px)'; g.drawImage(small, (W - cw) / 2 - 40, (H - ch) / 2 - 40, cw + 80, ch + 80); g.filter = 'none';
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, 0, W, H);
      const fitS = Math.min(W / src.width, H / src.height), fw = src.width * fitS, fh = src.height * fitS;
      g.drawImage(src, (W - fw) / 2, (H - fh) / 2, fw, fh);
      return c;
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
      $('file-verify').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; $('verify-result').hidden = true; $('verify-intro').hidden = true; $('verify-run').hidden = false; $('verify-status').textContent = '사진을 읽는 중…'; const s = await snapshotFile(f); if (s) this.run(s); else this.reset(); });
      $('btn-back-verify').addEventListener('click', () => show('view-home'));
      $('btn-make-card').addEventListener('click', () => this.makeCard());
      $('btn-pick-ledger').addEventListener('click', () => this.openPicker());
      $('btn-pick-gallery').addEventListener('click', () => $('file-mine').click());
      $('file-mine').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; const s = await snapshotFile(f); if (s) this.takeMine(s); });
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
        if (best && best.c > MATCH_TH && best.margin > 0.04) this.setMatched(best.e, '비슷해 보여요 (자동, 참고용)');
      }
      $('btn-pick-ledger').hidden = z < TH_WEAK; $('gallery-row').hidden = z < TH_WEAK || !!(this.matched && (this.matched.photo || this.matched.mid)); $('gallery-msg').hidden = true;
      $('btn-make-card').hidden = z < TH_WEAK;
      $('verify-run').hidden = true; $('verify-result').hidden = false; window.scrollTo({ top: 0 });
    },

    // 장부에 큰 사진이 없을 때: 갤러리의 도장 찍은 사진을 넣으면 같은 열쇠 도장이 있는지 확인한 뒤 카드에 쓴다
    async takeMine(file) {
      $('gallery-msg').hidden = false; $('gallery-msg').textContent = '이 사진에 내 도장이 있는지 확인하는 중…';
      try {
        const full = await loadImage(file, MAX_EDIT), c = thumbOf(full, MAX_FIND);
        const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data, pl = SealCore.planesOf(d, c.width, c.height);
        const r = await Worker_.run({ type: 'detect', planes: pl.map((p) => p.buffer), w: c.width, h: c.height, keys: [Key.value], opt: {} }, pl.map((p) => p.buffer), (p) => { $('gallery-msg').textContent = `이 사진에 내 도장이 있는지 확인하는 중… ${Math.round(p * 100)}%`; });
        if (r.z[0] < TH_WEAK) { $('gallery-msg').textContent = `이 사진에서는 내 도장을 찾지 못했어요(점수 ${r.z[0].toFixed(1)}). Seal로 도장 찍어 저장한 사진을 골라 주세요.`; track('gallery_mine_reject'); return; }
        const blob = await toBlob(full, 0.9), th = thumbOf(full, 320);
        const e = Object.assign({}, this.matched || {}, { photo: blob, thumb: th.toDataURL('image/jpeg', 0.8), fromGallery: true, galleryScore: r.z[0] });
        if (!e.date) e.date = file.lastModified || Date.now();
        if (e.id) { try { await Ledger.put(e); } catch (_) {} } // 장부 기록에 큰 사진을 다시 채워 넣음
        this.setMatched(e, 'gallery'); $('gallery-msg').textContent = `내 도장 확인(점수 ${r.z[0].toFixed(1)}). 이 사진을 카드에 써요.`; track('gallery_mine_ok');
      } catch (err) { $('gallery-msg').textContent = '사진을 열지 못했어요: ' + (err.message || err); }
    },
    setMatched(e, how) {
      this.matched = e; $('match').hidden = !e; $('gallery-row').hidden = !!(e && (e.photo || e.mid));
      if (!e) return;
      $('match-img').src = e.thumb; $('match-title').textContent = how === 'manual' ? '내가 고른 사진' : how === 'gallery' ? '갤러리에서 가져온 내 사진' : '이 사진 같아요';
      $('match-sub').textContent = `${fmtDate(new Date(e.date))}에 도장을 찍은 사진${how === 'manual' || how === 'gallery' ? '' : ' · ' + how}${e.photo ? '' : e.mid ? ' · 중간 크기 사진(1280px)으로 카드에 넣어요' : ' · 큰 사진은 장부에 없음(축소본만)'}`;
      if (this.cardBlob) { $('card-wrap').hidden = true; this.cardBlob = null; }
    },
    async openPicker() {
      const all = (await Ledger.all()).reverse(), grid = $('ledger-grid'); grid.innerHTML = '';
      if (!all.length) { App.showToast('장부에 보관된 사진이 없어요. 이 폰에서 도장을 찍은 사진만 나와요.', { duration: 3500 }); return; }
      all.forEach((e) => { const b = document.createElement('button'); b.type = 'button'; b.className = this.matched && this.matched.id === e.id ? 'is-on' : '';
        b.innerHTML = `<div class="ledger-grid__img"><img alt=""></div><small>${fmtDate(new Date(e.date))}</small>`; b.querySelector('img').src = e.thumb;
        b.addEventListener('click', () => { this.setMatched(e, 'manual'); App.closeSheet($('ledger-sheet')); track('ledger_pick_manual'); }); grid.appendChild(b); });
      track('ledger_pick_open'); App.openSheet($('ledger-sheet'));
    },

    // 신고 카드: 캡처 · 내 사진(장부) · 드러낸 도장 · 점수 · 날짜
    async makeCard() {
      const { z, p, flipped } = this.result, c = $('card-canvas'), g = c.getContext('2d'), W = 1080, H = 1920, M = 48, IW = W - 2 * M;
      const F = '-apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif', ROSE = '#B04A62', INK = '#2B2628', MUTED = '#7D7175', TINT = '#FBE9E8';
      const fit = (img, x, y, w, h) => { const s = Math.min(w / img.width, h / img.height), dw = img.width * s, dh = img.height * s, dx = x + (w - dw) / 2, dy = y + (h - dh) / 2; g.drawImage(img, dx, dy, dw, dh); return { x: dx, y: dy, w: dw, h: dh, s }; };
      const label = (t, x, y) => { g.fillStyle = INK; g.font = `800 30px ${F}`; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText(t, x, y); };
      const sub = (t, x, y, size = 24, color = MUTED) => { g.fillStyle = color; g.font = `500 ${size}px ${F}`; g.fillText(t, x, y); };
      g.fillStyle = '#FDF8F3'; g.fillRect(0, 0, W, H);
      // 머리
      g.fillStyle = ROSE; g.fillRect(0, 0, W, 170);
      g.fillStyle = '#fff'; g.font = `800 50px ${F}`; g.textBaseline = 'middle'; g.fillText('Seal 확인 결과', M, 70);
      g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = `500 26px ${F}`; g.fillText(`확인 시각 ${fmtDate(new Date())}  ·  열쇠 ${Key.code().slice(0, 4)}****  ·  pebbleitgo.com/seal`, M, 124);
      // 판정 띠
      g.fillStyle = z >= TH_SURE ? ROSE : '#8A6A1F'; g.font = `800 46px ${F}`; g.textBaseline = 'alphabetic';
      g.fillText(z >= TH_SURE ? `일치 점수 ${z.toFixed(1)} — 내 도장이 있음` : `일치 점수 ${z.toFixed(1)} — 도장이 약하게 보임`, M, 250);
      sub(`점수 9 이상 확실 · 7.5~9 약함 · 도장 없는 사진 5,670회 대조에서 7.5 초과 0건${flipped ? ' · 좌우 반전 상태로 발견' : ''}`, M, 292, 22);
      // 1행: 캡처 / 내 사진
      const colW = (IW - 32) / 2, top = 360, boxH = 640;
      label('① 의심 계정 캡처', M, top - 16); label('② 내 사진 (도장 장부)', M + colW + 32, top - 16);
      g.fillStyle = TINT; g.fillRect(M, top, colW, boxH); g.fillRect(M + colW + 32, top, colW, boxH);
      fit(this.suspect, M, top, colW, boxH);
      let mine = null;
      if (this.matched) {
        mine = (this.matched.photo && await blobToImage(this.matched.photo)) || (this.matched.mid && await blobToImage(this.matched.mid)) || await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = this.matched.thumb; });
        if (mine) {
          const r = fit(mine, M + colW + 32, top, colW, boxH);
          if (this.matched.tag) { // 이름표 위치를 색 테두리로 표시
            const t = this.matched.tag, base = Math.min(mine.width, mine.height);
            let bx, by, bw, bh;
            if (t.pos === 'corner') { const fs = Math.max(14, Math.round(base * 0.032)); bw = Math.min(mine.width * 0.6, fs * (t.text.length * 0.75 + 2)); bh = fs * 1.8; bx = mine.width - fs * 0.9 - bw; by = mine.height - fs * 0.7 - bh; }
            else { const fs = Math.max(20, Math.round(base * 0.075)); bw = Math.min(mine.width * 0.9, fs * (t.text.length * 0.75 + 1)); bh = fs * 2.2; bx = mine.width / 2 - bw / 2; by = mine.height / 2 - bh / 2; }
            g.strokeStyle = '#E0345B'; g.lineWidth = 6; g.strokeRect(r.x + bx * r.s, r.y + by * r.s, bw * r.s, bh * r.s);
            g.fillStyle = '#E0345B'; g.font = `800 22px ${F}`; g.fillText(`이름표 "${t.text}"`, r.x + bx * r.s, r.y + by * r.s - 8);
          }
        }
        sub(`도장 찍은 날짜 ${fmtDate(new Date(this.matched.date))}${this.matched.fromGallery ? ` · 갤러리 사진, 도장 확인 점수 ${this.matched.galleryScore.toFixed(1)}` : this.matched.photo ? '' : this.matched.mid ? ' · 장부 보관본(1280px)' : ' · 축소본'}`, M + colW + 32, top + boxH + 34, 22, INK);
      } else {
        g.fillStyle = MUTED; g.font = `500 26px ${F}`; g.textAlign = 'center';
        g.fillText('장부에 같은 사진이 없어요', M + colW + 32 + colW / 2, top + boxH / 2 - 12); g.fillText('(다른 폰에서 찍었거나 장부를 비움)', M + colW + 32 + colW / 2, top + boxH / 2 + 28); g.textAlign = 'left';
      }
      // 2행: 드러낸 도장 (로즈색으로 진하게) + 열쇠 무늬 기준
      const ry = top + boxH + 100, rh = 560, revW = IW - 272;
      label('③ 캡처 속 숨은 도장을 드러낸 모습', M, ry - 16);
      const tsize = Math.max(16, Math.round(p)), tile = SealCore.tilePreview(Key.value, 64), tc = document.createElement('canvas'); tc.width = tc.height = 64;
      const tid = tc.getContext('2d').createImageData(64, 64);
      for (let i = 0; i < 4096; i++) { const v = Math.max(0, Math.min(1, 0.5 + tile[i] * 0.45)); tid.data[i * 4] = 224; tid.data[i * 4 + 1] = 52; tid.data[i * 4 + 2] = 91; tid.data[i * 4 + 3] = Math.round(v * v * 235); }
      tc.getContext('2d').putImageData(tid, 0, 0);
      const rev = document.createElement('canvas'); rev.width = this.suspect.width; rev.height = this.suspect.height; const rg = rev.getContext('2d'); rg.drawImage(this.suspect, 0, 0);
      rg.globalAlpha = 0.35; rg.fillStyle = '#fff'; rg.fillRect(0, 0, rev.width, rev.height); rg.globalAlpha = 1;
      for (let y = 0; y < rev.height; y += tsize) for (let x = 0; x < rev.width; x += tsize) rg.drawImage(tc, x, y, tsize, tsize);
      g.fillStyle = TINT; g.fillRect(M, ry, revW, rh); const rr = fit(rev, M, ry, revW, rh);
      // 확대 한 칸 + 열쇠 무늬
      const sx = M + revW + 32, sw = IW - revW - 32;
      g.fillStyle = TINT; g.fillRect(sx, ry, sw, sw);
      const cx = Math.floor(rev.width / 2 / tsize) * tsize, cy = Math.floor(rev.height / 2 / tsize) * tsize;
      g.drawImage(rev, cx, cy, tsize * 2, tsize * 2, sx, ry, sw, sw); g.strokeStyle = ROSE; g.lineWidth = 3; g.strokeRect(sx, ry, sw, sw);
      sub('가운데 확대 (도장 2×2칸)', sx, ry + sw + 28, 20);
      const ky = ry + sw + 50; g.fillStyle = '#fff'; g.fillRect(sx, ky, sw, sw);
      const kc = document.createElement('canvas'); kc.width = kc.height = 64; const kid = kc.getContext('2d').createImageData(64, 64);
      for (let i = 0; i < 4096; i++) { const v = Math.max(0, Math.min(255, 128 + tile[i] * 70)); kid.data[i * 4] = v; kid.data[i * 4 + 1] = v; kid.data[i * 4 + 2] = v; kid.data[i * 4 + 3] = 255; }
      kc.getContext('2d').putImageData(kid, 0, 0); g.imageSmoothingEnabled = true; g.drawImage(kc, 0, 0, 64, 64, sx, ky, sw, sw); g.strokeRect(sx, ky, sw, sw);
      sub('이 열쇠의 도장 무늬 (기준)', sx, ky + sw + 28, 20);
      // 확대 영역 표시
      g.strokeStyle = ROSE; g.lineWidth = 4; g.strokeRect(rr.x + cx * rr.s, rr.y + cy * rr.s, tsize * 2 * rr.s, tsize * 2 * rr.s);
      sub(`도장 한 칸 약 ${tsize}px · 사진 전체에 바둑판처럼 반복 · 색은 Seal이 보이게 입힌 것`, M, ry + rh + 34, 22);
      // 바닥
      g.fillStyle = TINT; g.fillRect(0, H - 150, W, 150);
      sub('이 카드는 신고할 때 붙이는 참고 자료이며 법적 증거가 아닙니다.', M, H - 92, 24, INK);
      sub('도장은 사진 자체에는 보이지 않으며, 같은 열쇠로만 찾을 수 있습니다. Seal · pebbleitgo.com/seal', M, H - 54, 22);
      $('card-wrap').hidden = false; this.cardBlob = await toBlob(c, 0.9);
      track('card_made', { matched: !!this.matched, tag: !!(this.matched && this.matched.tag) }); c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  };

  // =================================================================
  // 설정 시트 · 사용법 · 헤더
  // =================================================================
  function renderKey() { $('key-code').textContent = Key.code(); }
  async function renderLedgerInfo() {
    const u = await Ledger.usage(), lim = ledgerLimit();
    document.querySelectorAll('[data-ledger-mb]').forEach((b) => b.classList.toggle('is-on', +b.dataset.ledgerMb === lim));
    $('ledger-info').textContent = u.count
      ? `기록 ${u.count}장(중간 크기 보관본 ${(u.midBytes / 1048576).toFixed(1)}MB) · 그중 원본 크기 사진 ${u.photos}장(${(u.bytes / 1048576).toFixed(1)}MB / 한도 ${lim}MB). 한도를 넘으면 오래된 사진의 원본 크기만 지우고 날짜·중간 크기(1280px)는 남아 카드에 쓸 수 있어요.`
      : `아직 도장 찍은 사진이 없어요. 도장을 찍으면 사진과 날짜를 이 폰에 보관해요(원본 크기는 ${lim}MB까지, 중간 크기·날짜는 ${LEDGER_MAX}장까지).`;
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
    $('btn-ledger-drop').addEventListener('click', async () => { await Ledger.dropPhotos(); await renderLedgerInfo(); App.showToast('큰 사진만 비웠어요. 날짜와 축소본은 남아 있어요.'); track('ledger_drop_photos'); });
    document.querySelectorAll('[data-ledger-mb]').forEach((b) => b.addEventListener('click', async () => { try { localStorage.setItem('seal:ledgerMB', b.dataset.ledgerMb); } catch (_) {} const d = await Ledger.prune(LEDGER_MAX, ledgerLimit()); await renderLedgerInfo(); if (d) App.showToast(`한도에 맞춰 오래된 사진 ${d}장은 축소본만 남겼어요.`); track('ledger_limit_set', { mb: +b.dataset.ledgerMb }); }));
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
