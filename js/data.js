/* ============================================================
 * 排座宝 P0 原型 — 数据模型 / 持久化 / 示例数据
 * 无依赖、可迁移（浏览器 window.PaizuoData / Node module.exports）
 * ============================================================ */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'paizuo_state_v1';
  const EVENTS_KEY = 'paizuo_events_index';

  /* 角色表：rank 用于座次排序与长辈梯度；headMust=礼俗上应坐主桌；headSeat=主桌上位优先
   * 婚宴角色与年会角色合并注册（同表共存，保证旧数据永远可解析） */
  const ROLES = {
    groom:       { label: '新郎',     rank: 100, headMust: true, scenario: 'wedding' },
    bride:       { label: '新娘',     rank: 100, headMust: true, scenario: 'wedding' },
    groomFather: { label: '新郎父亲', rank: 95,  headMust: true, scenario: 'wedding' },
    groomMother: { label: '新郎母亲', rank: 95,  headMust: true, scenario: 'wedding' },
    brideFather: { label: '新娘父亲', rank: 95,  headMust: true, scenario: 'wedding' },
    brideMother: { label: '新娘母亲', rank: 95,  headMust: true, scenario: 'wedding' },
    grandparent: { label: '祖辈',     rank: 96, scenario: 'wedding' },
    witness:     { label: '证婚人',   rank: 92,  headMust: true, scenario: 'wedding' },
    uncle:       { label: '舅父',     rank: 88,  headSeat: true, scenario: 'wedding' },
    elder:       { label: '长辈',     rank: 72, scenario: 'wedding' },
    leader:      { label: '领导',     rank: 65, scenario: 'wedding' },
    relative:    { label: '亲属',     rank: 40, scenario: 'wedding' },
    classmate:   { label: '同学',     rank: 28, scenario: 'wedding' },

    boss:        { label: '董事长',   rank: 100, headMust: true, scenario: 'banquet' },
    seniorExec:  { label: '总裁/副总裁', rank: 92, headMust: true, scenario: 'banquet' },
    vipGuest:    { label: '特邀嘉宾', rank: 88, scenario: 'banquet' },
    exec:        { label: '总监',     rank: 82, scenario: 'banquet' },
    manager:     { label: '经理',     rank: 70, scenario: 'banquet' },
    supervisor:  { label: '主管',     rank: 55, scenario: 'banquet' },
    staff:       { label: '员工',     rank: 30, scenario: 'banquet' },
    plusOne:     { label: '家属',     rank: 15, scenario: 'banquet' },

    colleague:   { label: '同事',     rank: 30 },
    friend:      { label: '朋友',     rank: 26 },
    other:       { label: '其他',     rank: 20 },
  };

  /* 场景：决定礼俗检查分支与新建活动的默认角色 */
  const SCENARIOS = {
    wedding: {
      label: '婚宴',
      checks: { head: true, uncle: true, mixed: true, gradient: true, dualHead: true, leader: true },
      defaultRoles: ['groom', 'bride', 'groomFather', 'groomMother', 'brideFather', 'brideMother',
                     'grandparent', 'witness', 'uncle', 'elder', 'leader', 'relative', 'colleague', 'classmate', 'friend', 'other'],
    },
    banquet: {
      label: '年会',
      checks: { head: true, uncle: false, mixed: false, gradient: true, dualHead: true, leader: true },
      defaultRoles: ['boss', 'seniorExec', 'vipGuest', 'exec', 'manager', 'supervisor', 'staff', 'plusOne', 'colleague', 'other'],
    },
  };

  const SIDES = { groom: '新郎方', bride: '新娘方' };

  /* 场地元素（布局 Tab 可添加的非桌元素） */
  const VENUE_KINDS = {
    wall:   { label: '墙面',   icon: '🧱' },
    wc:     { label: '卫生间', icon: '🚻' },
    sign:   { label: '签到台', icon: '📝' },
    buffet: { label: '餐台',   icon: '🍽' },
    rest:   { label: '休息区', icon: '🛋' },
  };

  const CONSTRAINT_TYPES = {
    mustTogether:   { label: '必须同桌', color: '#c0392b' },
    mustApart:      { label: '不能同桌', color: '#8e44ad' },
    preferTogether: { label: '希望同桌', color: '#2980b9' },
    preferApart:    { label: '最好分开', color: '#7f8c8d' },
  };

  function uid(prefix) {
    return (prefix || 'g') + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  function blankState() {
    return {
      meta: {
        eventName: '我的婚宴', date: '', unlocked: false, scenario: 'wedding',
        door: { side: 'bottom', t: 0.5 },               // 入口：边 + 沿边位置比例
        stage: { shape: 'none', x: 540, y: 70 },        // 舞台：形状 + 中心坐标
      },
      guests: [],      // {id, name, side, role, group, dietary, note, attending}
      tables: [],      // {id, name, capacity, isHead, x, y}
      venueItems: [],  // {id, kind, x, y} 场地元素（卫生间/签到台等）
      constraints: [], // {id, type, a, b}
      plan: null,      // {name, seats: {guestId: {t: tableId, s: seatIdx}}}
    };
  }

  /** 旧数据迁移：补 door/stage/venueItems 字段（app boot 时调用） */
  function migrate(state) {
    if (!state.meta) state.meta = {};
    if (!state.meta.door || !state.meta.door.side) state.meta.door = { side: 'bottom', t: 0.5 };
    if (!state.meta.stage || !('shape' in state.meta.stage)) state.meta.stage = { shape: 'none', x: 540, y: 70 };
    if (!Array.isArray(state.venueItems)) state.venueItems = [];
    // 元素/舞台统一携带 w/h（旧数据补默认尺寸）
    const IDEF = { wall: [220, 36], wc: [144, 60], sign: [144, 60], buffet: [144, 60], rest: [144, 60] };
    for (const it of state.venueItems) {
      const d = IDEF[it.kind] || IDEF.wc;
      if (!it.w) it.w = d[0];
      if (!it.h) it.h = d[1];
    }
    const SDEF = { rect: [300, 70], tshape: [300, 192], round: [190, 190] };
    if (!state.meta.stage || !('shape' in state.meta.stage)) {
      state.meta.stage = { shape: 'none', x: 540, y: 70, w: 300, h: 70 };
    }
    const sd = SDEF[state.meta.stage.shape] || SDEF.rect;
    if (!state.meta.stage.w) state.meta.stage.w = sd[0];
    if (!state.meta.stage.h) state.meta.stage.h = sd[1];
    return state;
  }

  /* ---------------- 存取 ---------------- */

  function save(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* file:// 隐私模式等 */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !Array.isArray(s.guests)) return null;
      return s;
    } catch (e) { return null; }
  }

  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { }
  }

  /* ---------------- 多活动管理 ---------------- */

  function listEvents() {
    try {
      const raw = localStorage.getItem(EVENTS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function saveIndex(list) {
    try { localStorage.setItem(EVENTS_KEY, JSON.stringify(list)); } catch (e) { }
  }

  function saveEventAs(id, name, state) {
    const list = listEvents();
    const meta = { id, name, scenario: state.meta.scenario || 'wedding',
                   guests: attendingGuests(state).length,
                   tables: state.tables.length, savedAt: Date.now() };
    const i = list.findIndex(e => e.id === id);
    if (i >= 0) { meta.savedAt = list[i].savedAt; list[i] = meta; } else list.unshift(meta);
    saveIndex(list);
    try { localStorage.setItem('paizuo_event_' + id, JSON.stringify(state)); } catch (e) { }
    return meta;
  }

  function loadEvent(id) {
    try {
      const raw = localStorage.getItem('paizuo_event_' + id);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return s && Array.isArray(s.guests) ? s : null;
    } catch (e) { return null; }
  }

  function deleteEvent(id) {
    saveIndex(listEvents().filter(e => e.id !== id));
    try { localStorage.removeItem('paizuo_event_' + id); } catch (e) { }
  }

  function newEventId() { return uid('ev'); }

  /* ---------------- 查询工具 ---------------- */

  function guestById(state, id) { return state.guests.find(g => g.id === id) || null; }
  function tableById(state, id) { return state.tables.find(t => t.id === id) || null; }

  function attendingGuests(state) {
    return state.guests.filter(g => g.attending !== false);
  }

  function totalCapacity(state) {
    return state.tables.reduce((s, t) => s + (t.capacity | 0), 0);
  }

  function unseated(state) {
    const seats = state.plan && state.plan.seats || {};
    return attendingGuests(state).filter(g => !seats[g.id]);
  }

  function guestsAtTable(state, tableId) {
    if (!state.plan) return [];
    const out = [];
    const seats = state.plan.seats;
    for (const gid in seats) {
      if (seats[gid].t === tableId) {
        const g = guestById(state, gid);
        if (g) out.push({ guest: g, s: seats[gid].s });
      }
    }
    out.sort((a, b) => a.s - b.s);
    return out;
  }

  function roleRank(guest) {
    const r = guest && ROLES[guest.role];
    return r ? r.rank : 20;
  }

  /* ---------------- 桌次工具 ---------------- */

  function addTable(state, opts) {
    opts = opts || {};
    const n = state.tables.length + 1;
    const hasHead = state.tables.some(t => t.isHead);
    const t = {
      id: uid('t'),
      name: opts.name || (hasHead ? (n + '桌') : (n === 1 ? '主桌' : n + '桌')),
      capacity: opts.capacity || 10,
      isHead: !!opts.isHead,
      x: undefined, y: undefined, // 由 stage 布局
    };
    state.tables.push(t);
    return t;
  }

  function ensureHeadTable(state) {
    if (!state.tables.some(t => t.isHead) && state.tables.length > 0) {
      state.tables[0].isHead = true;
      state.tables[0].name = '主桌';
    }
  }

  function setHeadTable(state, tableId) {
    for (const t of state.tables) {
      t.isHead = (t.id === tableId);
      if (t.isHead && !/主/.test(t.name)) t.name = '主桌';
    }
  }

  /* ---------------- 示例数据 ---------------- */
  /* 两个示例均为"真实场景还原"：
   *  - 场地：入口/舞台/签到台/餐台/卫生间/立柱（墙面）齐备，桌位按真实宴会厅动线摆放
   *  - 人情：冤家分桌、夫妻同桌、领导带家属、饮食禁忌、儿童、请假
   *  - tests/test.js 会对示例做场地干涉 / 约束互斥 / 容量可行性三重校验
   */

  function demoState() {
    const st = blankState();
    st.meta.eventName = '张伟 ❤ 林晓 婚宴';
    st.meta.date = '2026-11-28';
    st.meta.door = { side: 'bottom', t: 0.5 };
    st.meta.stage = { shape: 'tshape', x: 540, y: 110, w: 300, h: 192 };

    const mk = (name, opts) => {
      opts = opts || {};
      const g = {
        id: uid(), name,
        side: opts.side || '', role: opts.role || '', group: opts.group || '',
        dietary: opts.dietary || '', note: opts.note || '',
        attending: opts.attending !== false,
      };
      st.guests.push(g);
      return g;
    };
    const mkTable = (name, cap, x, y, isHead) => {
      const t = addTable(st, { name, capacity: cap, isHead: !!isHead });
      t.x = x; t.y = y;
      return t;
    };

    /* ---- 场地（真实宴会厅：T 台在前，入口在后，动线留白；障碍物由用户自行拖入） ---- */
    st.meta.stage = { shape: 'tshape', x: 540, y: 110, w: 300, h: 192 };
    st.venueItems.push(
      { id: uid('v'), kind: 'sign', x: 110, y: 1520, w: 150, h: 60 },   // 签到台（门侧左下）
      { id: uid('v'), kind: 'buffet', x: 970, y: 1520, w: 170, h: 64 }, // 餐台/酒水（右下角）
      { id: uid('v'), kind: 'wc', x: 1010, y: 430, w: 140, h: 60 },     // 卫生间
      { id: uid('v'), kind: 'rest', x: 130, y: 430, w: 150, h: 64 },    // 新娘休息室
    );

    /* ---- 桌次（主桌居前，男左女右，晚辈靠后近门） ---- */
    mkTable('主桌', 12, 540, 358, true);
    mkTable('2桌', 10, 230, 660);
    mkTable('3桌', 10, 850, 660);
    mkTable('4桌', 10, 230, 980);
    mkTable('5桌', 10, 850, 980);
    mkTable('6桌', 10, 540, 980);
    mkTable('7桌', 10, 540, 1300);
    mkTable('8桌', 10, 230, 1300);

    /* ---- 主桌：新人 + 双方父母 + 四位祖辈 + 证婚人 + 大舅（12） ---- */
    mk('张伟',   { side: 'groom', role: 'groom', group: '主家' });
    mk('林晓',   { side: 'bride', role: 'bride', group: '主家' });
    mk('张国栋', { side: 'groom', role: 'groomFather', group: '主家' });
    mk('王秀兰', { side: 'groom', role: 'groomMother', group: '主家' });
    mk('林建国', { side: 'bride', role: 'brideFather', group: '主家' });
    mk('陈玉梅', { side: 'bride', role: 'brideMother', group: '主家' });
    mk('张老爷子', { side: 'groom', role: 'grandparent', note: '爷爷，耳背，宜坐安静侧' });
    mk('王桂香', { side: 'groom', role: 'grandparent', note: '奶奶' });
    mk('林福生', { side: 'bride', role: 'grandparent', note: '外公' });
    mk('林奶奶', { side: 'bride', role: 'grandparent', dietary: '软烂饮食', note: '外婆，82 岁' });
    mk('刘明远', { side: 'groom', role: 'witness', group: '领导贵宾', note: '证婚人，张伟大学院长' });
    mk('林大山', { side: 'bride', role: 'uncle', group: '二姨一家' });

    /* ---- 2桌：男方长辈（10） ---- */
    mk('张伯山', { side: 'groom', role: 'elder', group: '大伯一家', note: '新郎大伯' });
    mk('钱淑芬', { side: 'groom', role: 'relative', group: '大伯一家', note: '大伯母' });
    mk('张丽华', { side: 'groom', role: 'elder', dietary: '素食', note: '姑姑，吃素三十年' });
    mk('张国泰', { side: 'groom', role: 'elder', note: '叔叔' });
    mk('何秀珍', { side: 'groom', role: 'relative', note: '婶婶' });
    mk('张伟豪', { side: 'groom', role: 'relative', group: '堂哥一家', note: '堂哥' });
    mk('高媛',   { side: 'groom', role: 'relative', group: '堂哥一家', note: '堂嫂' });
    mk('张守业', { side: 'groom', role: 'elder', note: '舅公' });
    mk('马春花', { side: 'groom', role: 'relative', note: '舅婆' });
    mk('张一诺', { side: 'groom', role: 'relative', dietary: '儿童餐', note: '侄子，6 岁' });

    /* ---- 3桌：女方长辈（10） ---- */
    mk('陈玉芳', { side: 'bride', role: 'elder', group: '二姨一家', note: '新娘二姨' });
    mk('周德旺', { side: 'bride', role: 'relative', group: '二姨一家', note: '二姨夫' });
    mk('林二山', { side: 'bride', role: 'elder', note: '二舅' });
    mk('吴秀芳', { side: 'bride', role: 'relative', note: '二舅妈' });
    mk('林桂花', { side: 'bride', role: 'elder', note: '姑妈' });
    mk('郑国栋', { side: 'bride', role: 'relative', note: '姑父' });
    mk('陈玉芬', { side: 'bride', role: 'elder', note: '三姨' });
    mk('何德发', { side: 'bride', role: 'relative', note: '三姨夫' });
    mk('林晓东', { side: 'bride', role: 'relative', group: '堂哥一家', note: '新娘堂哥' });
    mk('刘倩',   { side: 'bride', role: 'relative', group: '堂哥一家', note: '堂嫂，带娃来的' });

    /* ---- 4桌：新郎同事（10，领导带家属） ---- */
    mk('王建军', { side: 'groom', role: 'leader', group: '新郎同事', note: '张伟公司总经理' });
    mk('赵美凤', { side: 'groom', role: 'relative', group: '新郎同事', note: '王总夫人' });
    mk('孙立群', { side: 'groom', role: 'leader', group: '新郎同事', note: '副总' });
    mk('黄大炜', { side: 'groom', role: 'leader', group: '新郎同事', note: '销售总监' });
    mk('吴凯',   { side: 'groom', role: 'colleague', group: '新郎同事' });
    mk('郑洁',   { side: 'groom', role: 'colleague', group: '新郎同事' });
    mk('冯超',   { side: 'groom', role: 'colleague', group: '新郎同事' });
    mk('钱多多', { side: 'groom', role: 'colleague', group: '新郎同事', dietary: '清真', note: '回族，牛肉单做' });
    mk('李慕白', { side: 'groom', role: 'colleague', group: '新郎同事', note: '技术合伙人' });
    mk('许诺',   { side: 'groom', role: 'colleague', group: '新郎同事', attending: false, note: '出差迪拜，随礼了' });

    /* ---- 5桌：新娘同事 + 新郎好友（10） ---- */
    mk('韩雪',   { side: 'bride', role: 'colleague', group: '新娘同事', note: '新娘组长' });
    mk('方远',   { side: 'bride', role: 'colleague', group: '新娘同事' });
    mk('金玲',   { side: 'bride', role: 'colleague', group: '新娘同事' });
    mk('江晓芸', { side: 'bride', role: 'colleague', group: '新娘同事' });
    mk('夏之光', { side: 'bride', role: 'colleague', group: '新娘同事' });
    mk('庄小蔓', { side: 'bride', role: 'colleague', group: '新娘同事', dietary: '不吃辣' });
    mk('高一鸣', { side: 'groom', role: 'friend', note: '伴郎' });
    mk('袁明',   { side: 'groom', role: 'friend', group: '大学同学', note: '从深圳飞过来' });
    mk('任重',   { side: 'groom', role: 'friend' });
    mk('黎明朗', { side: 'groom', role: 'friend' });

    /* ---- 6桌：大学同学（10，混编） ---- */
    mk('陈斌',   { side: 'groom', role: 'classmate', group: '大学同学' });
    mk('何雨欣', { side: 'groom', role: 'classmate', group: '大学同学' });
    mk('罗成',   { side: 'groom', role: 'classmate', group: '大学同学' });
    mk('宋佳',   { side: 'groom', role: 'classmate', group: '大学同学' });
    mk('唐磊',   { side: 'groom', role: 'classmate', group: '大学同学' });
    mk('孙艺',   { side: 'bride', role: 'classmate', group: '大学同学' });
    mk('尹志平', { side: 'bride', role: 'classmate', group: '大学同学' });
    mk('孟真真', { side: 'bride', role: 'classmate', group: '大学同学' });
    mk('萧然',   { side: 'bride', role: 'classmate', group: '大学同学' });
    mk('路遥',   { side: 'bride', role: 'classmate', group: '大学同学' });

    /* ---- 7桌：新娘闺蜜团（8，留空位） ---- */
    mk('曹阳',   { side: 'bride', role: 'friend', group: '闺蜜团' });
    mk('魏莱',   { side: 'bride', role: 'friend', group: '闺蜜团' });
    mk('白云飞', { side: 'bride', role: 'friend', group: '闺蜜团' });
    mk('苏晴',   { side: 'bride', role: 'friend', group: '闺蜜团' });
    mk('叶芷',   { side: 'bride', role: 'friend', group: '闺蜜团', note: '伴娘' });
    mk('田恬',   { side: 'bride', role: 'friend', group: '闺蜜团' });
    mk('乔安',   { side: 'bride', role: 'friend', group: '闺蜜团' });
    mk('白露',   { side: 'bride', role: 'friend', group: '闺蜜团' });

    /* ---- 8桌：双方年轻亲属+孩子（8，留空位给临时到场） ---- */
    mk('张小虎', { side: 'groom', role: 'relative', note: '堂弟，大学生' });
    mk('张志远', { side: 'groom', role: 'relative', note: '表哥' });
    mk('孙美琪', { side: 'groom', role: 'relative', note: '表嫂' });
    mk('周小磊', { side: 'bride', role: 'relative', group: '二姨一家', note: '表弟，大学生' });
    mk('林巧巧', { side: 'bride', role: 'relative', note: '表妹，高中生' });
    mk('陈朵朵', { side: 'bride', role: 'relative', dietary: '儿童餐', note: '外甥女，5 岁' });
    mk('林晓峰', { side: 'bride', role: 'relative', note: '堂弟' });
    mk('徐璐',   { side: 'bride', role: 'relative', note: '堂弟妹' });

    /* ---- 马长贵（姑父）临时住院 ---- */
    mk('马长贵', { side: 'groom', role: 'relative', attending: false, note: '刚做完手术，姑姑代为随礼' });

    /* ---- 人情约束（真实矛盾 + 真实亲近） ---- */
    const gid = n => st.guests.find(g => g.name === n).id;
    st.constraints.push(
      { id: uid('c'), scope: 'guest', type: 'mustApart',      a: gid('陈玉芳'), b: gid('林二山') },   // 二姨二舅拆迁款闹掰
      { id: uid('c'), scope: 'guest', type: 'mustApart',      a: gid('孙立群'), b: gid('黄大炜') },   // 副总与总监争权
      { id: uid('c'), scope: 'guest', type: 'mustTogether',   a: gid('张国栋'), b: gid('王秀兰') },
      { id: uid('c'), scope: 'guest', type: 'mustTogether',   a: gid('林建国'), b: gid('陈玉梅') },
      { id: uid('c'), scope: 'guest', type: 'mustTogether',   a: gid('林晓东'), b: gid('刘倩') },     // 堂哥嫂必须同偕
      { id: uid('c'), scope: 'guest', type: 'preferTogether', a: gid('周小磊'), b: gid('林巧巧') },   // 表兄妹同龄
      { id: uid('c'), scope: 'role',  type: 'preferTogether', a: 'classmate', b: 'classmate' },       // 身份级：同学尽量同桌
    );
    return st;
  }

  function demoBanquetState() {
    const st = blankState();
    st.meta.eventName = '星辰科技 2027 年会';
    st.meta.date = '2027-01-15';
    st.meta.scenario = 'banquet';
    st.meta.door = { side: 'bottom', t: 0.5 };
    st.meta.stage = { shape: 'rect', x: 540, y: 90 };

    const mk = (name, opts) => {
      opts = opts || {};
      const g = {
        id: uid(), name,
        side: '', role: opts.role || '', group: opts.group || '',
        dietary: opts.dietary || '', note: opts.note || '',
        attending: opts.attending !== false,
      };
      st.guests.push(g);
      return g;
    };
    const mkTable = (name, cap, x, y, isHead) => {
      const t = addTable(st, { name, capacity: cap, isHead: !!isHead });
      t.x = x; t.y = y;
      return t;
    };

    /* ---- 场地：大舞台 + 茶歇餐台 + 签到 + 化妆间（障碍物由用户自行拖入） ---- */
    st.meta.stage = { shape: 'rect', x: 540, y: 95, w: 360, h: 84 };
    st.venueItems.push(
      { id: uid('v'), kind: 'sign', x: 110, y: 1260, w: 150, h: 60 },  // 签到台（门侧左下）
      { id: uid('v'), kind: 'buffet', x: 975, y: 1260, w: 180, h: 64 }, // 茶歇餐台（右下）
      { id: uid('v'), kind: 'wc', x: 1015, y: 430, w: 140, h: 60 },
      { id: uid('v'), kind: 'rest', x: 120, y: 330, w: 150, h: 64 },   // 演员化妆间
    );

    /* ---- 桌次：高管桌居前，部门分片，家属嘉宾靠侧 ---- */
    mkTable('主桌', 10, 540, 330, true);
    mkTable('研发一', 10, 250, 660);
    mkTable('研发二', 10, 590, 660);
    mkTable('市场部', 10, 930, 660);
    mkTable('销售部', 10, 250, 990);
    mkTable('职能',   10, 590, 990);
    mkTable('嘉宾席', 10, 930, 990);

    /* ---- 主桌：董事会+总裁办+特邀（9） ---- */
    mk('陈天雄', { role: 'boss', group: '高管', note: '董事长' });
    mk('刘振华', { role: 'seniorExec', group: '高管', note: '总裁' });
    mk('吴天南', { role: 'seniorExec', group: '高管', note: '副总裁' });
    mk('郑海峰', { role: 'seniorExec', group: '高管', note: '副总裁' });
    mk('钱多福', { role: 'exec', group: '高管', note: '财务总监' });
    mk('赵国庆', { role: 'exec', group: '高管', note: '研发总监' });
    mk('沈书瑶', { role: 'supervisor', group: '高管', note: '董事长秘书' });
    mk('王守义', { role: 'vipGuest', group: '嘉宾', note: 'B 轮投资人' });
    mk('袁圆',   { role: 'vipGuest', group: '嘉宾', note: '合作方 CEO' });

    /* ---- 研发一（10，经理带队） ---- */
    mk('吴小梅', { role: 'manager', group: '研发一组', note: '研发经理' });
    mk('罗凯',   { role: 'staff', group: '研发一组', note: '后端组长' });
    mk('叶青',   { role: 'plusOne', group: '家属', note: '罗凯爱人' });
    mk('梁山',   { role: 'staff', group: '研发一组', dietary: '清真', note: '算法，牛肉专桌备注' });
    mk('宋雨',   { role: 'staff', group: '研发一组' });
    mk('唐月',   { role: 'staff', group: '研发一组' });
    mk('陈默',   { role: 'staff', group: '研发一组', note: '刚拿专利奖' });
    mk('高翔',   { role: 'staff', group: '研发一组' });
    mk('林潇',   { role: 'staff', group: '研发一组' });
    mk('周子航', { role: 'staff', group: '研发一组' });

    /* ---- 研发二（8 出席，2 请假） ---- */
    mk('韩磊',   { role: 'supervisor', group: '研发二组', note: '前端组长' });
    mk('蒋文明', { role: 'staff', group: '研发二组' });
    mk('谢小凡', { role: 'staff', group: '研发二组', attending: false, note: '重感冒请假' });
    mk('冯亮',   { role: 'staff', group: '研发二组' });
    mk('许薇',   { role: 'staff', group: '研发二组' });
    mk('沈从',   { role: 'staff', group: '研发二组' });
    mk('阮清',   { role: 'staff', group: '研发二组' });
    mk('顾北',   { role: 'staff', group: '研发二组' });
    mk('温言',   { role: 'staff', group: '研发二组' });
    mk('丁满',   { role: 'staff', group: '研发二组', attending: false, note: '驻场出差' });

    /* ---- 市场部（10，总监带队） ---- */
    mk('孙丽萍', { role: 'exec', group: '市场部', note: '市场总监' });
    mk('周鸣',   { role: 'manager', group: '市场部', note: '品牌经理' });
    mk('姜涛',   { role: 'staff', group: '市场部' });
    mk('刘芸',   { role: 'plusOne', group: '市场部', note: '姜涛爱人' });
    mk('许静',   { role: 'staff', group: '市场部' });
    mk('何军',   { role: 'staff', group: '市场部' });
    mk('施悦',   { role: 'staff', group: '市场部' });
    mk('黄莺',   { role: 'staff', group: '市场部', note: '新媒体' });
    mk('蓝波',   { role: 'staff', group: '市场部', note: '实习生' });
    mk('夏小雨', { role: 'staff', group: '市场部', note: '实习生' });

    /* ---- 销售部（10） ---- */
    mk('郑大志', { role: 'manager', group: '销售部', note: '销售经理' });
    mk('马腾',   { role: 'staff', group: '销售部', note: '年度销冠' });
    mk('赵四海', { role: 'staff', group: '销售部' });
    mk('秦风',   { role: 'staff', group: '销售部' });
    mk('楚天阔', { role: 'staff', group: '销售部' });
    mk('魏建国', { role: 'staff', group: '销售部' });
    mk('朱磊',   { role: 'staff', group: '销售部' });
    mk('胡斌',   { role: 'staff', group: '销售部' });
    mk('石开',   { role: 'staff', group: '销售部' });
    mk('于娜',   { role: 'staff', group: '销售部', dietary: '素食' });

    /* ---- 职能（8，财务+人事+行政+IT） ---- */
    mk('方圆',   { role: 'manager', group: '职能', note: '财务经理' });
    mk('王甜甜', { role: 'staff', group: '职能', dietary: '素食', note: '出纳' });
    mk('冯春花', { role: 'manager', group: '职能', note: '人事经理' });
    mk('曹阳',   { role: 'staff', group: '职能' });
    mk('魏东',   { role: 'staff', group: '职能' });
    mk('苏芮',   { role: 'staff', group: '职能', note: '行政' });
    mk('白露',   { role: 'staff', group: '职能', note: '前台' });
    mk('常磊',   { role: 'staff', group: '职能', note: 'IT 运维' });

    /* ---- 嘉宾席（9，家属+随行+主持+后勤） ---- */
    mk('高丹丹', { role: 'plusOne', group: '家属', note: '梁山爱人' });
    mk('温可',   { role: 'plusOne', group: '家属', note: '宋雨对象' });
    mk('葛长贵', { role: 'other', group: '后勤', note: '董事长司机' });
    mk('林小曼', { role: 'other', group: '后勤', note: '行政文秘' });
    mk('郭涛',   { role: 'vipGuest', group: '嘉宾', note: '合作方随行' });
    mk('孙娜',   { role: 'vipGuest', group: '嘉宾', note: '礼仪公司' });
    mk('李菲',   { role: 'vipGuest', group: '嘉宾', dietary: '不吃辣', note: '年会主持人' });
    mk('杜文韬', { role: 'vipGuest', group: '嘉宾', attending: false, note: '临时取消，改视频致辞' });
    mk('文奇',   { role: 'staff', group: '后勤', note: '音响灯光' });

    /* ---- 约束（职场人情） ---- */
    const gid = n => st.guests.find(g => g.name === n).id;
    st.constraints.push(
      { id: uid('c'), scope: 'guest', type: 'mustTogether',   a: gid('陈天雄'), b: gid('刘振华') },   // 董事长总裁同席
      { id: uid('c'), scope: 'guest', type: 'mustApart',      a: gid('孙丽萍'), b: gid('郑大志') },   // 市场销售抢预算
      { id: uid('c'), scope: 'guest', type: 'preferTogether', a: gid('罗凯'),   b: gid('叶青') },     // 夫妻想同坐（跨部门）
      { id: uid('c'), scope: 'role',  type: 'preferApart',    a: 'manager',     b: 'manager' },       // 身份级：经理们分散带桌
      { id: uid('c'), scope: 'role',  type: 'preferApart',    a: 'plusOne',     b: 'staff' },         // 身份级：家属不与员工混坐
    );
    return st;
  }
  const api = {
    STORAGE_KEY, EVENTS_KEY, ROLES, SCENARIOS, SIDES, VENUE_KINDS, CONSTRAINT_TYPES,
    uid, blankState, migrate, save, load, clear,
    listEvents, saveEventAs, loadEvent, deleteEvent, newEventId,
    guestById, tableById, attendingGuests, totalCapacity, unseated,
    guestsAtTable, roleRank,
    addTable, ensureHeadTable, setHeadTable,
    demoState, demoBanquetState,
  };

  root.PaizuoData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
