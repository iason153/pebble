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
    if (loading) return loading;
    loading = (async () => {
      const c = cfg();
      onProgress && onProgress(0.02, '읽기 도구를 준비하고 있어요');
      await loadScript(c.SCRIPT);
      const w = await window.Tesseract.createWorker(['kor', 'eng'], 1, {
        workerPath: c.WORKER,
        corePath: c.CORE,
        langPath: c.LANG_PATH,
        gzip: true,
        logger: (m) => {
          if (!onProgress) return;
          if (m.status === 'loading language traineddata' || m.status === 'loading tesseract core') onProgress(0.05 + (m.progress || 0) * 0.25, '한글 사전을 내려받고 있어요 (처음 한 번만)');
          else if (m.status === 'initializing api') onProgress(0.32, '거의 준비됐어요');
        },
      });
      await w.setParameters({ preserve_interword_spaces: '1' });
      worker = w;
      return w;
    })();
    try {
      return await loading;
    } catch (e) {
      loading = null;
      throw e;
    }
  }

  async function fileToBitmap(file) {
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
  async function readBill(file, onProgress) {
    const t0 = Date.now();
    const w = await ready(onProgress);
    const bmp = await fileToBitmap(file);
    const raw = toCanvas(bmp, 1700);
    const pre = enhance(raw, 2600);
    if (bmp.close) bmp.close();

    onProgress && onProgress(0.4, '글자를 읽고 있어요 (1/2)');
    await w.setParameters({ tessedit_pageseg_mode: '3' });
    const r1 = await w.recognize(raw);
    onProgress && onProgress(0.7, '한 번 더 꼼꼼히 읽고 있어요 (2/2)');
    await w.setParameters({ tessedit_pageseg_mode: '4' });
    const r2 = await w.recognize(pre);
    onProgress && onProgress(0.97, '정리하고 있어요');
    return {
      texts: [r1.data.text || '', r2.data.text || ''],
      confidences: [r1.data.confidence || 0, r2.data.confidence || 0],
      ms: Date.now() - t0,
    };
  }

  /** 미리 내려받기(첫 화면에서 조용히) — 실패해도 조용히 넘어감 */
  function warmup() {
    if (worker || loading) return;
    try {
      const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
      idle(() => ready(null).catch(() => {}));
    } catch (_) {}
  }

  return { ready, readBill, warmup, enhance, toCanvas };
})();
