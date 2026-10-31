/* ============================================================
 * engine/rules.js —— 规则本身
 *
 * 这里放"不依赖界面"的判定：
 *   抽牌、焦燥、重组牌库、伤害、回合开始/结束、胜负
 *
 * 原则：所有函数都接收 state，改的是传进来的那一份。
 * （调用方负责先用 Engine.state.clone 复制，见 actions.js）
 * ============================================================ */
(function (root) {
  const Engine = (root.Engine = root.Engine || {});
  const S = () => Engine.state;
  const log = (st, m) => Engine.state.log(st, m);

  /* ---------- 抽牌 ---------- */

  /**
   * 抽 n 张。牌库不够时按规则处理「焦燥」。
   * @returns {number} 实际抽到几张
   */
  function draw(state, who, n) {
    const p = state.players[who];
    let got = 0;
    for (let i = 0; i < n; i++) {
      if (!p.deck.length) {
        // 山札切れ：先受焦燥 1/1，再重组
        if (!reshuffle(state, who)) break;   // 没牌可重组 → 抽不到
        sufferExhaustion(state, who);
      }
      if (!p.deck.length) break;
      p.hand.push(p.deck.shift());
      got++;
    }
    if (got) log(state, 'P' + (who + 1) + ' 抽 ' + got + ' 张');
    return got;
  }

  /**
   * 焦燥：受 1/1 伤害（装 1、命 1 各一点？）
   * 官方：焦燥是「1/1 的伤害」，由受到的一方选择打在装还是命上。
   * 这里自动选：有装就选装，否则选命。
   */
  function sufferExhaustion(state, who) {
    const p = state.players[who];
    const useAura = p.aura > 0;
    log(state, 'P' + (who + 1) + ' 焦燥 1/1 → ' + (useAura ? '装' : '命'));
    applyDamage(state, who, 1, 1, useAura ? 'aura' : 'life');
  }

  /**
   * 重组牌库：弃牌区 + 伏札区的「通常札」洗回牌库。
   * 王牌不进牌库。
   * @returns {boolean} 是否真的重组出了牌
   */
  function reshuffle(state, who) {
    const p = state.players[who];
    const back = p.discard
      .concat(p.hidden)
      .filter(c => c.kind === 'normal');
    if (!back.length) return false;
    p.discard = [];
    p.hidden = [];
    const rng = Engine.rng.makeRng(state.seed + state.tick * 7919 + who);
    state.tick++;
    p.deck = Engine.rng.shuffle(back, rng);
    log(state, 'P' + (who + 1) + ' 重组牌库（' + back.length + ' 张）');
    return true;
  }

  /* ---------- 伤害 ---------- */

  /**
   * 结算伤害。
   * @param {number} auraDmg 打在「装」上的点数
   * @param {number} lifeDmg 打在「命」上的点数
   * @param {'aura'|'life'} choice 由受方选择一条线
   *
   * 规则要点：
   *   - 伤害写 X/Y，X 是装伤、Y 是命伤，受方二选一
   *   - 装不够 X 就不能选装
   *   - 装的上限是 5，超过的部分直接消失（不会转成命伤）
   */
  function applyDamage(state, who, auraDmg, lifeDmg, choice) {
    const p = state.players[who];
    if (choice === 'aura') {
      if (p.aura < auraDmg) return false;      // 不合法
      p.aura -= auraDmg;
      log(state, 'P' + (who + 1) + ' 装 -' + auraDmg + '（余 ' + p.aura + '）');
    } else {
      p.life -= lifeDmg;
      log(state, 'P' + (who + 1) + ' 命 -' + lifeDmg + '（余 ' + p.life + '）');
    }
    checkWin(state);
    return true;
  }

  /** 能不能选装（装不够 X 就只能选命） */
  function canTakeAura(state, who, auraDmg) {
    return state.players[who].aura >= auraDmg;
  }

  /* ---------- 回合 ---------- */

  /**
   * 回合开始。
   *   1. 集中力 +1（上限 2）
   *   2. 每张付与札各移 1 颗结晶到虚
   *   3. 抽 2 张
   * 例外：每位玩家的「第一个回合」不做上述处理。
   */
  function startTurn(state) {
    const who = state.active;
    const p = state.players[who];
    state.phase = 'start';

    if (!p.firstTurnDone) {
      p.firstTurnDone = true;
      log(state, 'P' + (who + 1) + ' 的第一个回合（跳过默认处理）');
    } else {
      const I = Engine.state.INIT;
      if (p.focus < I.FOCUS_MAX) p.focus++;
      tickAttachments(state, who);
      draw(state, who, I.TURN_DRAW);
    }

    state.phase = 'main';
    log(state, '—— 第 ' + state.turn + ' 回合 · P' + (who + 1) + ' ——');
    return state;
  }

  /** 付与札：每张各移 1 颗结晶到虚；结晶没了就破弃 */
  function tickAttachments(state, who) {
    const p = state.players[who];
    if (!p.attachments.length) return;
    const keep = [];
    p.attachments.forEach(a => {
      if (a.crystals > 0) {
        a.crystals--;
        state.dust++;
      }
      if (a.crystals > 0) keep.push(a);
      else log(state, '付与「' + a.name + '」结晶耗尽，破弃');
    });
    p.attachments = keep;
  }

  /**
   * 回合结束：手牌弃到 2 张，然后换人。
   * @param {number[]} discardIdx 要弃掉的手牌下标（不传则自动弃最后几张）
   */
  function endTurn(state, discardIdx) {
    const who = state.active;
    const p = state.players[who];
    const limit = Engine.state.INIT.END_HAND;

    const idx = (discardIdx && discardIdx.length) ? discardIdx.slice()
      : null;

    if (p.hand.length > limit) {
      const need = p.hand.length - limit;
      let picked;
      if (idx) {
        picked = idx.slice(0, need);
      } else {
        picked = [];
        for (let i = 0; i < need; i++) picked.push(p.hand.length - 1 - i);
      }
      picked.sort((a, b) => b - a).forEach(i => {
        const c = p.hand.splice(i, 1)[0];
        if (c) { p.discard.push(c); log(state, '弃掉 ' + c.name); }
      });
    }

    state.phase = 'end';
    state.active = 1 - state.active;
    state.turn++;
    startTurn(state);
    return state;
  }

  /* ---------- 胜负 ---------- */

  function checkWin(state) {
    if (state.winner !== null) return;
    const dead = state.players.map((p, i) => (p.life <= 0 ? i : -1)).filter(i => i >= 0);
    if (dead.length === 1) {
      state.winner = 1 - dead[0];
      log(state, 'P' + (state.winner + 1) + ' 获胜');
    } else if (dead.length === 2) {
      state.winner = -1;   // 同时倒下
    }
  }

  Engine.rules = {
    draw, reshuffle, sufferExhaustion,
    applyDamage, canTakeAura,
    startTurn, endTurn, tickAttachments,
    checkWin
  };
})(typeof window !== 'undefined' ? window : globalThis);
