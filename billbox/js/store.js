'use strict';

/**
 * Billbox 저장소 — localStorage만. 로그인 없음. 폰을 바꾸면 사라진다(첫 화면·설정에서 안내).
 *
 * item = {
 *   id, name, kindId, amount(원, 숫자|null), due('YYYY-MM-DD'),
 *   repeat('monthly'|'bimonthly'|'quarterly'|'half'|'yearly'|'none'), months([6,12] 같은 고정 달|null),
 *   estimated(true면 고지서 없이 예상한 마감), tag('독촉'|'압류예고'|''), note,
 *   source('photo'|'manual'), createdAt, updatedAt,
 *   history:[{due, amount, paidAt}]   // 냈어요 기록(최근 24개)
 * }
 * settings = { remindHour, remindDays:[3,0], push:'off'|'on', deviceKey, introSeen, photoTipSeen }
 */
window.BillboxStore = (function () {
  const KEY = 'billbox:v1';
  const SKEY = 'billbox:settings';

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }
  function save(items) {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
      return true;
    } catch (_) {
      return false;
    }
  }
  function settings() {
    const def = { remindHour: (window.BILLBOX_CONFIG || {}).REMIND_HOUR_DEFAULT || 9, remindDays: [3, 0], push: 'off', deviceKey: '', introSeen: false, photoTipSeen: false, photoKeep: 'paid30', tipsDone: [] };
    try {
      const raw = localStorage.getItem(SKEY);
      return Object.assign(def, raw ? JSON.parse(raw) : {});
    } catch (_) {
      return def;
    }
  }
  function saveSettings(patch) {
    const s = Object.assign(settings(), patch);
    try {
      localStorage.setItem(SKEY, JSON.stringify(s));
    } catch (_) {}
    return s;
  }

  function uid() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------- 날짜 도우미 (전부 '그 지역 날짜' 기준, 시간대 꼬임 방지) ----------
  const p2 = (n) => String(n).padStart(2, '0');
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  }
  function parse(s) {
    const [y, m, d] = String(s).split('-').map(Number);
    return { y, m, d };
  }
  function fmt(y, m, d) {
    return `${y}-${p2(m)}-${p2(d)}`;
  }
  function daysInMonth(y, m) {
    return new Date(y, m, 0).getDate();
  }
  /** due - today (일). 음수면 지남 */
  function daysLeft(due) {
    const a = parse(due);
    const b = parse(todayStr());
    const ms = Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
    return Math.round(ms / 86400000);
  }
  /** 달 더하기, 일은 유지(없는 날이면 그 달 마지막 날) */
  function addMonths(due, n, anchorDay) {
    const { y, m } = parse(due);
    const d = anchorDay || parse(due).d;
    const total = y * 12 + (m - 1) + n;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
  }
  /** 고정 달 목록([6,12])에서 due 다음 차례 */
  function nextInMonths(due, months, anchorDay) {
    const { y, m } = parse(due);
    const d = anchorDay || parse(due).d;
    const sorted = [...months].sort((a, b) => a - b);
    for (const mm of sorted) if (mm > m) return fmt(y, mm, Math.min(d, daysInMonth(y, mm)));
    const mm = sorted[0];
    return fmt(y + 1, mm, Math.min(d, daysInMonth(y + 1, mm)));
  }
  function nextDue(item) {
    if (!item.repeat || item.repeat === 'none') return null;
    // day: 고지서에 적힌 원래 '일'. 1/31 → 2/28 → 3/31 처럼 날짜가 밀리지 않게 기준일을 기억한다
    const day = item.day || parse(item.due).d;
    if (item.months && item.months.length) return nextInMonths(item.due, item.months, day);
    const r = window.BillboxKinds.repeatById(item.repeat);
    return r.months ? addMonths(item.due, r.months, day) : null;
  }

  // ---------- 항목 조작 ----------
  function add(data) {
    const items = load();
    const now = new Date().toISOString();
    const item = Object.assign(
      { id: uid(), name: '', kindId: 'etc', amount: null, due: todayStr(), repeat: 'none', months: null, estimated: false, tag: '', note: '', source: 'manual', history: [] },
      data,
      { createdAt: now, updatedAt: now }
    );
    item.day = parse(item.due).d;
    items.push(item);
    save(items);
    return item;
  }
  function update(id, patch) {
    const items = load();
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return null;
    items[i] = Object.assign({}, items[i], patch, { updatedAt: new Date().toISOString() });
    if (patch.due && patch.estimated === false) items[i].day = parse(patch.due).d; // 사용자가 직접 고친 날짜가 새 기준
    save(items);
    return items[i];
  }
  function remove(id) {
    save(load().filter((x) => x.id !== id));
  }
  function get(id) {
    return load().find((x) => x.id === id) || null;
  }

  /** [냈어요] — 기록에 넣고, 반복이면 다음 마감으로 넘김(예상 표시). 한 번만이면 '낸 것'으로 보관 */
  function markPaid(id) {
    const it = get(id);
    if (!it) return null;
    const hist = [{ due: it.due, amount: it.amount, paidAt: new Date().toISOString(), usage: it.usage || null, tag: it.tag || '', estimated: !!it.estimated }, ...(it.history || [])].slice(0, 24);
    const next = nextDue(it);
    // 다음 차례는 "예상"으로 넘김. 금액은 지난번 금액을 그대로 둬서 "지난번 약 ○○원"으로 쓴다. 사용량·독촉 표시는 새 차례라 비움
    if (next) return update(id, { history: hist, due: next, estimated: true, tag: '', usage: null, paidAt: null });
    return update(id, { history: hist, paidAt: new Date().toISOString() });
  }
  /** 이번 차례만 건너뛰기: 기록 없이 다음 차례(예상)로 넘김. 반복이 아니면 지움 */
  function skip(id) {
    const it = get(id);
    if (!it) return null;
    const next = nextDue(it);
    if (!next) {
      remove(id);
      return null;
    }
    return update(id, { due: next, estimated: true, tag: '', usage: null, paidAt: null });
  }
  /** 독촉·압류예고는 밀린 돈을 한 번 내는 고지서 → 반복하지 않게 고침(v1.1.1 이전에 매월로 저장된 것) */
  function fixTaggedRepeat() {
    const items = load();
    let n = 0;
    for (const x of items) {
      if ((x.tag === '독촉' || x.tag === '압류예고') && x.repeat && x.repeat !== 'none') {
        x.repeat = 'none';
        x.months = null;
        n++;
      }
    }
    if (n) save(items);
    return n;
  }

  /** 실수로 눌렀을 때 되돌리기 */
  function undoPaid(id) {
    const it = get(id);
    if (!it || !it.history || !it.history.length) return null;
    const [last, ...rest] = it.history;
    return update(id, { history: rest, due: last.due, amount: last.amount, usage: last.usage || null, tag: last.tag || '', estimated: !!last.estimated, paidAt: null });
  }

  /** 같은 종류의 반복 항목이 있고 마감이 ±45일 안이면 "같은 것"으로 본다(고지서를 다시 찍었을 때 중복 방지).
   *  같은 종류 고지서가 여러 집으로 오는 경우(두 세대 등)를 위해 계좌·메모(호수)로 구분한다. */
  function findSimilar(kindId, due, tag, opts) {
    if (!kindId || kindId === 'etc') return null;
    const a = parse(due);
    const o = opts || {};
    const digits = (v) => String(v || '').replace(/[^\d]/g, '');
    const cands = load().filter((x) => {
      // 독촉·압류예고(밀린 돈)와 매달 오는 정기 고지서는 서로 다른 것으로 본다
      if (x.kindId !== kindId || x.paidAt || (x.tag || '') !== (tag || '')) return false;
      const b = parse(x.due);
      const diff = Math.abs(Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86400000;
      if (diff > 45) return false;
      // 납부 계좌가 둘 다 있는데 다르면 다른 집 고지서
      if (o.account && x.account && digits(o.account) !== digits(x.account)) return false;
      // 메모(호수·지번)가 둘 다 있는데 서로 안 맞으면 다른 집
      if (o.unit && x.note && !x.note.includes(o.unit) && !String(o.unit).includes(x.note.trim())) return false;
      return true;
    });
    if (cands.length <= 1) return cands[0] || null;
    // 여럿이면: 메모가 맞는 것 > 계좌가 맞는 것 > 마감이 가까운 것
    const byUnit = o.unit ? cands.find((x) => x.note && x.note.includes(o.unit)) : null;
    if (byUnit) return byUnit;
    const byAcct = o.account ? cands.find((x) => x.account && digits(x.account) === digits(o.account)) : null;
    if (byAcct) return byAcct;
    return cands.sort((x, y) => (x.due < y.due ? -1 : 1))[0];
  }

  /** 홈 화면용 묶음 */
  function groups() {
    const items = load().filter((x) => !x.paidAt);
    items.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
    const overdue = [];
    const week = [];
    const later = [];
    for (const it of items) {
      const n = daysLeft(it.due);
      if (n < 0) overdue.push(it);
      else if (n <= 7) week.push(it);
      else later.push(it);
    }
    const done = load()
      .filter((x) => x.paidAt)
      .sort((a, b) => (a.paidAt < b.paidAt ? 1 : -1));
    return { overdue, week, later, done };
  }

  function exportJson() {
    return JSON.stringify({ app: 'billbox', version: 1, exportedAt: new Date().toISOString(), items: load(), settings: settings() }, null, 2);
  }
  function importJson(text) {
    const obj = JSON.parse(text);
    if (!obj || obj.app !== 'billbox' || !Array.isArray(obj.items)) throw new Error('빌박스 백업 파일이 아니에요');
    const cur = load();
    const ids = new Set(cur.map((x) => x.id));
    let n = 0;
    for (const it of obj.items) {
      if (!it || !it.id || ids.has(it.id)) continue;
      cur.push(it);
      n++;
    }
    save(cur);
    return n;
  }

  // ---------- 나갈 돈 ----------
  const MONEY_GROUPS = [
    { id: 'bill', label: '공과금·세금', emoji: '🧾', kinds: ['electric', 'gas', 'water', 'health', 'pension', 'cartax', 'proptax', 'maint', 'telecom', 'fine'] },
    { id: 'house', label: '월세·보험·학원', emoji: '🏠', kinds: ['rent', 'insurance', 'academy'] },
    { id: 'loan', label: '대출 상환', emoji: '🏦', kinds: ['loan'] },
    { id: 'subscribe', label: '구독', emoji: '📺', kinds: ['subscribe'] },
    { id: 'etc', label: '자동이체·기타', emoji: '🔁', kinds: ['transfer', 'etc'] },
  ];
  const groupOf = (kindId) => (MONEY_GROUPS.find((g) => g.kinds.includes(kindId)) || MONEY_GROUPS[MONEY_GROUPS.length - 1]).id;
  const ym = (due) => due.slice(0, 7);
  function monthStr(offset) {
    const d = new Date();
    const t = new Date(d.getFullYear(), d.getMonth() + offset, 1);
    return `${t.getFullYear()}-${p2(t.getMonth() + 1)}`;
  }
  /** 아직 안 낸 항목이 앞으로 언제·얼마 나올지(반복이면 다음 차례들까지). untilYm까지 */
  function occurrences(item, untilYm) {
    const out = [];
    if (item.paidAt) return out;
    let due = item.due;
    let est = !!item.estimated;
    let guard = 0;
    while (due && ym(due) <= untilYm && guard++ < 30) {
      out.push({ due, amount: item.amount, estimated: est });
      due = nextDue(Object.assign({}, item, { due }));
      est = true;
    }
    return out;
  }
  /** 매달 나가는 돈으로 환산(반복 항목만) */
  function perMonth(item) {
    if (!item.repeat || item.repeat === 'none' || item.amount == null) return 0;
    if (item.months && item.months.length) return (item.amount * item.months.length) / 12;
    const r = window.BillboxKinds.repeatById(item.repeat);
    return r.months ? item.amount / r.months : 0;
  }
  function money() {
    const items = load();
    const cur = monthStr(0);
    const next = monthStr(1);
    const prev = monthStr(-1);
    const blank = () => ({ total: 0, paid: 0, left: 0, approxAmt: 0, approx: false, unknown: 0, groups: Object.fromEntries(MONEY_GROUPS.map((g) => [g.id, 0])), count: 0 });
    const M = { [prev]: blank(), [cur]: blank(), [next]: blank() };
    for (const it of items) {
      const gid = groupOf(it.kindId);
      for (const h of it.history || []) {
        const box = M[ym(h.due)];
        if (!box || h.amount == null) continue;
        box.total += h.amount;
        box.paid += h.amount;
        box.groups[gid] += h.amount;
        box.count++;
      }
      for (const o of occurrences(it, next)) {
        // 지난달보다 더 전에 밀린 건 이번 달 칸에 모아 보여 줌(아직 내야 하니까)
        const target = M[ym(o.due)] || (ym(o.due) < prev ? M[cur] : null);
        if (!target) continue;
        target.count++;
        if (o.amount == null) {
          target.unknown++;
          continue;
        }
        target.total += o.amount;
        target.left += o.amount;
        target.groups[gid] += o.amount;
        if (o.estimated) {
          target.approx = true;
          target.approxAmt += o.amount;
        }
      }
    }
    const fixed = items.reduce((a, it) => a + perMonth(it), 0);
    const fixedList = items
      .filter((it) => perMonth(it) > 0)
      .map((it) => ({ name: it.name || window.BillboxKinds.byId(it.kindId).label, kindId: it.kindId, perMonth: perMonth(it), repeat: it.repeat }))
      .sort((a, b) => b.perMonth - a.perMonth);
    return { cur, next, prev, months: M, fixed, fixedList, groups: MONEY_GROUPS };
  }

  return { skip, fixTaggedRepeat, money, load, save, settings, saveSettings, add, update, remove, get, markPaid, undoPaid, findSimilar, groups, nextDue, daysLeft, todayStr, addMonths, exportJson, importJson, uid };
})();
