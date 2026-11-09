/* ============================================================
 * 排座宝 P1.5 — Canvas 宴会厅舞台
 * 动态逻辑空间（随桌数/桌位生长）/ 可拖拽入口（上座朝向联动）/
 * 可拖拽舞台（矩形/T形/圆形）/ 缩放平移 / 紧凑渲染分档
 * Stage 不直接改数据：变更由 app.js 根据 drop/move 回调执行
 * ============================================================ */
(function (root) {
  'use strict';

  const BASE_W = 1080;          // 基准逻辑宽（空间可生长）
  const TABLE_R = 68;
  const SEAT_RING = 96;
  const SEAT_R = 17;
  const EDGE_INSET = 26;        // 入口贴边内缩
  const ITEM_HW = 72, ITEM_HH = 30;  // 场地元素半宽/半高

  const COLOR = {
    bg: '#faf7f2',
    tableFill: '#ffffff',
    tableRing: '#d9c9ac',
    headFill: '#fffbeb',
    headRing: '#d4a017',
    groom: '#dbeafe', groomText: '#1e40af',
    bride: '#fce7f3', brideText: '#9d174d',
    neutral: '#eef2f7', neutralText: '#334155',
    empty: '#c9bfae',
    up: '#b8860b',
  };

  let canvas, ctx, dpr = 1, scaleCss = 1, cssW = 0, cssH = 0;
  let logicalW = BASE_W, logicalH = 760;
  let originX = 0, originY = 0;   // 逻辑空间左上角的世界坐标（内容拖向左/上时为负）
  let getState, onEdit, onSeatClick, onSeatDblClick, onTableMove, onVenueMove, onTableGear, onPlace, onStageClick, onItemClick;
  let drag = null;       // {guestId, from:{t,s}|null, x, y, hover:{t,s}|null}
  let tableDrag = null;  // {tableId, dx, dy, moved}
  let venueDrag = null;  // {kind:'door'|'stage'|'item', id?, dx?, dy?}
  let resizeDrag = null;     // {kind:'stage'|'item', id?, anchorL, anchorT}
  let selectedResize = null; // {type:'stage'} | {type:'item', id} 弹窗打开时的选中缩放目标
  let selectedTableId = null;
  let placing = null;    // {kind, shape?} 放置模式
  let ghostPos = null;   // 放置幽灵位置（逻辑坐标）
  let selectedGuestId = null;

  /* ---- 视图变换（缩放/平移）：screen = logical*scale + t ---- */
  const view = { scale: 1, tx: 0, ty: 0 };
  const VIEW_MIN = 0.4, VIEW_MAX = 2.5;
  let pxPerLogical = 1;
  let renderTier = 2;    // 2=完整 1=紧凑 0=色点
  let panDrag = null;
  let zoomHook = null;

  /* ---- 入口 ---- */
  function doorPos(state) {
    const d = (state.meta && state.meta.door) || { side: 'bottom', t: 0.5 };
    if (d.side === 'top') return { x: originX + d.t * logicalW, y: originY + EDGE_INSET, side: d.side };
    if (d.side === 'bottom') return { x: originX + d.t * logicalW, y: originY + logicalH - EDGE_INSET, side: d.side };
    if (d.side === 'left') return { x: originX + EDGE_INSET, y: originY + d.t * logicalH, side: d.side };
    return { x: originX + logicalW - EDGE_INSET, y: originY + d.t * logicalH, side: d.side };
  }

  /* ---- 座位几何：上座（0号位）永远面向入口 ---- */
  function seatAngle(state, t, i) {
    const dp = doorPos(state);
    const base = Math.atan2(t.y - dp.y, t.x - dp.x);
    return base + (i * 2 * Math.PI) / t.capacity;
  }
  function seatPos(state, table, i) {
    const a = seatAngle(state, table, i);
    return { x: table.x + Math.cos(a) * SEAT_RING, y: table.y + Math.sin(a) * SEAT_RING };
  }

  /* ---- 布局：主桌顶部居中，其余 4 列网格 ---- */
  function layoutTables(state) {
    const others = [];
    for (const t of state.tables) {
      if (typeof t.x !== 'number' || typeof t.y !== 'number') others.push(t);
    }
    if (others.length) {
      let row = 0, col = 0;
      for (const t of others) {
        if (t.isHead) { t.x = logicalW / 2; t.y = 170; continue; }
        t.x = 150 + col * 260;
        t.y = 340 + row * 280;
        col++;
        if (col >= 4) { col = 0; row++; }
      }
    }
    computeLogicalSpace(state);
  }

  /* ---- 逻辑空间随内容向四方生长（含四周留白），无硬边界 ---- */
  function computeLogicalSpace(state) {
    const R = SEAT_RING + SEAT_R + 30;
    let x0 = 0, y0 = 0, x1 = 880, y1 = 480;
    const grow = (cx, cy, rx, ry) => {
      x0 = Math.min(x0, cx - rx); y0 = Math.min(y0, cy - ry);
      x1 = Math.max(x1, cx + rx); y1 = Math.max(y1, cy + ry);
    };
    for (const t of state.tables) grow(t.x, t.y, R, R);
    const stg = state.meta && state.meta.stage;
    if (stg && stg.shape !== 'none') grow(stg.x, stg.y, 210, 170);
    for (const it of state.venueItems || []) {
      grow(it.x, it.y, it.kind === 'wall' ? it.w / 2 + 40 : ITEM_HW + 40,
                     it.kind === 'wall' ? it.h / 2 + 40 : ITEM_HH + 40);
    }
    // 原点：内容向左/上越过了基准区，则空间随之向负方向扩展
    originX = Math.min(0, Math.floor(x0 - 120));
    originY = Math.min(0, Math.floor(y0 - 120));
    logicalW = Math.max(BASE_W, Math.ceil(x1 + 120 - originX));
    logicalH = Math.max(760, Math.ceil(y1 + 120 - originY));
  }

  /* 内容包围盒（含座位环与上座标签余量） */
  function contentBBox(state) {
    if (!state.tables.length) return { x0: 0, y0: 0, x1: logicalW, y1: logicalH };
    const R = SEAT_RING + SEAT_R + 26;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const t of state.tables) {
      x0 = Math.min(x0, t.x - R); y0 = Math.min(y0, t.y - R);
      x1 = Math.max(x1, t.x + R); y1 = Math.max(y1, t.y + R);
    }
    const stg = state.meta && state.meta.stage;
    if (stg && stg.shape !== 'none') {
      x0 = Math.min(x0, stg.x - 170); y0 = Math.min(y0, stg.y - 110);
      x1 = Math.max(x1, stg.x + 170); y1 = Math.max(y1, stg.y + 130);
    }
    y1 = Math.max(y1, logicalH - 70); // 入口
    for (const it of state.venueItems || []) {
      x0 = Math.min(x0, it.x - ITEM_HW - 16); y0 = Math.min(y0, it.y - ITEM_HH - 16);
      x1 = Math.max(x1, it.x + ITEM_HW + 16); y1 = Math.max(y1, it.y + ITEM_HH + 16);
    }
    return { x0, y0, x1, y1 };
  }

  /* ---- 尺寸 ---- */
  function resize() {
    if (!canvas) return;
    const w = canvas.clientWidth;
    if (!w) return; // IAB 冷启动早期可能为 0，等 render 自检再纠正
    dpr = window.devicePixelRatio || 1;
    cssW = w;
    scaleCss = cssW / logicalW;
    cssH = logicalH * scaleCss;
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    render();
  }

  function render() {
    if (!ctx) return;
    // 尺寸自检：宽度（IAB 冷启动可能为 0）与逻辑空间变化（加桌/拖拽出界/舞台）
    if (canvas.clientWidth && Math.abs(canvas.clientWidth - cssW) > 1) { resize(); return; }
    const state = getState();
    if (!state) return;
    layoutTables(state);
    const needW = Math.round(logicalW * scaleCss * dpr);
    const needH = Math.round(logicalH * scaleCss * dpr);
    if (Math.abs(needW - canvas.width) > 2 || Math.abs(needH - canvas.height) > 2) { resize(); return; }

    // 全画布底色（不随视图变换）
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    pxPerLogical = scaleCss * view.scale;
    renderTier = pxPerLogical >= 0.68 ? 2 : (pxPerLogical >= 0.48 ? 1 : 0);
    const k = dpr * pxPerLogical;
    ctx.setTransform(k, 0, 0, k, dpr * scaleCss * view.tx, dpr * scaleCss * view.ty);

    drawStage(state);
    drawVenueItems(state);
    drawDoor(state);

    // 桌子（主桌最后画，压顶）
    const tables = state.tables.slice().sort((a, b) => (a.isHead ? 1 : 0) - (b.isHead ? 1 : 0));
    for (const t of tables) drawTable(state, t);

    if (drag) drawDragGhost(state, drag);
    drawPlacingGhost(state);
    drawTableGears(state);
  }

  /* 桌上小齿轮入口：点击弹出桌位设置 */
  function drawTableGears(state) {
    if (renderTier < 1 || placing) return;
    const gr = renderTier === 2 ? 11 : 9;
    for (const t of state.tables) {
      const gx = t.x + TABLE_R - 16, gy = t.y + TABLE_R - 16;
      ctx.beginPath();
      ctx.arc(gx, gy, gr, 0, Math.PI * 2);
      ctx.fillStyle = selectedTableId === t.id ? '#c2543a' : 'rgba(255,255,255,.92)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = selectedTableId === t.id ? '#a03d26' : '#b3a284';
      ctx.stroke();
      ctx.fillStyle = selectedTableId === t.id ? '#fff' : '#7a6a4f';
      ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚙', gx, gy + 4);
    }
  }

  /* ---- 入口 ---- */
  function drawDoor(state) {
    const dp = doorPos(state);
    const horiz = dp.side === 'top' || dp.side === 'bottom';
    ctx.save();
    ctx.strokeStyle = '#b3a284';
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (horiz) { ctx.moveTo(dp.x - 55, dp.y); ctx.lineTo(dp.x + 55, dp.y); }
    else { ctx.moveTo(dp.x, dp.y - 55); ctx.lineTo(dp.x, dp.y + 55); }
    ctx.stroke();

    const ang = { top: Math.PI / 2, bottom: -Math.PI / 2, left: 0, right: Math.PI }[dp.side];
    ctx.translate(dp.x + Math.cos(ang) * 17, dp.y + Math.sin(ang) * 17);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(9, 0); ctx.lineTo(-6, -6); ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fillStyle = '#b3a284';
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#8a7a5c';
    ctx.font = '12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    if (horiz) ctx.fillText('宴会入口（可拖动）', dp.x, dp.y + (dp.side === 'top' ? 30 : -14));
    else ctx.fillText('宴会入口（可拖动）', dp.x + (dp.side === 'left' ? 62 : -62), dp.y + 4);
  }

  /* ---- 舞台 ---- */
  const STAGE_BASE = { rect: { w: 300, h: 70 }, tshape: { w: 300, h: 192 }, round: { w: 190, h: 190 } };

  function stageBounds(s) {
    if (!s || s.shape === 'none') return null;
    const base = STAGE_BASE[s.shape] || STAGE_BASE.rect;
    return { hw: (s.w || base.w) / 2, hh: (s.h || base.h) / 2 };
  }

  function drawStage(state) {
    const s = state.meta && state.meta.stage;
    if (!s || s.shape === 'none') return;
    const x = s.x, y = s.y;
    const base = STAGE_BASE[s.shape] || STAGE_BASE.rect;
    const sx = (s.w || base.w) / base.w, sy = (s.h || base.h) / base.h;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sx, sy);
    // 一体式填充：纵向微渐变（基准坐标）
    const grad = ctx.createLinearGradient(0, -100, 0, 100);
    grad.addColorStop(0, '#fdf1de');
    grad.addColorStop(1, '#f3ddba');
    ctx.fillStyle = grad;
    ctx.strokeStyle = '#c9a24b';
    ctx.lineWidth = 3 / ((sx + sy) / 2); // 非等比缩放时补偿线宽
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (s.shape === 'rect') {
      roundedPoly([[-150, -35], [150, -35], [150, 35], [-150, 35]], 8);
    } else if (s.shape === 'tshape') {
      roundedPoly([
        [-150, -96], [150, -96],
        [150, -40], [28, -40],
        [28, 100], [-28, 100],
        [-28, -40], [-150, -40],
      ], 10);
    } else {
      ctx.arc(0, 0, 95, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
    // 前沿高光线
    ctx.strokeStyle = 'rgba(201, 162, 75, .35)';
    ctx.lineWidth = 1.5 / ((sx + sy) / 2);
    ctx.beginPath();
    if (s.shape === 'rect') {
      ctx.moveTo(-142, 27); ctx.lineTo(142, 27);
    } else if (s.shape === 'tshape') {
      ctx.moveTo(-142, -44); ctx.lineTo(142, -44);
    } else {
      ctx.arc(0, 0, 84, Math.PI * 0.15, Math.PI * 0.85);
    }
    ctx.stroke();
    ctx.restore();
    // 文字在世界坐标绘制，避免被拉伸
    ctx.fillStyle = '#9a3b1e';
    ctx.font = 'bold 14px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('舞 台', x, s.shape === 'tshape' ? y - 60 * sy : y + 5);
    // 选中缩放目标 → 右下角手柄
    if (selectedResize && selectedResize.type === 'stage') {
      const hx = x + (s.w || base.w) / 2, hy = y + (s.h || base.h) / 2;
      ctx.fillStyle = '#e11d48';
      ctx.fillRect(hx - 7, hy - 7, 14, 14);
    }
  }

  /* 圆角多边形：切点全部由相邻顶点推导——凹角/凸角/对称性由构造保证，
   * 彻底避免手写 arcTo 切点方向错误（T 形左肩缺失的根因） */
  function roundedPoly(pts, r) {
    const n = pts.length;
    const mid0 = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    ctx.moveTo(mid0[0], mid0[1]);
    for (let i = 1; i <= n; i++) {
      const prev = pts[(i - 1) % n], cur = pts[i % n], next = pts[(i + 1) % n];
      const d1 = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) || 1;
      const d2 = Math.hypot(next[0] - cur[0], next[1] - cur[1]) || 1;
      const r1 = Math.min(r, d1 / 2), r2 = Math.min(r, d2 / 2);
      const inX = cur[0] - (cur[0] - prev[0]) / d1 * r1;
      const inY = cur[1] - (cur[1] - prev[1]) / d1 * r1;
      const outX = cur[0] + (next[0] - cur[0]) / d2 * r2;
      const outY = cur[1] + (next[1] - cur[1]) / d2 * r2;
      ctx.lineTo(inX, inY);
      ctx.arcTo(cur[0], cur[1], outX, outY, Math.min(r1, r2));
    }
    ctx.closePath();
  }

  function rr(x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---- 场地元素（卫生间/签到台/餐台/休息区/墙面） ---- */
  function drawVenueItems(state) {
    const K = root.PaizuoData.VENUE_KINDS;
    const C = root.PaizuoCollision;
    for (const it of state.venueItems || []) {
      ctx.save();
      const w = it.w || (it.kind === 'wall' ? 220 : 144);
      const h = it.h || (it.kind === 'wall' ? 36 : 60);
      if (it.kind === 'wall') {
        ctx.beginPath();
        rr(it.x - w / 2, it.y - h / 2, w, h, 4);
        ctx.fillStyle = '#7c8595';
        ctx.fill();
        ctx.strokeStyle = '#5b6472';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        const kind = K[it.kind] || { label: it.kind, icon: '📍' };
        ctx.beginPath();
        rr(it.x - w / 2, it.y - h / 2, w, h, 10);
        ctx.fillStyle = '#f3f7fb';
        ctx.fill();
        ctx.strokeStyle = '#9fb4c8';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#41566b';
        ctx.font = 'bold 12.5px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(kind.icon + ' ' + kind.label, it.x, it.y + 4.5);
      }
      // 选中缩放目标 → 右下角手柄
      if (selectedResize && selectedResize.type === 'item' && selectedResize.id === it.id) {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = '#e11d48';
        ctx.strokeRect(it.x - w / 2 - 5, it.y - h / 2 - 5, w + 10, h + 10);
        ctx.setLineDash([]);
        ctx.fillStyle = '#e11d48';
        ctx.fillRect(it.x + w / 2 - 7, it.y + h / 2 - 7, 14, 14);
      }
      ctx.restore();
    }
  }

  /* 放置模式幽灵 */
  function drawPlacingGhost(state) {
    if (!placing || !ghostPos) return;
    const C = root.PaizuoCollision;
    let geom;
    if (placing.kind === 'stage') {
      geom = C.stageGeom({ shape: placing.shape || 'tshape', x: ghostPos.x, y: ghostPos.y });
    } else if (placing.kind === 'wall') {
      geom = { kind: 'box', x: ghostPos.x, y: ghostPos.y, hw: 110, hh: 18 };
    } else {
      geom = { kind: 'box', x: ghostPos.x, y: ghostPos.y, hw: ITEM_HW, hh: ITEM_HH };
    }
    const dp = doorPos(state);
    const okPlace = C.legal(geom, C.collect(state, null, dp));
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    if (placing.kind === 'stage') {
      const b = { rect: [150, 35], tshape: null, round: [95] }[placing.shape || 'tshape'];
      if (placing.shape === 'round') ctx.arc(ghostPos.x, ghostPos.y, b[0], 0, Math.PI * 2);
      else rr(ghostPos.x - b[0], ghostPos.y - b[1], b[0] * 2, b[1] * 2, 8);
    } else if (placing.kind === 'wall') {
      rr(ghostPos.x - 110, ghostPos.y - 18, 220, 36, 4);
    } else {
      rr(ghostPos.x - ITEM_HW, ghostPos.y - ITEM_HH, ITEM_HW * 2, ITEM_HH * 2, 10);
    }
    ctx.fillStyle = okPlace ? 'rgba(21,128,61,.35)' : 'rgba(192,57,43,.4)';
    ctx.fill();
    ctx.strokeStyle = okPlace ? '#15803d' : '#c0392b';
    ctx.setLineDash([7, 5]);
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = okPlace ? '#15803d' : '#c0392b';
    ctx.font = 'bold 12.5px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(okPlace ? '点击放置' : '此处干涉，换个位置', ghostPos.x, ghostPos.y - (placing.kind === 'stage' ? 120 : 46));
    ctx.restore();
  }

  function venueItemAt(state, x, y) {
    const hits = [];
    for (let i = state.venueItems.length - 1; i >= 0; i--) {
      const it = state.venueItems[i];
      const hw = (it.w || (it.kind === 'wall' ? 220 : 144)) / 2;
      const hh = (it.h || (it.kind === 'wall' ? 36 : 60)) / 2;
      const hit = Math.abs(x - it.x) <= hw && Math.abs(y - it.y) <= hh;
      if (hit) hits.push(it.kind + '@' + Math.round(it.x) + ',' + Math.round(it.y) + ' hw' + Math.round(hw) + ' hh' + Math.round(hh));
      if (hit) return it;
    }
    return null;
  }

  function drawTable(state, t) {
    const isHead = t.isHead;
    ctx.beginPath();
    ctx.arc(t.x, t.y, TABLE_R, 0, Math.PI * 2);
    ctx.fillStyle = isHead ? COLOR.headFill : COLOR.tableFill;
    ctx.fill();
    ctx.lineWidth = isHead ? 5 : 3;
    ctx.strokeStyle = isHead ? COLOR.headRing : COLOR.tableRing;
    ctx.stroke();

    // 桌名（紧凑档加大加粗，保证缩小后仍可读）
    ctx.textAlign = 'center';
    ctx.fillStyle = isHead ? '#9a3b1e' : '#7a6a4f';
    const nameFont = renderTier === 2 ? (isHead ? 15 : 13) : renderTier === 1 ? 16 : 14;
    ctx.font = 'bold ' + nameFont + 'px "Microsoft YaHei", sans-serif';
    ctx.fillText(t.name, t.x, t.y + 5);

    if (renderTier === 2) {
      ctx.font = '11px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#9a8f77';
      const seated = root.PaizuoData.guestsAtTable(state, t.id).length;
      ctx.fillText(seated + '/' + t.capacity + ' 人', t.x, t.y + 22);

      const up = seatPos(state, t, 0);
      ctx.fillStyle = COLOR.up;
      ctx.font = '11px "Microsoft YaHei", sans-serif';
      ctx.fillText('★ 上座', up.x, up.y - 24);
    } else {
      const up = seatPos(state, t, 0);
      ctx.fillStyle = COLOR.up;
      ctx.font = 'bold 13px "Microsoft YaHei", sans-serif';
      ctx.fillText('★', up.x, up.y - 22);
    }

    const cap = t.capacity | 0;
    for (let i = 0; i < cap; i++) drawSeat(state, t, i);
  }

  function sideFill(side, compact) {
    if (compact) {
      return side === 'groom' ? '#93c5fd' : side === 'bride' ? '#f9a8d4' : '#cbd5e1';
    }
    return side === 'groom' ? COLOR.groom : side === 'bride' ? COLOR.bride : COLOR.neutral;
  }

  function sideText(side) {
    return side === 'groom' ? COLOR.groomText : side === 'bride' ? COLOR.brideText : COLOR.neutralText;
  }

  function drawSeat(state, t, i) {
    const p = seatPos(state, t, i);
    const seated = findSeated(state, t.id, i);
    const hovered = drag && drag.hover && drag.hover.t === t.id && drag.hover.s === i;

    if (renderTier < 2) {
      const r = renderTier === 0 ? SEAT_R * 0.72 : SEAT_R * 0.85;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = seated ? sideFill(seated.guest.side, true) : 'rgba(255,255,255,.55)';
      ctx.fill();
      if (hovered || (selectedGuestId && seated && seated.guest.id === selectedGuestId)) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#e11d48';
        ctx.stroke();
      }
      return;
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, SEAT_R, 0, Math.PI * 2);
    if (seated) {
      ctx.fillStyle = sideFill(seated.guest.side, false);
      ctx.fill();
      ctx.lineWidth = hovered ? 3 : 1;
      ctx.strokeStyle = hovered ? '#e11d48' : 'rgba(0,0,0,.15)';
    } else {
      ctx.fillStyle = 'rgba(255,255,255,.6)';
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = hovered ? '#e11d48' : COLOR.empty;
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (selectedGuestId && seated && seated.guest.id === selectedGuestId) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, SEAT_R + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#e11d48';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (seated) {
      ctx.fillStyle = sideText(seated.guest.side);
      ctx.font = '10px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      const name = seated.guest.name.length > 4 ? seated.guest.name.slice(0, 3) + '…' : seated.guest.name;
      ctx.fillText(name, p.x, p.y + 3.5);
    }
  }

  function findSeated(state, tableId, s) {
    const list = root.PaizuoData.guestsAtTable(state, tableId);
    return list.find(x => x.s === s) || null;
  }

  function drawDragGhost(state, d) {
    const g = root.PaizuoData.guestById(state, d.guestId);
    if (!g) return;
    ctx.beginPath();
    ctx.arc(d.x, d.y, SEAT_R + 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(225,29,72,.9)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(g.name.slice(0, 4), d.x, d.y + 4);
    if (d.from) {
      const t = root.PaizuoData.tableById(state, d.from.t);
      if (t) {
        const p = seatPos(state, t, d.from.s);
        ctx.beginPath();
        ctx.arc(p.x, p.y, SEAT_R, 0, Math.PI * 2);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(0,0,0,.25)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  /* ---- 命中检测（含视图逆变换） ---- */
  function toRaw(evt) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (evt.clientX - rect.left) / scaleCss,
      y: (evt.clientY - rect.top) / scaleCss,
    };
  }
  function toRawXY(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / scaleCss,
      y: (clientY - rect.top) / scaleCss,
    };
  }
  function toViewPoint(p) {
    return { x: (p.x - view.tx) / view.scale, y: (p.y - view.ty) / view.scale };
  }
  function toLogical(evt) { return toViewPoint(toRaw(evt)); }
  function toLogicalXY(clientX, clientY) { return toViewPoint(toRawXY(clientX, clientY)); }

  function seatAt(state, x, y) {
    let best = null, bestD = 22;
    for (const t of state.tables) {
      const cap = t.capacity | 0;
      for (let i = 0; i < cap; i++) {
        const p = seatPos(state, t, i);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) { bestD = d; best = { t: t.id, s: i }; }
      }
    }
    return best;
  }

  function tableAt(state, x, y) {
    for (const t of state.tables) {
      if (Math.hypot(t.x - x, t.y - y) <= TABLE_R) return t;
    }
    return null;
  }

  /* ---- 指针交互 ---- */
  function onPointerDown(evt) {
    // 交互前强制尺寸自检（IAB 的 setViewportSize 不触发 window resize，cssW 可能过期）
    if (canvas.clientWidth && Math.abs(canvas.clientWidth - cssW) > 1) resize();
    const state = getState();
    if (!state) return;
    const p = toLogical(evt);
    const C = root.PaizuoCollision;

    /* 放置模式：点击落位（干涉则保留模式等用户换位） */
    if (placing) {
      let geom;
      if (placing.kind === 'stage') geom = C.stageGeom({ shape: placing.shape || 'tshape', x: p.x, y: p.y });
      else if (placing.kind === 'wall') geom = { kind: 'box', x: p.x, y: p.y, hw: 110, hh: 18 };
      else geom = { kind: 'box', x: p.x, y: p.y, hw: ITEM_HW, hh: ITEM_HH };
      const okPlace = C.legal(geom, C.collect(state, null, doorPos(state)));
      if (okPlace) {
        if (onPlace) onPlace(placing, p.x, p.y);
        setPlacing(null);
      }
      render();
      return;
    }

    // 桌齿轮入口：小目标优先于大件（舞台/入口），避免被大命中盒吞掉
    if (renderTier >= 1) {
      for (const t of state.tables) {
        const gx = t.x + TABLE_R - 16, gy = t.y + TABLE_R - 16;
        if (Math.hypot(p.x - gx, p.y - gy) <= 14) {
          selectedTableId = t.id;
          if (onTableGear) onTableGear(t.id);
          render();
          return;
        }
      }
    }

    // 入口（场地对象优先，方便贴边抓取）
    const dp = doorPos(state);
    if (Math.hypot(p.x - dp.x, p.y - dp.y) <= 48) {
      venueDrag = { kind: 'door' };
      canvas.classList.add('panning');
      try { canvas.setPointerCapture(evt.pointerId); } catch (e) { }
      render();
      return;
    }
    const stg = state.meta && state.meta.stage;
    if (stg && stg.shape !== 'none') {
      // 选中缩放目标的手柄（右下角）优先于拖动
      if (selectedResize && selectedResize.type === 'stage') {
        const b = stageBounds(stg);
        if (Math.abs(p.x - (stg.x + b.hw)) <= 14 && Math.abs(p.y - (stg.y + b.hh)) <= 14) {
          resizeDrag = { kind: 'stage', anchorL: stg.x - b.hw, anchorT: stg.y - b.hh };
          canvas.classList.add('panning');
          try { canvas.setPointerCapture(evt.pointerId); } catch (e) { }
          render();
          return;
        }
      }
      const b2 = stageBounds(stg);
      if (Math.abs(p.x - stg.x) <= b2.hw && Math.abs(p.y - stg.y) <= b2.hh) {
        venueDrag = { kind: 'stage', dx: stg.x - p.x, dy: stg.y - p.y, moved: false };
        canvas.classList.add('panning');
        try { canvas.setPointerCapture(evt.pointerId); } catch (e) { }
        render();
        return;
      }
    }

    // 场地元素（选中缩放目标的手柄优先——直接按 id 找目标，不经 venueItemAt）
    if (selectedResize && selectedResize.type === 'item') {
      const tgt = (state.venueItems || []).find(x => x.id === selectedResize.id);
      if (tgt) {
        const vw = tgt.w || 144, vh = tgt.h || 60;
        const dxh = p.x - (tgt.x + vw / 2), dyh = p.y - (tgt.y + vh / 2);
        if (Math.abs(dxh) <= 16 && Math.abs(dyh) <= 16) {
          resizeDrag = { kind: 'item', id: tgt.id, anchorL: tgt.x - vw / 2, anchorT: tgt.y - vh / 2 };
          canvas.classList.add('panning');
          try { canvas.setPointerCapture(evt.pointerId); } catch (e) { }
          render();
          return;
        }
      }
    }

    const vItem = venueItemAt(state, p.x, p.y);
    if (vItem) {
      venueDrag = { kind: 'item', id: vItem.id, dx: vItem.x - p.x, dy: vItem.y - p.y, moved: false };
      canvas.classList.add('panning');
      try { canvas.setPointerCapture(evt.pointerId); } catch (e) { }
      render();
      return;
    }

    const seat = seatAt(state, p.x, p.y);
    if (seat) {
      const seated = findSeated(state, seat.t, seat.s);
      if (seated) {
        drag = { guestId: seated.guest.id, from: { t: seat.t, s: seat.s }, x: p.x, y: p.y, hover: seat };
        canvas.classList.add('dragging-guest');
      } else if (selectedGuestId) {
        onSeatClick(seat);
      }
      try { canvas.setPointerCapture(evt.pointerId); } catch (e) { }
      render();
      return;
    }

    const t = tableAt(state, p.x, p.y);
    if (t) {
      // 齿轮入口：点击弹出桌位设置
      const gx = t.x + TABLE_R - 16, gy = t.y + TABLE_R - 16;
      if (renderTier === 2 && Math.hypot(p.x - gx, p.y - gy) <= 14) {
        selectedTableId = t.id;
        if (onTableGear) onTableGear(t.id);
        render();
        return;
      }
      tableDrag = { tableId: t.id, dx: t.x - p.x, dy: t.y - p.y, moved: false };
      selectedTableId = t.id;
      canvas.classList.add('panning');
      try { canvas.setPointerCapture(evt.pointerId); } catch (e) { }
      return;
    }
    selectedTableId = null;

    const raw = toRaw(evt);
    panDrag = { sx: raw.x, sy: raw.y, tx0: view.tx, ty0: view.ty };
    canvas.classList.add('panning');
    try { canvas.setPointerCapture(evt.pointerId); } catch (e) { }
  }

  function onPointerMove(evt) {
    const state = getState();
    if (!state) return;
    const p = toLogical(evt);
    const C = root.PaizuoCollision;

    if (placing) {
      ghostPos = p;
      render();
      return;
    }

    if (resizeDrag) {
      const tgt = resizeDrag.kind === 'stage' ? state.meta.stage
        : (state.venueItems || []).find(x => x.id === resizeDrag.id);
      if (tgt) {
        const minW = resizeDrag.kind === 'stage' ? 80 : 60;
        const minH = resizeDrag.kind === 'stage' ? 40 : 24;
        const nw = Math.max(minW, p.x - resizeDrag.anchorL);
        const nh = Math.max(minH, p.y - resizeDrag.anchorT);
        const geom = resizeDrag.kind === 'stage'
          ? C.stageGeom({ shape: tgt.shape, x: resizeDrag.anchorL + nw / 2, y: resizeDrag.anchorT + nh / 2, w: nw, h: nh })
          : C.itemGeom({ ...tgt, x: resizeDrag.anchorL + nw / 2, y: resizeDrag.anchorT + nh / 2, w: nw, h: nh });
        const excl = resizeDrag.kind === 'stage' ? { type: 'stage' } : { type: 'item', id: tgt.id };
        const obstacles = C.collect(state, excl, doorPos(state));
        const isLegal = C.legal(geom, obstacles);
        if (isLegal) {
          tgt.w = Math.round(nw); tgt.h = Math.round(nh);
          tgt.x = Math.round(resizeDrag.anchorL + nw / 2);
          tgt.y = Math.round(resizeDrag.anchorT + nh / 2);
        }
        render();
      }
      return;
    }

    if (venueDrag) {
      if (venueDrag.kind === 'door') {
        // 投影到最近的边；与其他对象干涉则保持原位
        const dl = p.x, dr = logicalW - p.x, dt = p.y, db = logicalH - p.y;
        const minD = Math.min(dl, dr, dt, db);
        let side = minD === dt ? 'top' : minD === db ? 'bottom' : minD === dl ? 'left' : 'right';
        const tt = (side === 'top' || side === 'bottom')
          ? clamp(p.x / logicalW, 0.08, 0.92)
          : clamp(p.y / logicalH, 0.08, 0.92);
        const cand = { side, t: tt };
        const candPos = doorPos({ meta: { door: cand } });
        if (C.legal(C.doorGeom(candPos), C.collect(state, { type: 'door' }, doorPos(state)))) {
          state.meta.door = cand;
        }
      } else if (venueDrag.kind === 'stage') {
        const stg = state.meta.stage;
        const nx = p.x + venueDrag.dx;
        const ny = p.y + venueDrag.dy;
        if (Math.hypot(nx - stg.x, ny - stg.y) > 6) venueDrag.moved = true;
        if (C.legal(C.stageGeom({ shape: stg.shape, x: nx, y: ny }),
                    C.collect(state, { type: 'stage' }, doorPos(state)))) {
          stg.x = nx; stg.y = ny;
        }
      } else {
        const it = (state.venueItems || []).find(x => x.id === venueDrag.id);
        if (it) {
          const nx = p.x + venueDrag.dx;
          const ny = p.y + venueDrag.dy;
          if (Math.hypot(nx - it.x, ny - it.y) > 6) venueDrag.moved = true;
          const geom = C.itemGeom({ ...it, x: nx, y: ny });
          if (C.legal(geom, C.collect(state, { type: 'item', id: it.id }, doorPos(state)))) {
            it.x = nx; it.y = ny;
          }
        }
      }
      render();
      return;
    }

    if (panDrag) {
      const raw = toRaw(evt);
      view.tx = panDrag.tx0 + (raw.x - panDrag.sx);
      view.ty = panDrag.ty0 + (raw.y - panDrag.sy);
      clampView();
      render();
      return;
    }

    if (drag) {
      drag.x = p.x; drag.y = p.y;
      drag.hover = seatAt(state, p.x, p.y);
      render();
    } else if (tableDrag) {
      const t = root.PaizuoData.tableById(state, tableDrag.tableId);
      if (t) {
        // 完全自由拖动（空间随之四方生长）；唯一限制是干涉间隙，非法则沿单轴滑动
        const obstacles = C.collect(state, { type: 'table', id: t.id }, doorPos(state));
        const nx = p.x + tableDrag.dx;
        const ny = p.y + tableDrag.dy;
        if (Math.hypot(nx - t.x, ny - t.y) > 6) tableDrag.moved = true;
        if (C.legal(C.tableGeom({ x: nx, y: ny }), obstacles)) { t.x = nx; t.y = ny; }
        else if (C.legal(C.tableGeom({ x: nx, y: t.y }), obstacles)) { t.x = nx; }
        else if (C.legal(C.tableGeom({ x: t.x, y: ny }), obstacles)) { t.y = ny; }
        render();
      }
    }
  }

  function onPointerUp(evt) {
    const state = getState();
    if (!state) return;
    if (resizeDrag) {
      resizeDrag = null;
      if (onVenueMove) onVenueMove();
      render();
      return;
    }
    if (venueDrag) {
      const kind = venueDrag.kind;
      const itemId = venueDrag.id;
      const moved = venueDrag.moved;
      venueDrag = null;
      canvas.classList.remove('panning');
      if (moved) {
        if (onVenueMove) onVenueMove(); // 持久化入口/舞台/元素位置
      } else if (kind === 'stage' && onStageClick) {
        onStageClick(); // 点击舞台 → 就地弹窗
      } else if (kind === 'item' && onItemClick) {
        onItemClick(itemId); // 点击元素 → 就地弹窗
      }
      render();
      return;
    }
    if (panDrag) {
      panDrag = null;
      canvas.classList.remove('panning');
      return;
    }
    if (drag) {
      const p = toLogical(evt);
      const seat = seatAt(state, p.x, p.y);
      const insideAnyTable = state.tables.some(t => Math.hypot(t.x - p.x, t.y - p.y) <= TABLE_R + SEAT_RING);
      const drop = seat
        ? { type: 'seat', seat }
        : (insideAnyTable ? { type: 'noop' } : { type: 'blank' });
      const info = { guestId: drag.guestId, from: drag.from };
      drag = null;
      canvas.classList.remove('dragging-guest');
      onEdit(info, drop);
      render();
    } else if (tableDrag) {
      const tid = tableDrag.tableId;
      const moved = tableDrag.moved;
      tableDrag = null;
      canvas.classList.remove('panning');
      if (moved) {
        onTableMove();
      } else if (onTableGear) {
        onTableGear(tid); // 点击桌身 → 就地弹窗（与齿轮同入口）
      }
      render();
    }
  }

  function onDblClick(evt) {
    const state = getState();
    if (!state) return;
    const p = toLogical(evt);
    const seat = seatAt(state, p.x, p.y);
    if (seat) {
      const seated = findSeated(state, seat.t, seat.s);
      if (seated) onSeatDblClick(seated.guest.id, seat);
    }
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ---- 外部拖入（左侧宾客列表 → 画布） ---- */
  function externalDragStart(guestId, clientX, clientY) {
    const p = toLogicalXY(clientX, clientY);
    drag = { guestId, from: null, x: p.x, y: p.y, hover: null };
    render();
  }
  function externalDragMove(x, y) {
    const state = getState();
    if (!state || !drag) return;
    const p = toLogicalXY(x, y);
    drag.x = p.x; drag.y = p.y;
    drag.hover = seatAt(state, p.x, p.y);
    render();
  }
  function externalDragEnd(clientX, clientY) {
    const state = getState();
    if (!state || !drag) return;
    const p = toLogicalXY(clientX, clientY);
    const seat = seatAt(state, p.x, p.y);
    const info = { guestId: drag.guestId, from: null };
    drag = null;
    onEdit(info, seat ? { type: 'seat', seat } : { type: 'noop' });
    render();
  }

  /* ---- 缩放 / 平移 ---- */
  function clampView() {
    const st = getState();
    const bb = st ? contentBBox(st) : { x0: 0, y0: 0, x1: logicalW, y1: logicalH };
    const s = view.scale;
    view.tx = clamp(view.tx, logicalW * 0.2 - bb.x1 * s, logicalW * 0.8 - bb.x0 * s);
    view.ty = clamp(view.ty, logicalH * 0.2 - bb.y1 * s, logicalH * 0.8 - bb.y0 * s);
  }

  function zoomAt(rawPt, factor) {
    const ns = Math.min(VIEW_MAX, Math.max(VIEW_MIN, view.scale * factor));
    if (Math.abs(ns - view.scale) < 1e-6) return;
    const applied = ns / view.scale;
    view.tx = rawPt.x - (rawPt.x - view.tx) * applied;
    view.ty = rawPt.y - (rawPt.y - view.ty) * applied;
    view.scale = ns;
    clampView();
    if (zoomHook) zoomHook();
    render();
  }

  function zoomStep(factor) {
    zoomAt({ x: logicalW / 2, y: logicalH / 2 }, factor);
  }

  function onWheel(evt) {
    evt.preventDefault();
    const raw = toRaw(evt);
    const speed = evt.ctrlKey ? 0.005 : 0.0016;
    zoomAt(raw, Math.exp(-evt.deltaY * speed));
  }

  function fitView() {
    const st = getState();
    if (!st || !st.tables.length) { view.scale = 1; view.tx = 0; view.ty = 0; }
    else {
      const bb = contentBBox(st);
      const pad = 30;
      const bw = Math.max(1, bb.x1 - bb.x0), bh = Math.max(1, bb.y1 - bb.y0);
      const s = Math.min(1.15, (logicalW - pad * 2) / bw, (logicalH - pad * 2) / bh);
      view.scale = Math.max(VIEW_MIN, s);
      view.tx = logicalW / 2 - (bb.x0 + bb.x1) / 2 * view.scale;
      view.ty = logicalH / 2 - (bb.y0 + bb.y1) / 2 * view.scale;
    }
    clampView();
    if (zoomHook) zoomHook();
    render();
  }

  function resetView() { fitView(); }

  function setSelected(guestId) {
    selectedGuestId = guestId || null;
    render();
  }

  function setPlacing(p, shape) {
    placing = p ? { kind: p, shape: shape || 'tshape' } : null;
    ghostPos = null;
    canvas.classList.toggle('placing', !!placing);
    render();
  }

  /* 拖放过程：指针（屏幕坐标）处更新幽灵 */
  function setPlacingGhost(clientX, clientY) {
    if (!placing) return;
    ghostPos = toLogicalXY(clientX, clientY);
    render();
  }

  /* 拖放收尾：在指针处放置（干涉则失败返回 false，模式保留由调用方处理） */
  function placeAtClient(clientX, clientY) {
    if (!placing) return false;
    const state = getState();
    if (!state) return false;
    const p = toLogicalXY(clientX, clientY);
    const C = root.PaizuoCollision;
    let geom;
    if (placing.kind === 'stage') geom = C.stageGeom({ shape: placing.shape || 'tshape', x: p.x, y: p.y });
    else if (placing.kind === 'wall') geom = { kind: 'box', x: p.x, y: p.y, hw: 110, hh: 18 };
    else geom = { kind: 'box', x: p.x, y: p.y, hw: ITEM_HW, hh: ITEM_HH };
    if (!C.legal(geom, C.collect(state, null, doorPos(state)))) return false;
    if (onPlace) onPlace(placing, p.x, p.y);
    setPlacing(null);
    render();
    return true;
  }

  /* ---- 初始化 ---- */
  function init(canvasEl, hooks) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    getState = hooks.getState;
    onEdit = hooks.onEdit;
    onSeatClick = hooks.onSeatClick;
    onSeatDblClick = hooks.onSeatDblClick;
    onTableMove = hooks.onTableMove;
    onVenueMove = hooks.onVenueMove || hooks.onTableMove;
    onTableGear = hooks.onTableGear || null;
    onPlace = hooks.onPlace || null;
    onStageClick = hooks.onStageClick || null;
    onItemClick = hooks.onItemClick || null;

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', resize);
    if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
      new ResizeObserver(() => {
        if (canvas.clientWidth && Math.abs(canvas.clientWidth - cssW) > 1) resize();
      }).observe(canvas.parentElement);
    }

    resize();
    fitView();
  }

  function refresh() { render(); }

  const api = {
    init, render: refresh, resize,
    setSelected,
    externalDragStart, externalDragMove, externalDragEnd,
    seatPos, doorPos,
    zoomStep, resetView, fitView, setZoomHook: fn => { zoomHook = fn; },
    getView: () => ({ scale: view.scale, tier: renderTier, tx: view.tx, ty: view.ty }),
    getSpace: () => ({ w: logicalW, h: logicalH }),
    setPlacing, getPlacing: () => placing,
    setPlacingGhost, placeAtClient,
    debugHit: (x, y) => {
      const state = getState();
      const vItem = venueItemAt(state, x, y);
      const out = { vItem: vItem ? { kind: vItem.kind, id: vItem.id } : null,
                    sel: selectedResize, logical: { x: Math.round(x), y: Math.round(y) } };
      if (vItem) {
        const vw = vItem.w || (vItem.kind === 'wall' ? 220 : 144);
        const vh = vItem.h || (vItem.kind === 'wall' ? 36 : 60);
        out.dx = Math.round(x - (vItem.x + vw / 2)); out.dy = Math.round(y - (vItem.y + vh / 2));
        out.handleCond = selectedResize && selectedResize.type === 'item' && selectedResize.id === vItem.id &&
          Math.abs(out.dx) <= 14 && Math.abs(out.dy) <= 14;
      }
      return out;
    },
    doorPos,
  };
  root.PaizuoStage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
