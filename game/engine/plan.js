/* ============================================================
 * engine/plan.js —— 雪拉的「计略」（特性：計略）
 *
 * 规则要点（官方攻略 / 卡面）：
 *   1. 平时**秘密**准备着两个计略之一：【神谋】或【鬼谋】。
 *   2. 开局**必定是神谋**。
 *   3. 标着「计略を実行し、次の計略を準備する」的牌 =
 *        先结算已准备的计略（此时向对方公开）→ 再秘密准备下一个。
 *   4. 对方看不到你准备的是哪个（只看得到牌背）。
 *
 * 这个模块只管"计略本身"：状态、公开/隐藏、待选择。
 * 每条计略具体做什么，写在 effects.js 的 planEffects 表里。
 * ============================================================ */
(function (root) {
  'use strict';

  const KAMI = 'kami';   // 神谋
  const ONI  = 'oni';    // 鬼谋
  const LABEL = { kami: '神谋', oni: '鬼谋' };

  function of(state, who) {
    const p = state.players[who];
    return (p && (p.plan === ONI || p.plan === KAMI)) ? p.plan : KAMI;
  }

  /** 对方能不能看到？只有在"公开中"（正在执行）时才看得到 */
  function visible(state, who, viewer) {
    if (viewer === who) return true;
    return !!(state.players[who] && state.players[who].planRevealed);
  }

  function label(plan) { return LABEL[plan] || '?'; }

  /**
   * 执行计略：先把计略公开，然后把效果算出来。
   * 返回 'kami' / 'oni'，调用方据此走分支。
   */
  function execute(state, who) {
    const p = state.players[who];
    if (!p) return KAMI;
    const plan = of(state, who);
    p.planRevealed = true;
    Engine.state.emit(state, 'plan', { who: who, plan: plan, phase: 'reveal' });
    Engine.state.log(state, 'P' + (who + 1) + ' 执行计略：' + label(plan));
    return plan;
  }

  /** 准备下一个计略（秘密）：选择完成后立刻恢复"不可见" */
  function prepare(state, who, choice) {
    const p = state.players[who];
    if (!p) return;
    p.plan = (choice === ONI) ? ONI : KAMI;
    p.planRevealed = false;
    Engine.state.emit(state, 'plan', { who: who, plan: 'back', phase: 'prepare' });
    Engine.state.log(state, 'P' + (who + 1) + ' 准备了新的计略（对方不可见）');
  }

  /** 需要玩家选择下一个计略时挂起 */
  function needPrepare(state, who) {
    state.planPending = { who: who };
  }

  /** 玩家选好了 */
  function resolve(state, who, choice) {
    if (!state.planPending || state.planPending.who !== who) return null;
    prepare(state, who, choice);
    state.planPending = null;
    return true;
  }

  const api = {
    KAMI: KAMI, ONI: ONI, LABEL: LABEL,
    of: of, visible: visible, label: label,
    execute: execute, prepare: prepare, needPrepare: needPrepare, resolve: resolve
  };
  const Engine = (root.Engine = root.Engine || {});
  Engine.plan = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
