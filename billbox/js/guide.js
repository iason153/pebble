'use strict';

/**
 * Billbox 설명서 — 종류 × 단계별 안내, 늦으면 붙는 돈, "이렇게 하면 깎여요".
 *
 * 원칙
 * - 참고용이다. 고지서에 적힌 내용이 항상 우선. 세무·법률 상담 아님(화면에도 표기).
 * - 숫자는 확인된 것만 쓴다. 확인 안 된 비율은 숫자 대신 "고지서·발행처 확인"으로 적는다.
 * - 출처·확인 시점을 함께 둔다(CHECKED). 분기마다 다시 확인할 것.
 *
 * 확인한 근거(2026-10-15)
 * - 지방세 납부지연가산세: 미납 즉시 3%, 45만원 이상이면 1개월마다 0.66% 추가(최대 60개월)
 *   → 대표가 받은 안산시 재산세 독촉장 문구(지방세기본법 제55·56조) 그대로.
 * - 건강보험 연체금: 첫 달 2%, 이후 매월 0.5%p, 상한 5% (2020.1.16 개정, 서울신문 2020.1.2 보도).
 * - 과태료: 기한 지나면 가산금 3%, 이후 1개월마다 1.2% 중가산금(최대 60개월) — 질서위반행위규제법 제24조.
 *   의견제출 기한 안에 자진납부하면 최대 20% 감경할 수 있음("할 수 있다" 조항) — 같은 법 제18조.
 * - 지방세 전자송달·자동이체 공제: 각 건당 800원, 둘 다 1,600원(2022년 인상, 뉴스서울 2022.9 보도) — 지자체 확인 필요.
 * - 건강보험·국민연금 자동이체·이메일 고지 감액: 최대 월 830원 — 대표가 받은 건보공단 고지서 문구.
 * - 자동차세 1월 연납 5% 공제(2026, 3·6·9월도 가능하나 할인 줄어듦) — 헤럴드경제 2026.1 보도.
 * - 통신비 선택약정 25% 요금할인 — 과기정통부 제도(2017~).
 */
window.BillboxGuide = (function () {
  const CHECKED = '2026년 10월 확인';
  const won = (n) => Math.round(n).toLocaleString('ko-KR');

  // 종류 → 무리(설명이 같은 묶음)
  const GROUP = {
    proptax: 'localtax',
    cartax: 'localtax',
    health: 'nhis',
    pension: 'pension',
    electric: 'utility',
    gas: 'utility',
    water: 'utility',
    telecom: 'telecom',
    maint: 'maint',
    rent: 'rent',
    fine: 'fine',
    loan: 'loan',
    insurance: 'insurance',
    subscribe: 'subscribe',
    transfer: 'transfer',
    academy: 'etc',
    etc: 'etc',
  };

  /**
   * 늦으면 붙는 돈(어림). amount: 원, daysOver: 마감 지난 일수(0이면 "지금 안 내면")
   * @returns {{short:string, text:string, extra:number|null}|null}
   */
  function lateFee(kindId, amount, daysOver) {
    const g = GROUP[kindId] || 'etc';
    const months = Math.max(0, Math.floor((daysOver || 0) / 30));
    if (g === 'localtax') {
      if (!amount) return { short: '가산세 3%', text: '기한을 넘기면 바로 3%가 붙어요. 45만원 이상이면 한 달마다 0.66%씩 더 붙어요(최대 60개월).', extra: null };
      let rate = 0.03;
      if (amount >= 450000) rate += 0.0066 * Math.min(60, months);
      const extra = Math.floor(amount * rate);
      return { short: `+${won(extra)}원`, text: `기한을 넘기면 바로 3%(${won(amount * 0.03)}원)가 붙어요.${amount >= 450000 ? ' 45만원 이상이라 한 달마다 0.66%씩 더 붙어요(최대 60개월).' : ' 45만원 미만이라 그 뒤로는 더 안 붙어요.'}`, extra };
    }
    if (g === 'nhis') {
      if (!amount) return { short: '연체금 2%~', text: '기한을 넘기면 첫 달 2%, 그 뒤 한 달마다 0.5%씩 늘어 최대 5%까지 붙어요.', extra: null };
      const rate = Math.min(0.05, 0.02 + 0.005 * months);
      const extra = Math.floor(amount * rate);
      return { short: `+${won(extra)}원`, text: `기한을 넘기면 첫 달 2%(${won(amount * 0.02)}원), 그 뒤 한 달마다 0.5%씩 늘어 최대 5%(${won(amount * 0.05)}원)까지 붙어요.`, extra };
    }
    if (g === 'fine') {
      if (!amount) return { short: '가산금 3%~', text: '기한을 넘기면 3%, 그 뒤 한 달마다 1.2%씩 더 붙어요(최대 60개월).', extra: null };
      const rate = 0.03 + 0.012 * Math.min(60, months);
      const extra = Math.floor(amount * rate);
      return { short: `+${won(extra)}원`, text: `기한을 넘기면 3%(${won(amount * 0.03)}원), 그 뒤 한 달마다 1.2%씩 더 붙어요(최대 60개월).`, extra };
    }
    if (g === 'pension') return { short: '연체금', text: '기한을 넘기면 연체금이 붙어요. 정확한 금액은 국민연금 고객센터(국번 없이 1355)나 고지서에서 확인하세요.', extra: null };
    if (g === 'utility' || g === 'telecom') return { short: '연체료', text: '기한을 넘기면 연체료가 붙을 수 있어요. 비율은 발행처마다 달라서 고지서 뒷면이나 고객센터에서 확인하세요.', extra: null };
    if (g === 'maint') return { short: '연체료', text: '관리비는 관리규약에 따라 연체료가 붙을 수 있어요. 관리사무소에 확인하세요.', extra: null };
    if (g === 'loan') return { short: '연체이자', text: '하루라도 밀리면 연체이자가 붙고, 오래 밀리면 신용점수에 영향을 줄 수 있어요.', extra: null };
    if (g === 'subscribe' || g === 'transfer' || g === 'insurance') return { short: '', text: '잔액이 모자라면 결제가 안 되고, 서비스가 멈추거나 보장이 끊길 수 있어요.', extra: null };
    if (g === 'rent') return { short: '', text: '월세가 밀리면 계약 문제로 번질 수 있어요. 늦어질 것 같으면 미리 연락하세요.', extra: null };
    return null;
  }

  /** 단계: normal | overdue | dunning(독촉) | seizure(압류예고) */
  function stageOf(item, daysLeft) {
    if (item.tag === '압류예고') return 'seizure';
    if (item.tag === '독촉') return 'dunning';
    if (daysLeft < 0) return 'overdue';
    return 'normal';
  }

  const CONTACT = {
    localtax: '구청·시청 세무과(고지서의 문의처) 또는 위택스(wetax.go.kr)',
    nhis: '국민건강보험공단 1577-1000',
    pension: '국민연금공단 국번 없이 1355',
    utility: '고지서에 적힌 고객센터',
    telecom: '통신사 고객센터(휴대폰 114)',
    maint: '관리사무소',
    fine: '고지서를 보낸 기관(경찰서·구청 등)',
    loan: '대출받은 금융사',
  };

  /** 단계별 설명 카드 { tone, title, lines[] } */
  function stageCard(item, daysLeft) {
    const g = GROUP[item.kindId] || 'etc';
    const st = stageOf(item, daysLeft);
    const contact = CONTACT[g];
    const L = [];
    if (st === 'seizure') {
      L.push('여러 번 안내했는데 안 내서 "압류하겠다"고 미리 알리는 단계예요. 고지서에 적힌 기한까지 내면 압류 전에 멈춰요.');
      if (g === 'nhis' || g === 'pension') L.push('3회 이상 밀린 보험료는 밀린 횟수만큼(최장 24회) 나눠 낼 수 있어요. 한 번에 어렵다면 먼저 전화해 보세요.');
      if (g === 'localtax') L.push('형편이 어려우면 구청 세무과에 나눠 내기·미루기(징수유예)를 상담할 수 있어요.');
      L.push('기한이 지나면 예금·급여·자동차 등이 압류될 수 있어요.');
      if (contact) L.push(`문의: ${contact}`);
      return { tone: 'red', title: '⚠️ 압류 예고 단계', lines: L };
    }
    if (st === 'dunning') {
      L.push('원래 기한이 지나서 "다시 한번 내 주세요" 하는 단계예요. 독촉장 기한까지 내면 여기서 끝나요.');
      L.push('계속 안 내면 다음은 압류 예고 → 압류 순서예요.');
      if (g === 'nhis' || g === 'pension') L.push('한 번에 내기 어려우면 나눠 내기(분할 납부)를 물어보세요.');
      if (contact) L.push(`문의: ${contact}`);
      return { tone: 'orange', title: '📮 독촉 단계', lines: L };
    }
    if (st === 'overdue') {
      L.push('기한이 지났어요. 지금 내면 독촉장이 오기 전에 막을 수 있어요.');
      if (g === 'localtax' || g === 'nhis' || g === 'pension') L.push('기한이 지난 고지서도 가상계좌·은행 앱·편의점에서 낼 수 있어요. 금액이 바뀌었을 수 있으니 고지서의 문의처로 확인하세요.');
      if (contact) L.push(`문의: ${contact}`);
      return { tone: 'orange', title: '⏰ 기한 지남', lines: L };
    }
    return null;
  }

  /** "이렇게 하면 깎여요" 카드들 { id, title, text, where } */
  function saveTips(kindId) {
    const g = GROUP[kindId] || 'etc';
    const T = [];
    if (g === 'localtax') {
      T.push({ id: 'lt-esend', title: '전자고지 + 자동이체 신청', text: '종이 대신 전자로 받고(전자송달) 자동이체까지 하면 고지서 한 건마다 최대 1,600원을 깎아 줘요(각각 신청하면 800원).', where: '위택스(wetax.go.kr) 또는 구청 세무과 · 지자체마다 다를 수 있음' });
      if (kindId === 'cartax') T.push({ id: 'ct-annual', title: '자동차세 1월에 한 번에 내기(연납)', text: '1월에 1년 치를 한 번에 내면 남은 기간 세금의 5%를 깎아 줘요(2026년 기준). 3·6·9월에도 되지만 덜 깎여요.', where: '위택스 · 구청 세무과' });
    }
    if (g === 'nhis' || g === 'pension') T.push({ id: 'nh-auto', title: '자동이체 + 이메일 고지 신청', text: '건강보험·국민연금을 자동이체하고 이메일로 고지서를 받으면 한 달에 최대 830원을 깎아 줘요.', where: '건강보험공단 1577-1000 · 건강보험25시 앱' });
    if (g === 'telecom') T.push({ id: 'tc-sel', title: '선택약정 25% 할인', text: '휴대폰을 새로 사지 않고 쓰는 중이면 "선택약정"으로 요금 25%를 깎을 수 있어요. 약정이 끝났는지도 확인해 보세요.', where: '통신사 고객센터 114 · 통신사 앱' });
    if (g === 'utility') T.push({ id: 'ut-ebill', title: '전자 고지·자동이체 할인 확인', text: '지역 도시가스사·수도사업소·한전은 모바일 고지나 자동이체에 할인을 주는 경우가 있어요. 우리 지역은 되는지 확인해 보세요.', where: '고지서의 고객센터 · 한전ON(전기)' });
    if (g === 'fine') T.push({ id: 'fn-early', title: '빨리 내면 최대 20% 깎여요', text: '과태료는 사전 통지서의 의견 제출 기한 안에 스스로 내면 최대 20%까지 깎아 줄 수 있어요(자진 납부 감경). 고지서에 "감경" 금액이 따로 적혀 있는지 보세요.', where: '고지서를 보낸 기관' });
    if (g === 'subscribe') T.push({ id: 'sb-check', title: '안 쓰는 구독 정리', text: '최근 한 달 동안 안 쓴 구독이면 해지하거나, 오래 쓸 거면 연간 결제로 바꾸면 보통 더 싸요.', where: '각 서비스의 계정 설정' });
    return T.map((t) => Object.assign(t, { checked: CHECKED }));
  }

  return { lateFee, stageOf, stageCard, saveTips, GROUP, CHECKED };
})();
