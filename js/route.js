/* ============================================================
 * 排座宝 P1 — 敬酒动线生成
 * 从主桌开始按离主桌距离排序，逐桌给出宾客与称呼建议
 * ============================================================ */
(function (root) {
  'use strict';

  const D = root.PaizuoData;

  /** 宾客的敬酒称呼：角色标签优先，其次备注里的亲属称谓 */
  function address(guest) {
    const role = D.ROLES[guest.role];
    if (role) return role.label;
    if (guest.note) {
      const m = String(guest.note).match(/([\u4e00-\u9fa5]{2,4}(?:总|经理|老师|哥|姐|叔|姨|爷|奶))/);
      if (m) return m[1];
    }
    return '';
  }

  /**
   * @returns {stops: [{table, guests:[{name, addr, dietary}]}], text}
   * 顺序：主桌 → 按离主桌距离由近到远；跳过空桌
   */
  function generate(state) {
    if (!state.plan) return { stops: [], text: '' };
    const ctx = root.PaizuoSolver.buildContext(state);
    const stops = [];
    for (const ti of ctx.distOrder) {
      const t = state.tables[ti];
      const list = D.guestsAtTable(state, t.id);
      if (!list.length) continue;
      stops.push({
        table: t,
        guests: list.map(x => ({
          name: x.guest.name,
          addr: address(x.guest),
          dietary: x.guest.dietary || '',
        })),
      });
    }
    const lines = [];
    stops.forEach((s, i) => {
      const people = s.guests.map(g => g.name + (g.addr ? '（' + g.addr + '）' : '')).join('、');
      lines.push((i === 0 ? '★ ' : '') + s.table.name + '：' + people);
    });
    return { stops, text: lines.join('\n') };
  }

  const api = { generate, address };
  root.PaizuoRoute = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
