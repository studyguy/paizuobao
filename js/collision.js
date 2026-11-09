/* ============================================================
 * 排座宝 P1.5d — 场地干涉检测（纯函数，可单测）
 * 统一几何模型：圆（桌，含人）与 AABB 盒（舞台/元素/墙/入口区）
 * 任意两对象之间必须留有 MIN_GAP 的间隙，否则视为干涉
 * ============================================================ */
(function (root) {
  'use strict';

  const GAP = 26;               // 对象间最小间隙（逻辑像素）
  const DOOR_HALF = 58;         // 入口开口半宽

  /* ---- 对象几何提取（均返回 {kind:'circle'|'box', x, y, r | hw, hh, ref}） ---- */

  function tableGeom(t) {
    // 桌 + 座位环 + 人 的有效半径
    return { kind: 'circle', x: t.x, y: t.y, r: 113, ref: { type: 'table', id: t.id } };
  }

  const STAGE_BASE = { rect: { w: 300, h: 70 }, tshape: { w: 300, h: 192 }, round: { w: 190, h: 190 } };
  const ITEM_BASE = { w: 144, h: 60, wall: { w: 220, h: 36 } };

  function stageGeom(stage) {
    if (!stage || stage.shape === 'none') return null;
    const base = STAGE_BASE[stage.shape] || STAGE_BASE.rect;
    const w = stage.w || base.w, h = stage.h || base.h;
    return { kind: 'box', x: stage.x, y: stage.y, hw: w / 2, hh: h / 2, ref: { type: 'stage' } };
  }

  function itemGeom(it) {
    const base = ITEM_BASE[it.kind] || ITEM_BASE;
    const w = it.w || base.w, h = it.h || base.h;
    return { kind: 'box', x: it.x, y: it.y, hw: w / 2, hh: h / 2, ref: { type: 'item', id: it.id } };
  }

  function doorGeom(doorPos) {
    return { kind: 'circle', x: doorPos.x, y: doorPos.y, r: DOOR_HALF, ref: { type: 'door' } };
  }

  /** 全场对象清单（可排除某个 ref，用于拖动自身） */
  function collect(state, excludeRef, doorPos) {
    const out = [];
    for (const t of state.tables) {
      if (excludeRef && excludeRef.type === 'table' && excludeRef.id === t.id) continue;
      out.push(tableGeom(t));
    }
    const sg = stageGeom(state.meta && state.meta.stage);
    if (sg && !(excludeRef && excludeRef.type === 'stage')) out.push(sg);
    for (const it of state.venueItems || []) {
      if (excludeRef && excludeRef.type === 'item' && excludeRef.id === it.id) continue;
      out.push(itemGeom(it));
    }
    if (doorPos && !(excludeRef && excludeRef.type === 'door')) out.push(doorGeom(doorPos));
    return out;
  }

  /* ---- 判定 ---- */

  function hits(a, b) {
    // 返回 true = 干涉（含间隙不足）
    if (a.kind === 'circle' && b.kind === 'circle') {
      return Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + GAP;
    }
    if (a.kind === 'box' && b.kind === 'box') {
      return Math.abs(a.x - b.x) < a.hw + b.hw + GAP &&
             Math.abs(a.y - b.y) < a.hh + b.hh + GAP;
    }
    // 圆-盒：圆心到盒的最近距离
    const c = a.kind === 'circle' ? a : b;
    const box = a.kind === 'circle' ? b : a;
    const dx = Math.max(Math.abs(c.x - box.x) - box.hw, 0);
    const dy = Math.max(Math.abs(c.y - box.y) - box.hh, 0);
    return Math.hypot(dx, dy) < c.r + GAP;
  }

  /** 候选几何是否与 obstacles 任一干涉 */
  function legal(geom, obstacles) {
    for (const o of obstacles) {
      if (hits(geom, o)) return false;
    }
    return true;
  }

  /**
   * 为一个对象找不干涉的落点：从 preferred 开始螺旋外扩搜索。
   * @param makeGeom (x,y) => geom
   * @returns {x, y, found}
   */
  function findFreeSpot(makeGeom, preferred, obstacles, bounds) {
    const step = 46;
    if (legal(makeGeom(preferred.x, preferred.y), obstacles)) {
      return { x: preferred.x, y: preferred.y, found: true };
    }
    const maxR = bounds ? Math.max(bounds.w, bounds.h) : 2400;
    for (let ring = 1; ring * step < maxR; ring++) {
      for (let i = 0; i < ring * 8; i++) {
        const ang = (i / (ring * 8)) * Math.PI * 2;
        const x = preferred.x + Math.cos(ang) * ring * step;
        const y = preferred.y + Math.sin(ang) * ring * step;
        if (x < 60 || y < 60) continue;
        if (bounds && (x > bounds.w - 40 || y > bounds.h - 40)) continue;
        if (legal(makeGeom(x, y), obstacles)) return { x, y, found: true };
      }
    }
    return { x: preferred.x, y: preferred.y, found: false };
  }

  const api = { GAP, DOOR_HALF, tableGeom, stageGeom, itemGeom, doorGeom, collect, hits, legal, findFreeSpot };
  root.PaizuoCollision = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
