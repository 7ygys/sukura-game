/* ============================================================
 * engine/gauge.js —— 莱拉的「风雷」计略
 *
 * 规则（官方）：风神计略与雷神计略，初始 0，最大 20。
 *   使用「其他女神的牌」时，可以把其中一个 +1。
 *
 * 本项目的做法（按用户的描述简化）：
 *   使用其他女神的牌时只**记账**（otherCardsUsed++），
 *   到自己的**结束阶段**再统一询问"这几点怎么分配到风和雷"。
 *   —— 这样每回合只弹一次窗，不用每张牌都问。
 *
 * 和官方"立刻 +1"的区别只在时机上，总量相同；
 * 如果你更想要官方那种"立刻加"，把 finishEndTurn 里的 needAlloc 换成
 * 使用时的即时询问即可。
 * ============================================================ */
(function (root) {
  'use strict';

  const MAX = 20;

  function wind(state, who)   { const p = state.players[who]; return (p && p.wind) || 0; }
  function thunder(state, who){ const p = state.players[who]; return (p && p.thunder) || 0; }
  function total(state, who)  { return wind(state, who) + thunder(state, who); }

  function add(state, who, kind, n) {
    const p = state.players[who];
    if (!p) return;
    const k = (kind === 'thunder') ? 'thunder' : 'wind';
    p[k] = Math.min(MAX, Math.max(0, (p[k] || 0) + (n === undefined ? 1 : n)));
  }

  function set(state, who, kind, v) {
    const p = state.players[who];
    if (!p) return;
    const k = (kind === 'thunder') ? 'thunder' : 'wind';
    p[k] = Math.min(MAX, Math.max(0, v));
  }

  /** 用了一张"其他女神的牌" → 记一笔，等结束阶段分配 */
  function noteOtherCard(state, who, card) {
    const p = state.players[who];
    if (!p || !p.hasRaira) return;            // 牌组里没有莱拉就不记
    const g = String(card && card.id || '').split('-')[1];
    if (!g || g === 'raira') return;          // 莱拉自己的牌不算
    p.otherCardsUsed = (p.otherCardsUsed || 0) + 1;
  }

  /** 这一步可分几点（用了多少张其他女神的牌 - 已经分配过的） */
  function pendingPoints(state, who) {
    const p = state.players[who];
    if (!p) return 0;
    return Math.max(0, (p.otherCardsUsed || 0) - (p.gaugeClaimed || 0));
  }

  /** 分配一次：把 n 点加给它 */
  function claim(state, who, kind, n) {
    const p = state.players[who];
    if (!p) return 0;
    const take = Math.min(n, pendingPoints(state, who));
    if (take <= 0) return 0;
    add(state, who, kind, take);
    p.gaugeClaimed = (p.gaugeClaimed || 0) + take;
    return take;
  }

  const api = {
    MAX: MAX,
    wind: wind, thunder: thunder, total: total,
    add: add, set: set,
    noteOtherCard: noteOtherCard, pendingPoints: pendingPoints, claim: claim
  };
  const Engine = (root.Engine = root.Engine || {});
  Engine.gauge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
