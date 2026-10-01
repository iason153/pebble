'use strict';

/**
 * 저장소 (localStorage, 이 기기에만 저장 — 서버로 보내지 않음)
 *
 * getset:plan:v1    오늘 계획 { date, start, startTime, end, mode, stops[] }
 * getset:places:v1  자주 쓰는 곳 { home, recent[] }
 *
 * 저장이 막힌 브라우저(사생활 보호 모드 등)에서도 앱은 메모리 상태로 계속 동작한다.
 */
window.GetsetStore = (function () {
  const PLAN_KEY = 'getset:plan:v1';
  const PLACES_KEY = 'getset:places:v1';
  const RECENT_MAX = 12;
  const MODES = ['car', 'walk', 'bike', 'transit'];
  const STAY_MIN = 1;
  const STAY_MAX = 600;

  function todayStr(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

  function cleanPlace(p) {
    if (!p || typeof p !== 'object') return null;
    const lat = Number(p.lat);
    const lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !p.name) return null;
    return {
      id: String(p.id || ''),
      name: String(p.name).slice(0, 80),
      address: String(p.address || '').slice(0, 120),
      lat,
      lng,
      categoryCode: String(p.categoryCode || ''),
      categoryName: String(p.categoryName || ''),
    };
  }

  function cleanStop(s) {
    const place = cleanPlace(s && s.place);
    if (!place) return null;
    const stay = Math.round(Number(s.stay));
    return {
      uid: typeof s.uid === 'string' && s.uid ? s.uid : newUid(),
      place,
      kind: window.GetsetKinds.get(s.kind).id,
      stay: Number.isFinite(stay) ? Math.min(STAY_MAX, Math.max(STAY_MIN, stay)) : 30,
      fixedAt: isTime(s.fixedAt) ? s.fixedAt : null,
      deadline: isTime(s.deadline) ? s.deadline : null,
      order: s.order === 'first' || s.order === 'last' ? s.order : 'any',
      mode: MODES.includes(s.mode) ? s.mode : null, // null = 하루 기본 이동수단 따름
    };
  }

  function newUid() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function emptyPlan() {
    return { date: todayStr(), start: null, startTime: 'now', end: { type: 'return', place: null }, mode: 'car', stops: [] };
  }

  function loadPlan() {
    try {
      const raw = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return emptyPlan();
      const endType = raw.end && ['return', 'place', 'none'].includes(raw.end.type) ? raw.end.type : 'return';
      const endPlace = cleanPlace(raw.end && raw.end.place);
      return {
        date: typeof raw.date === 'string' ? raw.date : todayStr(),
        start: cleanPlace(raw.start),
        startTime: isTime(raw.startTime) ? raw.startTime : 'now',
        end: { type: endType === 'place' && !endPlace ? 'return' : endType, place: endPlace },
        mode: MODES.includes(raw.mode) ? raw.mode : 'car',
        stops: Array.isArray(raw.stops) ? raw.stops.map(cleanStop).filter(Boolean).slice(0, 12) : [],
      };
    } catch (_) {
      return emptyPlan();
    }
  }

  /** @returns {boolean} 저장 성공 여부 */
  function savePlan(plan) {
    try {
      localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
      return true;
    } catch (_) {
      return false;
    }
  }

  function loadPlaces() {
    try {
      const raw = JSON.parse(localStorage.getItem(PLACES_KEY) || 'null') || {};
      return {
        home: cleanPlace(raw.home),
        recent: Array.isArray(raw.recent) ? raw.recent.map(cleanPlace).filter(Boolean).slice(0, RECENT_MAX) : [],
      };
    } catch (_) {
      return { home: null, recent: [] };
    }
  }

  function savePlaces(places) {
    try {
      localStorage.setItem(PLACES_KEY, JSON.stringify(places));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 최근 장소 맨 앞에 추가 (같은 곳은 하나만). 현재 위치는 저장 안 함 */
  function pushRecent(places, place) {
    const p = cleanPlace(place);
    if (!p || p.id === 'current') return places;
    const same = (a) => (p.id && a.id === p.id) || (a.name === p.name && Math.abs(a.lat - p.lat) < 1e-5 && Math.abs(a.lng - p.lng) < 1e-5);
    places.recent = [p, ...places.recent.filter((a) => !same(a))].slice(0, RECENT_MAX);
    return places;
  }

  return { todayStr, isTime, newUid, emptyPlan, loadPlan, savePlan, loadPlaces, savePlaces, pushRecent, cleanStop, cleanPlace, MODES };
})();
