'use strict';

/**
 * 장소 종류 + 현실 시간 기본값
 *
 * ⚠️ 아래 숫자는 설계문서 §4-1의 "초안" 그대로다. 대표가 시간을 두고 결정하기로 한
 *    핵심 엔진 값이므로 확정값이 아니다. 확정되면 이 표만 고치면 된다.
 *    (1단계에서는 "머무는 시간" 기본 선택에만 쓰이고, 도착 후·출발 준비 값은
 *     2단계 현실 시간 모델부터 쓰인다)
 *
 * arrive / leave : 도착 후 실질 시간 / 출발 준비 시간 (분)
 *   car = 자동차, light = 도보·자전거·대중교통 (주차가 빠져서 작음)
 * stay : 기본 머무는 시간 (분)
 */
window.GetsetKinds = (function () {
  const LIST = [
    { id: 'gov',      label: '관공서·주민센터',     car: [8, 5],  light: [3, 1], stay: 20 },
    { id: 'bank',     label: '은행',                car: [5, 3],  light: [2, 1], stay: 20 },
    { id: 'hospital', label: '병원·의원',           car: [7, 4],  light: [3, 1], stay: 40 },
    { id: 'mart',     label: '대형마트·창고형',     car: [12, 8], light: [4, 2], stay: 45 },
    { id: 'local',    label: '동네 마트·편의점',    car: [3, 2],  light: [1, 1], stay: 10 },
    { id: 'mall',     label: '백화점·쇼핑몰',       car: [15, 10], light: [5, 3], stay: 60 },
    { id: 'food',     label: '음식점·카페',         car: [6, 4],  light: [2, 1], stay: 50 },
    { id: 'post',     label: '우체국·택배 접수',    car: [5, 3],  light: [2, 1], stay: 15 },
    { id: 'pickup',   label: '학교·학원 픽업',      car: [5, 2],  light: [2, 1], stay: 10 },
    { id: 'office',   label: '상가·사무실(빌딩)',   car: [15, 8], light: [5, 2], stay: 30 },
    { id: 'etc',      label: '기타',                car: [7, 4],  light: [3, 1], stay: 30 },
  ];
  const BY_ID = Object.fromEntries(LIST.map((k) => [k.id, k]));

  // 이름에 이 단어가 있으면 대형마트로 본다 (카카오 MT1에는 동네 슈퍼도 섞여 있음)
  const BIG_MARTS = /(이마트|홈플러스|롯데마트|코스트코|트레이더스|하나로마트|메가마트|빅마켓|농협하나로)/;

  /**
   * 카카오 장소 검색 결과의 카테고리로 종류를 추정한다. 사용자가 언제든 바꿀 수 있음.
   * @param {{categoryCode?:string, categoryName?:string, name?:string}} p
   */
  function guess(p) {
    const code = p.categoryCode || '';
    const cat = p.categoryName || '';
    const name = p.name || '';
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

  return { LIST, get: (id) => BY_ID[id] || BY_ID.etc, guess };
})();
