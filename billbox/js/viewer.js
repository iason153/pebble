'use strict';

/**
 * 고지서 보기 — 두 손가락 확대/이동, 두 번 톡 확대, 버튼(－ 맞춤 ＋ ⟳).
 * 브라우저 전체 확대가 아니라 사진만 확대되게 직접 처리한다(포인터 이벤트).
 */
window.BillboxViewer = (function () {
  const $ = (id) => document.getElementById(id);
  let img, stage;
  let s = 1, x = 0, y = 0, rot = 0, fit = 1;
  const pts = new Map();
  let pinch = null;
  let lastTap = 0;
  let url = null;

  function apply() {
    // 회전은 가운데 기준, 확대·이동은 왼쪽 위 기준
    img.style.transform = `translate(${x}px, ${y}px) scale(${s}) rotate(${rot}deg)`;
  }
  function natural() {
    const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
    return rot % 180 === 0 ? { w, h } : { w: h, h: w };
  }
  function doFit() {
    const r = stage.getBoundingClientRect();
    const n = natural();
    fit = Math.min(r.width / n.w, r.height / n.h);
    s = fit;
    center();
  }
  function center() {
    const r = stage.getBoundingClientRect();
    const n = natural();
    // 회전하면 사진의 시각적 왼쪽 위가 달라지므로 보정
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    let ox = 0, oy = 0;
    if (rot === 90) ox = h;
    else if (rot === 180) { ox = w; oy = h; }
    else if (rot === 270) oy = w;
    x = (r.width - n.w * s) / 2 + ox - r.width / 2;
    y = (r.height - n.h * s) / 2 + oy - r.height / 2;
    apply();
  }
  /** (cx, cy) 화면 점을 기준으로 배율 바꾸기 */
  function zoomAt(ns, cx, cy) {
    ns = Math.max(fit * 0.8, Math.min(fit * 8, ns));
    const r = stage.getBoundingClientRect();
    const px = cx - r.left - r.width / 2, py = cy - r.top - r.height / 2;
    x = px - ((px - x) * ns) / s;
    y = py - ((py - y) * ns) / s;
    s = ns;
    apply();
  }
  function midRect() {
    const r = stage.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  function wire() {
    if (img) return;
    img = $('viewer-img');
    stage = $('viewer-stage');
    img.addEventListener('load', () => {
      rot = 0;
      doFit();
    });
    stage.addEventListener('pointerdown', (e) => {
      stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s };
      }
      const now = Date.now();
      if (pts.size === 1 && now - lastTap < 300) {
        zoomAt(s > fit * 1.3 ? fit : fit * 2.5, e.clientX, e.clientY);
        if (s === fit) center();
        lastTap = 0;
      } else lastTap = now;
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      const cur = { x: e.clientX, y: e.clientY };
      pts.set(e.pointerId, cur);
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt((pinch.s * d) / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      } else if (pts.size === 1) {
        x += cur.x - prev.x;
        y += cur.y - prev.y;
        apply();
      }
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
    };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomAt(s * (e.deltaY < 0 ? 1.15 : 0.87), e.clientX, e.clientY);
    }, { passive: false });
    $('vw-in').addEventListener('click', () => zoomAt(s * 1.4, ...midRect()));
    $('vw-out').addEventListener('click', () => zoomAt(s / 1.4, ...midRect()));
    $('vw-fit').addEventListener('click', doFit);
    $('vw-rot').addEventListener('click', () => {
      rot = (rot + 90) % 360;
      doFit();
    });
    window.addEventListener('resize', () => {
      if (!$('viewer').hidden) doFit();
    });
  }

  /** blob 사진 보기. openSheet/closeSheet는 앱의 것을 써서 뒤로가기로 닫히게 */
  function open(blob, title, openSheet) {
    wire();
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(blob);
    $('viewer-title').textContent = title || '고지서';
    openSheet($('viewer'));
    img.src = url;
    if (img.complete && img.naturalWidth) requestAnimationFrame(doFit);
  }

  return { open };
})();
