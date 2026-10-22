'use strict';

/**
 * Billbox AI 읽기 — 사진을 암호화 연결로 우리 서버(/api/billbox/read)에 보내 Claude가 읽는다.
 *
 * 약속(안내문과 같아야 함):
 *   - 사진은 읽는 순간에만 서버를 거치고, 읽는 즉시 삭제된다. 어디에도 저장되지 않는다.
 *   - 읽은 금액·이름도 서버에 남지 않는다(결과는 폰으로만 돌아옴).
 *   - 설정에서 끄면 폰 안에서만 읽는다(느리고 덜 정확).
 * 실패·오프라인·한도 초과면 호출한 쪽이 폰 읽기(Tesseract)로 넘어간다.
 */
window.BillboxAI = (function () {
  const cfg = () => window.BILLBOX_CONFIG || {};
  const S = () => window.BillboxStore;

  function mode() {
    // 'on' | 'off' | ''(아직 안 물어봄)
    return S().settings().aiRead || '';
  }
  function available() {
    return !!cfg().API_BASE && mode() !== 'off' && navigator.onLine !== false;
  }

  /** 비트맵의 (x0,y0,w,h) 조각을 긴 변 1568px JPEG base64로 */
  async function cropB64(bmp, x0, y0, w, h) {
    const sc = Math.min(1, 1568 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * sc));
    c.height = Math.max(1, Math.round(h * sc));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(bmp, x0, y0, w, h, 0, 0, c.width, c.height);
    const out = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.87));
    c.width = c.height = 0;
    if (!out) throw new Error('이미지 변환 실패');
    const buf = await out.arrayBuffer();
    let bin = '';
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  /** 비트맵을 시계방향 rot(90|180|270)도 돌린 새 비트맵 */
  async function rotateBmp(bmp, rot) {
    const c = document.createElement('canvas');
    if (rot === 180) {
      c.width = bmp.width;
      c.height = bmp.height;
      const x = c.getContext('2d');
      x.translate(c.width, c.height);
      x.rotate(Math.PI);
      x.drawImage(bmp, 0, 0);
    } else {
      c.width = bmp.height;
      c.height = bmp.width;
      const x = c.getContext('2d');
      if (rot === 90) {
        x.translate(c.width, 0);
        x.rotate(Math.PI / 2);
      } else {
        x.translate(0, c.height);
        x.rotate(-Math.PI / 2);
      }
      x.drawImage(bmp, 0, 0);
    }
    const out = await createImageBitmap(c);
    c.width = c.height = 0;
    return out;
  }
  /** 두 읽기 결과 합치기: 나중(b) 것의 채워진 값을 우선 */
  function mergeRead(a, b) {
    const out = Object.assign({}, a);
    for (const k of Object.keys(b)) if (b[k] != null && b[k] !== '') out[k] = b[k];
    out.doc = true;
    return out;
  }

  async function post(body, timeout) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeout || 45000);
    try {
      const res = await fetch(cfg().API_BASE + '/read', {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ deviceKey: window.BillboxPush.deviceKey(), mediaType: 'image/jpeg' }, body)),
      });
      return res;
    } finally {
      clearTimeout(to);
    }
  }

  /**
   * 사진 1장을 AI로 읽기 → extract()와 같은 모양의 결과로 바꿔 돌려줌.
   * 못 읽으면(서버 없음·한도·오류) { fallback: true, reason } — 호출한 쪽이 폰 읽기로.
   */
  async function read(blob) {
    if (!available()) return { fallback: true, reason: mode() === 'off' ? 'off' : 'offline' };
    let bmp;
    let image;
    try {
      bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      image = await cropB64(bmp, 0, 0, bmp.width, bmp.height);
    } catch (_) {
      if (bmp && bmp.close) bmp.close();
      return { fallback: true, reason: 'encode' };
    }
    let res;
    try {
      res = await post({ image });
    } catch (_) {
      if (bmp.close) bmp.close();
      return { fallback: true, reason: 'network' };
    }
    if (res.status === 429) {
      if (bmp.close) bmp.close();
      return { fallback: true, reason: 'limit' };
    }
    if (!res.ok) {
      if (bmp.close) bmp.close();
      return { fallback: true, reason: 'server' };
    }
    let j;
    try {
      j = await res.json();
    } catch (_) {
      j = null;
    }
    let d = j && j.data;
    let usedRot = 0;
    // 사진이 옆으로 누워 있다고 하면: 바로 세워서 상위 모델로 전체를 다시 읽는다
    // (돌아간 빽빽한 표는 정독이 어렵고, 콕 찍기 조각도 엉뚱하게 잘리기 때문)
    if (d && d.doc !== false && (d.rot === 90 || d.rot === 180 || d.rot === 270)) {
      try {
        const rb = await rotateBmp(bmp, d.rot);
        if (bmp.close) bmp.close();
        bmp = rb;
        usedRot = d.rot;
        const img2 = await cropB64(bmp, 0, 0, bmp.width, bmp.height);
        const res2 = await post({ image: img2, detail: 1 }, 60000);
        if (res2.ok) {
          const j2 = await res2.json();
          if (j2 && j2.data && j2.data.doc !== false) d = mergeRead(d, j2.data);
        }
      } catch (_) {}
    }
    // 금액·기한을 못 읽음 → 사진을 위/아래 두 조각(겹치게)으로 쪼개 2배 해상도로 상위 모델에 다시 묻는다
    // (수도요금처럼 작은 색칸 숫자는 전체를 줄인 사진에선 뭉개지기 때문)
    if (d && d.doc !== false && (d.amount == null || d.due == null)) {
      try {
        const H = bmp.height;
        const tiles = [await cropB64(bmp, 0, 0, bmp.width, Math.round(H * 0.58)), await cropB64(bmp, 0, Math.round(H * 0.42), bmp.width, H - Math.round(H * 0.42))];
        const res2 = await post({ images: tiles, detail: 1 }, 60000);
        if (res2.ok) {
          const j2 = await res2.json();
          const d2 = j2 && j2.data;
          if (d2 && d2.doc !== false) {
            // 조각 읽기가 찾은 값으로 빈칸을 채움(조각이 더 많이 읽었으면 조각을 믿음)
            const score = (x) => (x.amount != null ? 1 : 0) + (x.due != null ? 1 : 0) + (x.account ? 1 : 0);
            d = score(d2) >= score(d) ? Object.assign({}, d, d2) : Object.assign({}, d2, d, { amount: d.amount != null ? d.amount : d2.amount, due: d.due || d2.due, account: d.account || d2.account, unit: d.unit || d2.unit });
          }
        }
      } catch (_) {}
    }
    if (bmp.close) bmp.close();
    if (!d) return { fallback: true, reason: 'server' };
    if (d.doc === false) return { notBill: true };

    // extract() 결과와 같은 모양으로
    const K = window.BillboxKinds;
    const kind = d.kind && d.kind !== 'etc' ? K.byId(d.kind) : null;
    const accounts = [];
    if (d.account) {
      const m = String(d.account).match(/^([^\d]*)([\d\s-]+)$/);
      accounts.push({ bank: m ? m[1].trim() : '', number: m ? m[2].replace(/\s/g, '') : String(d.account), count: 1 });
    }
    return {
      source: 'ai',
      kind,
      name: d.name || '',
      issuer: d.issuer || '',
      tag: d.tag || '',
      amount: d.amount,
      due: d.due,
      altAmounts: d.amountLate && d.amountLate !== d.amount ? [] : [],
      altDues: [],
      sure: { amount: d.amount != null, due: !!d.due },
      accounts,
      usage: d.usage && d.usage.value ? { value: d.usage.value, unit: d.usage.unit || '' } : null,
      amountLate: d.amountLate || null,
      autopay: d.autopay === true,
      unit: d.unit || null,
      rot: usedRot,
    };
  }

  /** 콕 찍기: 누른 곳 주변을 잘라 AI에게 그 값 하나만 묻는다 */
  async function readField(blob, nx, ny, field) {
    if (!available() || mode() !== 'on') return { fallback: true, reason: 'off' };
    let image;
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const W = bmp.width;
      const H = bmp.height;
      // 누른 곳을 가운데로, 너비 70%·높이(짧은 변의 24%) 조각 — 이름표까지 같이 보이게 넉넉히
      const bw = Math.min(W, Math.max(W * 0.7, 800));
      const bh = Math.min(H, Math.max(Math.min(W, H) * 0.24, 420));
      const x0 = Math.max(0, Math.min(W - bw, nx * W - bw / 2));
      const y0 = Math.max(0, Math.min(H - bh, ny * H - bh / 2));
      const c = document.createElement('canvas');
      const sc = Math.min(1, 1568 / Math.max(bw, bh));
      c.width = Math.round(bw * sc);
      c.height = Math.round(bh * sc);
      c.getContext('2d').drawImage(bmp, x0, y0, bw, bh, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      const out = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
      c.width = c.height = 0;
      const buf = await out.arrayBuffer();
      let bin = '';
      const u8 = new Uint8Array(buf);
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      image = btoa(bin);
    } catch (_) {
      return { fallback: true, reason: 'encode' };
    }
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 30000);
      const res = await fetch(cfg().API_BASE + '/read', {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceKey: window.BillboxPush.deviceKey(), image, mediaType: 'image/jpeg', field }),
      });
      clearTimeout(to);
      if (!res.ok) return { fallback: true, reason: res.status === 429 ? 'limit' : 'server' };
      const j = await res.json();
      return { value: j.value != null ? j.value : null };
    } catch (_) {
      return { fallback: true, reason: 'network' };
    }
  }

  return { available, mode, read, readField };
})();
