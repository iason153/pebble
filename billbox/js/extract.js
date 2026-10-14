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

  return { extract, candidates };
})();
