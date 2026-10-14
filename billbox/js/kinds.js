'use strict';

/**
 * Billbox 종류 사전
 *
 * - 고지서 종류 10종 + 직접 입력용 4종(구독·자동이체·대출·기타).
 * - re: 읽은 글자에서 종류를 알아내는 규칙(많이 맞은 종류가 이김)
 * - repeat: 기본 반복. monthly | bimonthly | quarterly | half | yearly | none
 * - months: 반기·연 1회처럼 "정해진 달"에만 오는 것 (자동차세 6·12월, 재산세 7·9월)
 * - emoji: 화면 스티커. 글자 못 읽는 사람도 그림으로 고르게.
 */
window.BillboxKinds = (function () {
  const KINDS = [
    { id: 'electric', label: '전기요금', emoji: '💡', repeat: 'monthly', re: /한국전력|한전|전기요금|전기 요금/g },
    { id: 'gas', label: '도시가스', emoji: '🔥', repeat: 'monthly', re: /도시가스|가스요금|가스 요금/g },
    { id: 'water', label: '수도요금', emoji: '🚰', repeat: 'monthly', re: /수도요금|상수도|수도 요금|수도사업/g },
    { id: 'health', label: '건강보험', emoji: '🏥', repeat: 'monthly', re: /국민건강보험|건강보험공단|건강보험료|건강 보험/g },
    { id: 'pension', label: '국민연금', emoji: '🪙', repeat: 'monthly', re: /국민연금|연금\s*보험료|연금보험료/g },
    { id: 'cartax', label: '자동차세', emoji: '🚗', repeat: 'half', months: [6, 12], re: /자동차세/g },
    { id: 'proptax', label: '재산세', emoji: '🏠', repeat: 'half', months: [7, 9], re: /재산세|지방세|구청장|시장\s*귀하/g },
    { id: 'maint', label: '관리비', emoji: '🏢', repeat: 'monthly', re: /관리비|관리사무소|입주자대표/g },
    { id: 'telecom', label: '통신비', emoji: '📱', repeat: 'monthly', re: /SKT|SK텔레콤|KT\b|LG\s*U\+|유플러스|통신요금|이동전화|인터넷요금/g },
    { id: 'fine', label: '과태료', emoji: '🚨', repeat: 'none', re: /과태료|범칙금|경찰서장|주정차/g },
    { id: 'subscribe', label: '구독', emoji: '📺', repeat: 'monthly', re: /넷플릭스|Netflix|유튜브 프리미엄|쿠팡|멜론|디즈니|구독/g },
    { id: 'transfer', label: '자동이체', emoji: '🔁', repeat: 'monthly', re: /자동이체/g },
    { id: 'loan', label: '대출 상환', emoji: '🏦', repeat: 'monthly', re: /대출|상환|원리금/g },
    { id: 'etc', label: '기타', emoji: '📄', repeat: 'none', re: null },
  ];

  /** 고지서 찍기에서 바로 고를 10종 (직접 입력에서는 14종 다 보임) */
  const BILL_IDS = ['electric', 'gas', 'water', 'health', 'pension', 'cartax', 'proptax', 'maint', 'telecom', 'fine'];

  const REPEATS = [
    { id: 'monthly', label: '매월', months: 1 },
    { id: 'bimonthly', label: '2개월마다', months: 2 },
    { id: 'quarterly', label: '3개월마다', months: 3 },
    { id: 'half', label: '6개월마다', months: 6 },
    { id: 'yearly', label: '매년', months: 12 },
    { id: 'none', label: '한 번만', months: 0 },
  ];

  function byId(id) {
    return KINDS.find((k) => k.id === id) || KINDS[KINDS.length - 1];
  }
  function repeatById(id) {
    return REPEATS.find((r) => r.id === id) || REPEATS[REPEATS.length - 1];
  }

  /** 읽은 글자 전체에서 가장 많이 나온 종류 → 없으면 null */
  function detect(text) {
    let best = null;
    let bestN = 0;
    for (const k of KINDS) {
      if (!k.re) continue;
      const n = (text.match(k.re) || []).length;
      if (n > bestN) {
        best = k;
        bestN = n;
      }
    }
    return best;
  }

  return { KINDS, BILL_IDS, REPEATS, byId, repeatById, detect };
})();
