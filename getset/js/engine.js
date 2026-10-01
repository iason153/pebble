'use strict';

/**
 * Getset 추천 엔진 — "어디부터 갈지"와 "실제로 끝나는 시각"
 * (설계문서 §4 현실 시간 모델, §5 이동수단, §6 추천 엔진)
 *
 * 방문지 1곳의 시간 = 이동 + 도착 후 실질 시간(주차·걸어가기·대기) + 머무는 시간 + 출발 준비
 *
 * 순서 계산
 *   - 8곳 이하: 가능한 순서를 전부 계산 (가지치기로 빠르게)
 *   - 9~12곳: 근사 계산 (가까운 곳 먼저 + 순서 바꿔보기 개선 반복)
 *   - 목표: ① 예약·마감을 모두 지킴 ② 가장 빨리 끝남 ③ 같으면 이동이 적음
 *   - "가장 빨리 끝남"과 "이동이 가장 적음"이 다르면 두 안을 모두 돌려줌
 *
 * ⚠️ 이동 시간은 지금은 전부 "직선거리로 어림한 값"이다.
 *    자동차는 4단계에서 카카오모빌리티 실제 길찾기로 바뀐다(이 파일의 travel()만 교체).
 *    실질 시간 기본값(kinds.js)도 대표 확정 전 초안이다.
 *
 * DOM을 쓰지 않는 순수 계산 파일 — 브라우저와 Node(테스트) 양쪽에서 돈다.
 */
(function (root) {
  const BRUTE_MAX = 8;
  const MAX_STOPS = 12;
  const PENALTY = 10000; // 늦는 1분 = 끝나는 시각 10000분 손해로 취급 (무조건 지키는 쪽 우선)

  // ---------------------------------------------------------------------
  // 이동 시간 어림 (분)
  // ---------------------------------------------------------------------
  function distM(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /**
   * 설계문서 §5 표:
   *   도보   직선 × 1.3 ÷ 분당 70m
   *   자전거 직선 × 1.3 ÷ 분당 250m
   *   대중교통 대기 8분 + 직선 × 1.4 ÷ 시속 20km + 걸어서 오가기 6분
   *   자동차(임시 어림) 2분 + 직선 × 1.35 ÷ 속도(시내 21km/h, 중거리 30km/h, 장거리 48km/h)
   */
  function travel(a, b, mode) {
    const d = distM(a, b);
    let min;
    if (d < 30) min = 0;
    else if (mode === 'walk') min = (d * 1.3) / 70;
    else if (mode === 'bike') min = (d * 1.3) / 250;
    else if (mode === 'transit') min = 8 + (d * 1.4) / (20000 / 60) + 6;
    else {
      const v = d < 3000 ? 350 : d < 15000 ? 500 : 800;
      min = 2 + (d * 1.35) / v;
    }
    return { min: Math.ceil(min), dist: Math.round(d) };
  }

  // ---------------------------------------------------------------------
  // 한 순서를 실제로 따라가 보며 시간표를 만든다
  // ---------------------------------------------------------------------
  function overhead(kind, mode, which) {
    const pair = mode === 'car' ? kind.car : kind.light;
    return pair[which === 'arrive' ? 0 : 1];
  }

  function simulate(ctx, order, opts = {}) {
    const { stops, start, end, dayMode, startMin, kindOf, travelFn } = ctx;
    let t = startMin;
    let prev = start;
    let lateness = 0;
    let travelSum = 0;
    let waitSum = 0;
    const rows = [];
    const violations = [];

    for (let p = 0; p < order.length; p++) {
      const i = order[p];
      const s = stops[i];
      const kind = kindOf(s.kind);
      const mode = s.mode || dayMode;
      const tr = travelFn(prev, s.place, mode);
      const leaveAt = t;
      t += tr.min;
      travelSum += tr.min;
      const arrive = t;
      const arriveOH = tr.dist < 30 && p > 0 ? 0 : overhead(kind, mode, 'arrive');
      const ready = arrive + arriveOH;
      let begin = ready;
      let wait = 0;
      let late = 0;
      if (s.fixedAt != null) {
        if (ready <= s.fixedAt) {
          wait = s.fixedAt - ready;
          begin = s.fixedAt;
        } else {
          late = ready - s.fixedAt;
          violations.push({ i, type: 'fixed', minutes: late });
        }
      }
      const finish = begin + s.stay;
      if (s.deadline != null && finish > s.deadline) {
        const m = finish - s.deadline;
        late += m;
        violations.push({ i, type: 'deadline', minutes: m });
      }
      lateness += late;
      waitSum += wait;

      const next = p + 1 < order.length ? stops[order[p + 1]] : null;
      const nextMode = next ? next.mode || dayMode : end.type !== 'none' ? dayMode : null;
      const leaveOH = nextMode ? overhead(kind, nextMode, 'leave') : 0;
      const depart = finish + leaveOH;

      // 가지치기: 이미 지금까지가 최선보다 나쁘면 그만 (출발 준비 전 시각 기준이라 안전한 하한)
      if (opts.bound != null) {
        const partial = opts.metric === 'travel' ? lateness * PENALTY + travelSum : lateness * PENALTY + finish;
        if (partial > opts.bound) return null;
      }

      rows.push({ i, mode, leaveAt, travel: tr.min, dist: tr.dist, arrive, arriveOH, ready, wait, begin, finish, leaveOH, depart, late });
      t = depart;
      prev = s.place;
    }

    const doneAt = rows.length ? rows[rows.length - 1].finish : startMin;
    let endLeg = null;
    let finishAll = doneAt;
    if (end.type !== 'none' && rows.length) {
      const target = end.type === 'return' ? start : end.place;
      const tr = travelFn(prev, target, dayMode);
      travelSum += tr.min;
      endLeg = { mode: dayMode, leaveAt: t, travel: tr.min, dist: tr.dist, arrive: t + tr.min, target: end.type };
      finishAll = t + tr.min;
    }

    return {
      order: order.slice(),
      rows,
      endLeg,
      doneAt,
      finishAll,
      travelSum,
      waitSum,
      lateness,
      violations,
      costFast: lateness * PENALTY + finishAll + travelSum * 0.001,
      costShort: lateness * PENALTY + travelSum + finishAll * 0.001,
    };
  }

  // ---------------------------------------------------------------------
  // 순서 찾기
  // ---------------------------------------------------------------------
  function groupOf(s) {
    return s.order === 'first' ? 0 : s.order === 'last' ? 2 : 1;
  }

  function validOrder(stops, order) {
    let g = 0;
    for (const i of order) {
      const gi = groupOf(stops[i]);
      if (gi < g) return false;
      g = gi;
    }
    return true;
  }

  /** 8곳 이하: 전부 계산 (그룹 순서 지키면서, 가지치기) */
  function bruteForce(ctx, metric) {
    const n = ctx.stops.length;
    const groups = ctx.stops.map(groupOf);
    let best = null;
    const used = new Array(n).fill(false);
    const order = [];
    const costKey = metric === 'travel' ? 'costShort' : 'costFast';

    function rec(minGroup) {
      if (order.length === n) {
        const sim = simulate(ctx, order);
        if (!best || sim[costKey] < best[costKey]) best = sim;
        return;
      }
      // 부분 순서로 가지치기
      if (best && order.length >= 2) {
        const part = simulate(ctx, order, { bound: best[costKey], metric });
        if (!part) return;
      }
      for (let i = 0; i < n; i++) {
        if (used[i] || groups[i] < minGroup) continue;
        // 아직 안 쓴 더 앞 그룹이 남아 있으면 이 그룹은 못 감
        let blocked = false;
        for (let j = 0; j < n; j++) if (!used[j] && groups[j] < groups[i]) blocked = true;
        if (blocked) continue;
        used[i] = true;
        order.push(i);
        rec(groups[i]);
        order.pop();
        used[i] = false;
      }
    }
    rec(0);
    return best;
  }

  /** 9~12곳: 근사 (여러 시작점 + 한 곳 옮기기/구간 뒤집기 개선) */
  function heuristic(ctx, metric) {
    const n = ctx.stops.length;
    const costKey = metric === 'travel' ? 'costShort' : 'costFast';
    const cost = (o) => (validOrder(ctx.stops, o) ? simulate(ctx, o)[costKey] : Infinity);

    const seeds = [];
    // ① 그룹별로 가까운 곳 먼저
    const nn = [];
    const left = new Set(ctx.stops.map((_, i) => i));
    let here = ctx.start;
    for (const g of [0, 1, 2]) {
      while ([...left].some((i) => groupOf(ctx.stops[i]) === g)) {
        let bi = -1;
        let bd = Infinity;
        for (const i of left) {
          if (groupOf(ctx.stops[i]) !== g) continue;
          const d = distM(here, ctx.stops[i].place);
          if (d < bd) {
            bd = d;
            bi = i;
          }
        }
        nn.push(bi);
        left.delete(bi);
        here = ctx.stops[bi].place;
      }
    }
    seeds.push(nn);
    // ② 예약·마감 이른 순서
    const byTime = ctx.stops
      .map((s, i) => ({ i, g: groupOf(s), t: s.fixedAt != null ? s.fixedAt : s.deadline != null ? s.deadline : 1e9 }))
      .sort((a, b) => a.g - b.g || a.t - b.t)
      .map((x) => x.i);
    seeds.push(byTime);
    // ③ 정해진 무작위 섞기 몇 개 (같은 입력이면 같은 결과)
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < 12; k++) {
      const o = nn.slice();
      for (let a = o.length - 1; a > 0; a--) {
        const b = Math.floor(rand() * (a + 1));
        [o[a], o[b]] = [o[b], o[a]];
      }
      o.sort((x, y) => groupOf(ctx.stops[x]) - groupOf(ctx.stops[y]));
      seeds.push(o);
    }

    let best = null;
    let bestCost = Infinity;
    for (const s0 of seeds) {
      let cur = s0.slice();
      let curCost = cost(cur);
      let improved = true;
      let guard = 0;
      while (improved && guard++ < 200) {
        improved = false;
        // 한 곳을 다른 자리로 옮기기
        for (let a = 0; a < n && !improved; a++) {
          for (let b = 0; b < n && !improved; b++) {
            if (a === b) continue;
            const o = cur.slice();
            const [x] = o.splice(a, 1);
            o.splice(b, 0, x);
            const c = cost(o);
            if (c < curCost - 1e-9) {
              cur = o;
              curCost = c;
              improved = true;
            }
          }
        }
        // 구간 뒤집기 (2-opt)
        for (let a = 0; a < n - 1 && !improved; a++) {
          for (let b = a + 1; b < n && !improved; b++) {
            const o = cur.slice(0, a).concat(cur.slice(a, b + 1).reverse(), cur.slice(b + 1));
            const c = cost(o);
            if (c < curCost - 1e-9) {
              cur = o;
              curCost = c;
              improved = true;
            }
          }
        }
      }
      if (curCost < bestCost) {
        bestCost = curCost;
        best = cur;
      }
    }
    return simulate(ctx, best);
  }

  function solve(ctx, metric) {
    return ctx.stops.length <= BRUTE_MAX ? bruteForce(ctx, metric) : heuristic(ctx, metric);
  }

  // ---------------------------------------------------------------------
  // 사람 말로 된 이유·경고·대안
  // ---------------------------------------------------------------------
  function hasBatchim(word) {
    const ch = String(word).trim().slice(-1);
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
    return /[0-9lmnLMN]$/.test(ch) && !/[2459]$/.test(ch); // 대충: 숫자·영문 끝
  }
  const josa = (w, a, b) => `${w}${hasBatchim(w) ? a : b}`;
  const short = (name) => (name.length > 12 ? name.slice(0, 11) + '…' : name);

  function fmt(min) {
    const m = ((Math.round(min) % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    const ap = h < 12 ? '오전' : '오후';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${ap} ${h12}:${String(mm).padStart(2, '0')}`;
  }

  function reasonsFor(ctx, sim) {
    const { stops } = ctx;
    const out = [];
    const pos = {};
    sim.order.forEach((i, p) => (pos[i] = p));
    const name = (i) => short(stops[i].place.name);

    const fixed = sim.order.filter((i) => stops[i].fixedAt != null);
    if (fixed.length) {
      const f = fixed[0];
      const before = sim.order.slice(0, pos[f]);
      out.push(
        before.length
          ? `${name(f)} 예약(${fmt(stops[f].fixedAt)}) 전에 ${before.length === 1 ? josa(name(before[0]), '을', '를') : `${before.length}곳을`} 먼저 다녀와요`
          : `${name(f)} 예약(${fmt(stops[f].fixedAt)})이 빨라서 여기부터 가요`
      );
    }
    const dl = sim.order.filter((i) => stops[i].deadline != null && stops[i].fixedAt == null);
    if (dl.length && out.length < 2) {
      const d = dl[0];
      out.push(`${josa(name(d), '은', '는')} 문 닫기(${fmt(stops[d].deadline)}) 전에 끝나게 넣었어요`);
    }
    const lastOnes = sim.order.filter((i) => stops[i].order === 'last');
    if (lastOnes.length && out.length < 2) out.push(`${josa(name(lastOnes[0]), '은', '는')} '제일 마지막'이라 끝에 넣었어요`);
    const firstOnes = sim.order.filter((i) => stops[i].order === 'first');
    if (firstOnes.length && out.length < 2) out.push(`${josa(name(firstOnes[0]), '은', '는')} '제일 먼저'라 처음에 넣었어요`);
    if (!out.length) out.push('가까운 곳끼리 이어서 다니도록 순서를 짰어요');
    return out.slice(0, 2);
  }

  function warningsFor(ctx, sim) {
    const { stops } = ctx;
    return sim.violations.map((v) => {
      const s = stops[v.i];
      const n = short(s.place.name);
      if (v.type === 'fixed' && s.fixedAt < ctx.startMin) return `${n} 예약(${fmt(s.fixedAt)})이 출발 시각보다 빨라요. 예약 시간을 확인해 주세요`;
      if (v.type === 'deadline' && s.deadline < ctx.startMin) return `${n} 문 닫는 시간(${fmt(s.deadline)})이 출발 시각보다 빨라요`;
      return v.type === 'fixed'
        ? `${n} 예약(${fmt(s.fixedAt)})에 ${v.minutes}분 늦어요`
        : `${n} 문 닫는 시간(${fmt(s.deadline)})보다 ${v.minutes}분 늦게 끝나요`;
    });
  }

  function suggestionsFor(ctx, input, best) {
    const out = [];
    // ① 일찍 출발하면? (출발 시각을 직접 정했고, 예약·마감이 출발 뒤인 경우만)
    //    휴대폰이 느려지지 않게 추천 순서 그대로 다시 따라가 봄
    const pastTimes = ctx.stops.some((s) => (s.fixedAt != null && s.fixedAt < ctx.startMin) || (s.deadline != null && s.deadline < ctx.startMin));
    if (!input.startIsNow && !pastTimes) {
      let lo = 0;
      let hi = 180;
      const feasibleAt = (k) => simulate(Object.assign({}, ctx, { startMin: ctx.startMin - k }), best.order).lateness === 0;
      if (feasibleAt(hi)) {
        while (hi - lo > 5) {
          const mid = Math.floor((lo + hi) / 10) * 5;
          if (mid <= lo) break;
          if (feasibleAt(mid)) hi = mid;
          else lo = mid;
        }
        out.push(`${hi}분 일찍 출발하면 모두 시간 안에 끝나요`);
      }
    }
    // ② 한 곳을 빼면?
    const n = ctx.stops.length;
    const candidates = [];
    for (let j = 0; j < n; j++) {
      const rest = ctx.stops.filter((_, k) => k !== j);
      if (!rest.length) continue;
      const sim = solve(Object.assign({}, ctx, { stops: rest }), 'fast');
      if (sim.lateness === 0) {
        const s = ctx.stops[j];
        const flexible = s.fixedAt == null && s.deadline == null;
        candidates.push({ j, flexible });
      }
    }
    candidates.sort((a, b) => Number(b.flexible) - Number(a.flexible));
    candidates.slice(0, 2).forEach(({ j }) => {
      out.push(`${josa(short(ctx.stops[j].place.name), '을', '를')} 다른 날로 미루면 나머지는 시간 안에 끝나요`);
    });
    if (!out.length) out.push('예약 시간이나 머무는 시간을 다시 확인해 보세요');
    return out.slice(0, 3);
  }

  // ---------------------------------------------------------------------
  // 바깥에서 부르는 함수
  // ---------------------------------------------------------------------
  /**
   * @param {object} input
   *   start {lat,lng,name}, startMin(자정부터 분), startIsNow, end {type, place},
   *   dayMode, stops [{place, kind, stay, fixedAt(분|null), deadline(분|null), order, mode}],
   *   kindOf(id) → {car:[도착,출발], light:[도착,출발]}
   *   travelFn (선택) — 4단계에서 실제 길찾기로 교체
   */
  function plan(input) {
    const stops = input.stops || [];
    if (!stops.length || !input.start) return null;
    if (stops.length > MAX_STOPS) return { tooMany: true };

    const ctx = {
      stops,
      start: input.start,
      end: input.end || { type: 'return' },
      dayMode: input.dayMode || 'car',
      startMin: input.startMin,
      kindOf: input.kindOf,
      travelFn: input.travelFn || travel,
    };

    const fast = solve(ctx, 'fast');
    const shortest = solve(ctx, 'travel');
    const options = [{ key: 'fast', label: '가장 빨리 끝나요', sim: fast }];
    const same = shortest.order.join() === fast.order.join();
    // 이동을 줄이는 대신 너무 늦게 끝나면 의미가 없으므로, 아끼는 이동의 2배(최소 10분)까지만 늦어져도 될 때 보여줌
    const saved = fast.travelSum - shortest.travelSum;
    const delay = shortest.finishAll - fast.finishAll;
    if (!same && shortest.lateness === 0 && saved >= 3 && delay <= Math.max(10, saved * 2)) {
      options.push({ key: 'short', label: '이동이 가장 적어요', sim: shortest });
    }

    options.forEach((o) => {
      o.reasons = reasonsFor(ctx, o.sim);
      o.warnings = warningsFor(ctx, o.sim);
    });
    const ok = fast.lateness === 0;
    return {
      ok,
      options,
      suggestions: ok ? [] : suggestionsFor(ctx, input, fast),
      method: stops.length <= BRUTE_MAX ? 'exact' : 'approx',
    };
  }

  /** 사용자가 직접 바꾼 순서로 다시 계산 (조정용) */
  function evaluate(input, order) {
    const ctx = {
      stops: input.stops,
      start: input.start,
      end: input.end || { type: 'return' },
      dayMode: input.dayMode || 'car',
      startMin: input.startMin,
      kindOf: input.kindOf,
      travelFn: input.travelFn || travel,
    };
    const sim = simulate(ctx, order);
    return { sim, reasons: [], warnings: warningsFor(ctx, sim), valid: validOrder(input.stops, order) };
  }

  const api = { plan, evaluate, travel, distM, fmt, josa, BRUTE_MAX, MAX_STOPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GetsetEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
