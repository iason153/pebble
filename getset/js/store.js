'use strict';

/**
 * 저장소 (localStorage, 이 기기에만 저장 — 서버로 보내지 않음)
 *
 * getset:plans:v2   날짜별 계획 { "2026-10-03": { date, start, startTime, end, mode, stops[] }, ... }
 * getset:places:v1  자주 쓰는 곳 { home, recent[] }
 * (예전 getset:plan:v1 하나짜리 계획은 처음 열 때 날짜별 저장으로 옮긴다)
 *
 * 저장이 막힌 브라우저(사생활 보호 모드 등)에서도 앱은 메모리 상태로 계속 동작한다.
 */
window.GetsetStore = (function () {
  const PLANS_KEY = 'getset:plans:v2';
  const OLD_PLAN_KEY = 'getset:plan:v1';
  const PLACES_KEY = 'getset:places:v1';
  const RECENT_MAX = 12;
  const KEEP_DAYS = 30; // 지난 계획은 30일 지나면 정리
  const MODES = ['car', 'walk', 'bike', 'transit'];
  const STAY_MIN = 5;
  const STAY_MAX = 600;

  function todayStr(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function parseDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(s, n) {
    const d = parseDate(s);
    d.setDate(d.getDate() + n);
    return todayStr(d);
  }

  const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

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

  function newUid() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** 근처 주차장을 골랐을 때: 주차장 이름·공영 여부·거기서 걸어가는 분 */
  function cleanLot(l) {
    const place = cleanPlace(l && l.place);
    const walk = Math.round(Number(l && l.walk));
    if (!place || !Number.isFinite(walk)) return null;
    return { place, pub: !!l.pub, walk: Math.min(30, Math.max(1, walk)) };
  }

  function cleanStop(s) {
    // 시간만 비워 둔 칸(점심 등)은 장소가 없다
    const block = s && typeof s.block === 'string' && /^[a-z]{1,12}$/.test(s.block) ? s.block : null;
    const place = block ? { id: '', name: String((s.place && s.place.name) || '식사').slice(0, 20), address: '', lat: 0, lng: 0, categoryCode: '', categoryName: '' } : cleanPlace(s && s.place);
    if (!place) return null;
    const stay = Math.round(Number(s.stay));
    // 정해진 시간은 하나만: 예약(fixedAt) / 원하는 시간(prefAt) / 문 닫는 시간(deadline)
    const fixedAt = isTime(s.fixedAt) ? s.fixedAt : null;
    const prefAt = !fixedAt && isTime(s.prefAt) ? s.prefAt : null;
    const deadline = !fixedAt && !prefAt && isTime(s.deadline) ? s.deadline : null;
    return {
      uid: typeof s.uid === 'string' && s.uid ? s.uid : newUid(),
      place,
      kind: window.GetsetKinds.get(s.kind).id,
      stay: Number.isFinite(stay) ? Math.min(STAY_MAX, Math.max(STAY_MIN, stay)) : 30,
      fixedAt,
      prefAt,
      deadline,
      order: s.order === 'first' || s.order === 'last' ? s.order : 'any',
      mode: MODES.includes(s.mode) ? s.mode : null, // null = 그날 기본 이동수단
      // auto = 장소 종류의 보통 주차장. 관리 페이지에서 새 주차장 종류를 만들 수 있으므로 모양만 검사
      ignoreHours: !!s.ignoreHours, // 이 곳은 영업시간 상관없음
      staySet: !!s.staySet, // 머무는 시간을 사용자가 직접 정했는지 (아니면 보통 값)
      near: !block && typeof s.near === 'string' && s.near ? s.near : null, // 간 김에 들르는 곳: 붙어 있는 볼일의 uid
      nearPos: s.nearPos === 'before' ? 'before' : 'after', // 그 볼일 가기 전에 / 끝나고
      block, // 'lunch' | 'dinner' | 'free' — 시간만 비우기
      task: !block && typeof s.task === 'string' && /^[a-z]{1,12}$/.test(s.task) ? s.task : null, // 할 일(약국·주유 등): 장소는 동선에 맞춰 자동으로
      pinned: !!s.pinned, // 할 일인데 사용자가 장소를 직접 고름 → 자동으로 안 바꿈
      cands: !block && Array.isArray(s.cands) ? s.cands.map(cleanPlace).filter(Boolean).slice(0, 15) : [],
      lot: !block ? cleanLot(s.lot) : null,
      parking: typeof s.parking === 'string' && /^[a-z0-9_]{1,24}$/.test(s.parking) ? s.parking : 'auto',
    };
  }

  function cleanPlan(raw, date) {
    const endType = raw && raw.end && ['return', 'place', 'none'].includes(raw.end.type) ? raw.end.type : 'return';
    const endPlace = cleanPlace(raw && raw.end && raw.end.place);
    // 'auto' = 약속 시간에 맞춰 자동으로 (v1.2 기본). 예전 '지금'도 자동으로 본다
    const startTime = raw && isTime(raw.startTime) ? raw.startTime : 'auto';
    return {
      date,
      start: cleanPlace(raw && raw.start),
      startTime,
      end: { type: endType === 'place' && !endPlace ? 'return' : endType, place: endPlace },
      mode: raw && MODES.includes(raw.mode) ? raw.mode : 'car',
      stops: raw && Array.isArray(raw.stops) ? raw.stops.map(cleanStop).filter(Boolean).slice(0, 12) : [],
      // 마지막으로 계산한 시간표(다녀온 뒤 묻기·한 군데 더에 씀)와 그 답
      sched: raw && raw.sched && typeof raw.sched === 'object' ? raw.sched : null,
      asked: raw && raw.asked && typeof raw.asked === 'object' ? raw.asked : {},
      done: raw && Array.isArray(raw.done) ? raw.done.filter((x) => typeof x === 'string').slice(0, 20) : [],
    };
  }

  /** 날짜별 계획 전체 읽기 (+ 예전 저장 옮기기, 오래된 것 정리) */
  function loadPlans() {
    let map = {};
    try {
      const raw = JSON.parse(localStorage.getItem(PLANS_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        Object.keys(raw).forEach((d) => {
          if (isDate(d)) map[d] = cleanPlan(raw[d], d);
        });
      }
      const old = JSON.parse(localStorage.getItem(OLD_PLAN_KEY) || 'null');
      if (old && isDate(old.date) && !map[old.date]) {
        map[old.date] = cleanPlan(old, old.date);
      }
      if (old) localStorage.removeItem(OLD_PLAN_KEY);
    } catch (_) {
      map = {};
    }
    const oldest = addDays(todayStr(), -KEEP_DAYS);
    Object.keys(map).forEach((d) => {
      if (d < oldest) delete map[d];
    });
    return map;
  }

  /** @returns {boolean} 저장 성공 여부. 볼일이 없고 기본값뿐인 날은 저장하지 않음 */
  function savePlans(map) {
    try {
      const out = {};
      Object.keys(map).forEach((d) => {
        const p = map[d];
        if (p.stops.length || d === todayStr()) out[d] = p;
      });
      localStorage.setItem(PLANS_KEY, JSON.stringify(out));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 그 날짜의 계획 (없으면 가장 가까운 계획의 출발지·끝·이동수단을 이어받아 새로 만듦) */
  function planFor(map, date) {
    if (map[date]) return map[date];
    const dates = Object.keys(map).sort((a, b) => Math.abs(parseDate(a) - parseDate(date)) - Math.abs(parseDate(b) - parseDate(date)));
    const near = dates.length ? map[dates[0]] : null;
    const plan = cleanPlan(near ? { start: near.start, end: near.end, mode: near.mode } : {}, date);
    map[date] = plan;
    return plan;
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

  function pushRecent(places, place) {
    const p = cleanPlace(place);
    if (!p || p.id === 'current') return places;
    const same = (a) => (p.id && a.id === p.id) || (a.name === p.name && Math.abs(a.lat - p.lat) < 1e-5 && Math.abs(a.lng - p.lng) < 1e-5);
    places.recent = [p, ...places.recent.filter((a) => !same(a))].slice(0, RECENT_MAX);
    return places;
  }

  return {
    todayStr, parseDate, addDays, isTime, newUid,
    loadPlans, savePlans, planFor, cleanStop, cleanPlace,
    loadPlaces, savePlaces, pushRecent,
    MODES, STAY_MIN, STAY_MAX,
  };
})();
