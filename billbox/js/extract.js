'use strict';

/**
 * Billbox 규칙 추출 — 읽은 글자(여러 번 읽은 결과)에서 종류·금액·납부기한을 뽑는다.
 *
 * 설계 원칙(사전 시험 8장 8/8 통과한 규칙 그대로):
 * - 원본과 손질본을 각각 읽어 후보를 "합쳐서 투표"한다. 한쪽이 놓친 걸 다른 쪽이 잡는다.
 * - 금액: 천 단위 쉼표 숫자. 옆에 "원"이 있거나 "납부할 금액·청구금액·체납금액" 줄이면 가점.
 *   계좌번호 줄(000-00-000)·"미납(전월)·부가세·기본요금·연체금" 같은 세부 항목 줄은 감점.
 * - 날짜: 2026.09.10 / 2026년 9월 10일 / 2026.1 0.1 0.(띄어진 숫자) 모두 인정. 월 1~12, 일 1~31만.
 *   "기한·까지·마감" 줄이면 가점, "기준일·작성일·체납기간·독촉기간" 줄이면 감점.
 * - 종류: 가장 많이 나온 이름(kinds.js).
 */
window.BillboxExtract = (function () {
  const AMT_KW = /납부할\s*금액|납\s*부\s*할\s*금\s*액|청구\s*금액|체납금액|납부금액|총\s*미납금액|보험료\s*납부기한|결제\s*금액|^\s*계\s/;
  const AMT_NEG = /미납금액\s*\(?전월|부가가치세|기본요금|사용요금|가산금|연\s*체\s*금|할인|보\s*험\s*료\s+\d|체납처분비|전\s*월/;
  const DATE_KW = /기한|까지|까시|키한|기헌|마감|납기/;
  const DATE_NEG = /기준일|작성|발행|체납기간|독촉기간|미납월|고지일|년\s*\d+\s*월\s*\d+\s*일\s*$/;
  const TAGS = [
    { re: /압류\s*예고/, label: '압류예고' },
    { re: /독촉/, label: '독촉' },
  ];

  function normLine(raw) {
    return raw.replace(/[oO]/g, '0').replace(/[lI|]/g, '1');
  }

  function candidates(text) {
    const A = [];
    const D = [];
    let prev = '';
    for (const raw of text.split('\n')) {
      const ln = normLine(raw);
      // 표 모양 고지서는 "납부마감일" 같은 이름표가 윗줄에, 값이 아랫줄에 오기도 한다 → 윗줄 이름표도 가점(조금 덜)
      const prevAmtKw = AMT_KW.test(prev);
      const prevDateKw = DATE_KW.test(prev) && !DATE_NEG.test(prev);
      prev = ln;
      const acct = /\d{3,}-\d{2,}-\d{3,}/.test(ln);

      const amtRe = /(\d{1,3}(?:,\d{3})+)\s*(원|윈|위|은|8)?/g;
      let m;
      while ((m = amtRe.exec(ln))) {
        const v = +m[1].replace(/,/g, '');
        if (v < 1000 || v > 50000000) continue;
        let s = 0;
        if (m[2]) s += 2;
        if (AMT_KW.test(ln)) s += 3;
        else if (prevAmtKw) s += 2;
        if (acct) s -= 3;
        if (AMT_NEG.test(ln)) s -= 3;
        if (/\d{4}[.\s]+\d{1,2}[.\s]+\d{1,2}/.test(ln)) s += 1;
        A.push({ v, s });
      }

      const dateRe = /(20\d\d)\s*[.\-년,]?\s*(\d\s?\d|\d)\s*[.\-월,]\s*(\d\s?\d|\d)/g;
      while ((m = dateRe.exec(ln))) {
        const mo = +m[2].replace(/\s/g, '');
        const da = +m[3].replace(/\s/g, '');
        if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
        const d = `${m[1]}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
        let s = 0;
        if (DATE_KW.test(ln)) s += 3;
        else if (prevDateKw) s += 2;
        if (DATE_NEG.test(ln)) s -= 3;
        if (/납부|남부/.test(ln)) s += 1;
        D.push({ d, s });
      }
    }
    return { A, D };
  }

  function vote(list, key) {
    const t = {};
    for (const c of list) t[c[key]] = (t[c[key]] || 0) + c.s + 1;
    return Object.entries(t).sort((a, b) => b[1] - a[1]);
  }

  /**
   * @param {string[]} texts 여러 번 읽은 글자(원본·손질본 …)
   * @returns {{kind, tag, amount, due, altAmounts, altDues, sure:{amount:boolean,due:boolean}}}
   */
  function extract(texts) {
    const all = texts.join('\n');
    const kind = window.BillboxKinds.detect(all);
    const tag = (TAGS.find((t) => t.re.test(all)) || {}).label || '';
    let A = [];
    let D = [];
    for (const t of texts) {
      const c = candidates(t);
      A = A.concat(c.A);
      D = D.concat(c.D);
    }
    const am = vote(A, 'v');
    const dm = vote(D, 'd');
    const amount = am[0] ? +am[0][0] : null;
    const due = dm[0] ? dm[0][0] : null;
    // "확신": 1등 점수가 2등의 1.5배 이상이고 점수 자체가 어느 정도 될 때
    const sure = (arr) => arr.length > 0 && arr[0][1] >= 3 && (arr.length === 1 || arr[0][1] >= arr[1][1] * 1.5);
    return {
      kind,
      tag,
      amount,
      due,
      altAmounts: am.slice(1, 4).map((x) => +x[0]),
      altDues: dm.slice(1, 4).map((x) => x[0]),
      sure: { amount: sure(am), due: sure(dm) },
    };
  }

  // ---------- 가상계좌 · 전자납부번호 ----------
  const BANKS = '(NH농협|농협|KB국민은행|KB국민|국민은행|국민|신한은행|신한|우리은행|우리|하나은행|하나|기업은행|IBK기업|기업|카카오뱅크|카카오|케이뱅크|토스뱅크|우체국|새마을금고|SC제일|제일은행|부산은행|대구은행|iM뱅크|경남은행|광주은행|전북은행|제주은행|수협|신협|씨티|산업은행)';
  /**
   * 읽은 글자에서 "은행 + 계좌번호"를 뽑는다. 사용자가 ✅로 확인한 것만 믿는다(오독 위험).
   * 잘 읽힌 순서: 두 번 읽기에서 똑같이 나온 횟수 → "가상계좌·입금" 줄 → 하이픈 모양이 은행 계좌답게 2~4묶음.
   */
  function accounts(texts) {
    const map = new Map();
    const re = new RegExp(BANKS + '\\s*[:.]?\\s*(\\d{2,6}(?:\\s?-\\s?\\d{1,8}){1,5})', 'g');
    let order = 0;
    for (const t of texts) {
      for (const raw of t.split('\n')) {
        const ln = normLine(raw);
        const ctx = /가상\s*계좌|입금|납부\s*계좌|계좌/.test(ln) ? 1 : 0;
        let m;
        while ((m = re.exec(ln))) {
          const num = m[2].replace(/\s/g, '');
          const digits = num.replace(/-/g, '');
          if (digits.length < 10 || digits.length > 16) continue;
          const bank = m[1].replace(/^NH/, '').replace(/^KB국민은행$/, '국민은행').replace(/^KB국민$/, '국민은행');
          const groups = num.split('-').length;
          const cur = map.get(digits) || { bank, number: num, count: 0, ctx: 0, shape: groups >= 2 && groups <= 4 ? 1 : 0, order: order++ };
          cur.count++;
          cur.ctx = Math.max(cur.ctx, ctx);
          map.set(digits, cur);
        }
      }
    }
    return [...map.values()]
      .sort((x, y) => y.count - x.count || y.ctx - x.ctx || y.shape - x.shape || x.order - y.order)
      .slice(0, 12)
      .map(({ bank, number, count }) => ({ bank, number, count }));
  }

  // ---------- 사용량(전기 kWh · 가스/수도 m³) — 시험 기능 ----------
  function usage(texts) {
    const all = texts.join('\n');
    const lines = all.split('\n').map(normLine);
    const pick = (re) => {
      for (const ln of lines) {
        if (!/사용량|검침량|당월\s*사용|사용\s*전력/.test(ln)) continue;
        const m = ln.match(re);
        if (m) return parseFloat(m[1].replace(/,/g, ''));
      }
      return null;
    };
    const kwh = pick(/(\d{1,5}(?:,\d{3})*(?:\.\d+)?)\s*kWh/i);
    if (kwh) return { value: kwh, unit: 'kWh' };
    const m3 = pick(/(\d{1,5}(?:\.\d+)?)\s*(?:m³|㎥|m3|m\?|m)\b/);
    if (m3) return { value: m3, unit: 'm³' };
    return null;
  }

  return { extract, candidates, accounts, usage };
})();
