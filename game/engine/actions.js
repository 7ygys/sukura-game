/* ============================================================================
 * engine/actions.js —— 动作层（界面和规则之间的那道门）
 * ============================================================================
 *
 * 【为什么要多这一层？直接调 rules 不行吗？】
 *   因为界面永远不该"直接改状态"。界面只说：**我想做这个动作**。
 *   这一层负责三件事：
 *     1. 复制一份状态（不动原来的）—— 这样以后要重放/回滚都还有救
 *     2. 检查是不是这个人做的、是不是他的回合
 *     3. 交给 rules 去算
 *
 * 【动作长什么样？】
 *   都是一个普通对象，`type` 表示种类：
 *
 *     { type:'basic',   player:0, which:'advance' }        基本动作
 *     { type:'playCard',player:0, cardId:'01-...' }        出牌
 *     { type:'respond', player:1, cardId:null }            要不要对应
 *     { type:'resolveDamage', player:1, choice:'aura' }    选装还是命
 *     { type:'endTurn', player:0 }                          结束回合
 *
 *   这种"用数据描述操作"的做法，以后联机时非常方便：
 *   根本不用传状态，只要把这些小对象发过去，对方自己算就行。
 * ========================================================================== */

(function (root) {
  const Engine = (root.Engine = root.Engine || {});

  /**
   * 执行一个动作。
   *
   * @param {object} state  旧状态（不会被改）
   * @param {object} action 动作
   * @returns {{ok:boolean, state:object, error?:string}}
   *          ok=false 时返回的是**原来的** state，界面不用管
   */
  function applyAction(state, action) {
    // 第 1 步：复制。之后所有修改都在这份副本上进行
    const next = Engine.state.clone(state);
    const R = Engine.rules;

    // 通用检查：已经分出胜负了就不许再操作
    if (next.winner !== null) {
      return { ok: false, state, error: '对局已经结束' };
    }

    // 通用检查：有攻击正在等待处理时，只能先处理这次攻击
    // （不然会出现"对方攻击还没结算，我又打出一张牌"这种漏洞）
    // 有付与正在分配结晶时，只能确认/取消
    if (next.nabu && ['confirmNabu', 'cancelNabu'].indexOf(action.type) < 0) {
      return { ok: false, state, error: '先把付与的结晶分配完' };
    }
    // 回合结束要选盖哪几张时，只能做这个
    if (next.endTurnPending && ['confirmEndTurn'].indexOf(action.type) < 0) {
      return { ok: false, state, error: '先把要盖的牌选完' };
    }

    // 攻击没结算时，只能做"处理这次攻击"相关的动作；
    // 「选择」「纳分配」这些是子步骤，不算打断
    const pending = next.pending;
    const allowedDuringPending = ['respond', 'resolveDamage', 'choose', 'confirmNabu', 'cancelNabu', 'damage', 'resolveExhaust'];
    if (pending && allowedDuringPending.indexOf(action.type) < 0) {
      return { ok: false, state, error: '有一张攻击还没结算' };
    }

    switch (action.type) {

      /* ---------------------------------------------------------------
       * 结束回合
       * ------------------------------------------------------------- */
      case 'endTurn': {
        if (action.player !== next.active)
          return { ok: false, state, error: '不是你的回合' };
        R.endTurn(next, action.discardIdx);
        return { ok: true, state: next };
      }

      /* ---------------------------------------------------------------
       * 基本动作（前进 / 后退 / 缠绕 / 宿命 / 离脱）
       * ------------------------------------------------------------- */
      case 'basic': {
        if (action.player !== next.active)
          return { ok: false, state, error: '不是你的回合' };
        const r = R.basicAction(next, action.player, action.which,
          { free: !!action.free, pay: action.pay, cardId: action.cardId });
        if (!r.ok) return { ok: false, state, error: r.error };
        return { ok: true, state: next };
      }

      /* ---------------------------------------------------------------
       * 付与的「纳」分配 / 取消
       * ------------------------------------------------------------- */
      case 'confirmNabu': {
        const r = R.confirmNabu(next, action.player, action.fromDust, action.fromAura);
        if (!r.ok) return { ok: false, state, error: r.error };
        return { ok: true, state: next };
      }

      case 'cancelNabu': {
        const r = R.cancelNabu(next, action.player);
        if (!r.ok) return { ok: false, state, error: r.error };
        return { ok: true, state: next };
      }

      /* ---------------------------------------------------------------
       * 做出选择（弹窗里的选项）
       * ------------------------------------------------------------- */
      case 'resolveExhaust': {
        const ex = next.exhaust;
        if (!ex || ex.remaining <= 0) return { ok: false, state, error: '没有要结算的焦燥' };
        if (ex.who !== action.player) return { ok: false, state, error: '不该由你结算焦燥' };
        const choice = action.choice === 'aura' ? 'aura' : 'life';
        if (choice === 'aura' && next.players[ex.who].aura < 1)
          return { ok: false, state, error: '装不够，只能扣命' };
        R.applyDamage(next, ex.who, 1, 1, choice);
        ex.remaining -= 1;
        if (ex.remaining <= 0) next.exhaust = null;
        return { ok: true, state: next };
      }

      case 'confirmEndTurn': {
        const r = R.confirmEndTurn(next, action.player, action.cardIds);
        if (!r.ok) return { ok: false, state, error: r.error };
        return { ok: true, state: next };
      }

      case 'choose': {
        const r = Engine.effects.resolveChoice(next, action.player, action.option);
        if (!r.ok) return { ok: false, state, error: r.error };
        // 选项可能改了间合 → 攻击要重新确认距离
        R.recheckRange(next);
        return { ok: true, state: next };
      }

      /* ---------------------------------------------------------------
       * 盖牌（伏札）：盖完可以免费做一次基本动作
       * ------------------------------------------------------------- */
      case 'hideCard': {
        if (action.player !== next.active)
          return { ok: false, state, error: '不是你的回合' };
        const r = R.hideCard(next, action.player, action.cardId);
        if (!r.ok) return { ok: false, state, error: r.error };
        return { ok: true, state: next };
      }

      /* ---------------------------------------------------------------
       * 出牌
       * ------------------------------------------------------------- */
      case 'playCard': {
        if (action.player !== next.active)
          return { ok: false, state, error: '不是你的回合' };
        const r = R.playCard(next, action.player, action.cardId);
        if (!r.ok) return { ok: false, state, error: r.error };
        return { ok: true, state: next };
      }

      /* ---------------------------------------------------------------
       * 对应：被攻击的一方决定用不用对应牌
       * （这一步不是"轮到你"，所以不能用 active 判断，要看 pending.defender）
       * ------------------------------------------------------------- */
      case 'respond': {
        if (!pending)
          return { ok: false, state, error: '现在没有待处理的攻击' };
        if (pending.defender !== action.player)
          return { ok: false, state, error: '你不是这次攻击的受害者' };
        const r = R.respond(next, action.player, action.cardId || null);
        if (!r.ok) return { ok: false, state, error: r.error };
        return { ok: true, state: next };
      }

      /* ---------------------------------------------------------------
       * 选择如何分配伤害（装 / 命）
       * ------------------------------------------------------------- */
      case 'resolveDamage': {
        const r = R.resolveDamage(next, action.player, action.choice);
        if (!r.ok) return { ok: false, state, error: r.error };
        return { ok: true, state: next };
      }

      /* ---------------------------------------------------------------
       * 直接造成伤害（焦燥之类的系统伤害，不走攻击流程）
       * ------------------------------------------------------------- */
      case 'damage': {
        const ok = R.applyDamage(next, action.who, action.aura, action.life, action.choice);
        if (!ok) return { ok: false, state, error: '装不够，不能选装' };
        return { ok: true, state: next };
      }

      default:
        return { ok: false, state, error: '未知动作：' + action.type };
    }
  }

  Engine.actions = { applyAction };
})(typeof window !== 'undefined' ? window : globalThis);
