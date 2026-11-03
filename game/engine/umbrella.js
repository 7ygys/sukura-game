/* ============================================================
 * engine/umbrella.js —— 雪姬的「伞的开合」（特性：変貌）
 *
 * 规则要点（官方攻略 / 卡面）：
 *   1. 伞有「閉（收）」和「開（撑）」两种状态，**开局是閉**。
 *   2. 一部分卡在两种状态下，适正距离 / 伤害 / 效果都不一样。
 *   3. **自己的结束阶段可以开合一次**（不是强制）。
 *   4. 「伞的开合」这件事本身会被别的牌监听：
 *      - かさまわし：开合时从手牌公开 → 虚→自装 1
 *      - はらりゆき：【再起】你进行伞的开合
 *
 * 这个模块只负责"伞本身"：状态读写、开合、状态相关的卡面取值。
 * 具体某张卡开合后发生什么，写在 effects.js 里。
 * ============================================================ */
(function (root) {
  'use strict';

  const CLOSED = 'closed';
  const OPEN = 'open';

  function raw(state, who) {
    const p = state.players[who];
    return p && p.umbrella === OPEN ? OPEN : CLOSED;
  }

  function isOpen(state, who) { return raw(state, who) === OPEN; }
  function isClosed(state, who) { return raw(state, who) === CLOSED; }
  /** 当前状态的中文名，界面和日志用 */
  function label(state, who) { return isOpen(state, who) ? '开' : '闭'; }

  /**
   * 取一张卡"当前伞状态下"的样子。
   * 没有 dual 数据的卡原样返回。
   * 返回 { range, rangeRaw, damage, damageRaw, text } —— 都可能是 undefined。
   */
  function viewOf(card, open) {
    if (!card || !card.dual) {
      return card ? { range: card.range, rangeRaw: card.rangeRaw, damage: card.damage, damageRaw: card.damageRaw, text: card.text } : null;
    }
    const d = open ? card.dual.open : card.dual.closed;
    return d || { range: card.range, rangeRaw: card.rangeRaw, damage: card.damage, damageRaw: card.damageRaw, text: card.text };
  }

  /** 这张卡是不是"随伞状态变化"的卡 */
  function isDual(card) { return !!(card && card.dual); }

  /**
   * 把这张牌在**两种状态下的适正距离**合并（どろりうら 用）。
   * 例：闭 4-6、开 0-2 → 0-6
   */
  function unionRange(card) {
    if (!card || !card.dual) return card ? (card.range || []).slice() : [];
    const a = (card.dual.closed && card.dual.closed.range) || [];
    const b = (card.dual.open && card.dual.open.range) || [];
    const all = a.concat(b);
    if (!all.length) return [];
    // 规则 10-4：把最小值到最大值之间的**所有整数**都算进适正距离
    const lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    const out = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }

  /** 把距离数组写成 "0-2" / "4" 这种文本 */
  function rangeText(arr) {
    if (!arr || !arr.length) return '-';
    const s = arr.slice().sort(function (a, b) { return a - b; });
    let start = s[0], prev = s[0], out = [];
    for (let i = 1; i <= s.length; i++) {
      const v = s[i];
      if (v === prev + 1) { prev = v; continue; }
      out.push(start === prev ? String(start) : start + '-' + prev);
      start = prev = v;
    }
    return out.join(',');
  }

  const api = {
    CLOSED: CLOSED, OPEN: OPEN,
    raw: raw, isOpen: isOpen, isClosed: isClosed, label: label,
    viewOf: viewOf, isDual: isDual, unionRange: unionRange, rangeText: rangeText
  };
  // 同时挂到 Engine 和全局：引擎里用 Engine.umbrella，页面里用 Umbrella
  const Engine = (root.Engine = root.Engine || {});
  Engine.umbrella = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Umbrella = api;
})(typeof window !== 'undefined' ? window : globalThis);
