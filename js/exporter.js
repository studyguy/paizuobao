/* ============================================================
 * 排座宝 P0 原型 — 座位表长图导出（1080px 宽 PNG）
 * 免费版带水印；解锁后去水印
 * ============================================================ */
(function (root) {
  'use strict';

  const D = root.PaizuoData;

  function seatListOrdered(state, table) {
    // 按座位号排列（上座=0 号位在最前）
    return D.guestsAtTable(state, table.id);
  }

  function exportPNG(state, opts) {
    opts = opts || {};
    const unlocked = !!state.meta.unlocked;
    const W = 1080;
    const pad = 40;
    const colW = (W - pad * 2 - 24) / 2; // 两列卡片

    // 预算高度
    const tables = state.tables.slice().sort((a, b) => (b.isHead ? 1 : 0) - (a.isHead ? 1 : 0));
    const cardHeights = tables.map(t => {
      const lines = Math.ceil((t.capacity | 0) / 2);
      return 64 + lines * 30 + 14;
    });
    let totalH = 150;
    for (let i = 0; i < tables.length; i += 2) {
      const rowH = Math.max(cardHeights[i] || 0, cardHeights[i + 1] || 0) + 18;
      totalH += rowH;
    }
    totalH += 110; // footer

    const c = document.createElement('canvas');
    c.width = W; c.height = totalH;
    const x2 = c.getContext('2d');

    // 背景
    x2.fillStyle = '#fdfbf7';
    x2.fillRect(0, 0, W, totalH);

    // 标题
    x2.textAlign = 'center';
    x2.fillStyle = '#7a2e1d';
    x2.font = 'bold 34px "Microsoft YaHei", sans-serif';
    x2.fillText(state.meta.eventName || '婚宴座位表', W / 2, 62);
    x2.fillStyle = '#8a7a5c';
    x2.font = '15px "Microsoft YaHei", sans-serif';
    const totalGuests = D.attendingGuests(state).length;
    const seated = totalGuests - D.unseated(state).length;
    const dateTxt = state.meta.date ? ' · ' + state.meta.date : '';
    x2.fillText(state.tables.length + ' 桌 · 已安排 ' + seated + '/' + totalGuests + ' 人' + dateTxt, W / 2, 92);
    x2.strokeStyle = '#e5d5b8';
    x2.lineWidth = 2;
    x2.beginPath(); x2.moveTo(pad, 112); x2.lineTo(W - pad, 112); x2.stroke();

    // 桌卡片
    let y = 132;
    for (let i = 0; i < tables.length; i += 2) {
      const rowH = Math.max(cardHeights[i] || 0, cardHeights[i + 1] || 0);
      for (let j = 0; j < 2; j++) {
        const t = tables[i + j];
        if (!t) continue;
        const x0 = pad + j * (colW + 24);
        drawTableCard(x2, state, t, x0, y, colW, cardHeights[i + j]);
      }
      y += rowH + 18;
    }

    // footer
    x2.textAlign = 'center';
    x2.fillStyle = '#a89a7d';
    x2.font = '13px "Microsoft YaHei", sans-serif';
    if (unlocked) {
      x2.fillText('由「排座宝」智能生成 · ' + new Date().toLocaleDateString('zh-CN'), W / 2, totalH - 40);
    } else {
      x2.fillText('由「排座宝」P0 原型生成 · 解锁正式版可去水印', W / 2, totalH - 40);
    }

    // 水印
    if (!unlocked) drawWatermark(x2, W, totalH);

    // 下载
    const a = document.createElement('a');
    a.download = ((state.meta.eventName || '座位表') + '-座位表.png').replace(/\s+/g, '');
    a.href = c.toDataURL('image/png');
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function drawTableCard(x2, state, t, x0, y0, w, h) {
    const isHead = t.isHead;
    // 卡片底
    x2.fillStyle = isHead ? '#fffbeb' : '#ffffff';
    x2.strokeStyle = isHead ? '#d4a017' : '#e5dcc8';
    x2.lineWidth = isHead ? 2.5 : 1.2;
    roundRect(x2, x0, y0, w, h, 10);
    x2.fill(); x2.stroke();

    // 头
    x2.textAlign = 'left';
    x2.fillStyle = isHead ? '#9a3b1e' : '#5c5340';
    x2.font = 'bold 17px "Microsoft YaHei", sans-serif';
    x2.fillText((isHead ? '★ ' : '') + t.name, x0 + 16, y0 + 30);
    x2.fillStyle = '#9a8f77';
    x2.font = '12px "Microsoft YaHei", sans-serif';
    x2.textAlign = 'right';
    x2.fillText(t.capacity + ' 人桌', x0 + w - 14, y0 + 30);

    // 座位 两列排布
    const list = seatListOrdered(state, t);
    x2.textAlign = 'left';
    for (let i = 0; i < t.capacity; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const px = x0 + 16 + col * (w - 32) / 2;
      const py = y0 + 52 + row * 30;
      const item = list.find(x => x.s === i);
      x2.font = '13px "Microsoft YaHei", sans-serif';
      if (i === 0) { // 上座
        x2.fillStyle = '#b8860b';
        x2.fillText('★', px, py);
      }
      x2.fillStyle = i === 0 ? '#b8860b' : '#b8ab8f';
      x2.fillText((i + 1) + '.', px + 14, py);
      if (item) {
        const g = item.guest;
        const role = D.ROLES[g.role] ? '（' + D.ROLES[g.role].label + '）' : '';
        x2.fillStyle = '#33302a';
        x2.font = 'bold 13px "Microsoft YaHei", sans-serif';
        x2.fillText(g.name + role, px + 38, py);
      } else {
        x2.fillStyle = '#c9bfae';
        x2.font = '13px "Microsoft YaHei", sans-serif';
        x2.fillText('空座', px + 38, py);
      }
    }
  }

  function drawWatermark(x2, W, H) {
    x2.save();
    x2.globalAlpha = 0.08;
    x2.fillStyle = '#7a2e1d';
    x2.font = 'bold 36px "Microsoft YaHei", sans-serif';
    x2.translate(W / 2, H / 2);
    x2.rotate(-Math.PI / 9);
    for (let ry = -H; ry < H; ry += 170) {
      for (let rx = -W; rx < W; rx += 320) {
        x2.fillText('排座宝 原型', rx, ry);
      }
    }
    x2.restore();
  }

  function roundRect(x2, x, y, w, h, r) {
    x2.beginPath();
    x2.moveTo(x + r, y);
    x2.arcTo(x + w, y, x + w, y + h, r);
    x2.arcTo(x + w, y + h, x, y + h, r);
    x2.arcTo(x, y + h, x, y, r);
    x2.arcTo(x, y, x + w, y, r);
    x2.closePath();
  }

  const api = { exportPNG };
  root.PaizuoExporter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
