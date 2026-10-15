'use strict';

/**
 * Billbox 글자 읽기 — Tesseract.js(한글+영문), 전부 폰 안에서.
 *
 * - 사진은 기기 밖으로 나가지 않는다. 서버에 보내는 것 없음.
 * - "두 번 읽고 투표": ① 원본(크기만 줄임) ② 손질본(흑백·확대·대비·선명). 각각 읽어 extract.js에 넘긴다.
 *   사전 시험(8장)에서 손질본만 쓰면 가스 고지서가 틀렸고, 둘을 합쳤을 때 8/8이었다.
 * - 엔진·언어 파일은 CDN에서 처음 한 번 받고 브라우저가 저장(IndexedDB)한다. 이후는 오프라인도 됨.
 * - 어떻게 찍어도 최선: 사진이 흐리거나 기울어도 그냥 읽는다. 실패 시 "직접 입력"으로 넘긴다.
 */
window.BillboxOCR = (function () {
  const cfg = () => (window.BILLBOX_CONFIG && window.BILLBOX_CONFIG.OCR) || {};
  let worker = null;
  let loading = null;
  let state = 'idle'; // idle | loading | ready | error
  let stateMsg = '';
  let stateProgress = 0;
  const listeners = [];
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
  const READY_TIMEOUT = 150000; // 2분 30초 안에 준비 안 되면 실패로 보고 다시 시도하게

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('OCR 엔진을 내려받지 못했어요'));
      document.head.appendChild(s);
    });
  }

  /** 엔진 준비(처음만 느림). onProgress(0~1, 문구) */
  async function ready(onProgress) {
    if (worker) return worker;
    if (loading) {
      // 이미 내려받는 중이면 진행 상황만 이어서 보여 준다
      if (onProgress) onState(({ state: st, msg, progress }) => st === 'loading' && onProgress(0.05 + progress * 0.3, msg));
      return loading;
    }
    const report = (p, msg) => {
      setState('loading', msg, p);
      onProgress && onProgress(0.05 + p * 0.3, msg);
    };
    loading = (async () => {
      const c = cfg();
      report(0.02, '읽기 도구를 준비하고 있어요');
      await loadScript(c.SCRIPT);
      const opts = {
        workerPath: c.WORKER,
        corePath: c.CORE,
        gzip: true,
        logger: (m) => {
          if (m.status === 'loading tesseract core') report(0.05 + (m.progress || 0) * 0.3, '읽기 엔진을 내려받고 있어요 (약 3MB)');
          else if (m.status === 'loading language traineddata') report(0.4 + (m.progress || 0) * 0.5, '한글 사전을 내려받고 있어요 (약 5MB, 처음 한 번만)');
          else if (m.status === 'initializing api') report(0.95, '거의 준비됐어요');
        },
        errorHandler: (err) => {
          console.warn('[Billbox OCR]', err);
        },
      };
      if (c.LANG_PATH) opts.langPath = c.LANG_PATH;
      // 언어 파일 주소가 살아 있는지 먼저 가볍게 확인(404면 Tesseract.js가 영원히 기다리므로 여기서 바로 실패시킴)
      const langBase = c.LANG_PATH ? `${c.LANG_PATH}/kor` : 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/kor/4.0.0_best_int/kor';
      try {
        const head = await fetch(`${langBase}.traineddata.gz`, { method: 'HEAD', cache: 'force-cache' });
        if (!head.ok) throw new Error('언어 파일 주소 오류 ' + head.status);
      } catch (e) {
        if (/주소 오류/.test(e.message)) throw e;
        /* 네트워크가 잠깐 끊긴 경우는 아래 createWorker가 캐시(IndexedDB)로 성공할 수 있으니 넘어감 */
      }
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('내려받기가 너무 오래 걸려요. 와이파이에서 다시 시도해 주세요')), READY_TIMEOUT));
      const w = await Promise.race([window.Tesseract.createWorker(['kor', 'eng'], 1, opts), timeout]);
      await w.setParameters({ preserve_interword_spaces: '1' });
      worker = w;
      try {
        localStorage.setItem('billbox:ocr-cached', '1');
      } catch (_) {}
      setState('ready', '찍을 준비 됐어요', 1);
      return w;
    })();
    try {
      return await loading;
    } catch (e) {
      loading = null;
      setState('error', e.message || '읽기 도구를 준비하지 못했어요', 0);
      throw e;
    }
  }

  /**
   * 엔진을 메모리에서 내림. 사전·엔진 파일은 브라우저 저장소(IndexedDB)에 남아 있어서 다음엔 몇 초면 다시 올라온다.
   * 카메라 앱으로 넘어가기 전·읽기가 끝난 뒤 부른다 → 안드로이드가 크롬 탭을 꺼 버리는 일("메모리가 부족하여…")을 줄인다.
   */
  async function release() {
    const w = worker;
    worker = null;
    loading = null;
    if (w) {
      try {
        await w.terminate();
      } catch (_) {}
    }
  }
  function isCached() {
    try {
      return localStorage.getItem('billbox:ocr-cached') === '1';
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
   * @param {(texts:string[])=>boolean} [goodEnough] 1차 결과로 충분한지 판단(extract.sure)
   * @returns {Promise<{texts:string[], confidences:number[], passes:number, ms:number}>}
   */
  async function readBill(file, onProgress, goodEnough) {
    const t0 = Date.now();
    const lock = await keepAwake();
    try {
      // 사진부터 작게 줄인 뒤(원본은 바로 버림) 엔진을 올린다 → 메모리가 겹치지 않게
      const bmp = await fileToBitmap(file, 1400);
      const raw = toCanvas(bmp, 1400);
      if (bmp.close) bmp.close();
      // 고지서 보기용 사본(폰 안에만 저장). 글자가 읽힐 만큼만 — 장당 200~300KB
      const photo = await new Promise((res) => raw.toBlob(res, 'image/jpeg', 0.82));
      const w = await ready(onProgress);

      onProgress && onProgress(0.45, '글자를 읽고 있어요');
      await w.setParameters({ tessedit_pageseg_mode: '3' });
      const r1 = await w.recognize(raw);
      const texts = [r1.data.text || ''];
      const confidences = [r1.data.confidence || 0];
      if (goodEnough && goodEnough(texts)) {
        onProgress && onProgress(0.97, '정리하고 있어요');
        return { texts, confidences, passes: 1, ms: Date.now() - t0, photo };
      }
      onProgress && onProgress(0.72, '자신이 없어서 한 번 더 꼼꼼히 읽어요');
      const pre = enhance(raw, 2000);
      await w.setParameters({ tessedit_pageseg_mode: '4' });
      const r2 = await w.recognize(pre);
      texts.push(r2.data.text || '');
      confidences.push(r2.data.confidence || 0);
      onProgress && onProgress(0.97, '정리하고 있어요');
      return { texts, confidences, passes: 2, ms: Date.now() - t0, photo };
    } finally {
      try {
        lock && lock.release();
      } catch (_) {}
      // 다 읽으면 엔진을 메모리에서 내림(다음 찍기 때 몇 초 만에 다시 올라옴)
      setTimeout(() => release(), 0);
    }
  }

  /** 미리 내려받기(첫 화면에서 조용히) — 실패해도 조용히 넘어감 */
  function warmup() {
    if (worker || loading) return;
    if (isCached()) {
      setState('ready', '찍을 준비 됐어요', 1); // 이미 받아 둠 → 메모리에 올리지 않음
      return;
    }
    setTimeout(() => {
      ready(null)
        .then(() => release()) // 받아만 두고 메모리에선 내림
        .catch(() => {});
    }, 400);
  }

  return { ready, readBill, warmup, release, isCached, onState, enhance, toCanvas, getState: () => ({ state, msg: stateMsg, progress: stateProgress }) };
})();
