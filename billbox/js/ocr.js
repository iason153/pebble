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
      const opt = { imageOrientation: 'from-image', resizeQuality: 'high' };
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
  function toCanvas(src, max) {
    const w = src.width || src.naturalWidth;
    const h = src.height || src.naturalHeight;
    const r = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * r);
    c.height = Math.round(h * r);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
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
      const bmp = await fileToBitmap(file, 1700);
      const raw = toCanvas(bmp, 1700);
      if (bmp.close) bmp.close();
      const photo = await new Promise((res) => raw.toBlob(res, 'image/jpeg', 0.82));
      const recog = async (img, psm) => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          const w = await ready(onProgress);
          try {
            await w.setParameters({ tessedit_pageseg_mode: psm });
            return await w.recognize(img);
          } catch (e) {
            if (attempt === 2) throw e;
            await release(true); // 망가진 엔진은 버리고 새로
          }
        }
      };
      onProgress && onProgress(0.45, '글자를 읽고 있어요');
      const r1 = await recog(raw, '3');
      const texts = [r1.data.text || ''];
      const confidences = [r1.data.confidence || 0];
      if (goodEnough && goodEnough(texts)) {
        onProgress && onProgress(0.97, '정리하고 있어요');
        return { texts, confidences, passes: 1, ms: Date.now() - t0, photo };
      }
      onProgress && onProgress(0.72, '자신이 없어서 한 번 더 꼼꼼히 읽어요');
      const pre = enhance(raw, 2400);
      const r2 = await recog(pre, '4');
      texts.push(r2.data.text || '');
      confidences.push(r2.data.confidence || 0);
      onProgress && onProgress(0.97, '정리하고 있어요');
      return { texts, confidences, passes: 2, ms: Date.now() - t0, photo };
    } finally {
      users = Math.max(0, users - 1);
      progressSink = null;
      try {
        lock && lock.release();
      } catch (_) {}
      releaseLater();
    }
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

  return { ready, readBill, warmup, retry, release, isCached, onState, enhance, toCanvas, getState: () => ({ state, msg: stateMsg, progress: stateProgress }) };
})();
