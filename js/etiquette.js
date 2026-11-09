/* ============================================================
 * 排座宝 P0 原型 — 中式婚宴礼俗检查器
 * v1 规则：主桌构成 / 舅父上座 / 双主桌建议 / 婆家娘家混坐 /
 *          长辈梯度 / 超员未安排 / 领导分散
 * ============================================================ */
(function (root) {
  'use strict';

  const D = root.PaizuoData;

  /**
   * @returns {issues: [{level:'error'|'warn'|'info', code, title, detail, fixable}]}
   */
  function check(state) {
    const issues = [];
    const SC = D.SCENARIOS[state.meta && state.meta.scenario || 'wedding'] || D.SCENARIOS.wedding;
    const C = SC.checks;
    if (!state.plan) {
      issues.push({ level: 'info', code: 'no-plan', title: '尚未排座', detail: '先完成一次排座（或手动安排），再来体检。' });
      return issues;
    }

    const attending = D.attendingGuests(state);
    const seats = state.plan.seats;
    const head = state.tables.find(t => t.isHead) || state.tables[0];
    const guestsAt = (tableId) => D.guestsAtTable(state, tableId);

    /* 1. 主桌构成 */
    for (const g of attending) {
      const r = D.ROLES[g.role];
      if (r && r.headMust) {
        const seat = seats[g.id];
        if (!seat) {
          issues.push({ level: 'error', code: 'head-miss', title: '主桌缺 ' + r.label, detail: g.name + '（' + r.label + '）尚未安排座位。', fixable: false });
        } else if (seat.t !== head.id) {
          const t = D.tableById(state, seat.t);
          issues.push({ level: 'error', code: 'head-miss', title: '主桌缺 ' + r.label, detail: g.name + '（' + r.label + '）目前在 ' + (t ? t.name : '?') + '，礼俗上应坐主桌。', fixable: true, guestId: g.id });
        }
      }
    }

    /* 2. 舅父上座（娘舅为大）—— 仅婚宴场景 */
    const uncles = C.uncle ? attending.filter(g => g.role === 'uncle') : [];
    for (const u of uncles) {
      const seat = seats[u.id];
      if (!seat) {
        issues.push({ level: 'warn', code: 'uncle', title: '舅父未安排', detail: '大舅 ' + u.name + ' 尚未安排座位，礼俗上应坐主桌上位。' });
      } else if (seat.t !== head.id) {
        const t = D.tableById(state, seat.t);
        issues.push({ level: 'warn', code: 'uncle', title: '舅父不在主桌', detail: '大舅 ' + u.name + ' 目前在 ' + (t ? t.name : '?') + '。按"娘舅为大"的习俗，建议安排到主桌。' });
      } else if (seat.s !== 0) {
        const at0 = guestsAt(head.id).find(x => x.s === 0);
        issues.push({ level: 'info', code: 'uncle-seat', title: '舅父未坐上座', detail: '主桌上位（面对大门首位）目前是 ' + (at0 ? at0.guest.name : '?') + '，大舅 ' + u.name + ' 在 ' + (seat.s + 1) + ' 号位。部分地区习俗以舅父坐上座为敬，可自行斟酌。' });
      }
    }

    /* 3. 双主桌建议 */
    const vips = attending.filter(g => D.roleRank(g) >= 85);
    if (head && vips.length > head.capacity) {
      issues.push({ level: 'info', code: 'dual-head', title: '可考虑设双主桌', detail: '主桌仅 ' + head.capacity + ' 座，但高身份宾客有 ' + vips.length + ' 位（新人、双方父母、证婚人、舅父等）。可开双主桌或让部分贵宾坐紧邻主桌的次桌。' });
    }

    /* 4. 婆家娘家混坐 —— 仅婚宴场景 */
    const hasGroom = C.mixed ? attending.some(g => g.side === 'groom') : false;
    const hasBride = C.mixed ? attending.some(g => g.side === 'bride') : false;
    if (hasGroom && hasBride) {
      for (const t of state.tables) {
        const list = guestsAt(t.id);
        if (list.length < 4) continue;
        const gN = list.filter(x => x.guest.side === 'groom').length;
        const bN = list.filter(x => x.guest.side === 'bride').length;
        if (gN > 0 && bN > 0 && Math.min(gN, bN) <= 2) {
          const minSide = gN < bN ? '新郎方' : '新娘方';
          issues.push({ level: 'info', code: 'mixed', title: t.name + ' 两方宾客混坐', detail: '该桌新郎方 ' + gN + ' 人、新娘方 ' + bN + ' 人，' + minSide + '亲友过少容易拘束。习俗上多按婆家/娘家分桌，也可接受，请自行权衡。' });
        }
      }
    }

    /* 5. 长辈梯度 */
    const dCtx = root.PaizuoSolver.buildContext(state);
    const count = new Array(dCtx.T).fill(0);
    const rankSum = new Array(dCtx.T).fill(0);
    for (const g of attending) {
      const seat = seats[g.id];
      if (!seat) continue;
      const ti = state.tables.findIndex(t => t.id === seat.t);
      if (ti < 0) continue;
      count[ti]++; rankSum[ti] += D.roleRank(g);
    }
    let worst = null;
    const order = dCtx.distOrder;
    for (let k = 0; k < order.length - 1; k++) {
      const t1 = order[k], t2 = order[k + 1];
      if (!count[t1] || !count[t2]) continue;
      const a1 = rankSum[t1] / count[t1], a2 = rankSum[t2] / count[t2];
      const v = a2 - a1;
      if (v >= 10 && (!worst || v > worst.v)) {
        worst = { v, t1: state.tables[t1], t2: state.tables[t2], a1: Math.round(a1), a2: Math.round(a2) };
      }
    }
    if (worst) {
      issues.push({ level: 'warn', code: 'gradient', title: '长辈梯度欠佳', detail: worst.t2.name + ' 离主桌更远，但平均辈分（' + worst.a2 + '）高于更近的 ' + worst.t1.name + '（' + worst.a1 + '）。通行做法：辈分越高越靠近主桌。' });
    }

    /* 6. 超员 / 未安排 */
    for (const t of state.tables) {
      const n = guestsAt(t.id).length;
      if (n > t.capacity) {
        issues.push({ level: 'error', code: 'over', title: t.name + ' 超员', detail: '该桌 ' + n + ' 人，超出容量 ' + t.capacity + ' 人。' });
      }
    }
    const unseated = D.unseated(state);
    if (unseated.length > 0) {
      const names = unseated.slice(0, 6).map(g => g.name).join('、') + (unseated.length > 6 ? ' 等' : '');
      issues.push({ level: 'warn', code: 'unseated', title: unseated.length + ' 人未安排', detail: names + ' 还没有座位。' });
    }

    /* 7. 领导分散（婚宴 leader / 年会 exec、manager 等中坚层，按辈分区间识别） */
    const leaderSeats = attending.filter(g => {
      const r = D.roleRank(g);
      return r >= 60 && r < 85;
    }).map(g => seats[g.id]).filter(Boolean);
    if (leaderSeats.length >= 2) {
      const tablesUsed = new Set(leaderSeats.map(s => s.t));
      const anyTableHasTwo = [...tablesUsed].some(tid => leaderSeats.filter(s => s.t === tid).length >= 2);
      if (!anyTableHasTwo && tablesUsed.size === leaderSeats.length) {
        issues.push({ level: 'info', code: 'leader', title: '领导各自分散', detail: '各位领导目前一人一桌。可考虑集中设"领导桌"便于敬酒接待。' });
      }
    }

    return issues;
  }

  /** 一键修复：把主桌成员换进主桌（与主桌中辈分最低的非成员对调） */
  function fixHeadComposition(state) {
    if (!state.plan) return 0;
    let fixed = 0;
    const seats = state.plan.seats;
    const head = state.tables.find(t => t.isHead) || state.tables[0];
    if (!head) return 0;

    for (const g of D.attendingGuests(state)) {
      const r = D.ROLES[g.role];
      if (!r || !r.headMust) continue;
      const seat = seats[g.id];
      if (!seat || seat.t === head.id) continue;

      // 主桌中辈分最低的非 headMust 宾客
      const members = D.guestsAtTable(state, head.id);
      let victim = null, victimRank = 1e9;
      for (const m of members) {
        const mr = D.ROLES[m.guest.role];
        if (mr && mr.headMust) continue;
        const rk = D.roleRank(m.guest);
        if (rk < victimRank) { victimRank = rk; victim = m; }
      }
      if (!victim) break; // 主桌全是必须成员，换不动
      seats[victim.guest.id] = { t: seat.t, s: victim.s };
      seats[g.id] = { t: head.id, s: victim.s };
      fixed++;
    }
    return fixed;
  }

  const api = { check, fixHeadComposition };
  root.PaizuoEtiquette = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
