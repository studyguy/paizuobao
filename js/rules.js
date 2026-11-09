/* ============================================================
 * 排座宝 P1.5d — 关系约束：身份/宾客双维度 + 互斥检测
 * 约束对象：{id, type, a, b, scope}
 *   scope='guest'（默认）：a/b 为宾客 id
 *   scope='role' ：a/b 为角色 key，展开作用于该身份的所有宾客
 * 互斥检测：同一条规则在两种维度下若对同一对宾客给出相反的
 *   「必须同桌/不能同桌」结论 → 硬互斥，禁止创建；
 *   「希望」级别的相反结论 → 软冲突，允许但提示。
 * ============================================================ */
(function (root) {
  'use strict';

  const D = root.PaizuoData;

  const HARD_OPP = { mustTogether: 'mustApart', mustApart: 'mustTogether' };
  const SOFT_OPP = { preferTogether: 'preferApart', preferApart: 'preferTogether' };

  /**
   * 展开一条约束为宾客对集合
   * @returns [{a, b}] 宾客 id 对（去自身、去重、无序对规范化 a<b）
   */
  function expandRule(rule, state) {
    const out = [];
    const norm = (x, y) => x < y ? [x, y] : [y, x];
    if (!rule || !rule.a || !rule.b) return out;
    if ((rule.scope || 'guest') === 'guest') {
      if (rule.a !== rule.b) out.push(norm(rule.a, rule.b));
      return out;
    }
    const ga = D.attendingGuests(state).filter(g => g.role === rule.a);
    const gb = D.attendingGuests(state).filter(g => g.role === rule.b);
    const seen = new Set();
    for (const x of ga) {
      for (const y of gb) {
        if (x.id === y.id) continue;
        const [a, b] = norm(x.id, y.id);
        const key = a + '|' + b;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([a, b]);
      }
    }
    return out;
  }

  function samePair(p, q) {
    return (p[0] === q[0] && p[1] === q[1]) || (p[0] === q[1] && p[1] === q[0]);
  }

  /**
   * 新建约束前的冲突检测
   * @param candidate {type, a, b, scope}
   * @param existing 现有约束数组
   * @param state
   * @returns {hard: [{against, pair}], soft: [{against, pair}], dup: bool, empty: bool}
   *   hard 非空 → 不能创建
   */
  function checkConflict(candidate, existing, state) {
    const res = { hard: [], soft: [], dup: false, empty: false };
    const np = expandRule(candidate, state);
    // 同身份「必须同桌」会把该身份所有人锁进一桌——不是错误，但要提示确认
    if ((candidate.scope || 'guest') === 'role' && candidate.a === candidate.b &&
        candidate.type === 'mustTogether') {
      res.empty = true;
    }
    if (!np.length) return res;
    // 同参数同类型去重
    for (const e of existing) {
      if (e.type === candidate.type && (e.scope || 'guest') === (candidate.scope || 'guest') &&
          e.a === candidate.a && e.b === candidate.b) {
        res.dup = true;
        break;
      }
      // 身份级与其展开出的宾客级同类型重复也算 dup
      if (e.type === candidate.type) {
        const ep = expandRule(e, state);
        if (ep.length === np.length && ep.every((p, i) => samePair(p, np[i]))) {
          res.dup = true;
          break;
        }
      }
    }
    for (const e of existing) {
      const ep = expandRule(e, state);
      for (const p of np) {
        for (const q of ep) {
          if (!samePair(p, q)) continue;
          if (HARD_OPP[candidate.type] === e.type) {
            res.hard.push({ against: e, pair: p });
          } else if (SOFT_OPP[candidate.type] === e.type ||
                     HARD_OPP[e.type] === candidate.type && candidate.type.startsWith('prefer')) {
            res.soft.push({ against: e, pair: p });
          }
        }
      }
    }
    return res;
  }

  /** 约束的人类可读描述（供列表展示） */
  function describe(rule, state) {
    const t = D.CONSTRAINT_TYPES[rule.type];
    const label = t ? t.label : rule.type;
    if ((rule.scope || 'guest') === 'role') {
      const ra = D.ROLES[rule.a] ? D.ROLES[rule.a].label : rule.a;
      const rb = D.ROLES[rule.b] ? D.ROLES[rule.b].label : rule.b;
      return { scope: '身份', text: ra + ' ↔ ' + rb };
    }
    const ga = D.guestById(state, rule.a);
    const gb = D.guestById(state, rule.b);
    return { scope: '宾客', text: (ga ? ga.name : '?') + ' ↔ ' + (gb ? gb.name : '?') };
  }

  /** 常用默认约束模板（按场景） */
  function templates(scenario) {
    if (scenario === 'banquet') {
      return [
        { label: '高管必须同桌', a: 'boss', b: 'seniorExec', type: 'mustTogether' },
        { label: '经理之间最好分开', a: 'manager', b: 'manager', type: 'preferApart' },
        { label: '家属不与员工同桌', a: 'plusOne', b: 'staff', type: 'preferApart' },
        { label: '特邀嘉宾与高管同桌', a: 'vipGuest', b: 'boss', type: 'preferTogether' },
      ];
    }
    return [
      { label: '双方父母各自同桌', a: 'groomFather', b: 'groomMother', type: 'mustTogether',
        extra: [{ a: 'brideFather', b: 'brideMother', type: 'mustTogether' }] },
      { label: '领导之间最好分桌', a: 'leader', b: 'leader', type: 'preferApart' },
      { label: '同学尽量同桌', a: 'classmate', b: 'classmate', type: 'preferTogether' },
      { label: '祖辈靠近主桌（与新人同桌）', a: 'grandparent', b: 'groom', type: 'preferTogether' },
    ];
  }

  const api = { expandRule, checkConflict, describe, templates };
  root.PaizuoRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
