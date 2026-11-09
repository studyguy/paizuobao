/* ============================================================
 * 排座宝 P1 — 自然语言约束解析（规则引擎 v1）
 * 架构：意图检测（整句）→ 分词拆出候选名 → 清洗尾部修饰 → 提及解析
 * 句式：A和B必须同桌 / A和B不能同桌 / A和B不对付 / A和B最好分开坐 /
 *       A希望和B一桌 / A、B、C坐一桌（顿号列表）/ XX来不了 / A一家坐一桌
 * 语义安全默认：不带"必须"等硬词的同桌 → preferTogether（软约束）
 * 预留 LLM 钩子：/api/nlp 可用时 UI 显示 LLM 标签（本原型为规则引擎）
 * ============================================================ */
(function (root) {
  'use strict';

  const D = root.PaizuoData;

  /* 亲属称谓归一：折叠成双字规范形
   * ① 按词条长度降序整体替换（"二舅妈"先于"二舅"，避免污染成"舅父妈"）
   * ② 只用多字词做源，避免误伤普通名字里的单字（如"新娘"的"娘"） */
  const KIN_WORDS = [
    ['二舅妈', '舅母'], ['大舅妈', '舅母'], ['小舅妈', '舅母'], ['舅妈', '舅母'],
    ['舅舅', '舅父'], ['大舅', '舅父'], ['二舅', '舅父'], ['小舅', '舅父'],
    ['姥爷', '外婆'], ['姥姥', '外婆'],
    ['老爸', '父亲'], ['爸爸', '父亲'],
    ['老妈', '母亲'], ['妈妈', '母亲'],
    ['两口子', '一家'], ['夫妇', '一家'], ['夫妻', '一家'],
  ];

  function normalize(s) {
    let out = String(s || '');
    for (const [w, rep] of KIN_WORDS) out = out.split(w).join(rep);
    return out;
  }

  /* 每位宾客的别名集合（带来源权重：姓名3 > 角色标签2 > 备注提及1）
   * 注意：不把 group 名做别名——"二姨一家"会让"二姨"歧义到组内每个人 */
  function aliasesOf(guest) {
    const out = [];
    const push = (p, w) => {
      p = normalize(p).trim();
      if (p.length >= 2) out.push({ t: p, w });
      // "新娘二姨" 这类长备注 → 尾词 "二姨" 也做别名
      if (p.length >= 3 && /[二三四五六七八大小堂表姑姨叔伯舅]/.test(p.slice(-2))) {
        out.push({ t: p.slice(-2), w });
      }
    };
    push(guest.name, 3);
    const role = D.ROLES[guest.role];
    if (role) push(role.label, 2);
    if (guest.note) for (const seg of String(guest.note).split(/[，,、（()）\s]+/)) push(seg, 1);
    // 去重（保留最高权重）
    const best = new Map();
    for (const a of out) {
      if (!best.has(a.t) || best.get(a.t).w < a.w) best.set(a.t, a);
    }
    return [...best.values()];
  }

  /**
   * 提及解析：最长别名优先；同长多命中 → 歧义
   */
  function resolveMention(mention, guests, used) {
    const m = normalize(mention);
    if (m.length < 2) return { guest: null, ambiguous: [] };
    const scored = [];
    for (const g of guests) {
      if (used && used.has(g.id)) continue;
      for (const a of aliasesOf(g)) {
        if (a.t === m || a.t.includes(m) || (m.includes(a.t) && a.t.length >= 2)) {
          scored.push({ g, len: a.t.length, w: a.w });
          break;
        }
      }
    }
    if (!scored.length) return { guest: null, ambiguous: [] };
    // 先按来源权重（姓名>角色>备注），同权重再按别名长度
    scored.sort((x, y) => y.w - x.w || y.len - x.len);
    const topW = scored[0].w, topL = scored[0].len;
    const top = scored.filter(s => s.w === topW && s.len === topL);
    if (top.length > 1) return { guest: null, ambiguous: top.map(s => s.g.name) };
    return { guest: top[0].g, ambiguous: [] };
  }

  /* ---------------- 意图与清洗 ---------------- */

  const KW = {
    hardT: /(必须|一定要|千万|务必|记得|要给我)/,
    softT: /(希望|最好|尽量|可以|方便)/,
    neg: /(不能|不要|别|禁止|无法|不准)/,
    conflict: /(不对付|有矛盾|闹掰|死对头|合不来|有仇)/,
    together: /(一起|同桌|一桌|同一桌|坐一块)/,
    apart: /(分开坐|分桌|分开|不同桌)/,
  };

  const ABSENT_RE = /(来不了|不能来|缺席|出不了席|去不了|无法出席|不来了|没空来|有事|出差)/;

  /* 从片段里清掉修饰词，留下人名 */
  const STRIP = [
    '千万', '务必', '一定要', '必须', '希望', '最好', '尽量', '可以', '方便',
    '不能', '不要', '别', '禁止', '无法', '不准', '记得',
    '不对付', '有矛盾', '闹掰', '死对头', '合不来', '有仇',
    '一起', '同一桌', '同桌', '一桌', '坐一块', '分开坐', '分桌', '分开', '不同桌',
    '安排', '坐在', '坐', '在', '请', '让', '把', '给',
  ].sort((a, b) => b.length - a.length);

  function cleanSeg(seg) {
    let s = normalize(seg).trim();
    let changed = true;
    while (changed) {
      changed = false;
      for (const k of STRIP) {
        if (s.includes(k)) { s = s.split(k).join(''); changed = true; }
      }
    }
    return s.replace(/^[，,、。；;！!？?\s]+|[，,、。；;！!？?\s]+$/g, '');
  }

  function detectIntent(sentence) {
    if (KW.conflict.test(sentence)) return 'mustApart';
    if (KW.neg.test(sentence) && (KW.together.test(sentence) || KW.apart.test(sentence))) return 'mustApart';
    if (KW.apart.test(sentence)) return 'preferApart';
    if (KW.together.test(sentence)) return KW.hardT.test(sentence) ? 'mustTogether' : 'preferTogether';
    return null;
  }

  function splitSentences(text) {
    return String(text || '')
      .split(/[。；;！!？?\n\r]+/)
      .map(s => s.trim().replace(/^(?:请|麻烦|帮忙|记得|注意|还有)[，,]?/, ''))
      .filter(Boolean);
  }

  /**
   * 解析主入口
   * @returns {suggestions: [{type, aGuest, bGuest, label, raw}], warnings: [string]}
   */
  function parse(text, guests) {
    const suggestions = [];
    const warnings = [];

    for (const raw of splitSentences(text)) {
      /* 1) 出席变化 */
      if (ABSENT_RE.test(raw) && !KW.together.test(raw) && !KW.apart.test(raw)) {
        // 取句首到第一个动词修饰前的人名
        const head = raw.split(/(来不了|不能来|缺席|出不了席|去不了|无法出席|不来了|没空来|出差|有事)/)[0];
        const name = cleanSeg(head);
        if (name.length >= 2) {
          const r = resolveMention(name, guests, null);
          if (r.guest) {
            suggestions.push({ type: 'absent', aGuest: r.guest, label: '标记「' + r.guest.name + '」不出席', raw });
            continue;
          }
          if (r.ambiguous.length) {
            warnings.push('「' + raw + '」提及的人有歧义：' + r.ambiguous.join('/'));
            continue;
          }
        }
      }

      /* 2) 一家同桌（分组提示） */
      if (/(一家|全家|两口子|夫妇|夫妻)/.test(raw) && KW.together.test(raw)) {
        const head = cleanSeg(raw.split(/(?:一家|全家|两口子|夫妇|夫妻)/)[0]);
        if (head.length >= 2) {
          const r = resolveMention(head, guests, null);
          if (r.guest && r.guest.group) {
            suggestions.push({ type: 'info', aGuest: r.guest, label: '「' + r.guest.group + '」按分组尽量同桌（引擎已生效）', raw });
            continue;
          }
          if (r.guest) {
            suggestions.push({ type: 'info', aGuest: r.guest, label: '「' + r.guest.name + '」的家人请先在宾客编辑里维护同分组', raw });
            continue;
          }
          if (r.ambiguous.length) {
            warnings.push('「' + raw + '」提及的人有歧义：' + r.ambiguous.join('/'));
            continue;
          }
        }
      }

      /* 3) 两方/多方约束：分词拆名 */
      const intent = detectIntent(raw);
      if (intent) {
        const parts = raw.split(/(?:和|跟|与|及|、|，)/)
          .map(cleanSeg)
          .filter(s => s.length >= 2);
        if (parts.length >= 2) {
          const resolved = [];
          const amb = [];
          for (const p of parts) {
            const r = resolveMention(p, guests, null);
            if (r.guest) resolved.push(r.guest);
            else if (r.ambiguous.length) amb.push(...r.ambiguous);
            else warnings.push('「' + raw + '」里 "' + p + '" 没认出来（试试用宾客列表的名字或备注称谓）');
          }
          if (amb.length) { warnings.push('「' + raw + '」提及的人有歧义：' + amb.join('/')); continue; }
          if (resolved.length < 2) continue;

          const n = Math.min(resolved.length, 6); // 多方约束最多取 6 人防爆
          const t = D.CONSTRAINT_TYPES[intent];
          let count = 0;
          for (let i = 0; i < n && count < 12; i++) {
            const jMax = intent === 'mustApart' || intent === 'preferApart' ? n : Math.min(i + 2, n);
            for (let j = i + 1; j < jMax; j++) {
              suggestions.push({
                type: intent, aGuest: resolved[i], bGuest: resolved[j],
                label: resolved[i].name + ' ' + t.label + ' ' + resolved[j].name, raw,
              });
              count++;
            }
          }
          continue;
        }
      }

      warnings.push('未识别：「' + raw + '」（支持：A和B必须同桌 / A和B不能同桌 / A和B不对付 / A和B最好分开坐 / A希望和B一桌 / A、B坐一桌 / XX来不了）');
    }
    return { suggestions, warnings };
  }

  const api = { parse, resolveMention, normalize };
  root.PaizuoNLP = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
