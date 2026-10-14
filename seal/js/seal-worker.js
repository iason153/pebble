'use strict';
/** Seal 워커 — 화면이 멈추지 않도록 도장 심기·찾기 계산을 따로 돌린다. */
importScripts('seal-core.js');
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'embed') {
      const rgba = new Uint8ClampedArray(m.buf);
      SealCore.embed(rgba, m.w, m.h, m.key, m.sy, m.sc);
      self.postMessage({ id: m.id, done: true, buf: rgba.buffer }, [rgba.buffer]);
      return;
    }
    const planes = m.planes.map((b) => new Float32Array(b));
    const r = SealCore.detect(planes, m.w, m.h, m.keys, Object.assign({}, m.opt, { onProgress: (p) => self.postMessage({ id: m.id, progress: p }) }));
    self.postMessage({ id: m.id, done: true, z: r.z, p: r.p });
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err && err.message) || err) });
  }
};
