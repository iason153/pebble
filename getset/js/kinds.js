'use strict';

/**
 * Getset 현실 시간 모델 — "내비가 계산하지 않는 시간" (설계문서 v1.1 §5)
 *
 * 숫자는 이제 코드가 아니라 값 파일 data/model.json 에 있다.
 *   - 대표가 관리 페이지(/getset/admin/)에서 고치고 → 값 파일을 내려받아 → 깃허브에 올리면 반영
 *   - 관리 페이지의 "이 폰에서만 먼저 적용"을 누르면 그 기기에서만 새 값으로 계산(업로드 전 시험용)
 *   - 값 파일을 못 읽으면 아래 BUILTIN(처음 값)으로 계산 — 서비스는 멈추지 않음
 *
 * ── 자동차로 도착할 때 ①자리 찾기 ②주차장→입구 ③건물 안(접수 등)
 * ── 자동차로 나올 때 ④건물 밖으로 ⑤입구→차 ⑥출차
 * ── 걷기·자전거·대중교통: 주차가 빠지고 ③·④ + 입구까지 1분
 */
window.GetsetKinds = (function () {
  const OVERRIDE_KEY = 'getset:model-override:v1';
  const BUILTIN = {"version": 2, "updated": "2026-10-04", "notes": [{"date": "2026-10-01", "version": 1, "text": "첫 값(초안). 현장 측정 전 — 대표 확정 필요"}, {"date": "2026-10-04", "version": 2, "text": "할 일 넣기용 종류 추가: 약국·현금 찾기·주유소, 주차 '차에서 바로'. 값은 초안"}], "parking": {"outdoor": {"label": "야외 주차장", "desc": "건물 앞마당·옆 주차장", "find": [["자리 찾아 주차", 2]], "toDoor": [["입구까지 걷기", 2]], "toCar": [["차까지 걷기", 2]], "out": [["출차", 1]]}, "pilotis": {"label": "필로티(1층) 주차장", "desc": "건물 1층 기둥 사이에 세우는 곳", "find": [["1층에 주차", 1]], "toDoor": [["현관까지", 1]], "toCar": [["차까지", 1]], "out": [["출차", 1]]}, "underground": {"label": "지하·건물 주차장", "desc": "층층이 내려가 자리 찾고 엘리베이터 타는 곳", "find": [["층층이 내려가며 자리 찾기", 4]], "toDoor": [["엘리베이터 기다리기", 2], ["엘리베이터 타고 올라가기", 1]], "toCar": [["엘리베이터 기다리기", 2], ["엘리베이터 타고 내려가기", 1]], "out": [["정산·출구 줄", 2]]}, "mechanical": {"label": "기계식 주차장", "desc": "차를 넣으면 기계가 올려 주는 곳", "find": [["입고 차례 기다리기", 5]], "toDoor": [["입구까지 걷기", 1]], "toCar": [["출고 기다리기", 5]], "out": [["출차", 1]]}, "street": {"label": "길가·근처 공영주차장", "desc": "전용 주차장이 없어 근처에 세우는 곳", "find": [["근처에 자리 찾기", 5]], "toDoor": [["가게까지 걷기", 3]], "toCar": [["차까지 걷기", 3]], "out": [["출차", 1]]}, "drivein": {"label": "차에서 바로 (주유소 등)", "desc": "주차 없이 차를 세우고 바로 볼일을 보는 곳", "find": [["차 세우기", 1]], "toDoor": [], "toCar": [], "out": [["출차", 1]]}}, "kinds": [{"id": "gov", "label": "관공서·주민센터", "stay": 20, "inside": [3, 1], "insideLabel": "번호표·창구 찾기", "outsideLabel": "건물 밖으로", "parking": "outdoor", "busy": false, "hours": {"weekday": ["09:00", "18:00"], "sat": null, "sun": null, "breaks": []}}, {"id": "bank", "label": "은행", "stay": 20, "inside": [2, 1], "insideLabel": "번호표 뽑기", "outsideLabel": "건물 밖으로", "parking": "outdoor", "busy": false, "hours": {"weekday": ["09:00", "16:00"], "sat": null, "sun": null, "breaks": []}}, {"id": "hospital", "label": "병원·의원", "stay": 40, "inside": [3, 2], "insideLabel": "접수하기", "outsideLabel": "수납", "parking": "underground", "busy": false, "hours": {"weekday": ["09:00", "18:00"], "sat": ["09:00", "13:00"], "sun": null, "breaks": [["12:30", "13:30"]]}}, {"id": "mart", "label": "대형마트·창고형", "stay": 45, "inside": [3, 4], "insideLabel": "카트 챙기기", "outsideLabel": "계산 줄·짐 싣기", "parking": "underground", "busy": true, "hours": {"weekday": ["10:00", "22:00"], "sat": ["10:00", "22:00"], "sun": ["10:00", "22:00"], "breaks": []}}, {"id": "local", "label": "동네 마트·편의점", "stay": 10, "inside": [0, 0], "insideLabel": "", "outsideLabel": "", "parking": "street", "busy": false, "hours": null}, {"id": "mall", "label": "백화점·쇼핑몰", "stay": 60, "inside": [4, 3], "insideLabel": "매장 찾아가기", "outsideLabel": "출구 찾기", "parking": "underground", "busy": true, "hours": {"weekday": ["10:30", "20:00"], "sat": ["10:30", "20:00"], "sun": ["10:30", "20:00"], "breaks": []}}, {"id": "food", "label": "음식점·카페", "stay": 50, "inside": [1, 1], "insideLabel": "자리 잡기", "outsideLabel": "계산", "parking": "outdoor", "busy": true, "hours": null}, {"id": "post", "label": "우체국·택배 접수", "stay": 15, "inside": [2, 1], "insideLabel": "번호표 뽑기", "outsideLabel": "건물 밖으로", "parking": "outdoor", "busy": false, "hours": {"weekday": ["09:00", "18:00"], "sat": null, "sun": null, "breaks": []}}, {"id": "pickup", "label": "학교·학원 픽업", "stay": 10, "inside": [1, 0], "insideLabel": "정문 앞 대기", "outsideLabel": "", "parking": "street", "busy": false, "hours": null}, {"id": "office", "label": "상가·사무실(빌딩)", "stay": 30, "inside": [4, 2], "insideLabel": "엘리베이터로 층 이동", "outsideLabel": "엘리베이터로 내려오기", "parking": "underground", "busy": false, "hours": null}, {"id": "pharmacy", "label": "약국", "stay": 10, "inside": [1, 0], "insideLabel": "차례 기다리기", "outsideLabel": "", "parking": "street", "busy": false, "hours": {"weekday": ["09:00", "19:00"], "sat": ["09:00", "14:00"], "sun": null, "breaks": []}}, {"id": "atm", "label": "현금 찾기(ATM)", "stay": 5, "inside": [1, 0], "insideLabel": "ATM 차례 기다리기", "outsideLabel": "", "parking": "street", "busy": false, "hours": null}, {"id": "gas", "label": "주유소", "stay": 7, "inside": [0, 0], "insideLabel": "", "outsideLabel": "", "parking": "drivein", "busy": false, "hours": null}, {"id": "etc", "label": "기타", "stay": 30, "inside": [2, 1], "insideLabel": "건물 안 이동", "outsideLabel": "건물 밖으로", "parking": "outdoor", "busy": false, "hours": null}, {"id": "home", "label": "집", "stay": 30, "inside": [1, 1], "insideLabel": "집 안으로", "outsideLabel": "나갈 준비", "parking": "pilotis", "busy": false, "hours": null, "hidden": true}], "busy": {"weekendFactor": 2, "lunchFactor": 1.5, "lunchFrom": "11:30", "lunchTo": "13:30"}, "travel": {"walkMpm": 70, "bikeMpm": 250, "detour": 1.3, "transitWait": 8, "transitAccess": 6, "transitKmh": 20, "transitDetour": 1.4, "carBase": 2, "carDetour": 1.35, "carCityMpm": 350, "carMidMpm": 500, "carFarMpm": 800, "nearWalkM": 150}, "pref": {"tolerance": 10, "weight": 3}, "meals": {"lunch": {"from": "11:30", "to": "13:30", "stay": 50}, "dinner": {"from": "17:30", "to": "19:30", "stay": 60}}, "buffer": {"relaxed": {"label": "넉넉하게", "travelPct": 15, "perStop": 5}, "normal": {"label": "보통", "travelPct": 5, "perStop": 0}, "tight": {"label": "딱 맞게", "travelPct": 0, "perStop": 0}}, "homeSuggest": {"minRest": 30}, "lot": {"find": 3, "out": 2}};

  let M = BUILTIN;
  let source = 'builtin'; // builtin | file | override
  let memo = new WeakMap();
  let lunchFrom = 690;
  let lunchTo = 810;

  const toMin = (t) => {
    if (typeof t !== 'string' || !/^\d{2}:\d{2}$/.test(t)) return null;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const num = (v, lo, hi, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };

  /** 값 파일 모양이 맞는지 검사하고 숫자 범위를 다듬는다. 틀리면 null */
  function validate(raw) {
    try {
      if (!raw || typeof raw !== 'object' || !raw.parking || !Array.isArray(raw.kinds)) return null;
      const steps = (arr) => (Array.isArray(arr) ? arr.filter((x) => Array.isArray(x) && x.length === 2).map(([l, m]) => [String(l).slice(0, 40), num(m, 0, 120, 0)]) : []);
      const parking = {};
      Object.keys(raw.parking).forEach((id) => {
        if (!/^[a-z0-9_]{1,24}$/.test(id)) return;
        const p = raw.parking[id];
        parking[id] = { label: String(p.label || id).slice(0, 30), desc: String(p.desc || '').slice(0, 60), find: steps(p.find), toDoor: steps(p.toDoor), toCar: steps(p.toCar || p.toDoor), out: steps(p.out) };
      });
      if (!Object.keys(parking).length) return null;
      const kinds = raw.kinds
        .filter((k) => k && /^[a-z0-9_]{1,24}$/.test(k.id))
        .map((k) => ({
          id: k.id,
          label: String(k.label || k.id).slice(0, 30),
          stay: num(k.stay, 5, 600, 30),
          inside: [num(k.inside && k.inside[0], 0, 120, 0), num(k.inside && k.inside[1], 0, 120, 0)],
          insideLabel: String(k.insideLabel || '').slice(0, 30),
          outsideLabel: String(k.outsideLabel || '').slice(0, 30),
          parking: parking[k.parking] ? k.parking : Object.keys(parking)[0],
          busy: !!k.busy,
          hours: k.hours || null,
          hidden: !!k.hidden,
        }));
      if (!kinds.find((k) => k.id === 'etc')) return null;
      const out = Object.assign({}, BUILTIN, raw, { parking, kinds });
      out.busy = Object.assign({}, BUILTIN.busy, raw.busy || {});
      out.travel = Object.assign({}, BUILTIN.travel, raw.travel || {});
      out.pref = Object.assign({}, BUILTIN.pref, raw.pref || {});
      out.meals = Object.assign({}, BUILTIN.meals, raw.meals || {});
      out.buffer = Object.assign({}, BUILTIN.buffer, raw.buffer || {});
      out.homeSuggest = Object.assign({}, BUILTIN.homeSuggest, raw.homeSuggest || {});
      out.lot = { find: num(raw.lot && raw.lot.find, 0, 30, BUILTIN.lot.find), out: num(raw.lot && raw.lot.out, 0, 30, BUILTIN.lot.out) };
      return out;
    } catch (_) {
      return null;
    }
  }

  function use(model, src) {
    M = model;
    source = src;
    memo = new WeakMap(); // 값이 바뀌었으니 기억해 둔 계산은 버림
    lunchFrom = toMin(model.busy.lunchFrom);
    lunchTo = toMin(model.busy.lunchTo);
    try {
      window.dispatchEvent(new CustomEvent('getset:model', { detail: { source: src, version: model.version } }));
    } catch (_) {}
  }

  /** 앱 시작 때 한 번: 관리자 시험 값 → 값 파일 → 처음 값 순서 */
  const ready = (async function load() {
    try {
      const o = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || 'null');
      const v = o && validate(o);
      if (v) {
        use(v, 'override');
        return;
      }
    } catch (_) {}
    try {
      const url = new URL('data/model.json', window.location.href.replace(/admin\/.*$/, '').replace(/[^/]*$/, ''));
      const res = await fetch(url.toString(), { cache: 'no-cache' });
      if (res.ok) {
        const v = validate(await res.json());
        if (v) use(v, 'file');
      }
    } catch (_) {
      /* 오프라인이면 처음 값으로 */
    }
  })();

  const BY = () => Object.fromEntries(M.kinds.map((k) => [k.id, k]));

  // 이름에 이 단어가 있으면 대형마트로 본다 (카카오 MT1에는 동네 슈퍼도 섞여 있음)
  const BIG_MARTS = /(이마트|홈플러스|롯데마트|코스트코|트레이더스|하나로마트|메가마트|빅마켓|농협하나로)/;

  /** 카카오 장소 검색 결과로 종류 추정. 사용자가 언제든 바꿀 수 있음 */
  function guess(p) {
    const code = (p && p.categoryCode) || '';
    const cat = (p && p.categoryName) || '';
    const name = (p && p.name) || '';
    const has = (re) => re.test(cat) || re.test(name);
    const by = (id, fallback) => (M.kinds.some((k) => k.id === id) ? id : fallback); // 옛 값 파일엔 없을 수 있음
    if (has(/우체국|택배|편의점택배/)) return 'post';
    if (has(/주민센터|행정복지센터|시청|구청|군청|도청|등기소|세무서|법원|경찰서|소방서|출입국|운전면허시험장|건강보험공단|국민연금|고용센터/)) return 'gov';
    if (code === 'PO3') return 'gov';
    if (code === 'PM9' || has(/약국/)) return by('pharmacy', 'local');
    if (code === 'OL7' || has(/주유소|충전소/)) return by('gas', 'etc');
    if (code === 'BK9' || has(/은행|새마을금고|신협|우체국금융/)) return 'bank';
    if (code === 'HP8' || has(/병원|의원|치과|한의원|보건소/)) return 'hospital';
    if (has(/백화점|쇼핑몰|아울렛|복합쇼핑|스타필드/)) return 'mall';
    if (code === 'MT1') return BIG_MARTS.test(name) ? 'mart' : 'local';
    if (code === 'CS2' || has(/슈퍼마켓|편의점|정육점|반찬/)) return 'local';
    if (code === 'FD6' || code === 'CE7') return 'food';
    if (code === 'SC4' || code === 'AC5' || has(/어린이집|유치원|학교|학원/)) return 'pickup';
    if (has(/빌딩|오피스|사무소|타워|센터빌딩/)) return 'office';
    return 'etc';
  }

  function get(id) {
    const by = BY();
    return by[id] || by.etc;
  }

  /**
   * 도착 후 / 출발 전 실질 시간 (단계별)
   * @param {{kind:string, parking?:string}} stop  parking: 'auto' 또는 주차장 종류 id
   * @param {string} mode  car | walk | bike | transit
   * @param {'arrive'|'leave'} which
   * @param {{weekend?:boolean, atMin?:number}} when
   * @returns {{total:number, parts:Array<[string, number]>, parking?:string}}
   */
  function overhead(stop, mode, which, when = {}, model = M) {
    const kinds = Object.fromEntries(model.kinds.map((k) => [k.id, k]));
    const k = kinds[stop.kind] || kinds.etc;
    const arrive = which === 'arrive';
    const insideMin = k.inside[arrive ? 0 : 1];
    const insideLabel = (arrive ? k.insideLabel : k.outsideLabel) || (arrive ? '건물 안 이동' : '건물 밖으로');
    const parts = [];

    if (mode !== 'car') {
      if (arrive) parts.push(['입구까지', 1]);
      if (insideMin) parts.push([insideLabel, insideMin]);
      return { total: sum(parts), parts };
    }

    const pid = model.parking[stop.parking] ? stop.parking : model.parking[k.parking] ? k.parking : Object.keys(model.parking)[0];
    const P = model.parking[pid];
    if (arrive) {
      const b = model.busy;
      let factor = 1;
      const lf = toMin(b.lunchFrom);
      const lt = toMin(b.lunchTo);
      if (k.busy && when.weekend) factor = num(b.weekendFactor, 1, 5, 1);
      else if (k.id === 'food' && !when.weekend && lf != null && when.atMin >= lf && when.atMin <= lt) factor = num(b.lunchFactor, 1, 5, 1);
      P.find.forEach(([l, m]) => parts.push([factor > 1 ? `${l}(붐빔)` : l, Math.round(m * factor)]));
      P.toDoor.forEach((x) => parts.push(x));
      if (insideMin) parts.push([insideLabel, insideMin]);
    } else {
      if (insideMin) parts.push([insideLabel, insideMin]);
      P.toCar.forEach((x) => parts.push(x));
      P.out.forEach((x) => parts.push(x));
    }
    return { total: sum(parts.filter(([, m]) => m > 0)), parts: parts.filter(([, m]) => m > 0), parking: pid };
  }

  /** 같은 볼일·같은 조건이면 결과가 같으므로 기억해 둔다 (순서 계산 때 수만 번 불림) */
  function overheadCached(stop, mode, which, when = {}) {
    const lunch = which === 'arrive' && stop.kind === 'food' && !when.weekend && when.atMin >= lunchFrom && when.atMin <= lunchTo;
    // 볼일마다 따로 기억하므로 종류·주차는 열쇠에 넣을 필요 없음 (볼일을 고치면 새 객체가 됨)
    const key = (mode === 'car' ? 0 : mode === 'walk' ? 1 : mode === 'bike' ? 2 : 3) * 8 + (which === 'arrive' ? 4 : 0) + (when.weekend ? 2 : 0) + (lunch ? 1 : 0);
    let m = memo.get(stop);
    if (!m) memo.set(stop, (m = new Map()));
    let v = m.get(key);
    if (!v) m.set(key, (v = overhead(stop, mode, which, when)));
    return v;
  }

  function sum(parts) {
    return parts.reduce((a, [, m]) => a + m, 0);
  }

  return {
    ready,
    validate,
    BUILTIN,
    OVERRIDE_KEY,
    get model() { return M; },
    get source() { return source; },
    get LIST() { return M.kinds.filter((k) => !k.hidden); },
    get PARKING() { return M.parking; },
    get PARKING_IDS() { return Object.keys(M.parking); },
    get travelParams() { return M.travel; },
    get prefParams() { return M.pref; },
    get,
    guess,
    overhead,
    overheadCached,
    toMin,
    /** 관리 페이지: 이 기기에서만 시험 적용 / 해제 */
    setOverride(model) {
      const v = validate(model);
      if (!v) return false;
      localStorage.setItem(OVERRIDE_KEY, JSON.stringify(model));
      use(v, 'override');
      return true;
    },
    clearOverride() {
      localStorage.removeItem(OVERRIDE_KEY);
    },
  };
})();
