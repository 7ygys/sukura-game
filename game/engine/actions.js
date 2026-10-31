/* ============================================================
 * engine/actions.js —— 动作层
 *
 * 界面永远不直接改 state，只发「动作」：
 *   { type:'endTurn', player:0, discardIdx:[1,2] }
 *
 * applyAction 返回一个【新】状态，旧的不动。
 * 这一层是以后联机的基础：把动作发过去，两边算出来必然一样。
 * ============================================================ */
(function (root) {
  const Engine = (root.Engine = root.Engine || {});

  /**
   * @param {object} state 旧状态
   * @param {object} action 动作
   * @returns {{ok:boolean, state:object, error?:string}}
   */
  function applyAction(state, action) {
    const next = Engine.state.clone(state);
    const R = Engine.rules;

    switch (action.type) {
      case 'endTurn': {
        if (action.player !== next.active)
          return { ok: false, state, error: '不是你的回合' };
        if (next.winner !== null)
          return { ok: false, state, error: '已经结束' };
        R.endTurn(next, action.discardIdx);
        return { ok: true, state: next };
      }

      case 'damage': {
        // 受方选择如何分配（装 / 命）
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
