'use strict';

/**
 * Billbox 글자 읽기 — Tesseract.js(한글+영문), 전부 폰 안에서. 사진은 기기 밖으로 안 나감.
 *
 * v1.1.2 안정화 (대표 피드백: "어떨 땐 준비 안 됐다고 못 읽고 어떨 땐 됨")
 * 원인 3가지를 고쳤다.
 *  1) 엔진을 외부 CDN(jsDelivr)에서 매번 받았다 → 폰 인터넷이 잠깐 느리면 실패.
 *     → 엔진·사전을 우리 사이트(billbox/vendor/)에 두고, 한 번 받으면 폰에 저장(서비스워커 + 브라우저 저장소).
 *  2) 미리 받기(warmup)가 끝나면 엔진을 내리는데, 그 사이 사용자가 찍으면 읽는 도중에 엔진이 꺼졌다(경쟁 버그).
 *     → "사용 중" 표시(lease)를 두고, 쓰는 사람이 없을 때만 내린다.
 *  3) 준비 확인 요청이 404가 아닌 오류(일시 403·429 등)에도 실패로 처리했다.
 *     → 우리 사이트 파일이라 확인 요청 자체를 없앰. 실패하면 자동으로 한 번 더 시도.
 * - 메모리: 다 읽고 45초 동안 안 쓰면 내린다(연달아 찍을 땐 바로 읽게). 사진 고르러 다른 앱 갈 때도 내린다.
 */
window.BillboxOCR = (function () {
  const cfg = () => (window.BILLBOX_CONFIG && window.BILLBOX_CONFIG.OCR) || {};
  const abs = (p) => new URL(p, location.href).toString().replace(/\/$/, '');
  let worker = null;
  let lastFocus = null; // 시험용: 마지막 자동 콕 찍기 결과
  let timing = null;
  let loading = null;
  let users = 0; // 지금 엔진을 쓰는 중인 작업 수
  let idleTimer = null;
  let state = 'idle'; // idle | loading | ready | error
  let stateMsg = '';
  let stateProgress = 0;
  const listeners = [];
  const IDLE_MS = 45000;
  const READY_TIMEOUT = 120000;

  function setState(st, msg, prog) {
    state = st;
    if (msg != null) stateMsg = msg;
    if (prog != null) stateProgress = prog;
    listeners.forEach((fn) => {
      try {
        fn({ state, msg: stateMsg, progress: stateProgress });
      } catch (_) {}
    });
  }
  function onState(fn) {
    listeners.push(fn);
    fn({ state, msg: stateMsg, progress: stateProgress });
  }
  let progressSink = null; // 지금 찍는 화면의 진행 표시

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('읽기 엔진 파일을 못 받았어요'));
      document.head.appendChild(s);
    });
  }

  async function createOnce() {
    const c = cfg();
    const report = (p, msg) => {
      setState('loading', msg, p);
      progressSink && progressSink(0.05 + p * 0.3, msg);
    };
    report(0.02, '읽기 도구를 준비하고 있어요');
    await loadScript(abs(c.SCRIPT));
    let timedOut = false;
    const make = window.Tesseract.createWorker(['kor', 'eng'], 1, {
      workerPath: abs(c.WORKER),
      corePath: abs(c.CORE),
      langPath: abs(c.LANG_PATH),
      gzip: true,
      logger: (m) => {
        if (m.status === 'loading tesseract core') report(0.05 + (m.progress || 0) * 0.3, '읽기 엔진을 준비하고 있어요');
        else if (m.status === 'loading language traineddata') report(0.4 + (m.progress || 0) * 0.5, isCached() ? '한글 사전을 불러오는 중' : '한글 사전을 내려받고 있어요 (처음 한 번만)');
        else if (m.status === 'initializing api') report(0.95, '거의 준비됐어요');
      },
      errorHandler: (err) => console.warn('[Billbox OCR]', err),
    });
    const timeout = new Promise((_, rej) =>
      setTimeout(() => {
        timedOut = true;
        rej(new Error('준비가 너무 오래 걸려요'));
      }, READY_TIMEOUT)
    );
    // 늦게라도 만들어진 엔진은 꺼서 메모리를 비움
    make.then((w) => timedOut && w.terminate().catch(() => {})).catch(() => {});
    const w = await Promise.race([make, timeout]);
    await w.setParameters({ preserve_interword_spaces: '1' });
    return w;
  }

  /** 엔진 준비. 실패하면 한 번 더 자동으로 시도 */
  async function ready(onProgress) {
    clearTimeout(idleTimer);
    if (onProgress) progressSink = onProgress;
    if (worker) return worker;
    if (!loading) {
      loading = (async () => {
        let lastErr;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const w = await createOnce();
            worker = w;
            try {
              localStorage.setItem('billbox:ocr-cached', cfg().REV || '1');
            } catch (_) {}
            setState('ready', '찍을 준비 됐어요', 1);
            return w;
          } catch (e) {
            lastErr = e;
            if (attempt === 1) setState('loading', '잠깐 끊겼어요. 한 번 더 시도할게요', 0.05);
          }
        }
        throw lastErr;
      })();
    }
    try {
      return await loading;
    } catch (e) {
      setState('error', `${(e && e.message) || '읽기 도구를 준비하지 못했어요'} · 인터넷을 확인하고 다시 받아 주세요`, 0);
      throw e;
    } finally {
      loading = null;
    }
  }

  /** 쓰는 사람이 없을 때만 엔진을 메모리에서 내림(사전은 폰 저장소에 남음) */
  async function release(force) {
    clearTimeout(idleTimer);
    if (users > 0 && !force) return;
    const w = worker;
    worker = null;
    if (w) {
      try {
        await w.terminate();
      } catch (_) {}
    }
  }
  function releaseLater() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => release(), IDLE_MS);
  }
  function isCached() {
    try {
      return localStorage.getItem('billbox:ocr-cached') === (cfg().REV || '1');
    } catch (_) {
      return false;
    }
  }

  /** 사진을 열 때부터 작게(1,200만 화소 사진을 그대로 풀면 50MB 가까이 메모리를 쓴다) */
  async function fileToBitmap(file, max) {
    try {
      const probe = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: 64, resizeQuality: 'low' });
      const portrait = probe.height >= probe.width;
      probe.close && probe.close();
      const full = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (Math.max(full.width, full.height) <= max) return full; // 작은 사진은 그대로(키우기는 캔버스에서)
      full.close && full.close();
      const opt = { imageOrientation: 'from-image', resizeQuality: 'medium' };
      if (portrait) opt.resizeHeight = max;
      else opt.resizeWidth = max;
      return await createImageBitmap(file, opt);
    } catch (_) {}
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('사진을 열 수 없어요'));
        img.src = URL.createObjectURL(file);
      });
    }
  }

  /** 긴 변을 max로 맞춰 캔버스에 그림 */
  function toCanvas(src, max, allowUp, quality) {
    const w = src.width || src.naturalWidth;
    const h = src.height || src.naturalHeight;
    const r = allowUp ? max / Math.max(w, h) : Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * r);
    c.height = Math.round(h * r);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = quality || 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  /** 손질본: 흑백 → 대비(자동 늘리기 + 1.4배) → 선명(언샤프 비슷한 3x3) */
  function enhance(srcCanvas, max) {
    const base = toCanvas(srcCanvas, max);
    const ctx = base.getContext('2d', { willReadFrequently: true });
    const { width: W, height: H } = base;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const n = W * H;
    const g = new Uint8ClampedArray(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const v = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
      g[i] = v;
      hist[v | 0]++;
    }
    // 자동 대비: 양끝 1% 잘라내고 펼침
    let lo = 0;
    let hi = 255;
    let acc = 0;
    const cut = n * 0.01;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc > cut) {
        lo = i;
        break;
      }
    }
    acc = 0;
    for (let i = 255; i >= 0; i--) {
      acc += hist[i];
      if (acc > cut) {
        hi = i;
        break;
      }
    }
    const span = Math.max(1, hi - lo);
    const g2 = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) {
      let v = ((g[i] - lo) / span) * 255;
      v = (v - 128) * 1.4 + 128;
      g2[i] = v;
    }
    // 선명하게: 가운데 5, 상하좌우 -1 (언샤프 마스크의 가벼운 버전)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let v = g2[i];
        if (x > 0 && x < W - 1 && y > 0 && y < H - 1) {
          v = g2[i] * 5 - g2[i - 1] - g2[i + 1] - g2[i - W] - g2[i + W];
          v = g2[i] + (v - g2[i]) * 0.35;
        }
        const p = i * 4;
        d[p] = d[p + 1] = d[p + 2] = v;
        d[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return base;
  }

  /**
   * 사진 한 장 읽기. 두 번 읽어 글자 배열을 돌려준다.
   * @returns {Promise<{texts:string[], confidences:number[], ms:number}>}
   */
  /** 읽는 동안 화면이 꺼지지 않게(안드로이드 크롬은 화면이 꺼지면 작업이 멈춘다) */
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) return await navigator.wakeLock.request('screen');
    } catch (_) {}
    return null;
  }

  /**
   * 적응형 흑백(Sauvola): 칸마다 배경색이 다른 표(수도·가스 고지서)에서도 글자만 또렷하게 남긴다.
   * 전체를 한 기준으로 흑백 처리하면 색칸 속 글자가 지워지는 문제를 막음. 적분 영상으로 빠르게 계산.
   */
  function sauvola(src, max, k = 0.2, winRatio = 0.02) {
    const c = toCanvas(src, max, true);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const W = c.width;
    const H = c.height;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const n = W * H;
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
    const W1 = W + 1;
    const I = new Float64Array(W1 * (H + 1));
    const I2 = new Float64Array(W1 * (H + 1));
    for (let y = 1; y <= H; y++) {
      let rs = 0;
      let rs2 = 0;
      for (let x = 1; x <= W; x++) {
        const v = g[(y - 1) * W + x - 1];
        rs += v;
        rs2 += v * v;
        I[y * W1 + x] = I[(y - 1) * W1 + x] + rs;
        I2[y * W1 + x] = I2[(y - 1) * W1 + x] + rs2;
      }
    }
    const r = Math.max(8, Math.round(winRatio * Math.max(W, H)));
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(H, y + r + 1);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(W, x + r + 1);
        const A = (y1 - y0) * (x1 - x0);
        const S = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
        const S2 = I2[y1 * W1 + x1] - I2[y0 * W1 + x1] - I2[y1 * W1 + x0] + I2[y0 * W1 + x0];
        const m = S / A;
        const sd = Math.sqrt(Math.max(0, S2 / A - m * m));
        const v = g[y * W + x] > m * (1 + k * (sd / 128 - 1)) ? 255 : 0;
        const q = (y * W + x) * 4;
        d[q] = d[q + 1] = d[q + 2] = v;
        d[q + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /**
   * 사진 한 장 읽기.
   * 1차: 원본(작게). 금액·기한 둘 다 확신이면 여기서 끝(시간 절반).
   * 2차: 자신 없을 때만 손질본을 한 번 더 읽어 후보를 합친다.
   * 읽는 도중 엔진이 꺼지는 등 문제가 생기면 엔진을 새로 올려 한 번 더 읽는다.
   */
  async function readBill(file, onProgress, goodEnough) {
    const t0 = Date.now();
    users++;
    const lock = await keepAwake();
    try {
      // 실험(실제 고지서 4장+합성 1장)으로 고른 설정: 긴 쪽 2600px로 맞춰 읽기(작은 사진은 키움).
      // 1400~1700px로 줄여 읽으면 수도요금처럼 글씨가 작은 표는 거의 다 깨졌다.
      // 확대·축소는 기본(부드럽게 '낮음') 보간으로 — '높음'은 글자 가장자리가 번져 오히려 더 틀렸다(시험 결과)
      const bmp = await fileToBitmap(file, 4000);
      const raw = toCanvas(bmp, 2600, true, 'low');
      if (bmp.close) bmp.close();
      const keep = toCanvas(raw, 1700);
      const photo = await new Promise((res) => keep.toBlob(res, 'image/jpeg', 0.82));
      keep.width = keep.height = 0;
      const recog = async (img, psm, blocks) => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          const w = await ready(onProgress);
          try {
            await w.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: '300', tessedit_char_whitelist: '' });
            return blocks ? await w.recognize(img, {}, { text: true, blocks: true }) : await w.recognize(img);
          } catch (e) {
            if (attempt === 2) throw e;
            await release(true); // 망가진 엔진은 버리고 새로
          }
        }
      };
      onProgress && onProgress(0.45, '글자를 읽고 있어요');
      const T = { start: Date.now() };
      const r1 = await recog(raw, '3', true);
      T.pass1 = Date.now() - T.start;
      const texts = [r1.data.text || ''];
      const confidences = [r1.data.confidence || 0];
      if (!(goodEnough && goodEnough(texts))) {
        // 이름표(청구금액·납기내…) 옆 숫자를 크게 키워 숫자만 다시 읽기 — 표가 촘촘한 고지서에 특히 효과
        onProgress && onProgress(0.6, '금액·기한 칸을 확대해서 다시 읽어요');
        try {
          const w = await ready(onProgress);
          const focus = await autoFocus(w, raw, r1.data, 6);
          await w.setParameters({ tessedit_char_whitelist: '' });
          if (focus.length) texts.push(focus.join('\n'), focus.join('\n')); // 두 번 넣어 무게를 줌
          lastFocus = focus;
          T.focus = Date.now() - T.start - T.pass1;
        } catch (e) {
          console.warn('[Billbox focus]', e);
          lastFocus = ['ERR ' + (e && e.message)];
        }
      }
      if (goodEnough && goodEnough(texts)) {
        raw.width = raw.height = 0;
        onProgress && onProgress(0.97, '정리하고 있어요');
        return { texts, confidences, passes: texts.length > 1 ? 1.5 : 1, ms: Date.now() - t0, photo, source: file };
      }
      onProgress && onProgress(0.72, '자신이 없어서 한 번 더 꼼꼼히 읽어요');
      const mode = window.__bbPass2 || 'enh2000'; // 시험: 정확도는 같고 Sauvola(psm6)보다 2배 빠름
      const pre = mode === 'sauvola' ? sauvola(raw, 2600) : enhance(raw, mode === 'enh' ? 2600 : 2000);
      raw.width = raw.height = 0;
      const r2 = await recog(pre, mode === 'sauvola' ? '6' : '4');
      T.pass2 = Date.now() - T.start;
      timing = T;
      pre.width = pre.height = 0;
      texts.push(r2.data.text || '');
      confidences.push(r2.data.confidence || 0);
      onProgress && onProgress(0.97, '정리하고 있어요');
      return { texts, confidences, passes: 2, ms: Date.now() - t0, photo, source: file };
    } finally {
      users = Math.max(0, users - 1);
      progressSink = null;
      try {
        lock && lock.release();
      } catch (_) {}
      releaseLater();
    }
  }

  /**
   * 사진에서 콕 찍어 읽기 — 사용자가 사진 위의 금액·날짜·계좌를 손가락으로 누르면, 그 둘레만 잘라 크게 키워
   * 숫자 전용으로 다시 읽는다. 표가 촘촘한 고지서(수도요금 등)도 이 방식은 거의 틀리지 않는다.
   * @param {Blob} source  원본 사진(가능하면 큰 것)
   * @param {number} nx, ny  누른 곳(사진 기준 0~1)
   * @param {'amount'|'due'|'account'} field
   * @returns {Promise<{text:string, value:any}>}
   */
  async function readRegion(source, nx, ny, field, hints) {
    users++;
    try {
      const bmp = await createImageBitmap(source, { imageOrientation: 'from-image' });
      const w = await ready(null);
      const out = await readSpot(w, bmp, bmp.width, bmp.height, nx, ny, field, [0.035, 0.055], false, hints);
      if (bmp.close) bmp.close();
      await w.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' });
      return out;
    } finally {
      users = Math.max(0, users - 1);
      releaseLater();
    }
  }

  /** 그림(src) 위 (nx, ny) 둘레를 잘라 크게 키워 한 칸(field) 값을 읽는다. 누른 곳에 가까운 숫자일수록 점수 높음 */
  async function readSpot(w, src, W, H, nx, ny, field, bands, quick, hints) {
    const hint = new Set((hints || []).map(String));
    const short = Math.min(W, H);
    const votes = new Map();
    const texts = [];
    // 자동으로 읽은 후보(전체 읽기)와 같은 값이면 가산 — 한 글자 잘못 읽은 값보다 두 번 맞은 값을 믿음
    const vote = (v, sc) => votes.set(v, (votes.get(v) || 0) + sc * (hint.has(v) ? 1.5 : 1));
    for (const hr of bands) {
      const bh = short * hr;
      const bw = short * (field === 'account' ? 0.8 : 0.6);
      const x0 = Math.max(0, Math.min(W - bw, nx * W - bw / 2));
      const y0 = Math.max(0, Math.min(H - bh, ny * H - bh / 2));
      const sc = Math.max(1, Math.min(5, 110 / bh));
      const c = document.createElement('canvas');
      c.width = Math.round(bw * sc);
      c.height = Math.round(bh * sc);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(src, x0, y0, bw, bh, 0, 0, c.width, c.height);
      const tapX = (nx * W - x0) * sc;
      const tapY = (ny * H - y0) * sc;
      // 색칸(분홍·하늘색) 안 글씨를 위해 흑백·대비를 높인 판도 같이 읽음
      const hi = enhance(c, Math.max(c.width, c.height));
      const wl = field === 'account' ? '0123456789-' : field === 'due' ? '0123456789.-/년월일' : '0123456789,.원';
      const plan = quick ? [[c, '7', wl], [hi, '7', wl], [c, '6', '']] : [[c, '7', wl], [c, '6', ''], [hi, '7', wl], [hi, '11', wl]];
      for (const [img, psm, white] of plan) {
        await w.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: white, user_defined_dpi: '300' });
        const r = await w.recognize(img, {}, { text: true, blocks: true });
        texts.push(r.data.text || '');
        for (const tok of tokensNear(r.data, tapX, tapY)) {
          const v = window.BillboxExtract.pickField([tok.text], field);
          if (v == null) continue;
          vote(String(v), tok.weight * (white ? 1.2 : 1));
        }
      }
      c.width = c.height = 0;
      hi.width = hi.height = 0;
      const top = [...votes.values()].sort((a, b) => b - a);
      if (top[0] >= 3 && (top.length === 1 || top[0] >= top[1] * 2)) break; // 충분히 확실하면 넓은 띠는 건너뜀
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    let value = best ? best[0] : window.BillboxExtract.pickField(texts, field);
    // 자신 없이 읽은 값이 전체 읽기 후보와 한 글자만 다르면(예: 03↔05) 후보 쪽이 맞을 가능성이 큼
    if (value != null && (!best || best[1] < 1.5) && !hint.has(String(value))) {
      const sv = String(value);
      const near = [...hint].find((h) => h.length === sv.length && [...h].filter((ch, i) => ch !== sv[i]).length === 1);
      if (near) value = near;
    }
    if (field === 'amount' && value != null) value = Number(value);
    return { text: texts.join(' | ').replace(/\s+/g, ' ').trim(), value, score: best ? best[1] : 0 };
  }

  /**
   * 자동 콕 찍기: 첫 읽기에서 "청구금액·납기내·납부마감일" 같은 이름표를 찾으면, 그 오른쪽(또는 바로 아래) 숫자를
   * 스스로 콕 찍어 다시 읽는다. 결과는 이름표를 붙인 글줄로 돌려줘서 extract가 높은 점수로 고르게 한다.
   */
  const LBL_AMT = /청구금|구금액|납부할금|부할금액|납부금액|체납금|납기내금|합계|결제금/;
  const LBL_DUE = /납기내|남기내|납기일|납부기한|남부기한|부기한|납부마감|남부마감|마감일|납기한/;
  const LBL_BAD = /납기후|남기후|기후금|미납|전월|사용기간/;
  let dbgJobs = [];
  async function autoFocus(w, raw, data, budget) {
    dbgJobs = [];
    const W = raw.width;
    const H = raw.height;
    const lines = [];
    for (const bl of data.blocks || []) for (const pa of bl.paragraphs || []) for (const ln of pa.lines || []) lines.push(ln);
    const jobs = [];
    for (const ln of lines) {
      const words = ln.words || [];
      if (!words.length) continue;
      // 고지서 이름표는 "청 구 금 액"처럼 글자 사이가 벌어져 낱말이 쪼개져 있다 → 줄 전체를 붙여서 찾고, 붙인 글자가 어느 낱말이었는지 기억
      let compact = '';
      const owner = [];
      words.forEach((wd, i) => {
        const t = wd.text.replace(/\s/g, '');
        compact += t;
        for (let k = 0; k < t.length; k++) owner.push(i);
      });
      const h = Math.max(8, ln.bbox.y1 - ln.bbox.y0);
      for (const [re, field, label] of [[LBL_AMT, 'amount', '청구금액'], [LBL_DUE, 'due', '납부기한 까지']]) {
        const g = new RegExp(re.source, 'g');
        let m;
        while ((m = g.exec(compact))) {
          const before = compact.slice(Math.max(0, m.index - 3), m.index + m[0].length + 2);
          if (LBL_BAD.test(before)) continue;
          const lastW = owner[m.index + m[0].length - 1];
          const firstW = owner[m.index];
          const lb = { x0: words[firstW].bbox.x0, x1: words[lastW].bbox.x1, y0: ln.bbox.y0, y1: ln.bbox.y1 };
          // 같은 줄 오른쪽에 숫자가 있으면 그 숫자 덩어리 가운데, 없으면 이름표 바로 아래 줄
          const right = words.slice(lastW + 1).filter((x) => /\d/.test(x.text));
          let tx;
          let ty;
          if (right.length) {
            const r0 = right[0];
            let last = r0;
            for (const x of right.slice(1)) {
              if (x.bbox.x0 - last.bbox.x1 < h * 1.2) last = x;
              else break;
            }
            tx = (r0.bbox.x0 + last.bbox.x1) / 2;
            ty = (r0.bbox.y0 + r0.bbox.y1) / 2;
          } else {
            tx = (lb.x0 + lb.x1) / 2;
            ty = lb.y1 + h * 0.9;
          }
          jobs.push({ field, label, nx: tx / W, ny: ty / H, weak: !right.length });
        }
      }
    }
    jobs.sort((x, y) => (x.weak ? 1 : 0) - (y.weak ? 1 : 0));
    const out = [];
    const done = new Set();
    for (const j of jobs.slice(0, budget)) {
      if (j.weak && done.has(j.field)) continue; // 이름표 오른쪽에서 이미 읽었으면 아래쪽 추측은 건너뜀
      const r = await readSpot(w, raw, W, H, j.nx, j.ny, j.field, [0.03, 0.045], true);
      dbgJobs.push([j.field, j.nx.toFixed(3), j.ny.toFixed(3), r.value, +r.score.toFixed(2)]);
      if (r.value == null || r.score < 1) continue; // 자신 없는 건 버림(엉뚱한 숫자가 높은 점수를 받지 않게)
      done.add(j.field);
      const v = j.field === 'amount' ? Number(r.value).toLocaleString('ko-KR') + ' 원' : String(r.value).replace(/-/g, '.');
      out.push(`${j.label} ${v}`);
    }
    return out;
  }

  /** 읽은 결과의 낱말들을 한 줄 안에서 붙여(예: "2026." "01." "05") 숫자 덩어리를 만들고, 누른 곳과의 거리로 가중치 */
  function tokensNear(data, tx, ty) {
    const out = [];
    for (const bl of data.blocks || [])
      for (const pa of bl.paragraphs || [])
        for (const ln of pa.lines || []) {
          const ws = (ln.words || []).filter((x) => /\d/.test(x.text));
          const h = Math.max(8, ln.bbox.y1 - ln.bbox.y0);
          let cur = null;
          const flush = () => {
            if (!cur) return;
            const cx = (cur.x0 + cur.x1) / 2;
            const cy = (cur.y0 + cur.y1) / 2;
            // 누른 곳이 덩어리 안이면 거리 0
            const dx = tx < cur.x0 ? cur.x0 - tx : tx > cur.x1 ? tx - cur.x1 : 0;
            const dy = Math.abs(cy - ty);
            const dist = Math.hypot(dx, dy * 1.5) / h;
            out.push({ text: cur.text, weight: (1 / (1 + dist)) * (0.5 + cur.conf / 200) });
            cur = null;
          };
          for (const wd of ws) {
            const b = wd.bbox;
            if (cur && b.x0 - cur.x1 < h * 0.9) {
              cur.text += wd.text;
              cur.x1 = b.x1;
              cur.y0 = Math.min(cur.y0, b.y0);
              cur.y1 = Math.max(cur.y1, b.y1);
              cur.conf = Math.min(cur.conf, wd.confidence || 0);
            } else {
              flush();
              cur = { text: wd.text, x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, conf: wd.confidence || 0 };
            }
          }
          flush();
        }
    return out;
  }

  /** 첫 화면에서 미리 받아 두기. 받은 뒤 아무도 안 쓰면 메모리에서 내림 */
  function warmup() {
    if (worker || loading) return;
    if (isCached()) {
      setState('ready', '찍을 준비 됐어요', 1); // 이미 받아 둠 → 메모리에 안 올림
      return;
    }
    setTimeout(() => {
      ready(null)
        .then(() => releaseLater())
        .catch(() => {});
    }, 400);
  }

  /** 홈의 [다시 받기] */
  function retry() {
    return ready(null).then(() => releaseLater());
  }

  return { getLastFocus: () => ({ lastFocus, dbgJobs, timing }), readRegion, ready, readBill, warmup, retry, release, isCached, onState, enhance, sauvola, toCanvas, getState: () => ({ state, msg: stateMsg, progress: stateProgress }) };
})();
