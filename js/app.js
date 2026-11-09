/* ============================================================
 * 排座宝 P0 原型 — UI 胶水层
 * ============================================================ */
(function () {
  'use strict';

  const Data = window.PaizuoData, Parser = window.PaizuoParser, Solver = window.PaizuoSolver,
        Etq = window.PaizuoEtiquette, Stage = window.PaizuoStage, Exporter = window.PaizuoExporter,
        NLP = window.PaizuoNLP, Route = window.PaizuoRoute, Rules = window.PaizuoRules,
        Col = window.PaizuoCollision;

  let state = null;
  let lastPlans = [];
  let lastIssues = [];
  let selectedGuestId = null;
  let editingGuestId = null; // null = 新增
  let listDrag = null;       // 左侧列表拖拽 {guestId, sx, sy, started}

  /* ---- P1：分享/引擎/多活动状态 ---- */
  let engine = 'local';            // 'cpsat' | 'local'
  let shareMode = null;            // null | 'edit' | 'view'
  let shareEventId = null, shareEditKey = null, shareTimer = null;

  /* ---------------- 小工具 ---------------- */
  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  let toastTimer = null;
  function toast(msg, long) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), long ? 4200 : 2400);
  }

  /* ---------------- 右侧抽屉 ---------------- */

  function openDrawer(title, tplId) {
    const body = $('drawerBody');
    body.innerHTML = '';
    const tpl = document.getElementById(tplId);
    if (!tpl) { toast('模板缺失：' + tplId); return; }
    body.appendChild(tpl.content.cloneNode(true));
    $('drawerTitle').textContent = title;
    $('drawer').classList.add('on');
    $('drawerMask').classList.add('on');
    body.scrollTop = 0;
  }

  function closeDrawer() {
    $('drawer').classList.remove('on');
    $('drawerMask').classList.remove('on');
  }

  function isDrawerOpen() {
    return $('drawer').classList.contains('on');
  }

  function mutate(fn) {
    if (shareMode === 'view') { toast('当前是只读查看链接，不能修改'); return; }
    fn(state);
    Data.save(state);
    if (shareMode === 'edit') scheduleShareSave();
    renderAll();
  }

  /* ---- P1：分享服务（协作/RSVP） ---- */

  function scheduleShareSave() {
    clearTimeout(shareTimer);
    shareTimer = setTimeout(async () => {
      try {
        await fetch('/api/events/' + shareEventId + '?k=' + encodeURIComponent(shareEditKey), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state }),
        });
      } catch (e) { /* 静默，下次改动重试 */ }
    }, 800);
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(() => toast('已复制')).catch(() => fallbackCopy(t));
    } else fallbackCopy(t);
  }

  function fallbackCopy(t) {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败，请手动选择'); }
    ta.remove();
  }

  function openShare() {
    openDrawer('🔗 分享与 RSVP', 'tpl-share');
    $('btnSyncRsvp').style.display = 'none';
    $('btnShareUpload').addEventListener('click', shareUpload);
    $('btnSyncRsvp').addEventListener('click', syncRsvp);
  }

  async function shareUpload() {
    const body = $('shareBody');
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: state.meta.eventName || '未命名', state }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      shareEventId = j.id;
      shareEditKey = j.editKey;
      const base = location.origin + location.pathname.replace('index.html', '');
      const links = [
        ['协作编辑', base + '?e=' + j.id + '&k=' + j.editKey],
        ['只读查看', base + '?e=' + j.id],
        ['RSVP 收集', base + 'rsvp.html?e=' + j.id],
      ];
      body.innerHTML =
        '<p class="hint" style="color:#15803d">✓ 已上传（ID ' + j.id + '）。把链接复制给对应的人：</p>' +
        links.map((L, i) =>
          '<div class="share-link"><span class="lbl">' + L[0] + '</span>' +
          '<input readonly value="' + L[1] + '" id="lnk' + i + '">' +
          '<button class="mini-btn" data-i="' + i + '">复制</button></div>').join('') +
        '<p class="hint" style="margin-top:12px">宾客回执链接（每人专属，打开即显示其姓名）：</p>' +
        '<div style="max-height:24vh;overflow-y:auto">' +
        Data.attendingGuests(state).map(g =>
          '<div class="share-link"><span class="lbl">' + g.name + '</span>' +
          '<input readonly value="' + base + 'rsvp.html?e=' + j.id + '&g=' + g.id + '">' +
          '<button class="mini-btn" data-g="' + g.id + '">复制</button></div>').join('') +
        '</div>';
      body.querySelectorAll('button[data-i]').forEach(b =>
        b.addEventListener('click', () => copyText($('lnk' + b.dataset.i).value)));
      body.querySelectorAll('button[data-g]').forEach(b =>
        b.addEventListener('click', () => copyText(b.parentElement.querySelector('input').value)));
      $('btnSyncRsvp').style.display = '';
      toast('已上传，链接生成完毕', true);
    } catch (e) {
      body.innerHTML = '<p class="nlp-warn">上传失败：' + e.message +
        '<br>请先运行 <code>python serve.py</code>，并通过 http://127.0.0.1:8767/ 访问（直接双击 index.html 无分享服务）。</p>';
    }
  }

  async function syncRsvp() {
    if (!shareEventId) { toast('请先上传活动'); return; }
    try {
      const res = await fetch('/api/events/' + shareEventId);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const ev = await res.json();
      let yes = 0, no = 0, extra = 0;
      mutate(() => {
        for (const gid in ev.rsvps || {}) {
          const g = Data.guestById(state, gid);
          if (!g) continue;
          const r = ev.rsvps[gid];
          g.attending = (r.status === 'yes');
          if (r.status === 'yes') { yes++; extra += r.extra || 0; } else no++;
          const tag = r.status === 'yes' ? '已回执出席' + (r.extra ? '+' + r.extra : '') : '已回执不出席';
          if (!/已回执/.test(g.note || '')) g.note = (g.note ? g.note + '；' : '') + tag;
          else g.note = (g.note || '').replace(/已回执[^；]*/, tag);
        }
      });
      toast('RSVP 同步完成：出席 ' + yes + '（随行 +' + extra + '）、不出席 ' + no, true);
    } catch (e) { toast('同步失败：' + e.message); }
  }

  /* ---- P1：AI 建约束（自然语言） ---- */

  let nlpSuggestions = [], nlpWarnings = [];

  function openNlp() {
    openDrawer('💬 AI 建约束', 'tpl-nlp');
    $('nlpText').value = '';
    $('nlpResult').innerHTML = '<p class="hint">输入后点「解析」。</p>';
    $('btnNlpApply').style.display = 'none';
    $('btnNlpParse').addEventListener('click', nlpParse);
    $('btnNlpApply').addEventListener('click', nlpApply);
    probeNlpEngine();
  }

  async function probeNlpEngine() {
    let label = '规则引擎 v1（本地）';
    try {
      const res = await fetch('/api/nlp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const j = await res.json();
      if (j.engine === 'llm') label = 'LLM';
    } catch (e) { /* 无服务 */ }
    $('nlpEngine').textContent = label;
  }

  function nlpParse() {
    const r = NLP.parse($('nlpText').value, Data.attendingGuests(state));
    nlpSuggestions = r.suggestions;
    nlpWarnings = r.warnings;
    const box = $('nlpResult');
    box.innerHTML = '';
    if (!nlpSuggestions.length && !nlpWarnings.length) {
      box.appendChild(el('div', 'nlp-warn', '没有解析到内容'));
    }
    for (const w of nlpWarnings) box.appendChild(el('div', 'nlp-warn', '⚠ ' + w));
    for (const s of nlpSuggestions) {
      const row = el('div', 'nlp-sug');
      const badge = el('span', 'c-type');
      if (Data.CONSTRAINT_TYPES[s.type]) {
        badge.textContent = Data.CONSTRAINT_TYPES[s.type].label;
        badge.style.background = Data.CONSTRAINT_TYPES[s.type].color;
      } else if (s.type === 'absent') {
        badge.textContent = '不出席';
        badge.style.background = '#8a7a5c';
      } else {
        badge.textContent = '提示';
        badge.style.background = '#2980b9';
      }
      row.appendChild(badge);
      row.appendChild(el('span', '', s.label));
      row.appendChild(el('span', 'raw', '「' + s.raw + '」'));
      box.appendChild(row);
    }
    $('btnNlpApply').style.display = nlpSuggestions.length ? '' : 'none';
  }

  function nlpApply() {
    let added = 0;
    mutate(() => {
      for (const s of nlpSuggestions) {
        if (s.type === 'absent') {
          const g = Data.guestById(state, s.aGuest.id);
          if (g && g.attending !== false) { g.attending = false; added++; }
        } else if (Data.CONSTRAINT_TYPES[s.type]) {
          const dup = state.constraints.some(c => c.type === s.type &&
            ((c.a === s.aGuest.id && c.b === s.bGuest.id) || (c.a === s.bGuest.id && c.b === s.aGuest.id)));
          if (!dup) {
            state.constraints.push({ id: Data.uid('c'), type: s.type, a: s.aGuest.id, b: s.bGuest.id });
            added++;
          }
        }
      }
    });
    closeDrawer();
    toast('AI 建约束：已添加 ' + added + ' 条', true);
  }

  /* ---- P1：敬酒动线 ---- */

  function openRoute() {
    openDrawer('🍶 敬酒动线', 'tpl-route');
    const r = Route.generate(state);
    $('routeText').textContent = r.text || '还没有座位安排——先排座再来。';
    $('btnRouteCopy').addEventListener('click', () => copyText($('routeText').textContent));
  }

  /* ---- P1：多活动管理 ---- */

  function openEvents() {
    openDrawer('🗂 活动管理', 'tpl-events');
    renderEvents();
    $('btnEventSaveCopy').addEventListener('click', saveEventCopy);
  }

  function renderEvents() {
    const list = Data.listEvents();
    const body = $('eventsBody');
    body.innerHTML = '';
    if (!list.length) {
      body.appendChild(el('p', 'hint', '还没有副本。点下方「另存副本」把当前活动存入列表。'));
      return;
    }
    for (const ev of list) {
      const row = el('div', 'ev-row');
      row.appendChild(el('span', 'nm', ev.name));
      row.appendChild(el('span', 'meta', ev.guests + ' 宾客 · ' + ev.tables + ' 桌 · ' + new Date(ev.savedAt).toLocaleDateString()));
      const load = el('button', 'mini-btn', '载入');
      load.addEventListener('click', () => {
        const s = Data.loadEvent(ev.id);
        if (!s) { toast('副本数据缺失'); return; }
        state = s;
        lastPlans = []; lastIssues = [];
        Data.save(state);
        $('scenarioSel').value = state.meta.scenario || 'wedding';
        renderAll();
        closeDrawer();
        toast('已载入「' + ev.name + '」');
      });
      const del = el('button', 'mini-btn', '删除');
      del.addEventListener('click', () => {
        if (!confirm('删除「' + ev.name + '」的副本？当前活动不受影响。')) return;
        Data.deleteEvent(ev.id);
        renderEvents();
      });
      row.append(load, del);
      body.appendChild(row);
    }
  }

  function saveEventCopy() {
    const name = prompt('副本名称：', (state.meta.eventName || '未命名') + ' 副本');
    if (!name) return;
    Data.saveEventAs(Data.newEventId(), name, state);
    renderEvents();
    toast('已保存副本「' + name + '」');
  }

  /* ---- P1：当天模式 ---- */

  function toggleDay() {
    const bar = $('dayBar');
    const on = bar.style.display === 'none';
    bar.style.display = on ? '' : 'none';
    if (on) toast('当天模式开启：可处理临时到场与现场调整', true);
  }

  function dayAdd() {
    const name = $('dayName').value.trim();
    if (!name) { toast('先填宾客姓名'); return; }
    mutate(() => {
      const g = {
        id: Data.uid(), name, side: '',
        role: state.meta.scenario === 'banquet' ? 'staff' : 'friend',
        group: '临时', note: '当天临时到场', attending: true,
      };
      state.guests.push(g);
      if (!state.plan) state.plan = { name: '手动', seats: {} };
      const used = {};
      for (const gid in state.plan.seats) {
        const s = state.plan.seats[gid];
        (used[s.t] = used[s.t] || new Set()).add(s.s);
      }
      const freeOf = t => t.capacity - (used[t.id] ? used[t.id].size : 0);
      const cand = state.tables.filter(t => freeOf(t) > 0)
        .sort((a, b) => freeOf(b) - freeOf(a));
      if (!cand.length) { toast('全部坐满了，请先在桌次设置加桌'); return; }
      const t = cand[0];
      const u = used[t.id] || new Set();
      let s = 0;
      while (u.has(s)) s++;
      state.plan.seats[g.id] = { t: t.id, s };
      $('dayName').value = '';
      toast('已安排 ' + name + ' → ' + t.name + '（' + (s + 1) + ' 号位）');
    });
  }

  function dayFix() {
    const r = Solver.repairOnly(state);
    mutate(() => { });
    runCheck();
    const msg = ['补位 ' + r.placed + ' 人', '调整 ' + r.moved + ' 人'].concat(r.warn).join('；');
    toast(msg || '一切正常，无需整理', true);
  }

  /* ---------------- 渲染 ---------------- */

  function renderAll() {
    renderStats();
    renderGuestList();
    renderPlanTabs();
    renderConstraints();
    renderReport(lastIssues);
    Stage.setSelected(selectedGuestId);
    Stage.render();
    $('eventName').value = state.meta.eventName || '';
    updateLockUI();
  }

  function renderStats() {
    const total = Data.attendingGuests(state).length;
    const unseated = Data.unseated(state).length;
    const cap = Data.totalCapacity(state);
    $('statsText').textContent =
      (Data.SCENARIOS[state.meta.scenario || 'wedding'].label + '场景 · ') +
      '宾客 ' + total + ' · 已安排 ' + (total - unseated) + ' · 未安排 ' + unseated +
      ' · 桌次 ' + state.tables.length + ' · 座位 ' + cap;
  }

  /* ---- P1：求解引擎探测 ---- */

  async function probeEngine() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('/api/health', { signal: ctrl.signal });
      clearTimeout(t);
      const j = await res.json();
      engine = j.engine === 'cpsat' ? 'cpsat' : 'local';
    } catch (e) { engine = 'local'; }
    renderEngineChip();
  }

  function renderEngineChip() {
    const chip = $('engineChip');
    chip.style.display = '';
    chip.textContent = engine === 'cpsat' ? '规则引擎 CP-SAT·云端' : '规则引擎 · 本地搜索';
  }

  function renderModeChip() {
    const chip = $('modeChip');
    if (!shareMode) { chip.style.display = 'none'; return; }
    chip.style.display = '';
    chip.textContent = shareMode === 'edit' ? '分享·可编辑' : '分享·只读';
  }

  let sideFilter = '';

  function matchSide(g) {
    if (!sideFilter) return true;
    return sideFilter === 'none' ? !g.side : g.side === sideFilter;
  }

  function renderGuestList() {
    const box = $('guestList');
    box.innerHTML = '';
    const kw = ($('guestFilter').value || '').trim();
    const attending = Data.attendingGuests(state);
    const seats = state.plan && state.plan.seats || {};

    const unseatedBox = el('div', 'gsec');
    unseatedBox.appendChild(el('div', 'gsec-title', '未安排 ' + Data.unseated(state).length));
    const chipRow = el('div', 'chip-row');
    let unshown = 0;
    for (const g of attending) {
      if (seats[g.id]) continue;
      if ((kw && !g.name.includes(kw)) || !matchSide(g)) { unshown++; continue; }
      chipRow.appendChild(guestChip(g, null));
    }
    if (!chipRow.children.length) {
      chipRow.appendChild(el('div', 'gsec-empty', unshown ? '（被筛选隐藏）' : '全部已安排 🎉'));
    }
    unseatedBox.appendChild(chipRow);
    box.appendChild(unseatedBox);

    // 其余宾客（按桌分组）
    const byTable = new Map();
    for (const g of attending) {
      const s = seats[g.id];
      if (!s) continue;
      if (!byTable.has(s.t)) byTable.set(s.t, []);
      byTable.get(s.t).push({ g, s });
    }
    const sortedTables = state.tables.slice().sort((a, b) => (b.isHead ? 1 : 0) - (a.isHead ? 1 : 0));
    for (const t of sortedTables) {
      const list = (byTable.get(t.id) || []).sort((a, b) => a.s - b.s);
      if (!list.length) continue;
      const sec = el('div', 'gsec');
      sec.appendChild(el('div', 'gsec-title', (t.isHead ? '★ ' : '') + t.name + '（' + list.length + '/' + t.capacity + '）'));
      const row = el('div', 'chip-row');
      for (const { g } of list) {
        if ((kw && !g.name.includes(kw)) || !matchSide(g)) continue;
        row.appendChild(guestChip(g, t));
      }
      sec.appendChild(row);
      box.appendChild(sec);
    }
  }

  function guestChip(g, table) {
    const chip = el('div', 'chip' + (selectedGuestId === g.id ? ' sel' : ''));
    chip.dataset.gid = g.id;
    const nm = el('span', 'chip-name', g.name);
    chip.appendChild(nm);
    const role = Data.ROLES[g.role];
    if (role) chip.appendChild(el('span', 'badge role', role.label));
    if (g.side) chip.appendChild(el('span', 'badge side ' + g.side, Data.SIDES[g.side] || g.side));
    if (table) chip.appendChild(el('span', 'badge table', table.name));
    if (g.dietary) chip.appendChild(el('span', 'badge diet', g.dietary));
    chip.title = (g.note ? g.note + '\n' : '') + '点击选中 / 拖到画布 / 双击编辑';
    chip.addEventListener('pointerdown', (e) => beginListDrag(e, g));
    chip.addEventListener('dblclick', () => openGuestDialog(g.id));
    return chip;
  }

  function beginListDrag(e, g) {
    if (e.button !== 0) return;
    listDrag = { guestId: g.id, sx: e.clientX, sy: e.clientY, started: false, pointerId: e.pointerId };
  }

  let paletteDrag = null; // {kind, sx, sy, active}

  function beginPaletteDrag(e, kind) {
    if (e.button !== 0) return;
    paletteDrag = { kind, sx: e.clientX, sy: e.clientY, active: false };
  }

  function documentPointerMove(e) {
    if (paletteDrag) {
      if (!paletteDrag.active && Math.hypot(e.clientX - paletteDrag.sx, e.clientY - paletteDrag.sy) > 7) {
        paletteDrag.active = true;
        Stage.setPlacing(paletteDrag.kind === 'stage' ? 'stage' : paletteDrag.kind,
                         paletteDrag.kind === 'stage' ? 'rect' : undefined);
      }
      if (paletteDrag.active) Stage.setPlacingGhost(e.clientX, e.clientY);
      return;
    }
    if (!listDrag || listDrag.started) return;
    if (Math.hypot(e.clientX - listDrag.sx, e.clientY - listDrag.sy) > 7) {
      listDrag.started = true;
      Stage.externalDragStart(listDrag.guestId, e.clientX, e.clientY);
      selectGuest(null);
    }
  }

  function documentPointerUp(e) {
    if (paletteDrag) {
      if (paletteDrag.active) {
        const ok = Stage.placeAtClient(e.clientX, e.clientY);
        if (!ok) toast('此处与现有布置干涉，未放置');
      } else {
        Stage.setPlacing(paletteDrag.kind === 'stage' ? 'stage' : paletteDrag.kind,
                         paletteDrag.kind === 'stage' ? 'rect' : undefined);
        toast('在画布上点击位置摆放，Esc 取消', true);
      }
      paletteDrag = null;
      return;
    }
    if (!listDrag) return;
    if (listDrag.started) {
      Stage.externalDragEnd(e.clientX, e.clientY);
    } else {
      const g = Data.guestById(state, listDrag.guestId);
      if (g) selectGuest(selectedGuestId === g.id ? null : g.id);
    }
    listDrag = null;
  }

  function selectGuest(gid) {
    selectedGuestId = gid || null;
    renderGuestList();
    Stage.setSelected(selectedGuestId);
  }

  /* ---------------- 方案 tabs ---------------- */

  function renderPlanTabs() {
    const box = $('planTabs');
    box.innerHTML = '';
    if (!lastPlans.length) {
      box.appendChild(el('span', 'plan-hint', state.plan ? '当前：' + state.plan.name : '尚未排座 — 点「✨ 智能排座」试试'));
      return;
    }
    for (const p of lastPlans) {
      const cur = state.plan && state.plan.name === p.name;
      const b = el('button', 'plan-tab' + (cur ? ' cur' : ''));
      b.appendChild(el('span', 'plan-name', p.name));
      b.appendChild(el('span', 'plan-score', p.score.hard > 0 ? '硬冲突 ' + p.score.hard : '软分 ' + p.score.soft));
      b.title = p.unmet.length ? p.unmet.join('\n') : '硬约束全部满足';
      b.addEventListener('click', () => {
        Solver.applyPlan(state, p);
        mutate(() => { });
        toast('已切换到 ' + p.name);
      });
      box.appendChild(b);
    }
    if (state.plan && state.plan.unmetNote) {
      box.appendChild(el('span', 'plan-warn', state.plan.unmetNote));
    }
  }

  /* ---------------- 约束面板（宾客/身份双维度 + 模板 + 互斥检测） ---------------- */

  let cDim = 'guest'; // 'guest' | 'role'

  function fillRoleConstraintSelect(sel) {
    const cur = sel.value;
    sel.innerHTML = '';
    const seen = new Set();
    for (const k in Data.ROLES) {
      const sc = Data.ROLES[k].scenario;
      if (sc && sc !== (state.meta.scenario || 'wedding')) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      const o = document.createElement('option');
      o.value = k;
      o.textContent = Data.ROLES[k].label;
      sel.appendChild(o);
    }
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  }

  function renderConstraints() {
    const selA = $('cA'), selB = $('cB');
    if (cDim === 'role') {
      fillRoleConstraintSelect(selA); fillRoleConstraintSelect(selB);
    } else {
      fillGuestSelect(selA); fillGuestSelect(selB);
    }
    $('dimGuest').classList.toggle('cur', cDim === 'guest');
    $('dimRole').classList.toggle('cur', cDim === 'role');

    const list = $('constraintList');
    list.innerHTML = '';
    if (!state.constraints.length) {
      list.appendChild(el('div', 'empty-hint', '还没有约束。可按宾客或按身份添加，也可用下方常用约束一键生成。'));
    }
    for (const c of state.constraints) {
      const d = Rules.describe(c, state);
      const t = Data.CONSTRAINT_TYPES[c.type];
      const row = el('div', 'c-row');
      const badge = el('span', 'c-type', t ? t.label : c.type);
      if (t) badge.style.background = t.color;
      row.appendChild(badge);
      row.appendChild(el('span', 'c-names', d.text));
      row.appendChild(el('span', 'badge scope', d.scope));
      const del = el('button', 'c-del', '✕');
      del.title = '删除';
      del.addEventListener('click', () => mutate(() => {
        state.constraints = state.constraints.filter(x => x.id !== c.id);
      }));
      row.appendChild(del);
      list.appendChild(row);
    }
    renderConstraintTemplates();
  }

  function renderConstraintTemplates() {
    const box = $('tplList');
    if (!box) return;
    box.innerHTML = '';
    for (const tpl of Rules.templates(state.meta.scenario || 'wedding')) {
      const b = el('button', 'btn', tpl.label);
      b.title = '身份级约束：应用到该身份的全部宾客';
      b.addEventListener('click', () => applyTemplate(tpl));
      box.appendChild(b);
    }
  }

  function applyTemplate(tpl) {
    const rules = [tpl].concat(tpl.extra || []);
    let added = 0, blocked = 0;
    for (const r of rules) {
      const cand = { type: r.type, a: r.a, b: r.b, scope: 'role' };
      const res = Rules.checkConflict(cand, state.constraints, state);
      if (res.hard.length) { blocked++; continue; }
      if (res.dup) continue;
      mutate(() => state.constraints.push({ id: Data.uid('c'), scope: 'role', ...cand }));
      added++;
    }
    if (added) toast('已添加 ' + added + ' 条身份级约束' + (blocked ? '，' + blocked + ' 条与现有约束互斥被跳过' : ''), true);
    else toast('没有可添加的约束（可能已存在或与现有约束互斥）', true);
  }

  function fillGuestSelect(sel) {
    const cur = sel.value;
    sel.innerHTML = '';
    for (const g of Data.attendingGuests(state)) {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = g.name + (g.side ? '（' + (Data.SIDES[g.side] || g.side) + '）' : '');
      sel.appendChild(o);
    }
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  }

  function addConstraint() {
    const a = $('cA').value, b = $('cB').value, type = $('cType').value;
    if (!a || !b) { toast('请选择两' + (cDim === 'role' ? '个身份' : '位宾客')); return; }
    if (a === b && cDim === 'guest') { toast('请选择两位不同宾客'); return; }
    const candidate = { type, a, b, scope: cDim };
    const res = Rules.checkConflict(candidate, state.constraints, state);
    if (res.dup) { toast('同样约束已存在'); return; }
    if (res.hard.length) {
      const ag = res.hard[0].against;
      const d = Rules.describe(ag, state);
      toast('不能创建：与现有约束「' + (Data.CONSTRAINT_TYPES[ag.type] || {}).label + ' ' + d.text +
        '」对同一对宾客的结论相反，二者互斥', true);
      return;
    }
    const doAdd = () => mutate(() => {
      state.constraints.push({ id: Data.uid('c'), scope: cDim, type, a, b });
    });
    if (res.empty) {
      if (!confirm('「必须同桌」用在同一身份上会把该身份的所有宾客锁进一桌，通常应选「希望同桌」。仍要添加？')) return;
    } else if (res.soft.length) {
      const ag = res.soft[0].against;
      const d = Rules.describe(ag, state);
      if (!confirm('与现有约束「' + (Data.CONSTRAINT_TYPES[ag.type] || {}).label + ' ' + d.text + '」的倾向相反（软冲突），仍要添加？')) return;
    }
    doAdd();
    const scopeTxt = cDim === 'role' ? '身份级' : '宾客级';
    toast('已添加' + scopeTxt + '约束');
  }

  /* ---------------- 礼俗报告 ---------------- */

  function renderReport(issues) {
    const list = $('issueList');
    list.innerHTML = '';
    if (!issues.length) {
      list.appendChild(el('div', 'empty-hint', '点上方「礼俗检查」给当前方案做一次体检。'));
      return;
    }
    let fixable = 0;
    const LV = { error: ['严重', 'lv-error'], warn: ['建议', 'lv-warn'], info: ['提示', 'lv-info'] };
    for (const it of issues) {
      const [label, cls] = LV[it.level] || LV.info;
      const row = el('div', 'issue ' + cls);
      row.appendChild(el('div', 'issue-title', '[' + label + '] ' + it.title));
      row.appendChild(el('div', 'issue-detail', it.detail));
      if (it.fixable) {
        fixable++;
        const fix = el('button', 'mini-btn', '一键修复');
        fix.addEventListener('click', () => {
          const n = Etq.fixHeadComposition(state);
          mutate(() => { });
          runCheck();
          toast('已把 ' + n + ' 位主桌成员调回主桌');
        });
        row.appendChild(fix);
      }
      list.appendChild(row);
    }
    if (issues.every(i => i.level === 'info')) {
      const ok = el('div', 'all-ok', '✓ 无硬性问题，只有可选建议');
      list.prepend(ok);
    } else if (fixable === 0) {
      const bad = issues.filter(i => i.level !== 'info').length;
      if (bad === 0) list.prepend(el('div', 'all-ok', '✓ 无硬性问题'));
    }
  }

  function runCheck() {
    lastIssues = Etq.check(state);
    // 切到报告 tab
    switchRightTab('report');
    renderReport(lastIssues);
    const errs = lastIssues.filter(i => i.level === 'error').length;
    const warns = lastIssues.filter(i => i.level === 'warn').length;
    toast('体检完成：' + errs + ' 项严重、' + warns + ' 项建议', true);
  }

  function switchRightTab(which) {
    for (const k of ['constraint', 'report']) {
      $('panel' + k).style.display = (k === which) ? '' : 'none';
      $('tab-' + k).classList.toggle('cur', k === which);
    }
  }

  /* ---------------- AI 排座 / 付费墙 ---------------- */

  function runSolve() {
    if (!state.guests.length) { toast('先导入或添加宾客'); return; }
    if (!state.tables.length) { toast('先在「桌次设置」里加桌'); return; }
    if (!state.meta.unlocked) { openPaywall('solve'); return; }

    $('solving').classList.add('show');
    const finish = () => $('solving').classList.remove('show');

    if (engine === 'cpsat') {
      solveCloud()
        .then(() => {
          finish();
          Data.save(state);
          renderAll();
          Stage.fitView();
          runCheck();
          toast('规则求解完成（CP-SAT 云端）：' + lastPlans.length + ' 套方案，已应用最优一套');
        })
        .catch(() => {
          finish();
          toast('云端引擎不可用，已改用本地规则搜索', true);
          setTimeout(() => { $('solving').classList.add('show'); solveLocal(); finish(); }, 30);
        });
    } else {
      setTimeout(() => { try { solveLocal(); } finally { finish(); } }, 40);
    }
  }

  async function solveCloud() {
    const ctx = Solver.buildContext(state);
    const payload = {
      guests: ctx.guests.map(g => ({ id: g.id, name: g.name, side: g.side, role: g.role, group: g.group })),
      tables: state.tables.map(t => ({ id: t.id, capacity: t.capacity, isHead: t.isHead, x: t.x, y: t.y })),
      constraints: Solver.exportConstraints(state), // 身份级已展开为宾客对
      roleTable: Data.ROLES,
      timeLimit: 8,
    };
    const res = await fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('solve HTTP ' + res.status);
    const j = await res.json();
    if (!j.plans || !j.plans.length) throw new Error('云端无解');
    lastPlans = j.plans.map((p, i) => Solver.planFromAssign(ctx, p.assign, '方案' + 'ABCDEF'[i]));
    lastPlans.sort((a, b) => (a.score.hard - b.score.hard) || (a.score.soft - b.score.soft));
    lastPlans.forEach((pl, i) => { pl.name = '方案' + 'ABCDEF'[i]; });
    Solver.applyPlan(state, lastPlans[0]);
  }

  function solveLocal() {
    const res = Solver.solve(state, { plans: 3 });
    for (const w of res.warn) toast(w, true);
    lastPlans = res.plans;
    if (res.plans.length) Solver.applyPlan(state, res.plans[0]);
    Data.save(state);
    renderAll();
    Stage.fitView();
    runCheck();
    toast('已按约束规则生成 ' + res.plans.length + ' 套方案，可点上方方案切换对比');
  }

  let paywallFrom = null;
  function openPaywall(from) {
    paywallFrom = from;
    openDrawer('🔓 解锁 排座宝 · 婚宴版', 'tpl-pay');
    $('btnMockPay').addEventListener('click', mockPay);
  }

  function mockPay() {
    closeDrawer();
    mutate(() => { state.meta.unlocked = true; });
    toast('已解锁（原型模拟支付）✨');
    if (paywallFrom === 'solve') runSolve();
  }

  function updateLockUI() {
    const b = $('btnUnlock');
    b.style.display = state.meta.unlocked ? 'none' : '';
    $('btnSolve').classList.toggle('locked', !state.meta.unlocked);
  }

  /* ---------------- 导入 ---------------- */

  function openImport() {
    openDrawer('📋 导入宾客名单', 'tpl-import');
    $('importText').value = '';
    $('importPreview').textContent = '粘贴后自动解析…';
    $('importText').addEventListener('input', previewImport);
    $('btnDoImport').addEventListener('click', doImport);
  }

  function previewImport() {
    const r = Parser.parseRoster($('importText').value);
    let txt = '解析到 ' + r.count + ' 位宾客';
    if (r.warnings.length) txt += '，' + r.warnings.length + ' 条警告';
    $('importPreview').textContent = txt + '\n' + r.guests.slice(0, 12).map(g => '· ' + g.name + (g.note ? '（' + g.note + '）' : '')).join('\n') + (r.count > 12 ? '\n…' : '');
  }

  function doImport() {
    const r = Parser.parseRoster($('importText').value);
    if (!r.guests.length) { toast('没有解析到宾客，请检查格式'); return; }
    mutate(() => {
      for (const g of r.guests) {
        state.guests.push({
          id: Data.uid(), name: g.name, side: g.side, role: g.role,
          group: '', dietary: '', note: g.note, attending: true,
        });
      }
    });
    closeDrawer();
    toast('已导入 ' + r.count + ' 位宾客' + (r.warnings.length ? '（' + r.warnings.length + ' 条警告，见下方宾客列表核对）' : ''), true);
    if (r.warnings.length) console.warn('[导入警告]', r.warnings);
  }

  /* ---------------- 宾客编辑 ---------------- */

  function openGuestDialog(gid) {
    editingGuestId = gid || null;
    const g = gid ? Data.guestById(state, gid) : null;
    openDrawer(g ? '✏️ 编辑宾客' : '✚ 添加宾客', 'tpl-guest');
    fillRoleSelect($('gRole'));
    $('gName').value = g ? g.name : '';
    $('gSide').value = g ? (g.side || '') : '';
    $('gRole').value = g ? (g.role || '') : '';
    $('gGroup').value = g ? (g.group || '') : '';
    $('gDietary').value = g ? (g.dietary || '') : '';
    $('gNote').value = g ? (g.note || '') : '';
    $('gAttending').checked = g ? g.attending !== false : true;
    $('btnDeleteGuest').style.display = g ? '' : 'none';
    $('btnSaveGuest').addEventListener('click', saveGuest);
    $('btnDeleteGuest').addEventListener('click', deleteGuest);
  }

  function saveGuest() {
    const name = $('gName').value.trim();
    if (!name) { toast('请填姓名'); return; }
    mutate(() => {
      if (editingGuestId) {
        const g = Data.guestById(state, editingGuestId);
        if (g) Object.assign(g, {
          name, side: $('gSide').value, role: $('gRole').value,
          group: $('gGroup').value.trim(), dietary: $('gDietary').value.trim(),
          note: $('gNote').value.trim(), attending: $('gAttending').checked,
        });
      } else {
        state.guests.push({
          id: Data.uid(), name, side: $('gSide').value, role: $('gRole').value,
          group: $('gGroup').value.trim(), dietary: $('gDietary').value.trim(),
          note: $('gNote').value.trim(), attending: $('gAttending').checked,
        });
      }
    });
    closeDrawer();
  }

  function deleteGuest() {
    if (!editingGuestId) return;
    const g = Data.guestById(state, editingGuestId);
    if (!g) return;
    if (!confirm('删除宾客「' + g.name + '」？')) return;
    mutate(() => {
      state.guests = state.guests.filter(x => x.id !== editingGuestId);
      state.constraints = state.constraints.filter(c => c.a !== editingGuestId && c.b !== editingGuestId);
      if (state.plan) delete state.plan.seats[editingGuestId];
    });
    closeDrawer();
  }

  /* ---------------- 左栏：宾客 / 布局 双 Tab ---------------- */

  function switchLeftTab(which) {
    $('ltab-guests').classList.toggle('cur', which === 'guests');
    $('ltab-layout').classList.toggle('cur', which === 'layout');
    $('lpanel-guests').style.display = which === 'guests' ? '' : 'none';
    $('lpanel-layout').style.display = which === 'layout' ? '' : 'none';
  }

  /* 布局面板 = 可拖入画布的元素清单；设置全部在画布就地弹窗完成 */
  let selectedTableId = null;

  /* 逻辑坐标 → 屏幕坐标（popover 定位用） */
  function logicalToScreen(lx, ly) {
    const v = Stage.getView();
    const sp = Stage.getSpace();
    const cv = $('stageCanvas');
    const rect = cv.getBoundingClientRect();
    const sc = cv.clientWidth / sp.w;
    return { x: rect.left + (lx * v.scale + v.tx) * sc, y: rect.top + (ly * v.scale + v.ty) * sc };
  }

  function showCanvasPop(pop, selTarget) {
    hideCanvasPops();               // 关其他弹窗（会清 selectedResize）
    if (selTarget) Stage.setSelectedResize(selTarget); // 清完再设置本弹窗的选中目标
    pop.style.display = 'block';
    // 初始位置：屏幕居中偏上（标题栏可拖动）
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.round((window.innerWidth - pw) / 2)) + 'px';
    pop.style.top = Math.max(8, Math.round((window.innerHeight - ph) / 2) - 30) + 'px';
  }

  function hideCanvasPops() {
    $('tablePop').style.display = 'none';
    $('stagePop').style.display = 'none';
    $('itemPop').style.display = 'none';
    // selectedResize 保留：手柄拉伸在弹窗交互期间需要持续有效；下次开弹窗会重设
  }

  /* 桌位就地设置弹窗（画布齿轮 / 点击桌身 触发，定位在桌旁） */
  let editingTableId = null;

  function openTableEditor(tid) {
    const t = Data.tableById(state, tid);
    if (!t) return;
    editingTableId = tid;
    $('teTitle').textContent = '桌位设置 — ' + t.name;
    $('teName').value = t.name;
    $('teCap').value = t.capacity;
    $('teHead').checked = !!t.isHead;
    showCanvasPop($('tablePop'));
  }

  function saveTableEditor() {
    const t = Data.tableById(state, editingTableId);
    if (!t) { hideCanvasPops(); return; }
    const name = $('teName').value.trim() || t.name;
    const cap = Math.max(4, Math.min(20, parseInt($('teCap').value, 10) || 10));
    const isHead = $('teHead').checked;
    mutate(() => {
      t.name = name;
      t.capacity = cap;
      if (state.plan) {
        for (const gid in state.plan.seats) {
          const s2 = state.plan.seats[gid];
          if (s2.t === t.id && s2.s >= cap) delete state.plan.seats[gid];
        }
      }
      if (isHead && !t.isHead) Data.setHeadTable(state, t.id);
    });
    hideCanvasPops();
    toast('「' + name + '」已更新（' + cap + ' 人）');
  }

  function deleteTableEditor() {
    const t = Data.tableById(state, editingTableId);
    if (!t) return;
    if (!confirm('删除「' + t.name + '」？其宾客回到未安排。')) return;
    mutate(() => {
      state.tables = state.tables.filter(x => x.id !== editingTableId);
      if (state.plan) for (const gid in state.plan.seats) if (state.plan.seats[gid].t === editingTableId) delete state.plan.seats[gid];
      Data.ensureHeadTable(state);
    });
    hideCanvasPops();
  }

  /* 舞台就地设置（点击舞台触发，屏幕居中） */
  const STAGE_BASE = { rect: { w: 300, h: 70 }, tshape: { w: 300, h: 192 }, round: { w: 190, h: 190 } };

  function openStageEditor() {
    const stg = state.meta.stage;
    if (!stg || stg.shape === 'none') return;
    $('spShape').value = stg.shape;
    $('spW').value = Math.round(stg.w || STAGE_BASE[stg.shape].w);
    $('spH').value = Math.round(stg.h || STAGE_BASE[stg.shape].h);
    $('spScale').value = Math.round(Math.sqrt(
      (stg.w * stg.h) / (STAGE_BASE[stg.shape].w * STAGE_BASE[stg.shape].h)) * 100);
    showCanvasPop($('stagePop'), { type: 'stage' });
  }

  function syncStageFields() {
    const stg = state.meta.stage;
    $('spW').value = Math.round(stg.w);
    $('spH').value = Math.round(stg.h);
    $('spScale').value = Math.round(Math.sqrt(
      (stg.w * stg.h) / (STAGE_BASE[stg.shape].w * STAGE_BASE[stg.shape].h)) * 100);
  }

  function applyStageSize(w, h) {
    const stg = state.meta.stage;
    const C = window.PaizuoCollision;
    const legal = C.legal(C.stageGeom({ shape: stg.shape, x: stg.x, y: stg.y, w, h }),
                          C.collect(state, { type: 'stage' }, Stage.doorPos(state)));
    if (!legal) { toast('调整后的尺寸与现有布置干涉，未应用'); syncStageFields(); return; }
    mutate(() => { stg.w = Math.round(w); stg.h = Math.round(h); });
  }

  /* 场地元素就地设置（点击元素触发，屏幕居中） */
  let editingItemId = null;

  function openItemEditor(itemId) {
    const it = (state.venueItems || []).find(x => x.id === itemId);
    if (!it) return;
    const K = Data.VENUE_KINDS[it.kind] || { label: it.kind, icon: '📍' };
    editingItemId = itemId;
    $('ipTitle').textContent = '元素设置 — ' + K.label;
    $('ipW').value = Math.round(it.w);
    $('ipH').value = Math.round(it.h);
    $('ipScale').value = Math.round(Math.sqrt((it.w * it.h) / 144 / 60) * 100);
    showCanvasPop($('itemPop'), { type: 'item', id: itemId });
  }

  function applyItemSize(w, h) {
    const it = (state.venueItems || []).find(x => x.id === editingItemId);
    if (!it) return;
    const C = window.PaizuoCollision;
    const legal = C.legal(C.itemGeom({ ...it, w, h }),
                          C.collect(state, { type: 'item', id: it.id }, Stage.doorPos(state)));
    if (!legal) { toast('调整后的尺寸与现有布置干涉，未应用'); openItemEditor(it.id); return; }
    mutate(() => { it.w = Math.round(w); it.h = Math.round(h); });
  }

  function deleteItemEditor() {
    const it = (state.venueItems || []).find(x => x.id === editingItemId);
    if (!it) return;
    if (!confirm('删除该元素？')) return;
    mutate(() => {
      state.venueItems = state.venueItems.filter(x => x.id !== editingItemId);
    });
    hideCanvasPops();
  }

  /* 元素落点创建（拖放/点击放置共用） */
  function placeElement(placing, x, y) {
    const SB = { rect: [300, 70], tshape: [300, 192], round: [190, 190] };
    const IB = { wall: [220, 36], wc: [144, 60], sign: [144, 60], buffet: [144, 60], rest: [144, 60] };
    mutate(() => {
      if (placing.kind === 'table') {
        const t = Data.addTable(state, { capacity: 10 });
        t.x = Math.round(x); t.y = Math.round(y);
      } else if (placing.kind === 'stage') {
        const d = SB[placing.shape] || SB.rect;
        state.meta.stage.shape = placing.shape;
        state.meta.stage.x = Math.round(x);
        state.meta.stage.y = Math.round(y);
        state.meta.stage.w = d[0]; state.meta.stage.h = d[1];
      } else {
        const d = IB[placing.kind] || IB.wc;
        state.venueItems.push({ id: Data.uid('v'), kind: placing.kind, x: Math.round(x), y: Math.round(y), w: d[0], h: d[1] });
      }
    });
    const K = Data.VENUE_KINDS[placing.kind];
    toast(placing.kind === 'table' ? '圆桌已放置，点击桌身或 ⚙ 设置容量' :
          placing.kind === 'stage' ? '舞台已放置，点击舞台可改形状' :
          placing.kind === 'wall' ? '墙面已放置：点击选中后拖右下角手柄调整大小' :
          (K ? K.label : '元素') + '已放置，可拖动调整', true);
  }

  /* ---------------- 画布交互回调 ---------------- */

  function canvasEdit(info, drop) {
    if (drop.type === 'noop') return;
    mutate(() => {
      const seats = state.plan ? state.plan.seats : (state.plan = { name: '手动', seats: {} }).seats;
      if (drop.type === 'blank' && info.from) {
        delete seats[info.guestId];
        return;
      }
      if (drop.type === 'seat') {
        const { t, s } = drop.seat;
        const table = Data.tableById(state, t);
        if (!table) return;
        // 占位 → 互换
        let occupant = null;
        for (const gid in seats) {
          if (seats[gid].t === t && seats[gid].s === s) { occupant = gid; break; }
        }
        if (info.from && info.from.t === t && info.from.s === s) return;
        if (occupant) {
          if (info.from) {
            seats[occupant] = { t: info.from.t, s: info.from.s };
          } else {
            delete seats[occupant]; // 从列表拖来且目标有人 → 原occupant改为未安排
          }
        }
        seats[info.guestId] = { t, s };
        selectGuest(null);
      }
    });
  }

  function canvasSeatClick(seat) {
    if (!selectedGuestId) { toast('先在左侧点选（或拖拽）一位宾客'); return; }
    canvasEdit({ guestId: selectedGuestId, from: null }, { type: 'seat', seat });
  }

  function canvasSeatDblClick(guestId) {
    mutate(() => { if (state.plan) delete state.plan.seats[guestId]; });
    toast('已取消安排');
  }

  /* ---------------- 顶栏按钮 ---------------- */

  function bindToolbar() {
    $('eventName').addEventListener('change', (e) => mutate(() => { state.meta.eventName = e.target.value; }));

    $('scenarioSel').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v === state.meta.scenario) return;
      if (!confirm('切换场景为「' + Data.SCENARIOS[v].label + '」？礼俗检查与角色建议将随之变化。')) {
        e.target.value = state.meta.scenario;
        return;
      }
      mutate(() => { state.meta.scenario = v; });
      toast('已切换到「' + Data.SCENARIOS[v].label + '」场景', true);
    });

    $('btnImport').addEventListener('click', openImport);
    $('btnAddGuest').addEventListener('click', () => openGuestDialog(null));
    $('btnNlp').addEventListener('click', openNlp);
    $('btnSolve').addEventListener('click', runSolve);
    $('btnRunCheck').addEventListener('click', runCheck);
    $('btnDay').addEventListener('click', toggleDay);
    $('btnDayAdd').addEventListener('click', dayAdd);
    $('btnDayFix').addEventListener('click', dayFix);
    $('btnRoute').addEventListener('click', openRoute);
    $('btnExport').addEventListener('click', () => {
      if (!state.plan) { toast('还没有座位安排，先排座或手动拖几个'); return; }
      Exporter.exportPNG(state);
      toast('长图已生成并开始下载');
    });
    $('btnCards').addEventListener('click', () => {
      const url = 'cards.html' + (shareEventId && !state.meta._localOnly ? '?e=' + shareEventId : '');
      window.open(url, '_blank');
    });
    $('btnShare').addEventListener('click', openShare);
    $('btnEvents').addEventListener('click', openEvents);
    $('btnUnlock').addEventListener('click', () => openPaywall('unlock'));
    $('btnDemo').addEventListener('click', () => loadDemo(Data.demoState, '婚宴'));
    $('btnDemoBq').addEventListener('click', () => loadDemo(Data.demoBanquetState, '年会'));
    $('btnClear').addEventListener('click', () => {
      if (!confirm('清空全部数据？')) return;
      state = Data.blankState();
      lastPlans = []; lastIssues = [];
      Data.save(state);
      renderAll();
    });

    // 左栏 tabs + 布局面板
    $('ltab-guests').addEventListener('click', () => switchLeftTab('guests'));
    $('ltab-layout').addEventListener('click', () => switchLeftTab('layout'));
    // 元素清单：拖入画布（或单击进入点击放置模式）
    $('paletteList').addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.pal-row');
      if (row) beginPaletteDrag(e, row.dataset.kind);
    });

    // 就地弹窗
    $('teSave').addEventListener('click', saveTableEditor);
    $('teDelete').addEventListener('click', deleteTableEditor);
    $('spShape').addEventListener('change', () => {
      const shape = $('spShape').value;
      const base = STAGE_BASE[shape] || STAGE_BASE.rect;
      mutate(() => { state.meta.stage.shape = shape; state.meta.stage.w = base.w; state.meta.stage.h = base.h; });
      syncStageFields();
    });
    $('spW').addEventListener('change', () => {
      const base = STAGE_BASE[state.meta.stage.shape] || STAGE_BASE.rect;
      applyStageSize(+$('spW').value || base.w, state.meta.stage.h);
    });
    $('spH').addEventListener('change', () => {
      const base = STAGE_BASE[state.meta.stage.shape] || STAGE_BASE.rect;
      applyStageSize(state.meta.stage.w, +$('spH').value || base.h);
    });
    $('spScale').addEventListener('change', () => {
      const base = STAGE_BASE[state.meta.stage.shape] || STAGE_BASE.rect;
      const cur = Math.sqrt((state.meta.stage.w * state.meta.stage.h) / (base.w * base.h)) * 100;
      const ratio = (+$('spScale').value || 100) / cur;
      applyStageSize(state.meta.stage.w * ratio, state.meta.stage.h * ratio);
    });
    $('spDelete').addEventListener('click', () => {
      mutate(() => { state.meta.stage.shape = 'none'; });
      hideCanvasPops();
    });
    $('ipW').addEventListener('change', () => {
      const it = state.venueItems.find(x => x.id === editingItemId);
      if (it) applyItemSize(+$('ipW').value || it.w, it.h);
    });
    $('ipH').addEventListener('change', () => {
      const it = state.venueItems.find(x => x.id === editingItemId);
      if (it) applyItemSize(it.w, +$('ipH').value || it.h);
    });
    $('ipScale').addEventListener('change', () => {
      const it = state.venueItems.find(x => x.id === editingItemId);
      if (!it) return;
      const cur = Math.sqrt((it.w * it.h) / 144 / 60) * 100;
      const ratio = (+$('ipScale').value || 100) / cur;
      applyItemSize(it.w * ratio, it.h * ratio);
    });
    $('ipDelete').addEventListener('click', deleteItemEditor);
    document.addEventListener('pointerdown', (e) => {
      const t = e.target;
      if (!t.closest || t.closest('.canvas-pop') || t.id === 'stageCanvas') return;
      hideCanvasPops();
    });
    // 取消/关闭按钮（三个弹窗共用 data-pop-close）
    document.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('[data-pop-close]')) hideCanvasPops();
    });
    // 弹窗标题栏拖动
    document.querySelectorAll('.canvas-pop h4').forEach((h) => {
      h.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const pop = h.closest('.canvas-pop');
        const r = pop.getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top;
        const move = (ev) => {
          pop.style.left = Math.max(8, Math.min(window.innerWidth - 80, ev.clientX - dx)) + 'px';
          pop.style.top = Math.max(8, Math.min(window.innerHeight - 40, ev.clientY - dy)) + 'px';
        };
        const up = () => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      });
    });

    // 约束维度切换
    $('dimGuest').addEventListener('click', () => { cDim = 'guest'; renderConstraints(); });
    $('dimRole').addEventListener('click', () => { cDim = 'role'; renderConstraints(); });
    $('sideChips').addEventListener('click', (e) => {
      const b = e.target.closest('.fchip');
      if (!b) return;
      sideFilter = b.dataset.side;
      [...$('sideChips').children].forEach(c => c.classList.toggle('cur', c === b));
      renderGuestList();
    });

    // 右栏 tabs
    $('tab-constraint').addEventListener('click', () => switchRightTab('constraint'));
    $('tab-report').addEventListener('click', () => switchRightTab('report'));

    // 约束
    $('btnAddC').addEventListener('click', addConstraint);

    // 抽屉：关闭按钮 / 遮罩 / 模板内 data-drawer-close
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerMask').addEventListener('click', closeDrawer);
    $('drawerBody').addEventListener('click', (e) => {
      const t = e.target.closest('[data-drawer-close]');
      if (t) closeDrawer();
    });

    // 画布缩放
    Stage.setZoomHook(() => {
      $('zoomLevel').textContent = Math.round(Stage.getView().scale * 100) + '%';
    });
    $('zoomIn').addEventListener('click', () => Stage.zoomStep(1.25));
    $('zoomOut').addEventListener('click', () => Stage.zoomStep(0.8));
    $('zoomFit').addEventListener('click', () => Stage.resetView());

    // 筛选
    $('guestFilter').addEventListener('input', renderGuestList);

    // 全局指针（列表拖拽）
    document.addEventListener('pointermove', documentPointerMove);
    document.addEventListener('pointerup', documentPointerUp);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (Stage.getPlacing()) { Stage.setPlacing(null); toast('已取消摆放'); }
        else if (isDrawerOpen()) closeDrawer();
        else { hideCanvasPops(); selectGuest(null); }
      }
    });
  }

  function loadDemo(make, label) {
    if (shareMode === 'view') { toast('只读链接不能替换数据'); return; }
    if (!confirm('载入示例' + label + '数据？将覆盖当前内容。')) return;
    state = make();
    lastPlans = []; lastIssues = [];
    $('scenarioSel').value = state.meta.scenario || 'wedding';
    Data.save(state);
    renderAll();
    Stage.fitView();
    toast('示例' + label + '已载入 — 点「✨ 智能排座」体验');
  }

  /* ---------------- 启动 ---------------- */

  function fillRoleSelect(sel) {
    sel.innerHTML = '<option value="">（无）</option>';
    const gWed = document.createElement('optgroup');
    gWed.label = '婚宴';
    const gBq = document.createElement('optgroup');
    gBq.label = '年会';
    for (const k in Data.ROLES) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = Data.ROLES[k].label;
      const sc = Data.ROLES[k].scenario;
      if (sc === 'banquet') gBq.appendChild(o);
      else if (sc === 'wedding') gWed.appendChild(o);
      else sel.appendChild(o);
    }
    if (gWed.children.length) sel.appendChild(gWed);
    if (gBq.children.length) sel.appendChild(gBq);
  }

  async function boot() {
    /* 分享/只读模式：?e=<活动ID>&k=<编辑密钥> */
    const q = new URLSearchParams(location.search);
    const e = q.get('e'), k = q.get('k');
    if (e) {
      shareEventId = e;
      shareEditKey = k || null;
      shareMode = k ? 'edit' : 'view';
      if (shareMode === 'view') document.body.classList.add('readonly');
      try {
        const res = await fetch('/api/events/' + e);
        if (res.ok) {
          const ev = await res.json();
          state = (ev.state && Array.isArray(ev.state.guests)) ? ev.state : Data.blankState();
        } else {
          toast('分享活动不存在，已载入本地数据', true);
          state = Data.load() || Data.demoState();
        }
      } catch (err) {
        toast('分享服务未连接（需 python serve.py），已载入本地数据', true);
        state = Data.load() || Data.demoState();
      }
    } else {
      state = Data.load() || Data.demoState();
    }
    if (!state.meta.scenario) state.meta.scenario = 'wedding';
    Data.migrate(state);
    Data.ensureHeadTable(state);

    $('scenarioSel').value = state.meta.scenario || 'wedding';

    Stage.init($('stageCanvas'), {
      getState: () => state,
      onEdit: canvasEdit,
      onSeatClick: canvasSeatClick,
      onSeatDblClick: canvasSeatDblClick,
      onTableMove: () => mutate(() => { }),
      onVenueMove: () => mutate(() => { }),
      onTableGear: (tid) => openTableEditor(tid),
      onPlace: placeElement,
      onStageClick: () => openStageEditor(),
      onItemClick: (id) => openItemEditor(id),
    });

    bindToolbar();
    switchRightTab('constraint');
    renderAll();
    renderModeChip();
    probeEngine();
    $('zoomLevel').textContent = Math.round(Stage.getView().scale * 100) + '%';

    if (shareMode === 'view') toast('只读查看模式：可浏览与打印，不能修改', true);
    else if (shareMode === 'edit') toast('协作编辑模式：改动会自动同步给其他打开者', true);
    else if (!q.get('e') && !Data.load()) toast('已载入示例婚宴（' + Data.attendingGuests(state).length + ' 位宾客/6 桌）— 直接点「✨ 智能排座」体验', true);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
