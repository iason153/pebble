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

  /** 사진을 긴 변 1568px JPEG로 줄여 base64로 (AI가 보기 좋은 크기 = 비용·속도 최적) */
  async function toB64(blob) {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const max = 1568;
    const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * sc));
    c.height = Math.max(1, Math.round(bmp.height * sc));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    const out = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
    c.width = c.height = 0;
    if (!out) throw new Error('이미지 변환 실패');
    const buf = await out.arrayBuffer();
    let bin = '';
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /**
   * 사진 1장을 AI로 읽기 → extract()와 같은 모양의 결과로 바꿔 돌려줌.
   * 못 읽으면(서버 없음·한도·오류) { fallback: true, reason } — 호출한 쪽이 폰 읽기로.
   */
  async function read(blob) {
    if (!available()) return { fallback: true, reason: mode() === 'off' ? 'off' : 'offline' };
    let image;
    try {
      image = await toB64(blob);
    } catch (_) {
      return { fallback: true, reason: 'encode' };
    }
    let res;
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 45000);
      res = await fetch(cfg().API_BASE + '/read', {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceKey: window.BillboxPush.deviceKey(), image, mediaType: 'image/jpeg' }),
      });
      clearTimeout(to);
    } catch (_) {
      return { fallback: true, reason: 'network' };
    }
    if (res.status === 429) return { fallback: true, reason: 'limit' };
    if (!res.ok) return { fallback: true, reason: 'server' };
    let j;
    try {
      j = await res.json();
    } catch (_) {
      return { fallback: true, reason: 'server' };
    }
    const d = j && j.data;
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
    };
  }

  return { available, mode, read };
})();
