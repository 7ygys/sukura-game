/* ============================================================
 * net/redact.js —— 状态降级（"同一个人能看到的那个世界"）
 *
 * 联机时主机握着完整状态，但**每位玩家只能看到自己该看的**。
 * 这个文件负责把完整状态压成"某个座位能看的样子"：
 *
 *   公开：间合 / 虚 / 双方的装·气·命 / 弃牌区 / 付与札 /
 *         已使用过的王牌 / 牌库与盖牌的**数量** / 进行到第几回合
 *   私有：手牌内容 / 盖牌内容 / 牌库顺序 / 未使用王牌的身份 /
 *         别人正在做的选择（选项里可能含手牌）
 *
 * 注意：渲染仍然用同一套 UI 代码，只是拿到的是"降级后的状态"。
 * ============================================================ */
(function (root) {
  'use strict';

  const HIDDEN = { id: '?', name: '??', namejp: '', kind: 'normal', types: [], hidden: true };

  function blankCard(kind) {
    return Object.assign({}, HIDDEN, { kind: kind || 'normal' });
  }

  /**
   * 把 state 压成 seat 这个座位能看的样子。
   * 返回**新的对象**，不会改动原来的 state。
   */
  function redact(state, seat) {
    const s = JSON.parse(JSON.stringify(state));
    const opp = 1 - seat;

    // ---- 对方的手牌 / 牌库 / 盖牌：只留数量 ----
    ['hand', 'deck', 'hidden'].forEach(function (k) {
      const arr = s.players[opp][k] || [];
      s.players[opp][k] = arr.map(function () { return blankCard('normal'); });
    });

    // ---- 对方的王牌：用过的公开，没用过的保密 ----
    s.players[opp].specials = (s.players[opp].specials || []).map(function (c) {
      return c.used ? c : blankCard('special');
    });

    // ---- 对方正在做选择时，选项里可能有他的手牌，不能透给我 ----
    if (s.choice && s.choice.who !== seat) {
      s.choice = {
        who: s.choice.who,
        sourceId: '?',
        prompt: '对方正在做选择…',
        options: []
      };
    }

    // ---- 事件流：只给我需要播的，且不泄漏隐藏牌的身份 ----
    s.events = (s.events || []).filter(function (ev) {
      return ev.who === undefined || ev.who === seat || isPublicEvent(ev);
    }).map(function (ev) {
      const e = Object.assign({}, ev);
      if (e.type === 'cardTo' && e.to === 'hidden' && e.who !== seat) {
        e.cardId = '?';                  // 别告诉我对面盖了哪张
      }
      return e;
    });

    // ---- 日志不渲染，直接清掉，省得泄漏 ----
    s.log = [];

    // ---- 内部字段不上网 ----
    delete s.attackStack;                // 嵌套攻击栈是引擎内部结构
    return s;
  }

  /** 这些人人都能看到的动画事件 */
  function isPublicEvent(ev) {
    return ev.type === 'basic'      // 基本动作（前進/後退…）
        || ev.type === 'move'       // 结晶移动
        || ev.type === 'damage'     // 伤害飘字
        || ev.type === 'turnStart'  // 回合黑条
        || ev.type === 'play'       // 打出的牌（公开）
        || ev.type === 'respond'    // 对应（公开）
        || ev.type === 'cancel'     // 打消（公开）
        || ev.type === 'attack'     // 攻击（公开）
        || ev.type === 'enhance'    // 付与展开（公开）
        || ev.type === 'stagger'    // 畏缩（公开）
        || ev.type === 'exhaust'    // 焦燥（公开）
        || ev.type === 'cardTo';    // 卡牌进区（盖牌时牌名会被涂掉）
  }

  /** 一份"双方都不该看"的空状态，用来在等待时占位 */
  function emptyView(state, seat) {
    return redact(state, seat);
  }

  const api = { redact: redact, emptyView: emptyView, blankCard: blankCard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Redact = api;
})(typeof window !== 'undefined' ? window : globalThis);
