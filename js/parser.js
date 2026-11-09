/* ============================================================
 * 排座宝 P0 原型 — 接龙/文本名单解析
 * 支持：微信接龙格式、编号列表、顿号分隔、+N 随行、括号备注、
 *       亲属称谓/领导称谓自动识别角色
 * ============================================================ */
(function (root) {
  'use strict';

  const D = root.PaizuoData;

  /* 称谓 → 角色 关键词表（按优先级） */
  const ROLE_HINTS = [
    { re: /证婚/, role: 'witness' },
    { re: /舅/, role: 'uncle' },
    { re: /(爷爷|奶奶|外公|外婆|姥爷|姥姥)/, role: 'grandparent' },
    { re: /(父亲|父亲大人|爸爸|老爸)/, role: 'elder' },
    { re: /(母亲|妈妈|老妈)/, role: 'elder' },
    { re: /(伯|叔|姑|姨|婶|舅妈|表)/, role: 'relative' },
    { re: /(哥|嫂|姐|姐夫|弟|妹)/, role: 'relative' },
    { re: /(总|董事长|经理|书记|局长|处长|科长|主任)/, role: 'leader' },
  ];

  const SIDE_HINTS = [
    { re: /(男方|新郎方|婆家|男方亲友|新郎亲友)/, side: 'groom' },
    { re: /(女方|新娘方|娘家|女方亲友|新娘亲友)/, side: 'bride' },
  ];

  /* 名字合法性：2-4 个汉字（允许 · ，少数民族姓名） */
  const NAME_RE = /^[\u4e00-\u9fa5·]{2,4}$/;

  function cleanLine(line) {
    return line.replace(/\s+/g, ' ').trim();
  }

  /** 解析一行，返回 {names: [{name, note, side, role, extra}], warnings: []} */
  function parseLine(rawLine, warnings) {
    const out = [];
    let line = cleanLine(rawLine);
    if (!line) return out;

    // 去掉接龙编号 1. 1、 1) 1． 1》 和 #接龙 前缀
    line = line.replace(/^#\s*接龙[:：]?\s*/, '');
    line = line.replace(/^\d+\s*[.、)．》）:：]\s*/, '');

    // 分隔符拆分：顿号/逗号/制表/多空格
    const segs = line.split(/[、，,；;\t]+| {2,}/).map(s => s.trim()).filter(Boolean);

    for (let seg of segs) {
      // 提取 +N / 带N人
      let extra = 0;
      const extraM = seg.match(/([+＋加]\s*(\d{1,2}))|（\s*([+＋]\s*\d{1,2})\s*）/);
      if (extraM) { extra = parseInt(extraM[2] || extraM[3] || '0', 10) || 0; seg = seg.replace(extraM[0], ''); }

      // 提取括号备注
      let note = '';
      const noteM = seg.match(/[（(]([^（）()]+)[)）]/);
      if (noteM) { note = noteM[1].trim(); seg = seg.replace(noteM[0], ''); }

      seg = seg.replace(/\s+/g, '').replace(/[。.!！?？~～]/g, '');
      if (!seg) continue;

      // "张三一家" / "张三全家" → 本名 + 2 随行
      let familyExtra = 0;
      const famM = seg.match(/^([\u4e00-\u9fa5·]{2,4})(一家|全家|夫妇|夫妻)$/);
      if (famM) {
        seg = famM[1];
        familyExtra = /一家|全家/.test(famM[2]) ? 2 : 1;
        if (!note) note = famM[2];
      }

      // 尾部称谓拆解："张伟爸" → 名字张伟 + 备注；无论整体是否合法名，凡以称谓结尾都尝试拆
      let role = '';
      {
        const SUF2 = '(爸爸|妈妈|老爸|老妈|父亲|母亲|爷爷|奶奶|外公|外婆|姥爷|姥姥)';
        let suffixM = seg.match(new RegExp('^([\u4e00-\u9fa5·]{2,4})' + SUF2 + '$'));
        let sufTxt = suffixM ? suffixM[2] : '';
        if (!suffixM) {
          suffixM = seg.match(/^([\u4e00-\u9fa5·]{2,4})(爸|妈|爹|娘|爷|奶)$/);
          if (suffixM) sufTxt = suffixM[2];
        }
        if (suffixM && NAME_RE.test(suffixM[1])) {
          note = (note ? note + '，' : '') + sufTxt;
          role = /爷|奶|外公|外婆|姥爷|姥姥/.test(sufTxt) ? 'grandparent' : 'elder';
          seg = suffixM[1];
        }
      }

      // 名称里直接含称谓关键词 → 角色推断（"大舅""王总""李老师"这类整体不合法名时强拆会出错，
      // v1 允许 2-6 字整体入名，由 UI 提示用户复核）
      if (!role) {
        for (const h of ROLE_HINTS) {
          if (h.re.test(seg)) { role = h.role; break; }
        }
      }
      // 备注兜底："（新娘大舅）""（公司总经理）" → 角色推断
      if (!role && note) {
        for (const h of ROLE_HINTS) {
          if (h.re.test(note)) { role = h.role; break; }
        }
      }
      let side = '';
      for (const h of SIDE_HINTS) {
        if (h.re.test(note)) { side = h.side; break; }
      }

      const nameOk = /^[\u4e00-\u9fa5·]{2,6}$/.test(seg);
      if (!nameOk) {
        warnings.push('未能识别：" ' + rawLine.trim() + ' "（片段：" ' + seg + ' "）');
        continue;
      }

      out.push({ name: seg, note, side, role, extra: extra + familyExtra });

      // 随行人员生成 "XX家属1/2" 或 "XX家属"（先取总量，避免读被循环修改的数组尾部）
      const totalExtra = extra + familyExtra;
      for (let i = 1; i <= totalExtra; i++) {
        out.push({ name: seg + '家属' + (totalExtra === 1 ? '' : i), note: '随 ' + seg, side, role: '', extra: 0 });
      }
    }
    return out;
  }

  /**
   * 解析整段文本 → {guests: [{name, note, side, role}], warnings: [string], count}
   */
  function parseRoster(text) {
    const warnings = [];
    const guests = [];
    const seen = new Map(); // 查重
    const lines = String(text || '').split(/\r?\n/);

    for (const line of lines) {
      if (!cleanLine(line)) continue;
      if (/^#接龙|^接龙$|接龙结果/.test(cleanLine(line)) && guests.length === 0) continue;
      const items = parseLine(line, warnings);
      for (const it of items) {
        const key = it.name;
        if (seen.has(key)) {
          warnings.push('重名跳过：' + it.name);
          continue;
        }
        seen.set(key, true);
        guests.push({ name: it.name, note: it.note, side: it.side, role: it.role });
      }
    }
    return { guests, warnings, count: guests.length };
  }

  const api = { parseRoster };
  root.PaizuoParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
