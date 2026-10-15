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
  const AMT_KW = /납부할\s*금액|납\s*부\s*할\s*금\s*액|청구\s*금액|청\s*구\s*금|체납금액|납부금액|총\s*미납금액|보험료\s*납부기한|결제\s*금액|납기\s*내|납기내\s*금액|합\s*계|^\s*계\s/;
  const AMT_NEG = /미납금액\s*\(?전월|부가가치세|기본요금|사용요금|가산금|연\s*체\s*금|할인|보\s*험\s*료\s+\d|체납처분비|전\s*월|납기\s*후|기후\s*금액|감면|정액요금|물이용|상\s*수\s*도\s+\d|하\s*수\s*도\s+\d/;
  const DATE_KW = /기한|까지|까시|키한|기헌|마감|납기\s*내|납기일|납기/;
  const DATE_NEG = /기준일|작성|발행|체납기간|독촉기간|미납월|고지일|인출일|사용기간|검침일|이후|이전|단가|적용|요율|년\s*\d+\s*월\s*\d+\s*일\s*$/;
  // 갤러리·캡처 화면 위쪽의 "2026. 10. 14. 오후 8:32" 같은 찍은 시각 → 납부기한이 아님
  const TIME_RE = /오전|오후|\b\d{1,2}:\d{2}\b/;
  const LATE_RE = /납기\s*후|기\s*후\s*\d|나기루|납기루/;
  const WON = '(원|윈|위|은|인|8|=)';
  const TAGS = [
    { re: /압류\s*예고/, label: '압류예고' },
    { re: /독촉/, label: '독촉' },
  ];

  /** d(YYYY-MM-DD) - 오늘 (일) */
  function dayDiff(d) {
    const [y, m, dd] = d.split('-').map(Number);
    const t = (typeof window !== 'undefined' && window.__bbToday) ? new Date(window.__bbToday) : new Date(); // 시험용: 옛 고지서로 시험할 때 "오늘"을 그 시점으로
    return Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
  }
  function daysBetween(a, b) {
    const p = (x) => x.split('-').map(Number);
    const [y1, m1, d1] = p(a);
    const [y2, m2, d2] = p(b);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  }

  function normLine(raw) {
    return raw
      .replace(/[oO]/g, '0')
      .replace(/[lI|]/g, '1')
      // 연도 첫 자리 오독(2623년02월 → 2023년02월)
      .replace(/\b2[1-9](\d\d)(?=\s*[년.]\s*\d{1,2}\s*[월.])/g, '20$1');
  }

  function candidates(text) {
    const A = [];
    const D = [];
    let prev = '';
    for (const raw of text.split('\n')) {
      const ln = normLine(raw);
      // 표 모양 고지서는 "납부마감일" 같은 이름표가 윗줄에, 값이 아랫줄에 오기도 한다 → 윗줄 이름표도 가점(조금 덜)
      const prevAmtKw = AMT_KW.test(prev) && !AMT_NEG.test(prev);
      // 윗줄에 이름표가 둘("납부마감일  사용기간")이어도 마감·기한이 있으면 인정
      const prevDateKw = /기한|마감|납기\s*내|납기일/.test(prev) || (DATE_KW.test(prev) && !DATE_NEG.test(prev));
      const prevLate = LATE_RE.test(prev);
      prev = ln;
      const acct = /\d{3,}-\d{2,}-\d{3,}/.test(ln);
      const late = LATE_RE.test(ln);

      // 금액 ① 쉼표 있는 숫자 "188,380"  ② 쉼표 없는 숫자 "6450 원"(수도요금 등) — ②는 "원"이 붙었거나 바로 앞에 금액 이름표가 있을 때만
      const amtRe = new RegExp('(\\d{1,3}(?:,\\d{3})+)\\s*' + WON + '?|(?<![\\d,.\\-])(\\d{3,7})\\s*(원|윈|위|은|인)?(?![\\d,.\\-])', 'g');
      let m;
      while ((m = amtRe.exec(ln))) {
        const plain = !m[1];
        const v = +(m[1] || m[3]).replace(/,/g, '');
        const won = plain ? m[4] : m[2];
        if (v < 1000 || v > 50000000) continue;
        const before = ln.slice(Math.max(0, m.index - 16), m.index);
        if (plain) {
          if (!won && !AMT_KW.test(before)) continue; // 쉼표 없는 그냥 숫자는 번호일 가능성이 큼
          if (/^(19|20)\d\d$/.test(String(v)) && /^\s*[년.]/.test(ln.slice(m.index + m[0].length - 1, m.index + m[0].length + 2))) continue; // 연도
        }
        let s = 0;
        if (won && won !== '=' && won !== '8') s += 2;
        else if (won) s += 1;
        if (AMT_KW.test(before) && !AMT_NEG.test(before)) s += 4;
        else if (AMT_KW.test(ln)) s += 2;
        else if (prevAmtKw) s += 2;
        if (acct) s -= 3;
        if (AMT_NEG.test(before)) s -= 4;
        else if (AMT_NEG.test(ln)) s -= 2;
        if (LATE_RE.test(before) || prevLate) s -= 4;
        else if (late) s -= 2;
        if (plain) s -= 1;
        A.push({ v, s });
      }

      // "2026.12.05", "2026년 12월 5일", "2026.1 0.1 0." 그리고 점이 하나 빠진 "2026. 12 05"(글자 읽기에서 자주 생김)까지
      const dateRe = /(20\d\d)\s*[.\-년,]?\s*(\d\s?\d|\d)\s*[.\-월,]\s*(\d\s?\d|\d)|(20\d\d)\s*[.\-년,]\s*(\d{1,2})\s+(\d{2})(?!\d)/g;
      while ((m = dateRe.exec(ln))) {
        const idx = m.index;
        const len = m[0].length;
        if (m[4]) m = [m[0], m[4], m[5], m[6]];
        const mo = +m[2].replace(/\s/g, '');
        const da = +m[3].replace(/\s/g, '');
        if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
        const d = `${m[1]}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
        const before = ln.slice(Math.max(0, idx - 16), idx);
        const after = ln.slice(idx + len, idx + len + 6);
        const near = ln.slice(Math.max(0, idx - 3), idx + len + 3);
        let s = 0;
        // 이름표가 날짜 바로 앞에 있으면 크게, 같은 줄 어딘가에 있으면 조금
        if (DATE_KW.test(before) && !LATE_RE.test(before)) s += 4;
        else if (DATE_KW.test(ln) && !late) s += 1;
        else if (prevDateKw && !prevLate) s += 2;
        if (/^\s*[.일]?\s*(까지|까시|까)/.test(after)) s += 3;
        if (DATE_NEG.test(before)) s -= 4;
        else if (DATE_NEG.test(ln)) s -= 1;
        if (TIME_RE.test(ln)) s -= 5;
        if (LATE_RE.test(before) || prevLate) s -= 4;
        else if (late) s -= 1;
        if (/납부|남부/.test(before)) s += 1;
        // "2025.05 ~ 2026.08"처럼 기간의 한쪽 끝인 날짜는 납부기한이 아님(같은 줄 다른 날짜는 그대로)
        if (/~|∼|〜|부터|사이/.test(near) || /^\s*[~∼〜-]/.test(after)) s -= 3;
        // 너무 먼 날짜(1년 넘게 지났거나 반년 넘게 남음)는 감점
        const age = dayDiff(d);
        if (age < -400 || age > 200) s -= 2;
        D.push({ d, s });
      }
      // 연도 없는 "10/30", "10월 30일"(카톡·문자 고지서에 흔함): 바로 앞에 기한 이름표가 있을 때만, 연도는 오늘에 가까운 쪽
      const mdRe = /(?<![\d.\-\/])(\d{1,2})\s*(?:\/|월|\.)\s*(\d{1,2})\s*일?(?![\d.\-\/])/g;
      while ((m = mdRe.exec(ln))) {
        const idx = m.index;
        const head = ln.slice(0, idx);
        if (/20\d\d\s*[.\-년,\/]?\s*$/.test(head)) continue; // 연도가 붙은 날짜는 위에서 처리
        const before = head.slice(-16);
        if (!DATE_KW.test(before) || LATE_RE.test(before) || DATE_NEG.test(before)) continue;
        const mo = +m[1], da = +m[2];
        if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
        const today = window.__bbToday ? new Date(window.__bbToday + 'T00:00:00') : new Date();
        let y = today.getFullYear();
        const md = (yy) => `${yy}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
        if (dayDiff(md(y)) < -60) y += 1;
        else if (dayDiff(md(y)) > 300) y -= 1;
        D.push({ d: md(y), s: 3 });
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
    let dm = vote(D, 'd');
    // 납기 내/납기 후 짝: 점수가 비슷한 두 날짜가 2주~두 달 반 차이면 앞의 것이 진짜 기한(뒤는 "늦게 내면" 기한)
    if (dm.length >= 2 && dm[0][1] > 0 && dm[1][1] > 0 && dm[1][1] >= dm[0][1] * 0.6) {
      const gap = daysBetween(dm[1][0], dm[0][0]);
      if (gap >= 14 && gap <= 75) dm = [dm[1], dm[0], ...dm.slice(2)];
    }
    const amount = am[0] ? +am[0][0] : null;
    // 점수가 마이너스인 날짜는 기한이라고 보기 어려움 → 비워 두고 사용자가 고르게(틀린 값보다 빈칸이 나음)
    const due = dm[0] && dm[0][1] >= 0 ? dm[0][0] : null;
    // "확신": 1등 점수가 2등의 1.5배 이상이고 점수 자체가 어느 정도 될 때
    const sure = (arr) => arr.length > 0 && arr[0][1] >= 3 && (arr.length === 1 || arr[0][1] >= arr[1][1] * 1.5);
    return {
      kind,
      tag,
      amount,
      due,
      altAmounts: am.slice(1, 4).filter((x) => x[1] > -1).map((x) => +x[0]),
      altDues: dm.slice(1, 4).filter((x) => x[1] > 0).map((x) => x[0]), // 점수가 낮은(기간·옛 날짜) 건 후보로도 안 보여 줌
      sure: { amount: sure(am), due: sure(dm) },
      _debug: { am: am.slice(0, 6), dm: dm.slice(0, 6) },
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
    // 은행 이름이 잘리거나 안 읽힌 계좌("…계좌: 116100-64-872060")도 모양이 계좌면 후보로(점수는 낮게).
    // 같은 번호 앞부분이 은행 이름과 함께 잘려 읽힌 게 있으면("농협 116100-64-8") 그 은행으로 채움
    const bare = /(?<![\d-])(\d{3,6}-\d{2,6}-\d{4,8}(?:-\d{1,3})?)(?![\d-])/g;
    const partial = new RegExp(BANKS + '\\s*[:.]?\\s*(\\d{3,6}-\\d{1,6}(?:-\\d{0,8})?)', 'g');
    const partials = [];
    for (const t of texts)
      for (const raw of t.split('\n')) {
        const ln = normLine(raw);
        let m;
        while ((m = partial.exec(ln))) partials.push({ bank: m[1].replace(/^NH/, '').replace(/^KB국민(은행)?$/, '국민은행'), pre: m[2].replace(/\s/g, '') });
      }
    for (const t of texts)
      for (const raw of t.split('\n')) {
        const ln = normLine(raw);
        if (/전화|TEL|팩스|FAX|콜센터|고객센터/i.test(ln)) continue;
        let m;
        while ((m = bare.exec(ln))) {
          const num = m[1];
          const digits = num.replace(/-/g, '');
          if (digits.length < 11 || digits.length > 16) continue;
          if (/^0\d{1,2}-\d{3,4}-\d{4}$/.test(num) || /^1\d{3}-\d{4}$/.test(num)) continue; // 전화번호
          if (map.has(digits)) {
            map.get(digits).count++;
            continue;
          }
          const p = partials.find((x) => num.startsWith(x.pre) && x.pre.length >= 6);
          const ctx = /가상\s*계좌|입금|납부\s*계좌|계좌|전용/.test(ln) ? 1 : 0;
          map.set(digits, { bank: p ? p.bank : '', number: num, count: p ? 1 : 0.5, ctx, shape: 1, order: order++ });
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

  /**
   * 콕 찍어 읽은 작은 조각들에서 한 칸 값만 고른다(여러 번 읽은 것 중 가장 많이·그럴듯하게 나온 것).
   * field: amount → 숫자(원), due → 'YYYY-MM-DD', account → '000-00-000000'
   */
  function pickField(texts, field) {
    const count = new Map();
    const add = (v, w) => count.set(v, (count.get(v) || 0) + w);
    for (const raw of texts) {
      const t = normLine(raw);
      if (field === 'amount') {
        // 날짜처럼 생긴 부분(2026. 01. 05)은 금액 후보에서 빼고
        const ta = t.replace(/20\d\d\s*[.\-년,]\s*\d{1,2}\s*[.\-월,]\s*\d{1,2}\s*[.일]?/g, ' ');
        // 쉼표가 점으로 읽힌 "188.380"도 금액으로
        const re = /(\d{1,3}(?:[,.]\d{3})+|\d{3,8})\s*(원|워|윈)?/g;
        let m;
        while ((m = re.exec(ta))) {
          const v = +m[1].replace(/[,.]/g, '');
          if (v < 100 || v > 50000000) continue;
          if (/^20\d\d$/.test(m[1]) && !m[2]) continue;
          add(v, 1 + (/[,.]/.test(m[1]) ? 1 : 0) + (m[2] ? 1 : 0));
        }
      } else if (field === 'due') {
        // 연도 첫 자리 오독(2823·2623 → 2023), 구분점이 °·, 로 읽힌 것까지
        const t2 = t.replace(/\b2[1-9](\d\d)(?=\s*[.\-년/°·,])/g, '20$1');
        const re = /(20\d\d)\s*[.\-년/°·,]\s*(\d{1,2})\s*[.\-월/°·,]?\s*(\d{1,2})/g;
        let m;
        while ((m = re.exec(t2))) {
          const mo = +m[2];
          const da = +m[3];
          if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
          add(`${m[1]}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`, 1);
        }
      } else if (field === 'account') {
        const re = /\d{2,6}(?:\s?-\s?\d{1,8}){1,5}/g;
        let m;
        while ((m = re.exec(t))) {
          const num = m[0].replace(/\s/g, '');
          const dg = num.replace(/-/g, '');
          if (dg.length < 10 || dg.length > 16) continue;
          add(num, 1);
        }
      }
    }
    const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  }

  return { extract, candidates, accounts, usage, pickField };
})();
