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
  const TRAVEL_DEFAULT = { walkMpm: 70, bikeMpm: 250, detour: 1.3, transitWait: 8, transitAccess: 6, transitKmh: 20, transitDetour: 1.4, carBase: 2, carDetour: 1.35, carCityMpm: 350, carMidMpm: 500, carFarMpm: 800 };

  /** 직선거리로 어림한 이동 시간. 계수는 값 파일(model.json → travel)에서 옴 */
  function travel(a, b, mode, params) {
    const P = params || TRAVEL_DEFAULT;
    const d = distM(a, b);
    let min;
    if (d < 30) min = 0;
    else if (mode === 'walk') min = (d * P.detour) / P.walkMpm;
    else if (mode === 'bike') min = (d * P.detour) / P.bikeMpm;
    else if (mode === 'transit') min = P.transitWait + (d * P.transitDetour) / ((P.transitKmh * 1000) / 60) + P.transitAccess;
    else {
      const v = d < 3000 ? P.carCityMpm : d < 15000 ? P.carMidMpm : P.carFarMpm;
      min = P.carBase + (d * P.carDetour) / v;
    }
    return { min: Math.ceil(min), dist: Math.round(d) };
  }

  // ---------------------------------------------------------------------
  // 한 순서를 실제로 따라가 보며 시간표를 만든다
  // ---------------------------------------------------------------------
  // 도착 후·출발 전 실질 시간은 kinds.js(주차장 종류·건물 안 시간·혼잡)가 계산해서 넘겨준다
  // 원하는 시간: tolerance분까지 늦는 건 괜찮고, 그보다 늦으면 1분마다 끝나는 시각 weight분 손해로 취급
  // (값은 model.json → pref, 기본 10분 / 3배)

  /**
   * 도착해서 볼일을 할 수 있게 된 시각(ready)부터 실제 시작·끝·늦음을 계산 — 모든 시간 규칙이 여기 모임
   *   - 영업 시작 전이면 문 열 때까지 기다림 (openAt)
   *   - 원하는 시간(prefAt): 일찍 오면 기다렸다 시작, 많이 늦으면 약한 손해(soft)
   *   - 예약(fixedAt): 일찍 오면 기다림, 늦으면 위반
   *   - 점심 휴진 등(breaks): 볼일이 그 시간에 걸리면 끝난 뒤로 미룸 (예약은 사용자가 알고 잡았으니 그대로)
   *   - 문 닫는 시간: 사용자가 넣은 deadline과 영업 종료 closeAt 중 이른 쪽까지 끝내야 함
   *   - 쉬는 날(closed): 어떤 순서로도 못 지킴 → 위반으로 표시
   */
  function serve(s, ready, tol, weight) {
    let begin = ready;
    let late = 0;
    let soft = 0;
    let prefLate = 0;
    const viol = [];
    // 직접 정한 도착 시각이 있으면 보통 영업 시작 시간은 따지지 않음 (그 시간에 가기로 한 것이므로)
    if (s.openAt != null && s.fixedAt == null && begin < s.openAt) begin = s.openAt;
    if (s.prefAt != null) {
      if (ready < s.prefAt) begin = Math.max(begin, s.prefAt);
      else if (ready - s.prefAt > tol) {
        prefLate = ready - s.prefAt;
        soft = (prefLate - tol) * weight;
      }
    }
    if (s.fixedAt != null) {
      if (ready <= s.fixedAt) begin = Math.max(begin, s.fixedAt);
      else {
        late += ready - s.fixedAt;
        viol.push({ type: 'fixed', minutes: ready - s.fixedAt });
      }
    }
    if (s.breaks && s.fixedAt == null) {
      for (const [b0, b1] of s.breaks) {
        if (begin < b1 && begin + s.stay > b0) begin = b1;
      }
    }
    const finish = begin + s.stay;
    const userDl = s.deadline != null ? s.deadline : Infinity;
    const closeDl = s.closeAt != null ? s.closeAt : Infinity;
    const dl = Math.min(userDl, closeDl);
    if (finish > dl) {
      late += finish - dl;
      viol.push({ type: userDl <= closeDl ? 'deadline' : 'hours', minutes: finish - dl });
    }
    if (s.closed) {
      late += 60;
      viol.push({ type: 'closed', minutes: 0 });
    }
    return { begin, wait: begin - ready, finish, late, soft, prefLate, viol };
  }

  function simulate(ctx, order, opts = {}) {
    const { stops, start, end, dayMode, startMin, overheadFn, travelFn } = ctx;
    const PREF_TOLERANCE = ctx.prefTol;
    const PREF_WEIGHT = ctx.prefWeight;
    const startOH = ctx.startOH || null; // 집에서 나와 차까지 등 (첫 이동 전에 붙음)
    let t = startMin;
    let prev = start;
    let lateness = 0;
    let travelSum = 0;
    let waitSum = 0;
    let soft = 0;
    let sumFinish = 0; // 끝나는 시각이 같으면 볼일을 앞쪽에 몰아서 빨리 해치우는 순서를 고르기 위함
    const rows = [];
    const violations = [];
    let usedCar = false;
    let pending = null; // 아직 "나오는 시간"을 안 붙인 직전 실제 장소 {row, s, mode}

    for (let p = 0; p < order.length; p++) {
      const i = order[p];
      const s = stops[i];

      // 시간만 비워 둔 칸(점심 등): 장소가 없으니 이동·주차 없이 그 자리에서 시간만 씀
      if (s.anywhere) {
        const sv = serve(s, t, PREF_TOLERANCE, PREF_WEIGHT);
        soft += sv.soft;
        sumFinish += sv.finish;
        sv.viol.forEach((v) => violations.push({ i, type: v.type, minutes: v.minutes }));
        lateness += sv.late;
        if (opts.bound != null) {
          const partial = opts.metric === 'travel' ? lateness * PENALTY + travelSum : lateness * PENALTY + sv.finish + soft;
          if (partial > opts.bound) return null;
        }
        rows.push({ i, anywhere: true, mode: null, outAt: t, startOH: 0, startParts: [], leaveAt: t, travel: 0, dist: 0, arrive: t, arriveOH: 0, arriveParts: [], parking: null, ready: t, wait: sv.wait, begin: sv.begin, finish: sv.finish, leaveOH: 0, leaveParts: [], depart: sv.finish, late: sv.late, prefLate: sv.prefLate });
        t = sv.finish;
        continue;
      }

      let mode = s.mode || dayMode;
      // 차로 다니는 날이라도 바로 근처(직선 nearWalk m 안)는 차를 두고 걸어간다
      if (mode === 'car' && ctx.nearWalk && distM(prev, s.place) < ctx.nearWalk) mode = 'walk';
      const outAt = t; // 직전 장소(또는 출발지)에서 걸어 나오기 시작하는 시각
      let preOH = 0;
      let preParts = [];
      if (pending) {
        // 차로 왔다가 차로 떠날 때만 주차장 시간(엘리베이터·출차)이 붙음. 걸어서 왔으면 차가 여기 없음
        const leaveMode = pending.mode === 'car' && mode === 'car' ? 'car' : mode === 'car' ? 'walk' : mode;
        const lOH = overheadFn(pending.s, leaveMode, 'leave', t);
        pending.row.leaveOH = lOH.total;
        pending.row.leaveParts = lOH.parts;
        if (!pending.row.parking && lOH.parking) pending.row.parking = lOH.parking;
        pending.row.depart = t + lOH.total;
        preOH = lOH.total;
        preParts = lOH.parts;
      }
      // 출발지(집)에 세워 둔 차를 처음 탈 때: 나와서 차까지 + 출차
      if (startOH && mode === 'car' && !usedCar) {
        preOH += startOH.total;
        preParts = preParts.concat(startOH.parts);
      }
      if (mode === 'car') usedCar = true;
      t += preOH;
      const tr = travelFn(prev, s.place, mode);
      const leaveAt = t;
      t += tr.min;
      travelSum += tr.min;
      const arrive = t;
      // 바로 옆 건물(30m 안)로 걸어 옮기는 경우가 아니면 도착 후 실질 시간이 붙음
      const aOH = tr.dist < 30 && pending ? { total: 0, parts: [] } : overheadFn(s, mode, 'arrive', arrive);
      const arriveOH = aOH.total;
      const ready = arrive + arriveOH;
      const sv = serve(s, ready, PREF_TOLERANCE, PREF_WEIGHT);
      const { begin, wait, finish, late, prefLate } = sv;
      soft += sv.soft;
      sumFinish += finish;
      sv.viol.forEach((v) => violations.push({ i, type: v.type, minutes: v.minutes }));
      lateness += late;
      waitSum += wait;

      // 가지치기: 이미 지금까지가 최선보다 나쁘면 그만 (출발 준비 전 시각 기준이라 안전한 하한)
      if (opts.bound != null) {
        const partial = opts.metric === 'travel' ? lateness * PENALTY + travelSum : lateness * PENALTY + finish + soft;
        if (partial > opts.bound) return null;
      }

      const row = { i, mode, outAt, startOH: preOH, startParts: preParts, leaveAt, travel: tr.min, dist: tr.dist, arrive, arriveOH, arriveParts: aOH.parts, parking: aOH.parking || null, ready, wait, begin, finish, leaveOH: 0, leaveParts: [], depart: finish, late, prefLate };
      rows.push(row);
      t = finish;
      prev = s.place;
      pending = { row, s, mode };
    }

    const doneAt = rows.length ? rows[rows.length - 1].finish : startMin;
    let endLeg = null;
    let finishAll = doneAt;
    if (end.type !== 'none' && pending) {
      const target = end.type === 'return' ? start : end.place;
      const outAt = t;
      const leaveMode = pending.mode === 'car' && dayMode === 'car' ? 'car' : dayMode === 'car' ? 'walk' : dayMode;
      const lOH = overheadFn(pending.s, leaveMode, 'leave', t);
      pending.row.leaveOH = lOH.total;
      pending.row.leaveParts = lOH.parts;
      if (!pending.row.parking && lOH.parking) pending.row.parking = lOH.parking;
      pending.row.depart = t + lOH.total;
      t += lOH.total;
      const tr = travelFn(prev, target, dayMode);
      travelSum += tr.min;
      endLeg = { mode: dayMode, outAt, startOH: lOH.total, leaveAt: t, travel: tr.min, dist: tr.dist, arrive: t + tr.min, target: end.type };
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
      soft,
      violations,
      // 우선순서: 약속 지키기 ≫ 가장 빨리 끝남 > 볼일을 앞쪽에 몰기 > 이동 적게 (뒤의 둘은 1분보다 작은 차이로만 작용)
      costFast: lateness * PENALTY + finishAll + soft + sumFinish * 5e-5 + travelSum * 1e-6,
      costShort: lateness * PENALTY + travelSum + soft + finishAll * 0.001 + sumFinish * 1e-6,
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

  /**
   * 8곳 이하: 전부 계산 — 앞에서부터 한 곳씩 붙여가며 시간을 이어서 계산(되돌아갈 때 그대로 재사용)
   * 이미 최선보다 나빠진 갈래는 더 보지 않는다(가지치기). 마지막에 최선 순서만 다시 따라가 시간표를 만든다.
   */
  function bruteForce(ctx, metric) {
    const { stops, start, end, dayMode, startMin, overheadFn, travelFn } = ctx;
    const PREF_TOLERANCE = ctx.prefTol;
    const PREF_WEIGHT = ctx.prefWeight;
    const n = stops.length;
    const groups = stops.map(groupOf);
    const modes = stops.map((s) => s.mode || dayMode);
    const endTarget = end.type === 'return' ? start : end.type === 'place' ? end.place : null;
    const used = new Array(n).fill(false);
    const remainInGroup = [0, 0, 0];
    groups.forEach((g) => remainInGroup[g]++);
    const order = [];
    let bestCost = Infinity;
    let bestOrder = null;
    const isTravel = metric === 'travel';
    const startOHmin = ctx.startOH ? ctx.startOH.total : 0;

    // 두 지점 사이 이동은 순서와 상관없이 같으므로 미리 계산
    const trMemo = new Map();
    const tr = (ai, bi, mode) => {
      const key = (ai + 1) * 256 + (bi + 1) * 4 + (mode === 'car' ? 0 : mode === 'walk' ? 1 : mode === 'bike' ? 2 : 3);
      let v = trMemo.get(key);
      if (!v) trMemo.set(key, (v = travelFn(ai >= 0 ? stops[ai].place : start, bi >= 0 ? stops[bi].place : endTarget, mode)));
      return v;
    };

    function rec(prevIdx, tFinish, lateness, soft, travelSum, curGroup, sumF, prevMode, usedCar) {
      if (order.length === n) {
        let t = tFinish;
        let travel = travelSum;
        if (endTarget && prevIdx >= 0) {
          const last = stops[prevIdx];
          const lm = prevMode === 'car' && dayMode === 'car' ? 'car' : dayMode === 'car' ? 'walk' : dayMode;
          t += overheadFn(last, lm, 'leave', tFinish).total;
          const leg = tr(prevIdx, -1, dayMode);
          t += leg.min;
          travel += leg.min;
        }
        const c = isTravel ? lateness * PENALTY + travel + soft + t * 0.001 + sumF * 1e-6 : lateness * PENALTY + t + soft + sumF * 5e-5 + travel * 1e-6;
        if (c < bestCost) {
          bestCost = c;
          bestOrder = order.slice();
        }
        return;
      }
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        const g = groups[j];
        if (g < curGroup) continue;
        if (g > curGroup && remainInGroup[curGroup] > 0) continue; // 앞 그룹이 남아 있음
        if (g > 1 && remainInGroup[1] > 0) continue;
        if (g > 0 && remainInGroup[0] > 0) continue;
        const s = stops[j];
        if (s.anywhere) {
          const sv0 = serve(s, tFinish, PREF_TOLERANCE, PREF_WEIGHT);
          const L0 = lateness + sv0.late;
          const S0 = soft + sv0.soft;
          const F0 = sumF + sv0.finish;
          const bound0 = isTravel ? L0 * PENALTY + travelSum + S0 : L0 * PENALTY + sv0.finish + S0 + F0 * 5e-5;
          if (bound0 >= bestCost) continue;
          used[j] = true;
          remainInGroup[g]--;
          order.push(j);
          rec(prevIdx, sv0.finish, L0, S0, travelSum, g, F0, prevMode, usedCar);
          order.pop();
          remainInGroup[g]++;
          used[j] = false;
          continue;
        }
        let mode = modes[j];
        if (mode === 'car' && ctx.nearWalk && tr(prevIdx, j, 'car').dist < ctx.nearWalk) mode = 'walk';
        let t = tFinish;
        if (startOHmin && mode === 'car' && !usedCar) t += startOHmin;
        if (prevIdx >= 0) {
          const lm = prevMode === 'car' && mode === 'car' ? 'car' : mode === 'car' ? 'walk' : mode;
          t += overheadFn(stops[prevIdx], lm, 'leave', tFinish).total;
        }
        const leg = tr(prevIdx, j, mode);
        t += leg.min;
        const oh = leg.dist < 30 && prevIdx >= 0 ? 0 : overheadFn(s, mode, 'arrive', t).total;
        const ready = t + oh;
        const sv = serve(s, ready, PREF_TOLERANCE, PREF_WEIGHT);
        const finish = sv.finish;
        const late = sv.late;
        const sft = sv.soft;
        const L = lateness + late;
        const S = soft + sft;
        const T = travelSum + leg.min;
        const F = sumF + finish;
        const bound = isTravel ? L * PENALTY + T + S : L * PENALTY + finish + S + F * 5e-5;
        if (bound >= bestCost) continue;
        used[j] = true;
        remainInGroup[g]--;
        order.push(j);
        rec(j, finish, L, S, T, g, F, mode, usedCar || mode === 'car');
        order.pop();
        remainInGroup[g]++;
        used[j] = false;
      }
    }
    rec(-1, startMin, 0, 0, 0, 0, 0, null, false);
    return simulate(ctx, bestOrder);
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
          const d = ctx.stops[i].anywhere ? 0 : distM(here, ctx.stops[i].place);
          if (d < bd) {
            bd = d;
            bi = i;
          }
        }
        nn.push(bi);
        left.delete(bi);
        if (!ctx.stops[bi].anywhere) here = ctx.stops[bi].place;
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
    const pref = sim.order.filter((i) => stops[i].prefAt != null);
    if (pref.length && out.length < 2) {
      const q = pref[0];
      const r = sim.rows[pos[q]];
      out.push(
        r.prefLate > ctx.prefTol
          ? `${josa(name(q), '은', '는')} 원하는 시간(${fmt(stops[q].prefAt)})보다 ${r.prefLate}분 늦어져요. 다른 일정 때문에 어쩔 수 없었어요`
          : `${josa(name(q), '은', '는')} 원하는 시간(${fmt(stops[q].prefAt)})에 맞췄어요`
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
      if (v.type === 'closed') return `${josa(n, '은', '는')} 이날 보통 쉬어요${s.closedNote ? ` (${s.closedNote})` : ''}`;
      if (v.type === 'hours') return `${josa(n, '은', '는')} 보통 ${fmt(s.closeAt)}에 문을 닫아요 — ${v.minutes}분 늦게 끝나요`;
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

  /** overheadFn이 없을 때 쓰는 아주 단순한 값 (테스트·비상용) */
  function defaultOverhead(stop, mode, which) {
    const m = mode === 'car' ? (which === 'arrive' ? 7 : 4) : which === 'arrive' ? 3 : 1;
    return { total: m, parts: [['이동·대기', m]] };
  }

  // ---------------------------------------------------------------------
  // 바깥에서 부르는 함수
  // ---------------------------------------------------------------------
  /**
   * @param {object} input
   *   start {lat,lng,name}, startMin(자정부터 분), startIsNow, end {type, place},
   *   dayMode, stops [{place, kind, parking, stay, fixedAt, prefAt, deadline(분|null), order, mode}],
   *   overheadFn(stop, mode, 'arrive'|'leave', 시각) → {total, parts} — kinds.js 현실 시간 모델
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
      overheadFn: input.overheadFn || defaultOverhead,
      travelFn: input.travelFn || ((a, b, m) => travel(a, b, m, input.travelParams)),
      prefTol: input.pref && Number.isFinite(input.pref.tolerance) ? input.pref.tolerance : 10,
      prefWeight: input.pref && Number.isFinite(input.pref.weight) ? input.pref.weight : 3,
      startOH: input.startOH || null,
      nearWalk: input.travelParams && Number(input.travelParams.nearWalkM) > 0 ? Number(input.travelParams.nearWalkM) : 0,
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
    options.forEach((o) => (o.latest = latestStart(input, o.sim.order)));
    return {
      ok,
      options,
      suggestions: ok ? [] : suggestionsFor(ctx, input, fast),
      method: stops.length <= BRUTE_MAX ? 'exact' : 'approx',
    };
  }

  /**
   * 늦어도 몇 시엔 출발해야 하나 — 추천 순서 그대로 출발만 늦춰 보며, 예약·마감·영업시간을 다 지키는 가장 늦은 출발 시각
   * 시간 약속이 하나도 없으면 null
   */
  function latestStart(input, order) {
    const hard = input.stops.some((s) => s.fixedAt != null || s.deadline != null || s.closeAt != null);
    if (!hard) return null;
    const ctx = makeCtx(input);
    const ok = (k) => simulate(Object.assign({}, ctx, { startMin: input.startMin + k }), order).lateness === 0;
    if (!ok(0)) return null;
    let lo = 0;
    let hi = 1;
    while (hi <= 720 && ok(hi)) {
      lo = hi;
      hi *= 2;
    }
    hi = Math.min(hi, 721);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    return lo >= 720 ? null : input.startMin + lo;
  }

  function makeCtx(input) {
    return {
      stops: input.stops,
      start: input.start,
      end: input.end || { type: 'return' },
      dayMode: input.dayMode || 'car',
      startMin: input.startMin,
      overheadFn: input.overheadFn || defaultOverhead,
      travelFn: input.travelFn || ((a, b, m) => travel(a, b, m, input.travelParams)),
      prefTol: input.pref && Number.isFinite(input.pref.tolerance) ? input.pref.tolerance : 10,
      prefWeight: input.pref && Number.isFinite(input.pref.weight) ? input.pref.weight : 3,
      startOH: input.startOH || null,
      nearWalk: input.travelParams && Number(input.travelParams.nearWalkM) > 0 ? Number(input.travelParams.nearWalkM) : 0,
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
      overheadFn: input.overheadFn || defaultOverhead,
      travelFn: input.travelFn || ((a, b, m) => travel(a, b, m, input.travelParams)),
      prefTol: input.pref && Number.isFinite(input.pref.tolerance) ? input.pref.tolerance : 10,
      prefWeight: input.pref && Number.isFinite(input.pref.weight) ? input.pref.weight : 3,
      startOH: input.startOH || null,
      nearWalk: input.travelParams && Number(input.travelParams.nearWalkM) > 0 ? Number(input.travelParams.nearWalkM) : 0,
    };
    const sim = simulate(ctx, order);
    return { sim, reasons: [], warnings: warningsFor(ctx, sim), valid: validOrder(input.stops, order) };
  }

  const api = { plan, evaluate, latestStart, travel, distM, fmt, josa, BRUTE_MAX, MAX_STOPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GetsetEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
