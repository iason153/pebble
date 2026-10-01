'use strict';

/**
 * Getset 현실 시간 모델 — "내비가 계산하지 않는 시간" (설계문서 §4)
 *
 * ⚠️ 아래 숫자는 전부 "초안"이다. 대표가 시간을 두고 결정하기로 한 핵심 값이므로
 *    확정값이 아니다. 숫자는 이 파일에만 있으니, 확정되면 여기만 고치면 된다.
 *
 * ── 자동차로 도착할 때 ─────────────────────────────────────────────
 *   ① 주차장 들어가서 자리 찾기    (주차장 종류별 · 주말에 붐비는 곳은 더 김)
 *   ② 주차장 → 건물 입구           (야외: 걷기 / 지하·건물: 엘리베이터 기다리기 + 올라가기)
 *   ③ 건물 안 → 볼일 시작          (장소 종류별: 번호표·접수·층 이동·카트 챙기기 등)
 * ── 자동차로 나올 때 ───────────────────────────────────────────────
 *   ④ 볼일 끝 → 건물 밖            (장소 종류별: 계산 줄·짐 싣기 등)
 *   ⑤ 건물 → 차                    (②와 같은 길을 거꾸로)
 *   ⑥ 출차                          (지하: 정산·출구 줄 / 야외·길가: 짧음)
 * ── 걷기·자전거·대중교통 ────────────────────────────────────────────
 *   주차가 빠지고 ③·④ + 입구까지 1분
 */
window.GetsetKinds = (function () {
  // 장소 종류: 머무는 시간 보통값, 건물 안 시간[들어갈 때, 나올 때], 주로 쓰는 주차장, 주말 혼잡
  const LIST = [
    { id: 'gov',      label: '관공서·주민센터',   stay: 20, inside: [3, 1], parking: 'outdoor',     busy: false, insideLabel: '번호표·창구 찾기' },
    { id: 'bank',     label: '은행',              stay: 20, inside: [2, 1], parking: 'outdoor',     busy: false, insideLabel: '번호표 뽑기' },
    { id: 'hospital', label: '병원·의원',         stay: 40, inside: [3, 2], parking: 'underground', busy: false, insideLabel: '접수하기', outsideLabel: '수납' },
    { id: 'mart',     label: '대형마트·창고형',   stay: 45, inside: [3, 4], parking: 'underground', busy: true,  insideLabel: '카트 챙기기', outsideLabel: '계산 줄·짐 싣기' },
    { id: 'local',    label: '동네 마트·편의점',  stay: 10, inside: [0, 0], parking: 'street',      busy: false },
    { id: 'mall',     label: '백화점·쇼핑몰',     stay: 60, inside: [4, 3], parking: 'underground', busy: true,  insideLabel: '매장 찾아가기', outsideLabel: '출구 찾기' },
    { id: 'food',     label: '음식점·카페',       stay: 50, inside: [1, 1], parking: 'outdoor',     busy: true,  insideLabel: '자리 잡기', outsideLabel: '계산' },
    { id: 'post',     label: '우체국·택배 접수',  stay: 15, inside: [2, 1], parking: 'outdoor',     busy: false, insideLabel: '번호표 뽑기' },
    { id: 'pickup',   label: '학교·학원 픽업',    stay: 10, inside: [1, 0], parking: 'street',      busy: false, insideLabel: '정문 앞 대기' },
    { id: 'office',   label: '상가·사무실(빌딩)', stay: 30, inside: [4, 2], parking: 'underground', busy: false, insideLabel: '엘리베이터로 층 이동', outsideLabel: '엘리베이터로 내려오기' },
    { id: 'etc',      label: '기타',              stay: 30, inside: [2, 1], parking: 'outdoor',     busy: false, insideLabel: '건물 안 이동' },
  ];
  const BY_ID = Object.fromEntries(LIST.map((k) => [k.id, k]));

  // 주차장 종류별 시간 (분)
  const PARKING = {
    outdoor: {
      label: '야외 주차장',
      desc: '건물 앞마당·옆 주차장',
      find: [['자리 찾아 주차', 2]],
      toDoor: [['입구까지 걷기', 2]],
      out: [['출차', 1]],
    },
    underground: {
      label: '지하·건물 주차장',
      desc: '층층이 내려가 자리 찾고 엘리베이터 타는 곳',
      find: [['층층이 내려가며 자리 찾기', 4]],
      toDoor: [['엘리베이터 기다리기', 2], ['엘리베이터 타고 올라가기', 1]],
      out: [['정산·출구 줄', 2]],
    },
    street: {
      label: '길가·근처 공영주차장',
      desc: '전용 주차장이 없어 근처에 세우는 곳',
      find: [['근처에 자리 찾기', 5]],
      toDoor: [['가게까지 걷기', 3]],
      out: [['출차', 1]],
    },
  };
  const PARKING_IDS = Object.keys(PARKING);

  const BUSY_WEEKEND = 2; // 주말 대형마트·백화점·음식점: 자리 찾기 2배
  const BUSY_LUNCH = 1.5; // 평일 점심(11:30~13:30) 음식점: 자리 찾기 1.5배

  // 이름에 이 단어가 있으면 대형마트로 본다 (카카오 MT1에는 동네 슈퍼도 섞여 있음)
  const BIG_MARTS = /(이마트|홈플러스|롯데마트|코스트코|트레이더스|하나로마트|메가마트|빅마켓|농협하나로)/;

  /** 카카오 장소 검색 결과로 종류 추정. 사용자가 언제든 바꿀 수 있음 */
  function guess(p) {
    const code = (p && p.categoryCode) || '';
    const cat = (p && p.categoryName) || '';
    const name = (p && p.name) || '';
    const has = (re) => re.test(cat) || re.test(name);

    if (has(/우체국|택배|편의점택배/)) return 'post';
    if (has(/주민센터|행정복지센터|시청|구청|군청|도청|등기소|세무서|법원|경찰서|소방서|출입국|운전면허시험장|건강보험공단|국민연금|고용센터/)) return 'gov';
    if (code === 'PO3') return 'gov';
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

  /**
   * 도착 후 / 출발 전 실질 시간 (단계별)
   * @param {{kind:string, parking?:string}} stop  parking: 'auto' 또는 PARKING 키
   * @param {string} mode  car | walk | bike | transit
   * @param {'arrive'|'leave'} which
   * @param {{weekend?:boolean, atMin?:number}} when
   * @returns {{total:number, parts:Array<[string, number]>, parking?:string}}
   */
  function overhead(stop, mode, which, when = {}) {
    const k = BY_ID[stop.kind] || BY_ID.etc;
    const inIdx = which === 'arrive' ? 0 : 1;
    const insideMin = k.inside[inIdx];
    const insideLabel = which === 'arrive' ? k.insideLabel : k.outsideLabel || '건물 밖으로';
    const parts = [];

    if (mode !== 'car') {
      if (which === 'arrive') parts.push(['입구까지', 1]);
      if (insideMin) parts.push([insideLabel || '건물 안 이동', insideMin]);
      return { total: sum(parts), parts };
    }

    const pid = PARKING[stop.parking] ? stop.parking : k.parking;
    const P = PARKING[pid];
    if (which === 'arrive') {
      let factor = 1;
      if (k.busy && when.weekend) factor = BUSY_WEEKEND;
      else if (k.id === 'food' && !when.weekend && when.atMin >= 690 && when.atMin <= 810) factor = BUSY_LUNCH;
      P.find.forEach(([l, m]) => parts.push([factor > 1 ? `${l}(붐빔)` : l, Math.round(m * factor)]));
      P.toDoor.forEach((x) => parts.push(x));
      if (insideMin) parts.push([insideLabel || '건물 안 이동', insideMin]);
    } else {
      if (insideMin) parts.push([insideLabel, insideMin]);
      P.toDoor.forEach(([l, m]) => parts.push([l.replace('올라가기', '내려가기').replace('입구까지 걷기', '차까지 걷기').replace('가게까지 걷기', '차까지 걷기'), m]));
      P.out.forEach((x) => parts.push(x));
    }
    return { total: sum(parts), parts, parking: pid };
  }

  // 같은 볼일·같은 조건이면 결과가 같으므로 기억해 둔다 (순서 계산 때 수만 번 불림 → 휴대폰 속도)
  const memo = new WeakMap();
  function overheadCached(stop, mode, which, when = {}) {
    const lunch = stop.kind === 'food' && !when.weekend && when.atMin >= 690 && when.atMin <= 810 && which === 'arrive';
    const key = `${mode}|${which}|${when.weekend ? 1 : 0}|${lunch ? 1 : 0}|${stop.parking || ''}|${stop.kind}`;
    let m = memo.get(stop);
    if (!m) memo.set(stop, (m = new Map()));
    let v = m.get(key);
    if (!v) m.set(key, (v = overhead(stop, mode, which, when)));
    return v;
  }

  function sum(parts) {
    return parts.reduce((a, [, m]) => a + m, 0);
  }

  return { LIST, PARKING, PARKING_IDS, get: (id) => BY_ID[id] || BY_ID.etc, guess, overhead, overheadCached };
})();
