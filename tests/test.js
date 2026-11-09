/* ============================================================
 * 排座宝 P0 原型 — Node 单测
 * 运行：node tests/test.js
 * ============================================================ */
'use strict';

const path = require('path');
const root = globalThis;

// 按依赖顺序加载（模块挂到 globalThis）
require(path.join(__dirname, '..', 'js', 'data.js'));
require(path.join(__dirname, '..', 'js', 'parser.js'));
require(path.join(__dirname, '..', 'js', 'nlp.js'));
require(path.join(__dirname, '..', 'js', 'solver.js'));
require(path.join(__dirname, '..', 'js', 'etiquette.js'));
require(path.join(__dirname, '..', 'js', 'route.js'));
require(path.join(__dirname, '..', 'js', 'collision.js'));
require(path.join(__dirname, '..', 'js', 'rules.js'));

const Data = root.PaizuoData;
const Parser = root.PaizuoParser;
const Solver = root.PaizuoSolver;
const Etq = root.PaizuoEtiquette;
const NLP = root.PaizuoNLP;
const R = root.PaizuoRules;
const Route = root.PaizuoRoute;

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

/* ---------------- parser ---------------- */
section('接龙/文本解析');

{
  const r = Parser.parseRoster(
    '#接龙\n' +
    '1. 林大山（新娘大舅）\n' +
    '2. 王建军 +1\n' +
    '3. 陈玉芳一家\n' +
    '张丽华、钱志强\n' +
    '王总（公司总经理）\n'
  );
  ok(r.count === 9, '解析数量 9（1+2+3+2+1 实际=' + r.count + '）', r.guests.map(g => g.name));
  const byName = new Map(r.guests.map(g => [g.name, g]));
  ok(byName.has('林大山'), '基础姓名');
  ok(byName.has('王建军') && byName.has('王建军家属'), '+1 生成随行家属');
  ok(byName.has('陈玉芳') && byName.has('陈玉芳家属1') && byName.has('陈玉芳家属2'), '「一家」生成 2 随行');
  ok(byName.has('张丽华') && byName.has('钱志强'), '顿号分隔');
  ok(byName.get('林大山') && byName.get('林大山').role === 'uncle', '备注识别舅父角色');
  ok(byName.get('王总') && byName.get('王总').role === 'leader', '「王总」识别领导');
}

{
  const r = Parser.parseRoster('张伟爸\n李四妈\n赵六爷爷\n');
  const m = new Map(r.guests.map(g => [g.name, g]));
  ok(m.has('张伟') && !m.has('张伟爸'), '「张伟爸」拆出名字张伟', [...m.keys()]);
  ok(m.get('张伟') && m.get('张伟').note.includes('爸'), '称谓进备注');
  ok(m.get('赵六') && m.get('赵六').role === 'grandparent', '爷爷→祖辈');
}

{
  const r = Parser.parseRoster('hello world 123!!!\n');
  ok(r.count === 0 && r.warnings.length >= 1, '乱码行进警告不进名单', r.warnings);
}

{
  const r = Parser.parseRoster('张三\n张三\n');
  ok(r.count === 1 && r.warnings.some(w => w.includes('重名')), '重名去重');
}

/* ---------------- solver ---------------- */
section('约束求解引擎');

const st = Data.demoState();
ok(st.guests.length === 79, '示例 79 位宾客（实际 ' + st.guests.length + '）', st.guests.length);
ok(st.tables.length === 8 && st.tables[0].isHead, '示例 8 桌且首桌为主桌');
ok(Data.attendingGuests(st).length === 77, '出席 77 人（2 位不出席被过滤）');

{
  const ctx = Solver.buildContext(st);
  ok(ctx.G === 77 && ctx.T === 8, '上下文构建 G/T 正确');
  ok(ctx.mustT.length === 3 && ctx.mustA.length === 2 && ctx.prefT.length >= 2, '约束编译（身份级已展开）：3必同桌/2不能同桌/愿同桌含身份级展开',
     { mustT: ctx.mustT.length, mustA: ctx.mustA.length });
}

console.log('  … 求解中（约数秒）…');
const t0 = Date.now();
const res = Solver.solve(st, { plans: 3 });
const solveMs = Date.now() - t0;
console.log('  求解耗时 ' + solveMs + 'ms');

ok(res.plans.length === 3, '生成 3 套方案', res.plans.length);
ok(res.plans[0].name === '方案A', '方案按优劣排序命名');

{
  const top = res.plans[0];
  ok(top.score.hard === 0, '最优方案硬约束全满足（hard=' + top.score.hard + '）', top.score);
  ok(top.unmet.length === 0, '无未满足项', top.unmet);

  // 座位映射完整性
  const seatedIds = new Set();
  let seatConflict = 0;
  const seenSeat = new Set();
  for (const tid in top.seatOrder) {
    const arr = top.seatOrder[tid];
    for (let s = 0; s < arr.length; s++) {
      const key = tid + '#' + s;
      if (seenSeat.has(key)) seatConflict++;
      seenSeat.add(key);
      seatedIds.add(arr[s]);
    }
  }
  ok(seatConflict === 0, '无座位冲突');
  ok(seatedIds.size === 77, '77 人全部入座（实际 ' + seatedIds.size + '）', seatedIds.size);

  // 容量
  const table = id => Data.tableById(st, id);
  let overCap = 0;
  for (const tid in top.seatOrder) {
    if (top.seatOrder[tid].length > table(tid).capacity) overCap++;
  }
  ok(overCap === 0, '无超员桌');

  // 不能同桌：孙立群 ↔ 黄大炜（副总与总监争权）
  const sun = st.guests.find(g => g.name === '孙立群');
  const huang = st.guests.find(g => g.name === '黄大炜');
  const seatOf = gid => { for (const tid in top.seatOrder) if (top.seatOrder[tid].includes(gid)) return tid; return null; };
  ok(seatOf(sun.id) !== seatOf(huang.id), '硬约束：副总与总监不同桌');

  // 必须同桌：双方父母 + 堂哥嫂
  const gf = st.guests.find(g => g.name === '张国栋');
  const gm = st.guests.find(g => g.name === '王秀兰');
  ok(seatOf(gf.id) === seatOf(gm.id), '硬约束：新郎父母同桌');
  const bd = st.guests.find(g => g.name === '林晓东');
  const bz = st.guests.find(g => g.name === '刘倩');
  ok(seatOf(bd.id) === seatOf(bz.id), '硬约束：堂哥嫂同桌');

  // 礼俗软约束：新郎新娘在主桌
  const headTid = st.tables.find(t => t.isHead).id;
  const xl = st.guests.find(g => g.name === '张伟');
  const xn = st.guests.find(g => g.name === '林晓');
  ok(seatOf(xl.id) === headTid && seatOf(xn.id) === headTid, '新人坐主桌');

  // 桌内座次：主桌 0 号位（上座）应是最高辈分
  const headArr = top.seatOrder[headTid];
  const eff = headArr.map(gid => {
    const g = Data.guestById(st, gid);
    return Data.roleRank(g) + (g.role === 'uncle' ? 5 : 0); // 主桌舅父加权与求解器一致
  });
  const sortedDesc = eff.slice().sort((a, b) => b - a);
  ok(JSON.stringify(eff) === JSON.stringify(sortedDesc), '主桌座次按（加权）辈分降序', eff);
}

{
  // applyPlan → state.plan
  Solver.applyPlan(st, res.plans[0]);
  ok(st.plan && st.plan.name === '方案A', 'applyPlan 写入 state.plan');
  ok(Object.keys(st.plan.seats).length === 77, 'seats 映射 77 人');
  ok(Data.unseated(st).length === 0, 'unseated=0');
}

/* ---------------- etiquette ---------------- */
section('礼俗检查器');

{
  const issues = Etq.check(st);
  ok(Array.isArray(issues), 'check 返回数组');
  const errs = issues.filter(i => i.level === 'error');
  ok(errs.length === 0, '方案A 无严重礼俗问题', errs.map(e => e.title));
  const codes = issues.map(i => i.code);
  console.log('  提示项：' + (codes.join(', ') || '（无）'));
  // 主桌 12 座恰好容纳 12 位高身份宾客 → 不触发双主桌
  ok(!codes.includes('dual-head'), '主桌 12 座容纳全部高身份，无双主桌建议');
}

{
  // 破坏场景：把新郎扔到 6 桌 → check 应报主桌缺人；fix 应修回
  const xl = st.guests.find(g => g.name === '张伟');
  const head = st.tables.find(t => t.isHead);
  st.plan.seats[xl.id] = { t: 't-not-exist', s: 0 };
  // 放到最后一桌
  const last = st.tables[st.tables.length - 1];
  st.plan.seats[xl.id] = { t: last.id, s: 9 };
  const issues = Etq.check(st);
  ok(issues.some(i => i.code === 'head-miss' && i.fixable), '破坏后报「主桌缺新郎」且可修复');
  const n = Etq.fixHeadComposition(st);
  ok(n >= 1, 'fixHeadComposition 修复 ' + n + ' 人');
  const issues2 = Etq.check(st);
  ok(!issues2.some(i => i.code === 'head-miss' && i.detail.includes('张伟')), '修复后主桌有新郎');
}

{
  // 未排座 / 空状态
  const empty = Data.blankState();
  const s0 = Solver.solve(empty, {});
  ok(s0.plans.length === 0 && s0.warn.length === 1, '空状态求解给警告不崩溃', s0.warn);
  const i0 = Etq.check(empty);
  ok(i0.length === 1 && i0[0].code === 'no-plan', '空状态礼俗检查提示先排座');
}

/* ---------------- NLP 自然语言解析 ---------------- */
section('自然语言约束解析');
{
  const st = Data.demoState();
  const guests = Data.attendingGuests(st);
  const r = NLP.parse('二姨和舅舅不能同桌。孙立群和黄大炜不对付。张国栋和王秀兰必须同桌。', guests);
  ok(r.suggestions.length === 3, '三句解析出三条建议（实际 ' + r.suggestions.length + '）', r.suggestions.map(s => s.label));
  const byType = {};
  r.suggestions.forEach(s => { (byType[s.type] = byType[s.type] || []).push(s); });
  ok((byType.mustApart || []).length === 2, '两条不能同桌（不对付→硬约束）');
  ok((byType.mustTogether || []).length === 1, '必须同桌一条');
  const ma = byType.mustApart[0];
  const names = new Set([ma.aGuest.name, ma.bGuest.name]);
  ok(names.has('陈玉芳') && (names.has('林大山')), '「二姨和舅舅」正确解析到宾客', [...names]);
}

{
  const st = Data.demoState();
  const guests = Data.attendingGuests(st);
  // 软硬语义：不带"必须"的同桌 → 软约束
  const r = NLP.parse('袁明希望和陈斌一桌', guests);
  ok(r.suggestions.length === 1 && r.suggestions[0].type === 'preferTogether', '希望同桌→preferTogether', r.suggestions.map(s => s.type + ':' + s.label));
  const r2 = NLP.parse('吴凯和郑洁坐一起', guests);
  ok(r2.suggestions.length === 1 && r2.suggestions[0].type === 'preferTogether', '裸同桌默认软约束');
  const r3 = NLP.parse('吴凯和郑洁必须坐一起', guests);
  ok(r3.suggestions.length === 1 && r3.suggestions[0].type === 'mustTogether', '带必须→硬约束');
}

{
  const st = Data.demoState();
  const guests = Data.attendingGuests(st);
  // 出席变化 + 顿号多方
  const r = NLP.parse('袁明来不了。曹阳、魏莱、白云飞坐一桌', guests);
  ok(r.suggestions.length === 3, '缺席1条 + 多方同桌链2条（实际 ' + r.suggestions.length + '）', r.suggestions.map(s => s.label));
  ok(r.suggestions[0].type === 'absent' && r.suggestions[0].aGuest.name === '袁明', '袁明标记不出席');
  const chain = r.suggestions.slice(1);
  ok(chain.every(s => s.type === 'preferTogether'), '顿号列表→链式软约束');
}

{
  const st = Data.demoState();
  const guests = Data.attendingGuests(st);
  const r = NLP.parse('随便写点啥', guests);
  ok(r.suggestions.length === 0 && r.warnings.length >= 1, '无法识别进警告');
  const r2 = NLP.parse('不存在的人和不存在的那个人不能同桌', guests);
  ok(r2.suggestions.length === 0 && r2.warnings.length >= 1, '人名认不出进警告');
}

/* ---------------- 最小扰动整理 ---------------- */
section('当天模式·最小扰动整理');
{
  const st = Data.demoState();
  const res = Solver.solve(st, { plans: 1 });
  Solver.applyPlan(st, res.plans[0]);
  const before = JSON.stringify(st.plan.seats);
  // 制造一个未安排 + 一个临时到场
  const victim = Data.attendingGuests(st)[10];
  delete st.plan.seats[victim.id];
  const g2 = { id: Data.uid(), name: '临时嘉宾', side: '', role: 'friend', group: '临时', note: '', attending: true };
  st.guests.push(g2);
  const r = Solver.repairOnly(st);
  ok(r.placed + r.moved >= 2, '补位+调整（placed=' + r.placed + ' moved=' + r.moved + '）');
  const seated = Object.keys(st.plan.seats).length;
  ok(seated === 78, '全部 78 人入座（实际 ' + seated + '）', seated);
  // 验证最小扰动：除 victim/g2 外，其余宾客桌次不变
  let changed = 0;
  const beforeMap = JSON.parse(before);
  for (const gid in beforeMap) {
    const a = beforeMap[gid], b = st.plan.seats[gid];
    if (!b || b.t !== a.t) changed++;
  }
  ok(changed <= 2, '其余宾客扰动 ≤2 桌（实际 ' + changed + '）', changed);
}

/* ---------------- 敬酒动线 ---------------- */
section('敬酒动线');
{
  const st = Data.demoState();
  const res = Solver.solve(st, { plans: 1 });
  Solver.applyPlan(st, res.plans[0]);
  const r = Route.generate(st);
  ok(r.stops.length === 8, '8 桌全部成站（实际 ' + r.stops.length + '）');
  ok(r.stops[0].table.isHead, '首站是主桌');
  ok(r.text.split(String.fromCharCode(10)).length === 8, '文本 8 行');
  ok(/（新郎）|（新娘）|（舅父）/.test(r.text), '带称呼建议');
}

/* ---------------- 年会场景 ---------------- */
section('年会场景与礼俗分支');
{
  const st = Data.demoBanquetState();
  ok(st.meta.scenario === 'banquet', '年会示例场景标记');
  ok(Data.attendingGuests(st).length === 63, '年会出席 63 人（实际 ' + Data.attendingGuests(st).length + '）', Data.attendingGuests(st).length);
  ok(st.tables.length === 7, '年会 7 桌');
  const res = Solver.solve(st, { plans: 2 });
  ok(res.plans.length === 2 && res.plans[0].score.hard === 0, '年会求解硬约束满足', res.plans[0].score);
  Solver.applyPlan(st, res.plans[0]);
  const issues = Etq.check(st);
  ok(!issues.some(i => i.code === 'uncle' || i.code === 'mixed'), '年会场景跳过舅父/婆家检查', issues.map(i => i.code));
  ok(Data.roleRank(st.guests.find(g => g.name === '陈天雄')) === 100, '年会角色权重生效');
}

/* ---------------- 多活动管理 ---------------- */
section('多活动管理');
{
  // 伪 localStorage
  const mem = {};
  global.localStorage = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; },
  };
  const stA = Data.demoState();
  const metaA = Data.saveEventAs(Data.newEventId(), '张伟婚宴副本', stA);
  const stB = Data.demoBanquetState();
  Data.saveEventAs(Data.newEventId(), '年会副本', stB);
  const list = Data.listEvents();
  ok(list.length === 2, '两个副本入索引');
  const back = Data.loadEvent(metaA.id);
  ok(back && back.guests.length === stA.guests.length, '副本完整读回',
     { got: back && back.guests.length, want: stA.guests.length });
  Data.deleteEvent(list[0].id);
  ok(Data.listEvents().length === 1, '删除副本');
  delete global.localStorage;
}

/* ---------------- 示例方案合法性（真实场景三重校验） ---------------- */
section('示例方案合法性');
{
  const C = root.PaizuoCollision;
  for (const [label, make] of [['婚宴', Data.demoState], ['年会', Data.demoBanquetState]]) {
    const d = make();
    const att = Data.attendingGuests(d);

    // 1) 场地互不干涉：全部对象（含入口）两两之间留有间隙
    const geoms = [];
    for (const t of d.tables) geoms.push(C.tableGeom(t));
    const sg = C.stageGeom(d.meta.stage);
    if (sg) geoms.push(sg);
    for (const it of d.venueItems) geoms.push(C.itemGeom(it));
    geoms.push(C.doorGeom(root.PaizuoStage ? null : { x: d.meta.door.t * 1371, y: 999 }));
    // 门：按 computeLogicalSpace 同款近似（bottom 中点）
    const maxX = Math.max(...d.tables.map(t => t.x), ...d.venueItems.map(i => i.x));
    const maxY = Math.max(...d.tables.map(t => t.y), ...d.venueItems.map(i => i.y));
    const lw = Math.max(1080, maxX + 143 + 120);
    const lh = Math.max(760, maxY + 143 + 170);
    const doorGeom = { kind: 'circle', x: lw / 2, y: lh - 26, r: C.DOOR_HALF };
    geoms[geoms.length - 1] = doorGeom;
    let hitPairs = 0;
    for (let i = 0; i < geoms.length; i++) {
      for (let j = i + 1; j < geoms.length; j++) {
        if (C.hits(geoms[i], geoms[j])) { hitPairs++; console.log('    干涉: #' + i + ' × #' + j); }
      }
    }
    ok(hitPairs === 0, label + '场地 ' + geoms.length + ' 个对象互不干涉（干涉对 ' + hitPairs + '）');

    // 2) 容量可行
    const capTotal = d.tables.reduce((a, t) => a + t.capacity, 0);
    ok(att.length <= capTotal, label + '出席 ' + att.length + ' ≤ 座位 ' + capTotal);
    ok(d.tables.every(t => t.capacity >= 4 && t.capacity <= 20), label + '每桌容量 4~20');

    // 3) 预置约束无硬互斥（逐条 vs 之前的全部）
    let hardCnt = 0;
    for (let i = 0; i < d.constraints.length; i++) {
      const res = R.checkConflict(d.constraints[i], d.constraints.slice(0, i), d);
      hardCnt += res.hard.length;
    }
    ok(hardCnt === 0, label + '预置 ' + d.constraints.length + ' 条约束无硬互斥');

    // 4) 必须同桌连通块 ≤ 最大桌容量（块调度可行性）
    const parent = new Map(att.map(g => [g.id, g.id]));
    const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const c of d.constraints) {
      if ((c.scope || 'guest') !== 'guest' || c.type !== 'mustTogether') continue;
      const ra = find(c.a), rb = find(c.b);
      if (ra !== rb) parent.set(ra, rb);
    }
    const blockSize = {};
    for (const g of att) {
      const r2 = find(g.id);
      blockSize[r2] = (blockSize[r2] || 0) + 1;
    }
    const maxBlock = Math.max(...Object.values(blockSize));
    const maxCap = Math.max(...d.tables.map(t => t.capacity));
    ok(maxBlock <= maxCap, label + '必须同桌最大块 ' + maxBlock + ' ≤ 最大桌容量 ' + maxCap);
  }
}

/* ---------------- 汇总 ---------------- */
console.log('\n========================================');
console.log('通过 ' + passed + ' / 失败 ' + failed);
process.exit(failed ? 1 : 0);
