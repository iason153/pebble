'use strict';

/**
 * 내 정보 (첫 실행에 받는 것) — 이 기기에만 저장 (설계문서 v1.1 §8)
 *
 * getset:profile:v1
 *   onboarded   첫 실행을 마쳤는지 (건너뛰어도 true)
 *   home        { place, parking, arriveMin, leaveMin }   집과 집 주차, "주차하고 집 안까지 / 집에서 차까지" 분
 *   places      [{ key, label, place, parking, arriveMin, leaveMin }]   회사·학교 등 자주 가는 곳
 *   mode        평소 이동수단
 *   buffer      relaxed | normal | tight   여유 성향
 *   consent     true | false | null   모두의 기록 보내기 동의 (null = 아직 안 물음)
 */
window.GetsetProfile = (function () {
  const KEY = 'getset:profile:v1';
  const MODES = ['car', 'walk', 'bike', 'transit'];
  const BUFFERS = ['relaxed', 'normal', 'tight'];

  /** 장소를 구분하는 열쇠: 카카오 장소 ID, 없으면 이름+좌표 */
  function placeKey(p) {
    if (!p) return '';
    if (p.id && p.id !== 'current') return 'k' + p.id;
    return `n${p.name}@${Number(p.lat).toFixed(4)},${Number(p.lng).toFixed(4)}`;
  }

  const num = (v, def) => {
    if (v == null || v === '') return def; // Number(null)은 0이 되므로 따로 처리
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= 120 ? n : def;
  };

  function cleanMy(x) {
    const place = window.GetsetStore.cleanPlace(x && x.place);
    if (!place) return null;
    return {
      key: placeKey(place),
      label: String((x && x.label) || '').slice(0, 20),
      place,
      parking: typeof x.parking === 'string' && /^[a-z0-9_]{1,24}$/.test(x.parking) ? x.parking : 'auto',
      arriveMin: num(x.arriveMin, null),
      leaveMin: num(x.leaveMin, null),
    };
  }

  function load() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch (_) {}
    raw = raw || {};
    const home = raw.home ? cleanMy(Object.assign({ label: '집' }, raw.home)) : null;
    return {
      onboarded: !!raw.onboarded,
      home,
      places: Array.isArray(raw.places) ? raw.places.map(cleanMy).filter(Boolean).slice(0, 20) : [],
      mode: MODES.includes(raw.mode) ? raw.mode : 'car',
      buffer: BUFFERS.includes(raw.buffer) ? raw.buffer : 'normal',
      consent: raw.consent === true ? true : raw.consent === false ? false : null,
    };
  }

  function save(p) {
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 이 장소가 집이나 내 장소면 그 정보 */
  function findMy(profile, place) {
    const k = placeKey(place);
    if (!k) return null;
    if (profile.home && profile.home.key === k) return profile.home;
    return profile.places.find((x) => x.key === k) || null;
  }

  return { load, save, placeKey, findMy, cleanMy, MODES, BUFFERS };
})();
