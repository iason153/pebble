/**
 * Seal 핵심 계산 — 보이지 않는 바둑판 도장 심기 / 찾기 (외부 라이브러리 없음)
 *
 * 방식(사전 시험 docs/Seal_사전시험_결과_v0.md에서 확정):
 *  - 열쇠(32비트 숫자) → 한 칸짜리 무늬(6~22 주기 대역). 사진 긴 변을 6칸으로 나눠 바둑판처럼 반복해 심는다.
 *  - 밝기(Y)에는 약하게(0.6), 파랑-노랑 색차(Cb)에는 주로(2.0) 심는다. 무늬 많은 곳엔 세게, 평평·어두운 곳엔 약하게.
 *  - 찾기: 의심 사진을 0.2% 간격의 배율로 훑으며 한 칸 크기로 접고, 열쇠 무늬와 대조. 두 층 점수를 합친다.
 *  - 점수 9 이상 = 확실, 7.5~9 = 약함, 미만 = 못 찾음 (도장 없는 사진 5,670회 대조에서 7.5 초과 0건)
 * 페이지와 워커 양쪽에서 쓴다(self.SealCore).
 */
'use strict';
const T = 64, KT = 6, CMIN = 6, CMAX = 22, PN = 256;

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

// 1차원 FFT(제자리), n은 2의 거듭제곱
function fft1(re, im, n, inv, off, stride) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const a = off + i * stride, b = off + j * stride; let t = re[a]; re[a] = re[b]; re[b] = t; t = im[a]; im[a] = im[b]; im[b] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = off + (i + k) * stride, b = off + (i + k + len / 2) * stride;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[off + i * stride] /= n; im[off + i * stride] /= n; }
}
function fft2(re, im, n, inv) {
  for (let y = 0; y < n; y++) fft1(re, im, n, inv, y * n, 1);
  for (let x = 0; x < n; x++) fft1(re, im, n, inv, x, n);
}
const fq = (i, n) => (i <= n / 2 ? i : i - n);

// 열쇠 → 도장 한 칸의 주파수 성분(T×T, 대역 제한)
function tileSpec(key) {
  const r = rng(key), re = new Float64Array(T * T), im = new Float64Array(T * T);
  for (let i = 0; i < T * T; i++) re[i] = gauss(r);
  fft2(re, im, T, false);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const f = Math.hypot(fq(y, T), fq(x, T));
    if (f < CMIN || f > CMAX) { re[y * T + x] = 0; im[y * T + x] = 0; }
  }
  return { re, im };
}
// 도장 한 칸을 PN×PN 그림으로(심을 때 사용), 표준편차 1
function tileImage(key) {
  const s = tileSpec(key), re = new Float64Array(PN * PN), im = new Float64Array(PN * PN);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const fy = fq(y, T), fx = fq(x, T);
    if (Math.abs(fy) > CMAX || Math.abs(fx) > CMAX) continue;
    const j = ((fy + PN) % PN) * PN + ((fx + PN) % PN);
    re[j] = s.re[y * T + x]; im[j] = s.im[y * T + x];
  }
  fft2(re, im, PN, true);
  let m = 0, v = 0; for (let i = 0; i < PN * PN; i++) m += re[i]; m /= PN * PN;
  for (let i = 0; i < PN * PN; i++) v += (re[i] - m) ** 2; v = Math.sqrt(v / (PN * PN));
  const out = new Float32Array(PN * PN); for (let i = 0; i < PN * PN; i++) out[i] = (re[i] - m) / v;
  return out;
}

// ---- 그림 도구 ----
function lumaOf(rgba, W, H) { const y = new Float32Array(W * H); for (let i = 0, j = 0; i < W * H; i++, j += 4) y[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]; return y; }
function boxBlur(src, W, H, r) { // 가로세로 상자 흐림(반지름 r)
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H), d = 2 * r + 1;
  for (let y = 0; y < H; y++) { let s = 0; const o = y * W;
    for (let x = -r; x <= r; x++) s += src[o + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) { tmp[o + x] = s / d; s += src[o + Math.min(W - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; } }
  for (let x = 0; x < W; x++) { let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) { out[y * W + x] = s / d; s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x]; } }
  return out;
}
function gaussBlur(src, W, H, sigma) { // 상자 흐림 3번 = 가우시안 근사
  const r = Math.max(1, Math.round(Math.sqrt(sigma * sigma * 12 / 3 + 1) / 2 - 0.5));
  return boxBlur(boxBlur(boxBlur(src, W, H, r), W, H, r), W, H, r);
}
function areaDown(src, W, H, w, h) { // 면적 평균 축소
  const out = new Float32Array(w * h), cnt = new Float32Array(w * h);
  for (let y = 0; y < H; y++) { const ty = Math.min(h - 1, (y * h / H) | 0);
    for (let x = 0; x < W; x++) { const j = ty * w + Math.min(w - 1, (x * w / W) | 0); out[j] += src[y * W + x]; cnt[j]++; } }
  for (let i = 0; i < w * h; i++) out[i] /= Math.max(1, cnt[i]);
  return out;
}
function bilin(src, w, h, fx, fy) {
  fx = Math.min(w - 1, Math.max(0, fx)); fy = Math.min(h - 1, Math.max(0, fy));
  const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
  return (src[y0 * w + x0] * (1 - ax) + src[y0 * w + x1] * ax) * (1 - ay) + (src[y1 * w + x0] * (1 - ax) + src[y1 * w + x1] * ax) * ay;
}

// 무늬 있는 곳엔 세게, 평평하고 어두운 곳엔 약하게(눈에 안 띄게). 밝기용·색용 두 장
function strengthMask(y, W, H) {
  const s = 512 / Math.max(W, H), w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
  const yc = s < 1 ? areaDown(y, W, H, w, h) : y, cw = s < 1 ? w : W, ch = s < 1 ? h : H;
  const m = boxBlur(yc, cw, ch, 3), sq = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) sq[i] = yc[i] * yc[i];
  const m2 = boxBlur(sq, cw, ch, 3), ty = new Float32Array(cw * ch), tc = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    const v = Math.sqrt(Math.max(0, m2[i] - m[i] * m[i])) / 6, lum = Math.min(1.3, Math.max(0.35, 0.35 + 0.65 * m[i] / 128));
    ty[i] = Math.min(3, Math.max(0.15, v)) * lum; tc[i] = Math.min(1.5, Math.max(0.5, v)) * lum;
  }
  return { my: gaussBlur(ty, cw, ch, 3), mc: gaussBlur(tc, cw, ch, 3), w: cw, h: ch };
}

// 도장 심기: rgba(Uint8ClampedArray)를 제자리에서 고침. sy=밝기 세기, sc=파랑-노랑 색 세기
function embed(rgba, W, H, key, sy, sc) {
  const y = lumaOf(rgba, W, H), mk = strengthMask(y, W, H), tile = tileImage(key);
  const tp = Math.round(Math.max(W, H) / KT), k = PN / tp;
  const row = new Float32Array(tp * tp);
  for (let ty = 0; ty < tp; ty++) for (let tx = 0; tx < tp; tx++) { // 주기 경계를 고려한 양선형 보간
    const fx = tx * k, fy = ty * k, x0 = fx | 0, y0 = fy | 0, x1 = (x0 + 1) % PN, y1 = (y0 + 1) % PN, ax = fx - x0, ay = fy - y0;
    row[ty * tp + tx] = (tile[y0 * PN + x0] * (1 - ax) + tile[y0 * PN + x1] * ax) * (1 - ay) + (tile[y1 * PN + x0] * (1 - ax) + tile[y1 * PN + x1] * ax) * ay;
  }
  const mx = mk.w / W, my = mk.h / H;
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    const p = row[(yy % tp) * tp + (xx % tp)], j = (yy * W + xx) * 4;
    const dy = p * sy * bilin(mk.my, mk.w, mk.h, xx * mx, yy * my), dc = p * sc * bilin(mk.mc, mk.w, mk.h, xx * mx, yy * my);
    rgba[j] += dy; rgba[j + 1] += dy - 0.344136 * dc; rgba[j + 2] += dy + 1.772 * dc; // Uint8ClampedArray가 반올림·범위 제한
  }
}
function planesOf(rgba, W, H) { // 밝기(Y)와 파랑-노랑 색차(Cb)
  const y = new Float32Array(W * H), c = new Float32Array(W * H);
  for (let i = 0, j = 0; i < W * H; i++, j += 4) { y[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]; c[i] = -0.168736 * rgba[j] - 0.331264 * rgba[j + 1] + 0.5 * rgba[j + 2]; }
  return [y, c];
}

// 도장 찾기: planes=[밝기, 색차] 배열. 두 층의 일치도를 합쳐 판단. 반환 {z:[열쇠별 점수], p:한 칸 크기}
function detect(planes, W0, H0, keys, opt = {}) {
  const onp = opt.onProgress || (() => {}); let it = 0; const total = Math.ceil((Math.log(opt.pmax || 700) - Math.log(opt.pmin || 64)) / (opt.step || 0.002));
  const pmin = opt.pmin || 64, pmax = opt.pmax || 700, step = opt.step || 0.002, EPS = [2.0, 1.0];
  const specs = keys.map(tileSpec), best = keys.map(() => -9); let bp = 0; const NC = planes.length;
  const band = new Uint8Array(T * T), ri = new Int32Array(T * T), cnt = new Float64Array(64);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) { const f = Math.hypot(fq(y, T), fq(x, T)), i = y * T + x; ri[i] = Math.round(f); band[i] = f >= CMIN && f <= CMAX ? 1 : 0; cnt[ri[i]] += band[i]; }
  let lev = -1, W = 0, H = 0, cw = W0, ch = H0, curL = 0; let cur = planes.slice(), base = [];
  const colAcc = new Float32Array(T), fold = new Float64Array(T * T), ring = new Float64Array(64);
  const RE = planes.map(() => new Float64Array(T * T)), IM = planes.map(() => new Float64Array(T * T));
  const cr = new Float64Array(T * T), ci = new Float64Array(T * T), sum = new Float64Array(T * T);
  for (let lp = Math.log(pmin); lp < Math.log(pmax); lp += step) {
    const p = Math.exp(lp), L = Math.max(0, Math.floor(Math.log2(p / T)));
    if (++it % 40 === 0) onp(it / total);
    if (L !== lev) {
      while (curL < L) { const nw = cw >> 1, nh = ch >> 1;
        cur = cur.map(src => { const nx = new Float32Array(nw * nh);
          for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) { const a = 2 * y * cw + 2 * x; nx[y * nw + x] = (src[a] + src[a + 1] + src[a + cw] + src[a + cw + 1]) / 4; }
          return nx; });
        cw = nw; ch = nh; curL++; }
      W = cw; H = ch; lev = L;
      base = cur.map((src, c) => { const lo = gaussBlur(src, W, H, T / 4), hp = new Float32Array(W * H), sq = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) { hp[i] = src[i] - lo[i]; sq[i] = hp[i] * hp[i]; }
        const e = gaussBlur(sq, W, H, 6);
        for (let i = 0; i < W * H; i++) hp[i] = hp[i] / (Math.sqrt(Math.max(0, e[i])) + EPS[c]);
        return hp; });
    }
    const f = T / (p / (1 << L));
    if (W * f < T || H * f < T) continue;
    const bx0 = new Int32Array(W), bxa = new Float32Array(W);
    for (let x = 0; x < W; x++) { const u = x * f, k = Math.floor(u); bx0[x] = k % T; bxa[x] = u - k; }
    for (let c = 0; c < NC; c++) { // 줄이면서 바로 T×T 칸으로 접기(양선형 분배)
      const bs = base[c], re = RE[c], im = IM[c]; fold.fill(0);
      for (let y = 0; y < H; y++) {
        colAcc.fill(0); const o = y * W;
        for (let x = 0; x < W; x++) { const v = bs[o + x], a = bxa[x], b = bx0[x]; colAcc[b] += v * (1 - a); colAcc[b + 1 === T ? 0 : b + 1] += v * a; }
        const u = y * f, k = Math.floor(u), a = u - k, r0 = (k % T) * T, r1 = ((k + 1) % T) * T;
        for (let x = 0; x < T; x++) { fold[r0 + x] += colAcc[x] * (1 - a); fold[r1 + x] += colAcc[x] * a; }
      }
      for (let i = 0; i < T * T; i++) { re[i] = fold[i]; im[i] = 0; }
      fft2(re, im, T, false); ring.fill(0);
      for (let i = 0; i < T * T; i++) { if (!band[i]) { re[i] = 0; im[i] = 0; } else ring[ri[i]] += Math.hypot(re[i], im[i]); }
      for (let i = 0; i < T * T; i++) if (band[i]) { const g = ring[ri[i]] / Math.max(1, cnt[ri[i]]) + 1e-9; re[i] /= g; im[i] /= g; }
    }
    for (let kI = 0; kI < keys.length; kI++) {
      const s = specs[kI]; sum.fill(0);
      for (let c = 0; c < NC; c++) {
        const re = RE[c], im = IM[c];
        for (let i = 0; i < T * T; i++) { cr[i] = re[i] * s.re[i] + im[i] * s.im[i]; ci[i] = im[i] * s.re[i] - re[i] * s.im[i]; }
        fft2(cr, ci, T, true);
        let m = 0, v = 0; for (let i = 0; i < T * T; i++) m += cr[i]; m /= T * T;
        for (let i = 0; i < T * T; i++) v += (cr[i] - m) ** 2; v = Math.sqrt(v / (T * T)) + 1e-12;
        for (let i = 0; i < T * T; i++) sum[i] += (cr[i] - m) / v;
      }
      let mx = -1e9; for (let i = 0; i < T * T; i++) if (sum[i] > mx) mx = sum[i];
      const z = mx / Math.sqrt(NC);
      if (z > best[kI]) { best[kI] = z; if (kI === 0) bp = p; }
    }
  }
  return { z: best, p: bp };
}

// 열쇠 무늬를 눈에 보이게 그린 한 칸(신고 카드의 '드러낸 도장'용). 밝은 회색 바탕에 진하게.
function tilePreview(key, size) {
  const t = tileImage(key), c = new Float32Array(size * size), k = PN / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) c[y * size + x] = t[((y * k) | 0) * PN + ((x * k) | 0)];
  return c; // 표준편차 1 기준 값. 그릴 때 128 + v*40 정도로.
}
self.SealCore = { embed, detect, planesOf, tileImage, tilePreview, T, KT };
