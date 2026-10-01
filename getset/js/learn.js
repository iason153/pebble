'use strict';

/**
 * 개인 학습 — "도착 → 볼일 시작 → 끝 → 출발" 기록으로 내 실질 시간을 배운다 (설계문서 v1.1 §5-5, §6-2)
 *
 * 값 고르는 순서 (기록이 적을 땐 아래 값과 섞어 천천히 옮겨 감)
 *   이 장소 내 기록 → 이 장소 종류 내 기록 → (모두의 기록: 8단계) → 기본값(또는 내가 정한 시간)
 *   섞기: (기록수 × 가운데값 + 3 × 아래 단계 값) ÷ (기록수 + 3)
 *
 * 모두의 기록에 보낼 익명 기록은 동의한 경우에만 대기열에 쌓아 두고, 서버(8단계)가 생기면 보낸다.
 * 집·내 장소(회사 등)·현재 위치 기록은 대기열에 넣지 않는다.
 */
window.GetsetLearn = (function () {
  const KEY = 'getset:learn:v1';
  const QUEUE_KEY = 'getset:obs-queue:v1';
  const KEEP = 20; // 장소·구간마다 최근 20개만
  const K_BLEND = 3;
  const LIMITS = { a: [0, 90], l: [0, 60], s: [1, 600], t: [0, 240] };

  let db = load();

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && raw.p && raw.k) return raw;
    } catch (_) {}
    return { p: {}, k: {}, n: 0 };
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch (_) {}
  }

  const mc = (mode) => (mode === 'car' ? 'c' : 'w'); // 자동차 / 그 밖(주차 없음)

  function median(arr) {
    if (!arr || !arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function blend(arr, prior) {
    const n = arr ? arr.length : 0;
    if (!n) return prior;
    return (n * median(arr) + K_BLEND * prior) / (n + K_BLEND);
  }
  function slot(root, key, m) {
    root[key] = root[key] || {};
    root[key][m] = root[key][m] || { a: [], l: [] };
    root[key].s = root[key].s || [];
    return root[key];
  }
  function push(arr, v, lim) {
    if (!Number.isFinite(v) || v < lim[0] || v > lim[1]) return;
    arr.push(Math.round(v * 10) / 10);
    if (arr.length > KEEP) arr.splice(0, arr.length - KEEP);
  }

  /**
   * 한 방문지 기록 저장
   * @param {{key:string, kind:string, mode:string, arrive?:number, leave?:number, stay?:number}} r  분 단위, 없는 구간은 생략
   */
  function add(r) {
    const m = mc(r.mode);
    const P = slot(db.p, r.key, m);
    const Kd = slot(db.k, r.kind, m);
    if (r.arrive != null) {
      push(P[m].a, r.arrive, LIMITS.a);
      push(Kd[m].a, r.arrive, LIMITS.a);
    }
    if (r.leave != null) {
      push(P[m].l, r.leave, LIMITS.l);
      push(Kd[m].l, r.leave, LIMITS.l);
    }
    if (r.stay != null) {
      push(P.s, r.stay, LIMITS.s);
      push(Kd.s, r.stay, LIMITS.s);
    }
    db.n = (db.n || 0) + 1;
    save();
  }

  /**
   * 도착 후(a) / 출발 전(l) 실질 시간 추정
   * @returns {{total:number, n:number, kn:number}}  n = 이 장소 기록 수, kn = 이 종류 기록 수
   */
  function estimate(key, kind, mode, which, prior) {
    const m = mc(mode);
    const kArr = db.k[kind] && db.k[kind][m] ? db.k[kind][m][which] : [];
    const pArr = db.p[key] && db.p[key][m] ? db.p[key][m][which] : [];
    const kindEst = blend(kArr, prior);
    const est = blend(pArr, kindEst);
    return { total: Math.max(0, Math.round(est)), n: pArr.length, kn: kArr.length };
  }

  /** 이 장소에서 실제로 머문 시간 (기록 2회 이상일 때만) */
  function stayHint(key) {
    const arr = db.p[key] && db.p[key].s;
    return arr && arr.length >= 2 ? { median: Math.round(median(arr)), n: arr.length } : null;
  }

  function summary() {
    return { visits: db.n || 0, places: Object.keys(db.p).length };
  }

  function clear() {
    db = { p: {}, k: {}, n: 0 };
    save();
  }

  // ---- 모두의 기록 대기열 (동의한 경우만, 8단계 서버가 생기면 전송) ----
  function queueObs(obs) {
    try {
      const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
      q.push(obs);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-200)));
    } catch (_) {}
  }
  function queueSize() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]').length;
    } catch (_) {
      return 0;
    }
  }
  function clearQueue() {
    localStorage.removeItem(QUEUE_KEY);
  }

  return { add, estimate, stayHint, summary, clear, queueObs, queueSize, clearQueue, median };
})();
