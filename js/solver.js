/* ============================================================
 * 排座宝 P0 原型 — 约束求解引擎
 * 设计对齐 PerfectTablePlan 思路：
 *  - mustTogether 宾客合并为"块"（super-guest）整体调度，
 *    消除单点移动无法跨越的硬约束势垒
 *  - 桌级分配优化（模拟退火） + 桌内座次排序（辈分/舅父上位）
 *  - 软硬约束分级：硬=超员/必须同桌/不能同桌；软=希望同桌、
 *    长辈梯度、主桌构成、婆家娘家混坐、自定义组内聚
 *  - 一次生成多套方案供对比（方案A/B/C）
 * ============================================================ */
(function (root) {
  'use strict';

  const D = root.PaizuoData;

  /* ---- 惩罚权重 ---- */
  const W = {
    HARD: 1e6,            // 硬约束（计数后乘）
    headMustOff: 60,      // 礼俗主桌成员不在主桌
    vipOffHead: 25,       // 高身份(非必须主桌)不在主桌
    uncleOffHead: 22,     // 舅父不在主桌
    nonVipOnHead: 8,      // 普通宾客占用主桌
    preferT: 12,          // 希望同桌被拆开
    preferA: 12,          // 最好分开却同桌
    groupSplit: 6,        // 自定义组每多拆一桌
    mixedMinority: 3,     // 男女方混坐且一方过少
    gradient: 2,          // 长辈梯度违例每单位
  };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 预编译问题上下文 */
  function buildContext(state) {
    const guests = D.attendingGuests(state);
    const gIdx = new Map();
    guests.forEach((g, i) => gIdx.set(g.id, i));

    const G = guests.length;
    const tables = state.tables;
    const T = tables.length;
    const caps = tables.map(t => t.capacity | 0);
    const capTotal = caps.reduce((a, b) => a + b, 0);

    const headIdx = Math.max(0, tables.findIndex(t => t.isHead));

    // 桌面距离（stage 布局坐标；未布局则给默认网格坐标）
    const pos = tables.map((t, i) => {
      if (typeof t.x === 'number' && typeof t.y === 'number') return { x: t.x, y: t.y };
      return defaultTablePos(tables, i);
    });
    const headPos = pos[headIdx];
    const dists = pos.map(p => Math.hypot(p.x - headPos.x, p.y - headPos.y));
    const distOrder = tables.map((_, i) => i).sort((a, b) => dists[a] - dists[b]);

    const ranks = guests.map(g => D.roleRank(g));
    const roles = guests.map(g => g.role || '');
    const sides = guests.map(g => g.side || '');
    const isUncle = roles.map(r => r === 'uncle');
    const headMust = guests.map(g => { const r = D.ROLES[g.role]; return !!(r && r.headMust); });
    const vip = guests.map((g, i) => ranks[i] >= 85);

    // 约束 → 索引对（身份级约束先展开为宾客对）
    const mustT = [], mustA = [], prefT = [], prefA = [];
    const pushC = (c, ai, bi) => {
      if (c.type === 'mustTogether') mustT.push([ai, bi]);
      else if (c.type === 'mustApart') mustA.push([ai, bi]);
      else if (c.type === 'preferTogether') prefT.push([ai, bi]);
      else if (c.type === 'preferApart') prefA.push([ai, bi]);
    };
    for (const c of state.constraints || []) {
      if ((c.scope || 'guest') === 'role') {
        const ga = guests.filter(g => g.role === c.a);
        const gb = guests.filter(g => g.role === c.b);
        for (const x of ga) {
          for (const y of gb) {
            if (x.id === y.id) continue;
            const ai = gIdx.get(x.id), bi = gIdx.get(y.id);
            if (ai === undefined || bi === undefined) continue;
            pushC(c, ai, bi);
          }
        }
        continue;
      }
      const ai = gIdx.get(c.a), bi = gIdx.get(c.b);
      if (ai === undefined || bi === undefined) continue;
      pushC(c, ai, bi);
    }

    // 自定义组（≥3 人）
    const groups = new Map();
    guests.forEach((g, i) => {
      if (g.group && g.group !== '主家') {
        if (!groups.has(g.group)) groups.set(g.group, []);
        groups.get(g.group).push(i);
      }
    });
    const bigGroups = [...groups.values()].filter(arr => arr.length >= 3);

    return { guests, gIdx, G, T, tables, caps, capTotal, headIdx, dists, distOrder,
             ranks, roles, sides, isUncle, headMust, vip, mustT, mustA, prefT, prefA, bigGroups };
  }

  function defaultTablePos(tables, i) {
    // 与 stage.js 保持一致的兜底网格布局
    const isHead = tables[i].isHead;
    if (isHead) return { x: 540, y: 170 };
    const others = tables.map((t, j) => ({ t, j })).filter(o => !o.t.isHead);
    const row = Math.floor(others.findIndex(o => o.j === i) / 4);
    const col = others.findIndex(o => o.j === i) % 4;
    return { x: 150 + col * 260, y: 340 + row * 280 };
  }

  /* ---- 块构建：mustTogether 通过并查集合并为一个调度单元 ---- */
  function buildBlocks(ctx) {
    const { G, mustT } = ctx;
    const parent = new Array(G);
    for (let i = 0; i < G; i++) parent[i] = i;
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const [a, b] of mustT) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }
    const map = new Map();
    for (let i = 0; i < G; i++) {
      const r = find(i);
      if (!map.has(r)) map.set(r, []);
      map.get(r).push(i);
    }
    const blocks = [...map.values()];
    const blockOf = new Array(G);
    blocks.forEach((b, bi) => { for (const i of b) blockOf[i] = bi; });
    return { blocks, blockOf };
  }

  /* ---- 目标函数 ---- */
  function evaluate(assign, ctx) {
    const { G, T, caps, headIdx, distOrder, ranks, isUncle, headMust, vip,
            mustT, mustA, prefT, prefA, bigGroups, sides } = ctx;

    let hard = 0, soft = 0;
    const count = new Array(T).fill(0);
    const rankSum = new Array(T).fill(0);
    const groomN = new Array(T).fill(0);
    const brideN = new Array(T).fill(0);

    for (let i = 0; i < G; i++) {
      const t = assign[i];
      count[t]++;
      rankSum[t] += ranks[i];
      if (sides[i] === 'groom') groomN[t]++;
      else if (sides[i] === 'bride') brideN[t]++;
    }

    for (let t = 0; t < T; t++) {
      if (count[t] > caps[t]) hard += (count[t] - caps[t]);
      // 混坐 & 一方过少
      if (groomN[t] > 0 && brideN[t] > 0) {
        const min = Math.min(groomN[t], brideN[t]);
        if (min <= 2 && count[t] >= 4) soft += W.mixedMinority;
      }
    }

    for (const [a, b] of mustT) if (assign[a] !== assign[b]) hard++;
    for (const [a, b] of mustA) if (assign[a] === assign[b]) hard++;
    for (const [a, b] of prefT) if (assign[a] !== assign[b]) soft += W.preferT;
    for (const [a, b] of prefA) if (assign[a] === assign[b]) soft += W.preferA;

    for (let i = 0; i < G; i++) {
      const t = assign[i];
      if (headMust[i] && t !== headIdx) soft += W.headMustOff;
      else if (isUncle[i] && t !== headIdx) soft += W.uncleOffHead;
      else if (vip[i] && !headMust[i] && t !== headIdx) soft += W.vipOffHead;
      if (t === headIdx && ranks[i] < 60) soft += W.nonVipOnHead;
    }

    // 自定义组内聚
    for (const members of bigGroups) {
      const used = new Set();
      for (const m of members) used.add(assign[m]);
      if (used.size > 1) soft += (used.size - 1) * W.groupSplit;
    }

    // 长辈梯度：按离主桌距离排序，远桌平均辈分不应高于近桌
    let rankAcc = 0;
    for (let k = 0; k < distOrder.length - 1; k++) {
      const t1 = distOrder[k], t2 = distOrder[k + 1];
      const c1 = count[t1] || 1, c2 = count[t2] || 1;
      const a1 = rankSum[t1] / c1, a2 = rankSum[t2] / c2;
      const v = a2 - a1;
      if (v > 0) { soft += v * W.gradient; rankAcc += v; }
    }

    return { hard, soft, total: hard * W.HARD + soft, gradientViol: rankAcc };
  }

  /* ---- 模拟退火（块级 move / swap） ---- */
  function anneal(ctx, seed, iterations) {
    const rand = mulberry32(seed);
    const { G, T, caps } = ctx;
    const { blocks, blockOf } = buildBlocks(ctx);
    const B = blocks.length;
    const blockSize = blocks.map(b => b.length);

    // 初始化：块按大小降序贪心装入剩余容量最大的桌（可行解，无超员）
    const assign = new Array(G).fill(0);
    const remaining = caps.slice();
    const order = blocks.map((_, i) => i).sort((a, b) => blockSize[b] - blockSize[a]);
    for (const bi of order) {
      let best = 0, bestR = -1;
      for (let t = 0; t < T; t++) {
        if (remaining[t] > bestR) { bestR = remaining[t]; best = t; }
      }
      if (bestR < blockSize[bi]) {
        // 全满（容量不足）：均匀散开
        for (const m of blocks[bi]) assign[m] = (bi % T);
        continue;
      }
      for (const m of blocks[bi]) { assign[m] = best; remaining[best]--; }
    }

    let cur = evaluate(assign, ctx);
    let best = { assign: assign.slice(), ev: cur };
    const T0 = 40, alpha = Math.pow(0.001 / T0, 1 / iterations);

    for (let it = 0; it < iterations; it++) {
      const temp = T0 * Math.pow(alpha, it);
      const cand = assign.slice();

      if (rand() < 0.6 || B < 2) { // move：整块搬到随机桌
        const bi = Math.floor(rand() * B);
        const t = Math.floor(rand() * T);
        for (const m of blocks[bi]) cand[m] = t;
      } else { // swap：两块交换桌次
        const b1 = Math.floor(rand() * B);
        let b2 = Math.floor(rand() * B);
        if (b2 === b1) b2 = (b2 + 1) % B;
        const t1 = cand[blocks[b1][0]], t2 = cand[blocks[b2][0]];
        for (const m of blocks[b1]) cand[m] = t2;
        for (const m of blocks[b2]) cand[m] = t1;
      }

      const ev = evaluate(cand, ctx);
      const d = ev.total - cur.total;
      if (d < 0 || (d > 0 && rand() < Math.exp(-d / Math.max(temp, 1e-6)))) {
        assign.splice(0, G, ...cand);
        cur = ev;
        if (ev.total < best.ev.total) best = { assign: cand.slice(), ev };
      }
    }
    return { best, blocks, blockOf };
  }

  /* ---- 超员修复（块级贪心，不拆散必须同桌块） ---- */
  function repair(assign, ctx, blocks, blockOf) {
    const { G, T, caps } = ctx;
    const count = new Array(T).fill(0);
    for (let i = 0; i < G; i++) count[assign[i]]++;

    let guard = 0;
    while (guard++ < 300) {
      const over = count.findIndex((c, t) => c > caps[t]);
      if (over < 0) break;
      // 找 over 桌上"块平均辈分"最低的块
      let pickBlock = -1, pickKey = 1e9;
      for (let i = 0; i < G; i++) {
        if (assign[i] !== over) continue;
        const bi = blockOf[i];
        const avg = ctx.ranks[i] / blocks[bi].length;
        if (avg < pickKey) { pickKey = avg; pickBlock = bi; }
      }
      if (pickBlock < 0) break;
      const members = blocks[pickBlock];
      let dst = -1, bestCost = 1e18;
      for (let t = 0; t < T; t++) {
        if (t === over) continue;
        if (count[t] + members.length > caps[t]) continue;
        for (const m of members) assign[m] = t;
        const ev = evaluate(assign, ctx);
        if (ev.total < bestCost) { bestCost = ev.total; dst = t; }
        for (const m of members) assign[m] = over; // 还原
      }
      if (dst < 0) break; // 没有整块可容纳的空间，留给 unmet 报告
      for (const m of members) assign[m] = dst;
      count[over] -= members.length;
      count[dst] += members.length;
    }
    return assign;
  }

  /* ---- 桌内座次：辈分降序；主桌舅父加权（娘舅为大） ---- */
  function seatOrder(ctx, assign) {
    const { G, T, tables, headIdx, ranks, isUncle, guests } = ctx;
    const byTable = Array.from({ length: T }, () => []);
    for (let i = 0; i < G; i++) byTable[assign[i]].push(i);

    const order = {};
    for (let t = 0; t < T; t++) {
      const isHead = tables[t].isHead || t === headIdx;
      byTable[t].sort((a, b) => {
        const ra = ranks[a] + (isHead && isUncle[a] ? 5 : 0);
        const rb = ranks[b] + (isHead && isUncle[b] ? 5 : 0);
        return rb - ra;
      });
      order[tables[t].id] = byTable[t].map(i => guests[i].id);
    }
    return order;
  }

  /**
   * 求解入口
   * @returns {plans: [{name, seatOrder, score:{hard,soft}, unmet:[string]}], warn:[string]}
   */
  function solve(state, options) {
    options = options || {};
    const planCount = options.plans || 3;
    const ctx = buildContext(state);
    const warn = [];
    const plans = [];

    if (ctx.G === 0) { warn.push('还没有宾客，先导入名单'); return { plans, warn }; }
    if (ctx.T === 0) { warn.push('还没有桌子，先在「桌次设置」里加桌'); return { plans, warn }; }
    if (ctx.G > ctx.capTotal) {
      warn.push('座位总数 ' + ctx.capTotal + ' 少于宾客 ' + ctx.G + ' 人，将在报告中标出未安排者');
    }

    const iterations = Math.min(60000, Math.max(15000, ctx.G * ctx.T * 90));

    for (let p = 0; p < planCount; p++) {
      const { best, blocks, blockOf } = anneal(ctx, (Date.now() ^ (0x9E3779B9 * (p + 1))) >>> 0, iterations);
      let assign = repair(best.assign, ctx, blocks, blockOf);
      const ev = evaluate(assign, ctx);
      const order = seatOrder(ctx, assign);

      const unmet = [];
      if (ev.hard > 0) {
        const count = new Array(ctx.T).fill(0);
        for (let i = 0; i < ctx.G; i++) count[assign[i]]++;
        for (let t = 0; t < ctx.T; t++) if (count[t] > ctx.caps[t]) unmet.push(ctx.tables[t].name + ' 超员 ' + (count[t] - ctx.caps[t]) + ' 人');
        for (const [a, b] of ctx.mustT) if (assign[a] !== assign[b]) unmet.push('必须同桌未满足：' + ctx.guests[a].name + ' ↔ ' + ctx.guests[b].name);
        for (const [a, b] of ctx.mustA) if (assign[a] === assign[b]) unmet.push('不能同桌未满足：' + ctx.guests[a].name + ' ⚡ ' + ctx.guests[b].name);
      }
      if (ctx.G > ctx.capTotal) {
        const seated = Math.min(ctx.G, ctx.capTotal);
        unmet.push('座位不足，' + (ctx.G - seated) + ' 人未安排');
      }

      plans.push({
        name: '方案' + ('ABCDEF'[p] || (p + 1)),
        seatOrder: order,
        score: { hard: ev.hard, soft: Math.round(ev.soft), gradient: Math.round(ev.gradientViol * 10) / 10 },
        unmet,
      });
    }

    // 软分越低越好，排序后命名
    plans.sort((a, b) => (a.score.hard - b.score.hard) || (a.score.soft - b.score.soft));
    plans.forEach((pl, i) => { pl.name = '方案' + 'ABCDEF'[i]; });

    return { plans, warn };
  }

  /**
   * 把求解结果写入 state.plan
   */
  function applyPlan(state, plan) {
    const seats = {};
    for (const tableId in plan.seatOrder) {
      const arr = plan.seatOrder[tableId];
      for (let s = 0; s < arr.length; s++) seats[arr[s]] = { t: tableId, s };
    }
    state.plan = { name: plan.name, seats };
  }

  /**
   * 云端 assign 数组（宾客下标→桌下标，顺序同 buildContext）→ plan 对象
   * 桌内座次沿用本地辈分排序
   */
  function planFromAssign(ctx, assign, name) {
    const ev = evaluate(assign, ctx);
    const order = seatOrder(ctx, assign);
    const unmet = [];
    const count = new Array(ctx.T).fill(0);
    for (let i = 0; i < ctx.G; i++) count[assign[i]]++;
    for (let t = 0; t < ctx.T; t++) if (count[t] > ctx.caps[t]) unmet.push(ctx.tables[t].name + ' 超员');
    return { name, seatOrder: order, score: { hard: ev.hard, soft: Math.round(ev.soft) }, unmet };
  }

  /**
   * 当天模式·最小扰动整理：只处理「未安排」与「超员」，
   * 其余已座宾客一律不动（块级移动，不拆散必须同桌）
   */
  function repairOnly(state) {
    const ctx = buildContext(state);
    const warn = [];
    if (!ctx.G || !ctx.T) return { placed: 0, moved: 0, warn: ['先准备好宾客和桌次'] };
    if (!state.plan) {
      state.plan = { name: '手动', seats: {} };
      return { placed: 0, moved: 0, warn: ['尚无安排，请先用 AI 排座或手动拖拽'] };
    }

    const tIndex = new Map(state.tables.map((t, i) => [t.id, i]));
    const assign = new Array(ctx.G).fill(-1);
    for (let i = 0; i < ctx.G; i++) {
      const seat = state.plan.seats[ctx.guests[i].id];
      if (seat && tIndex.has(seat.t)) assign[i] = tIndex.get(seat.t);
    }
    const { blocks, blockOf } = buildBlocks(ctx);

    // 1) 未安排的块：按块内最高辈分降序，装入有空位且总分最优的桌
    const count = new Array(ctx.T).fill(0);
    for (let i = 0; i < ctx.G; i++) if (assign[i] >= 0) count[assign[i]]++;
    let placed = 0;
    const pending = blocks.map((b, bi) => bi).filter(bi => assign[blocks[bi][0]] === -1);
    pending.sort((a, b) =>
      Math.max(...blocks[b].map(i => ctx.ranks[i])) - Math.max(...blocks[a].map(i => ctx.ranks[i])));
    for (const bi of pending) {
      const members = blocks[bi];
      let dst = -1, bestCost = 1e18;
      for (let t = 0; t < ctx.T; t++) {
        if (count[t] + members.length > ctx.caps[t]) continue;
        for (const m of members) assign[m] = t;
        const ev = evaluate(assign, ctx);
        if (ev.total < bestCost) { bestCost = ev.total; dst = t; }
        for (const m of members) assign[m] = -1;
      }
      if (dst >= 0) {
        for (const m of members) { assign[m] = dst; count[dst]++; }
        placed += members.length;
      } else {
        warn.push('空位装不下整块（须同桌约束）：' + members.map(i => ctx.guests[i].name).join('、'));
      }
    }

    // 2) 超员修复（块级）
    repair(assign, ctx, blocks, blockOf);

    // 3) 只写回有变化的宾客
    let moved = 0;
    for (let i = 0; i < ctx.G; i++) {
      if (assign[i] < 0) continue;
      const g = ctx.guests[i];
      const seat = state.plan.seats[g.id];
      const newTid = state.tables[assign[i]].id;
      if (!seat || seat.t !== newTid) {
        const used = new Set();
        for (const gid in state.plan.seats) {
          if (state.plan.seats[gid].t === newTid) used.add(state.plan.seats[gid].s);
        }
        let s = 0;
        while (used.has(s)) s++;
        state.plan.seats[g.id] = { t: newTid, s };
        moved++;
      }
    }
    return { placed, moved, warn };
  }

  /** 身份级约束展开后的宾客对清单（发给 CP-SAT 服务端用） */
  function exportConstraints(state) {
    const ctx = buildContext(state);
    const g = i => ctx.guests[i].id;
    const mk = (arr, type) => arr.map(([ai, bi]) => ({ a: g(ai), b: g(bi), type }));
    return [
      ...mk(ctx.mustT, 'mustTogether'),
      ...mk(ctx.mustA, 'mustApart'),
      ...mk(ctx.prefT, 'preferTogether'),
      ...mk(ctx.prefA, 'preferApart'),
    ];
  }

  const api = { solve, applyPlan, planFromAssign, repairOnly, buildContext, evaluate, buildBlocks, exportConstraints, W };
  root.PaizuoSolver = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
