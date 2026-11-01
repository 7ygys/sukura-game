/* ============================================================================
 * engine/rules.js —— 规则本体
 * ============================================================================
 *
 * 【这个文件是干什么的】
 *   把「官方规则书上的文字」翻译成代码。
 *   这里不碰画面、不碰网络，只回答一件事：
 *     「现在这个局面，玩家做这个操作，合不合法？合法的话，局面变成什么样？」
 *
 * 【读代码前先记住三个概念】
 *
 *   1. 状态（state）是一个大对象，装着这局游戏的**全部事实**：
 *      谁多少命、手牌有哪些、现在距离几格、轮到谁……具体形状见 state.js。
 *
 *   2. 这里的函数**会直接修改传进来的 state**。
 *      这是故意的：修改一份副本比每次生成全新对象省事得多。
 *      "不要改原状态"这件事由调用方 actions.js 负责（它先 clone 再交给我们）。
 *
 *   3. 每个操作都返回 { ok, error }：
 *      ok 为 false 表示"不能这么做"，此时 state 不应该被改动。
 *
 * 【散樱乱武的底层资源模型】
 *   场上所有的"资源"其实都是**同一种东西：樱花结晶**。
 *   它们只是放在不同的地方，名字不一样：
 *
 *     虚(dust)       ← 场中央那一圈，是公共池
 *     间合(distance) ← 两条命之间的格数，0 是最贴脸，10 是最远
 *     装(aura)       ← 相当于护甲/能量，上限 5
 *     气(flare)      ← 用来支付王牌的费用
 *     命(life)       ← 掉到 0 就输
 *
 *   而「基本动作」干的事，就是**把结晶从一处搬到另一处**：
 *     前进 距→装    后退 装→距    缠绕 尘→装    宿命 装→气    离脱 尘→距
 *
 *   理解了这一点，后面所有卡牌效果都是在"搬结晶"和"改伤害数字"。
 * ========================================================================== */

(function (root) {
  const Engine = (root.Engine = root.Engine || {});

  /** 小工具：写日志（会显示在界面右下角，也方便调试） */
  const log = (st, m) => Engine.state.log(st, m);

  /* ==========================================================================
   * 一、抽牌
   * ========================================================================== */

  /**
   * 抽 n 张牌。
   *
   * 规则细节：牌库抽空时不能直接算"无牌可抽"，而是要先处理「焦燥」——
   *   1. 先受 1 点伤害（1/1，由受伤方选打在装还是命上）
   *   2. 再把弃牌区 + 伏札区里的「通常札」洗回牌库（这步叫"重组"）
   *   3. 重组完继续抽
   *
   * @returns {number} 实际抽到几张
   */
  function draw(state, who, n) {
    const p = state.players[who];
    let got = 0;
    let exhaustCount = 0;

    for (let i = 0; i < n; i++) {
      // 牌库空了 → 焦燥（1/1 伤害）。注意：焦燥**不会**自动帮你重组牌库，
      // 重组是回合开始时另外选的，而且要付 1 点命（规则 9-7）。
      if (!p.deck.length) {
        // 抽不到 → 记 1 点焦燥（之后由玩家逐点选扣装还是扣命）
        exhaustCount++;
        continue;          // 继续处理后面要抽的张数
      }
      if (!p.deck.length) break;

      p.hand.push(p.deck.shift());   // shift() 从数组头部取，头部就是牌堆顶
      got++;
    }

    if (got) {
      log(state, 'P' + (who + 1) + ' 抽 ' + got + ' 张');
      Engine.state.emit(state, 'draw', { who: who, n: got });
    }
    if (exhaustCount > 0) {
      log(state, 'P' + (who + 1) + ' 焦燥 ' + exhaustCount + ' 点（待结算）');
      state.exhaust = { who: who, remaining: exhaustCount };
      Engine.state.emit(state, 'exhaust', { who: who, n: exhaustCount });
    }
    return got;
  }

  /**
   * 焦燥：牌库抽空时的惩罚，1/1 伤害。
   * 规则上说"由受到伤害的玩家选择装还是命"，这里为了简单自动选：
   * 有装就先扣装，没装才扣命。
   */
  function sufferExhaustion(state, who) {
    const p = state.players[who];
    const useAura = p.aura > 0;
    log(state, 'P' + (who + 1) + ' 焦燥 1/1 → ' + (useAura ? '装' : '命'));
    Engine.state.emit(state, 'exhaust', { who: who });
    applyDamage(state, who, 1, 1, useAura ? 'aura' : 'life');
  }

  /**
   * 重组牌库：把弃牌区 + 伏札区里的「通常札」洗回牌库。
   *
   * 注意两点：
   *   - **王牌不进牌库**（王牌有自己的回收机制叫「再起」）
   *   - 付与区里的牌不会进牌库（它们还在场上生效）
   *
   * @returns {boolean} 是否真的洗回了牌
   */
  function reshuffle(state, who, payLife) {
    const p = state.players[who];

    const back = p.discard.concat(p.hidden).filter(c => c.kind === 'normal');
    if (!back.length) return false;

    // 规则 9-7-ⅰ：由规则产生的再构成，先失去 1 点命
    if (payLife) {
      log(state, 'P' + (who + 1) + ' 重组的代价：命 -1');
      applyDamage(state, who, 0, 1, 'life');
    }

    p.discard = [];
    p.hidden = [];
    // 注意：要**把原来牌库里剩下的牌也算进去**再洗，不能直接覆盖
    const all = p.deck.concat(back);
    p.deck = Engine.rng.shuffle(all);

    log(state, 'P' + (who + 1) + ' 重组牌库（' + back.length + ' 张洗回，共 ' + all.length + ' 张）');
    return true;
  }

  /* ==========================================================================
   * 一·三、回合结束时选盖牌
   * ==========================================================================
   *
   * 规则 8-3-2：手牌超过上限（2 张）时，要一张一张盖成伏札。
   * 盖哪几张由玩家自己挑。
   */
  function confirmEndTurn(state, who, cardIds) {
    const pend = state.endTurnPending;
    if (!pend || pend.who !== who) return { ok: false, error: '现在不用选盖牌' };
    const ids = cardIds || [];
    if (ids.length !== pend.need) return { ok: false, error: '要正好选 ' + pend.need + ' 张' };

    const p = state.players[who];
    for (const id of ids) {
      const i = p.hand.findIndex(c => c.id === id);
      if (i < 0) return { ok: false, error: '手牌里没有这张：' + id };
      const card = p.hand.splice(i, 1)[0];
      p.hidden.push(card);
      Engine.state.emit(state, 'cardTo', { who: who, cardId: card.id, to: 'hidden' });
      log(state, '盖上伏札 ' + card.name);
    }

    state.endTurnPending = null;
    state.phase = 'end';
    tryRevive(state, who, 'normal');   // 规则 10-7：再起在「结束阶段」检查
    state.active = 1 - state.active;
    state.turn++;
    startTurn(state);
    return { ok: true };
  }

  /* ==========================================================================
   * 一·四、付与的「纳」分配
   * ========================================================================== */

  /**
   * 展开付与札时，「纳」的结晶可以**从虚和装两处取**，由玩家自己分配。
   * 这里负责：检查分配是否合法 → 扣结晶 → 把牌放进付与区。
   */
  function confirmNabu(state, who, fromDust, fromAura) {
    const nb = state.nabu;
    if (!nb || nb.who !== who) return { ok: false, error: '现在没有要分配的付与' };

    fromDust = Math.max(0, fromDust | 0);
    fromAura = Math.max(0, fromAura | 0);
    if (fromDust + fromAura !== nb.cap)
      return { ok: false, error: '分配的结晶数必须正好是 ' + nb.cap };
    if (fromDust > state.dust) return { ok: false, error: '虚里的结晶不够' };
    if (fromAura > state.players[who].aura) return { ok: false, error: '装里的结晶不够' };

    const p = state.players[who];
    const idx = handIndexOf(p, nb.cardId);
    if (idx < 0) return { ok: false, error: '手上没有这张牌' };
    const card = p.hand[idx];

    p.hand.splice(idx, 1);
    Engine.state.emit(state, 'cardTo', { who: who, cardId: card.id, to: 'attach' });
    // 结晶从虚/装「搬到付与札上」，这两步也要各自发事件给动画
    if (fromDust) moveCrystal(state, who, 'dust', 'attach', fromDust);
    if (fromAura) moveCrystal(state, who, 'aura', 'attach', fromAura);
    p.attachments.push(Object.assign({}, card, { crystals: nb.cap }));

    state.turnUsed[who] = (state.turnUsed[who] || 0) + 1;
    if ((card.types || []).indexOf('fullpower') >= 0) p.fullpowerUsed = true;
    state.quietSpark = true;      // 别把这次减装画成"飞向虚"

    log(state, '付与「' + card.name + '」展开，纳 ' + nb.cap +
      '（虚 -' + fromDust + '，装 -' + fromAura + '）');

    // 【展开时】效果（规则 9-2-3 ⅳ）
    const et = (Engine.effects && Engine.effects.cards) || {};
    const ee = et[card.id];
    if (ee && ee.onExpanded) ee.onExpanded(state, who, card);
    Engine.state.emit(state, 'enhance', { who: who });

    state.nabu = null;
    return { ok: true };
  }

  /** 反悔：这次展开取消，牌回到手里 */
  function cancelNabu(state, who) {
    if (!state.nabu || state.nabu.who !== who) return { ok: false, error: '没有要取消的付与' };
    state.nabu = null;
    log(state, '取消展开');
    return { ok: true };
  }

  /* ==========================================================================
   * 一·五、盖牌（伏札）
   * ========================================================================== */

  /**
   * 主动盖一张牌（背面朝上放进伏札区）。
   *
   * 规则：盖牌之后，**可以立刻免费做一次基本动作**。
   * 这个"免费"很重要——它不花集中力。
   */
  function hideCard(state, who, cardId) {
    const p = state.players[who];
    const idx = handIndexOf(p, cardId);
    if (idx < 0) return { ok: false, error: '手上没有这张牌' };

    const card = p.hand.splice(idx, 1)[0];
    p.hidden.push(card);
    Engine.state.emit(state, 'cardTo', { who: who, cardId: card.id, to: 'hidden' });
    log(state, 'P' + (who + 1) + ' 盖牌「' + card.name + '」→ 可免费做一次基本动作');
    return { ok: true };
  }

  /* ==========================================================================
   * 一·六、结晶移动（唯一入口）
   * ==========================================================================
   *
   * 场上所有樱花结晶的移动都必须走这里：
   *   前进 距→装    后退 装→距    缠绕 尘→装    宿命 装→气    离脱 尘→距
   *   受伤 装→虚    命伤 命→气    付与 虚/装→付与札
   *
   * 为什么统一：界面要按"这次是哪一种移动"来播动画。
   * 如果各处自己改数字，界面就只能靠"哪个数变了"去猜，必然猜错。
   *
   * 区域名：'distance' 'dust' 'aura' 'flare' 'life' 'attach'
   */
  function moveCrystal(state, who, from, to, n) {
    const p = state.players[who];
    const get = (k) => (k === 'dust' || k === 'distance') ? state[k] : p[k];
    const set = (k, v) => { if (k === 'dust' || k === 'distance') state[k] = v; else p[k] = v; };

    // 「付与札」不是数值区域：减/加由调用方自己处理，这里只负责发事件
    // 注意：n 可能是 0（这次伤害是 0），不能用 `n || 1`，否则 0 会变成 1
    const want = (n === undefined || n === null) ? 1 : n;
    let num;
    if (from === 'attach') {
      num = want;                        // 调用方已经从卡片上扣掉了
    } else {
      num = Math.min(get(from) || 0, want);
      if (to === 'aura') num = Math.min(num, Engine.state.INIT.AURA_MAX - p.aura);
      if (to === 'distance') num = Math.min(num, 10 - state.distance);
      if (from === 'distance' && (p.attachments || []).some((a) => {
        const e = (Engine.effects && Engine.effects.cards || {})[a.id];
        return e && e.blockArrowFromDistance;
      })) {
        Engine.state.log(state, '「スモーク」：间合的结晶不能被箭头移动');
        return 0;
      }
      if (num <= 0) return 0;
      set(from, get(from) - num);
    }

    if (to !== 'attach') set(to, get(to) + num);

    // 给界面播动画用
    Engine.state.emit(state, 'move', { who: who, from: from, to: to, n: num });
    return num;
  }

  /* ==========================================================================
   * 二、伤害
   * ========================================================================== */

  /**
   * 结算一次伤害。
   *
   * 散樱的伤害写成 **X/Y**：
   *   X = 打在「装」上的点数
   *   Y = 打在「命」上的点数
   *
   * **由受伤的一方二选一**，不是攻击方选。
   * 比如伤害 3/1，你可以选"扣 3 点装"或者"扣 1 点命"。
   *
   * 两个限制：
   *   - 装不够 X 时，不能选装（只能选命）
   *   - 装的上限是 5
   *
   * @param {number} who     谁受伤
   * @param {number} auraDmg 装伤 X
   * @param {number} lifeDmg 命伤 Y
   * @param {'aura'|'life'} choice 受伤方选择
   * @returns {boolean} 是否成功
   */
  function applyDamage(state, who, auraDmg, lifeDmg, choice) {
    const p = state.players[who];

    // 规则 10-26「両方のダメージを受ける」：两种都要吃，不由玩家二选一。
    // 装不够时只扣现有的（多出来的算溢出），命伤照常扣。
    // 「-」代表这条线没有伤害，不能选
    if (choice === 'aura' && (auraDmg === null || auraDmg === undefined)) return false;
    if (choice === 'life' && (lifeDmg === null || lifeDmg === undefined)) return false;

    if (choice === 'both') {
      const available = p.aura + shadowAura(state, who);
      const realAura = (auraDmg === null || auraDmg === undefined) ? 0 : Math.min(available, auraDmg);
      if (realAura > 0) applyDamage(state, who, realAura, 0, 'aura');
      if (lifeDmg !== null && lifeDmg !== undefined && lifeDmg > 0) applyDamage(state, who, 0, lifeDmg, 'life');
      return true;
    }

    if (choice === 'aura') {
      // 装不够就不能选装——这是规则里明确的"不合法选择"
      if (p.aura + shadowAura(state, who) < auraDmg) return false;
      // 先用"视为在装中"的付与札结晶，再扣真正的装
      let rest = auraDmg;
      const shieldFromAttach = Math.min(shadowAura(state, who), rest);
      if (shieldFromAttach > 0) {
        let left = shieldFromAttach;
        const keep = [];
        (p.attachments || []).forEach(function (a) {
          const e = (Engine.effects && Engine.effects.cards && Engine.effects.cards[a.id]);
          if (left > 0 && e && e.auraShield) {
            const take = Math.min(a.crystals, left);
            a.crystals -= take; left -= take;
            state.dust += take;
          }
          if (a.crystals > 0) keep.push(a);
          else p.discard.push(Object.assign({}, a, { crystals: 0 }));
        });
        p.attachments = keep;
        rest -= shieldFromAttach;
      }
      moveCrystal(state, who, 'aura', 'dust', rest);
      Engine.state.emit(state, 'damage', { who: who, kind: 'aura', n: rest });
      log(state, 'P' + (who + 1) + ' 装 -' + auraDmg + '（余 ' + p.aura + '）→ 虚 +' + auraDmg);
    } else {
      // 命里的结晶被打掉后**不会消失**，它飞到气里去
      moveCrystal(state, who, 'life', 'flare', lifeDmg);
      Engine.state.emit(state, 'damage', { who: who, kind: 'life', n: lifeDmg });
      log(state, 'P' + (who + 1) + ' 命 -' + lifeDmg + '（余 ' + p.life + '）→ 气 +' + lifeDmg);
    }

    checkWin(state);
    return true;
  }

  /** 「这张牌上的结晶视为在装中」的附加装（無音壁） */
  function shadowAura(state, who) {
    let n = 0;
    (state.players[who].attachments || []).forEach(function (a) {
      const e = (Engine.effects && Engine.effects.cards && Engine.effects.cards[a.id]);
      if (e && e.auraShield) n += (a.crystals || 0);
    });
    return n;
  }

  /** 这次伤害能不能选"装"（界面用它决定按钮亮不亮） */
  function canTakeAura(state, who, auraDmg) {
    return state.players[who].aura + shadowAura(state, who) >= auraDmg;
  }

  /* ==========================================================================
   * 三、回合
   * ========================================================================== */

  /**
   * 回合开始时的处理，按官方顺序：
   *   1. 集中力 +1（上限 2）
   *   2. 每张付与札把 1 颗结晶送到虚（结晶耗尽的付与札破弃）
   *   3. 抽 2 张
   *
   * **例外**：每位玩家的"第一个回合"跳过以上全部。
   * 所以开局时双方各有 3 张手牌，但谁都不会在第一个回合再抽牌。
   */
  function startTurn(state) {
    const who = state.active;
    const p = state.players[who];
    state.phase = 'start';
    // 先告诉界面「回合开始了」，让它先扫黑条
    Engine.state.emit(state, 'turnStart', { who: who, turn: state.turn });
    state.turnUsed[who] = 0;
    p.buff = { aura: 0, life: 0 };
    p.terminated = false;
    p.fullpowerUsed = false;
    p.usedBasicThisTurn = false;

    if (!p.firstTurnDone) {
      p.firstTurnDone = true;
      log(state, 'P' + (who + 1) + ' 的第一个回合（跳过默认处理）');
    } else {
      const I = Engine.state.INIT;
      if (p.staggered) {
        // 规则 5-1-4：畏缩中「获得集中力」会被替换成「解除畏缩」
        p.staggered = false;
        log(state, 'P' + (who + 1) + ' 解除畏缩');
      } else if (p.focus < I.FOCUS_MAX) {
        p.focus++;
      }
      tickAttachments(state, who);

      // ⅲ 重组牌库（每回合都会问，付 1 点命）→ ⅳ 抽 2
      const material = p.discard.concat(p.hidden).filter(c => c.kind === 'normal').length;
      if (material > 0) {
        state.choice = {
          who: who, sourceId: 'reshuffle',
          prompt: '是否重组牌库？（现有 ' + p.deck.length + ' 张，会失去 1 点命）',
          options: ['yes', 'no']
        };
        log(state, 'P' + (who + 1) + ' 可以选择重组牌库');
      } else {
        draw(state, who, I.TURN_DRAW);
      }
    }

    state.phase = 'main';
    log(state, '—— 第 ' + state.turn + ' 回合 · P' + (who + 1) + ' ——');
    return state;
  }

  /**
   * 付与札每回合的损耗：每张牌把 1 颗结晶送回虚。
   * 结晶没了，这张付与札就"破弃"（进弃牌区）。
   */
  function tickAttachments(state, who) {
    const p = state.players[who];
    if (!p.attachments.length) return;

    const keep = [];
    const table = (Engine.effects && Engine.effects.cards) || {};
    p.attachments.forEach(a => {
      if (a.crystals > 0) {
        const e = table[a.id];
        // 圏域：本该进虚的结晶改为进间合；间合满了就**留在牌上**不动
        if (e && e.redirectTo === 'distance') {
          if (state.distance >= 10) {
            keep.push(a);
            return;
          }
          a.crystals--;
          moveCrystal(state, who, 'attach', 'distance', 1);
          log(state, '「' + a.name + '」：结晶改为送至间合');
        } else {
          a.crystals--;
          moveCrystal(state, who, 'attach', 'dust', 1);
        }
      }
      if (a.crystals > 0) {
        keep.push(a);
      } else {
        // 结晶耗尽 → 破弃：先触发【破弃时】，再进弃牌区
        const eff = (Engine.effects && Engine.effects.cards && Engine.effects.cards[a.id]);
        if (eff && eff.onBreak) eff.onBreak(state, who, a);
        p.discard.push(Object.assign({}, a, { crystals: 0 }));
        log(state, '付与「' + a.name + '」结晶耗尽，破弃');
      }
    });
    p.attachments = keep;
  }

  /**
   * 回合结束：
   *   1. 手牌弃到只剩 2 张（注意：不是"手牌上限 2"，只是结束时要丢到 2）
   *   2. 换人
   *   3. 立刻开始下一个人的回合
   *
   * @param {number[]} discardIdx 玩家选择要弃掉的手牌下标；不传就自动弃末尾
   */
  function endTurn(state, discardIdx) {
    const who = state.active;
    const p = state.players[who];
    const limit = Engine.state.INIT.END_HAND;   // 结束时手牌最多留几张

    if (p.hand.length > limit) {
      const need = p.hand.length - limit;       // 要盖几张

      // 没指定 → 先把"要选几张"挂起来，等玩家自己挑
      if (!discardIdx || !discardIdx.length) {
        state.endTurnPending = { who: who, need: need };
        log(state, 'P' + (who + 1) + ' 需要盖掉 ' + need + ' 张手牌');
        return state;
      }

      const picked = discardIdx.slice(0, need);

      // 规则 8-3-2：超出的手牌是**盖成伏札**，不是丢进弃牌区
      picked.sort((a, b) => b - a).forEach(i => {
        const c = p.hand.splice(i, 1)[0];
        if (c) { p.hidden.push(c); log(state, '盖上伏札 ' + c.name); }
      });
    }

    state.phase = 'end';
    tryRevive(state, who, 'normal');   // 规则 10-7：再起在「结束阶段」检查
    state.active = 1 - state.active;   // 0↔1 切换
    state.turn++;
    startTurn(state);
    return state;
  }

  /* ==========================================================================
   * 四、基本动作（五个）
   * ========================================================================== */

  /**
   * 基本动作就是"搬结晶"，不用出牌、不用花钱，只要条件满足就能做。
   *
   * 每个动作由两部分组成：
   *   need(st, p)  —— 现在能不能做（界面据此把图标变灰）
   *   apply(st, p) —— 做了什么（改 state）
   *
   * 写成这种"数据表"而不是一堆 if-else，好处是：
   *   加新动作只要往上加一行，别处不用改。
   */
  const BASIC = {
    // 前进：距 → 装。
    // 规则 9-6-1：间合 ≤ 达人距离（默认 2）时**什么都不会发生**，即不能前进。
    advance: {
      name: '前进',
      need: (st, p) => effDistance(st) > taijinOf(st) && p.aura < Engine.state.INIT.AURA_MAX,
      apply: (st, p, who) => { moveCrystal(st, who, 'distance', 'aura', 1); }
    },

    // 后退：装 → 距 → 拉开距离
    retreat: {
      name: '后退',
      need: (st, p) => p.aura >= 1 && st.distance < 10,
      apply: (st, p, who) => { moveCrystal(st, who, 'aura', 'distance', 1); }
    },

    // 缠绕：虚 → 装 → 从公共池补充护甲
    gather: {
      name: '缠绕',
      need: (st, p) => st.dust >= 1 && p.aura < Engine.state.INIT.AURA_MAX,
      apply: (st, p, who) => { moveCrystal(st, who, 'dust', 'aura', 1); }
    },

    // 宿命：装 → 气 → 消耗护甲换王牌费用
    charge: {
      name: '宿命',
      need: (st, p) => p.aura >= 1,
      apply: (st, p, who) => { moveCrystal(st, who, 'aura', 'flare', 1); }
    },

    // 离脱：虚 → 距。规则 9-6-5：间合 > 达人距离时什么都不会发生
    disengage: {
      name: '离脱',
      need: (st, p) => effDistance(st) <= taijinOf(st) && st.distance < 10 && st.dust >= 1,
      apply: (st, p, who) => { moveCrystal(st, who, 'dust', 'distance', 1); }
    }
  };

  /**
   * 这个基本动作现在能不能做。
   * 除了动作本身的条件，还要**有 1 点集中力**——基本动作不是免费的。
   * 集中力每回合最多涨到 2，所以一回合最多做两次基本动作。
   */
  /**
   * 「現在の間合」（规则 5-2-1）：
   *   = 间合里的结晶数 + 各种效果造成的修正（distanceMod）
   * 修正不需要搬结晶，是凭空加上去的，效果结束就消失。
   */
  function effDistance(state) {
    const d = state.distance + (state.distanceMod || 0);
    return Math.max(0, Math.min(10, d));
  }

  /** 达人距离：默认 2，付与札可以加（例如圏域 +1） */
  function taijinOf(state) {
    let base = 2;
    state.players.forEach(function (p) {
      (p.attachments || []).forEach(function (a) {
        const e = (Engine.effects && Engine.effects.cards && Engine.effects.cards[a.id]);
        if (e && e.taijinPlus) base += e.taijinPlus;
      });
    });
    return base;
  }

  function canBasic(state, who, which) {
    const b = BASIC[which];
    if (!b) return false;
    const p = state.players[who];
    if (p.focus < 1) return false;
    return b.need(state, p);
  }

  /** 执行一个基本动作 */
  /**
   * 执行基本动作。
   *
   * 规则 9-6-ⅱ：标准行动里做基本动作，代价**二选一**：
   *   ⅱ-A 花 1 点集中力
   *   ⅱ-B 把 1 张手牌盖成伏札
   * （卡牌效果送的基本动作不用付）
   */
  function basicAction(state, who, which, opts) {
    opts = opts || {};
    const free = !!opts.free;
    const b = BASIC[which];
    if (!b) return { ok: false, error: '没有这个动作：' + which };

    const p = state.players[who];
    if (p.terminated) return { ok: false, error: '终端：本回合不能再使用牌或做基本动作' };
    // 用了《全力》卡之后就进入全力行动，不能再做基本动作
    if (p.fullpowerUsed) return { ok: false, error: '全力行动：本回合已经用过牌了' };
    if (!b.need(state, p)) return { ok: false, error: b.name + '的条件不满足' };

    if (!free) {
      const pay = opts.pay || 'focus';
      if (pay === 'hand') {
        const idx = handIndexOf(p, opts.cardId);
        if (idx < 0) return { ok: false, error: '要付的手牌不在手上' };
        const card = p.hand.splice(idx, 1)[0];
        p.hidden.push(card);
      } else {
        if (p.focus < 1) return { ok: false, error: '集中力不足（也可以改用手牌付）' };
        p.focus -= 1;
      }
    }

    p.usedBasicThisTurn = true;
    b.apply(state, p, who);
    Engine.state.emit(state, 'basic', { who: who, which: which });
    log(state, 'P' + (who + 1) + ' ' + b.name + (free ? '（免费）' : ''));
    return { ok: true };
  }

  /**
   * 重新确认适正距离（规则 9-4-ⅲ）。
   * 对应把间合改了（例如見切り）之后要再查一次，打不到就落空。
   */
  function recheckRange(state) {
    const pd = state.pending;
    if (!pd || pd.cancelled) return false;
    if (!pd.range || pd.range.indexOf(effDistance(state)) >= 0) return false;

    log(state, '对应改变了间合，攻击落空（间合 ' + effDistance(state) + '）');
    state.pending = null;
    if (state.attackQueue && state.attackQueue.length) {
      const spec = state.attackQueue.shift();
      Engine.effects.generateAttack(state, pd.attacker, spec);
    }
    return true;
  }

  /* ==========================================================================
   * 五、出牌（攻击 / 行动 / 付与）
   * ==========================================================================
   *
   * 【为什么要用 pending（待处理）这个东西】
   *   一张攻击牌打出去，不是"立刻掉血"，中间还有好几步：
   *
   *     ① 出牌 → ② 对方要不要「对应」 → ③ 受伤方选「装」还是「命」 → 结算完
   *
   *   所以出牌时先把这次攻击记在 state.pending 里，等后面两步做完再清掉。
   *   这就像"正在进行的攻防"，同一时间只会有一次。
   */

  /** 这张牌现在能不能打出去？（距离对不对） */
  function inRange(state, card) {
    // range 为 null 的牌（行动/付与）没有距离要求
    if (!card.range) return true;
    return card.range.indexOf(effDistance(state)) >= 0;
  }

  /**
   * 从手牌里找一张牌（按 id），找不到返回 -1
   * 用 id 而不是下标，是因为手牌会变动，下标不可靠。
   */
  function handIndexOf(player, cardId) {
    return player.hand.findIndex(c => c.id === cardId);
  }

  /**
   * 出牌。这是整个引擎最复杂的一步，顺序如下：
   *
   *   1. 牌在手上吗？
   *   2. 是王牌吗？→ 检查气够不够，扣气
   *   3. 是攻击吗？→ 检查距离
   *   4. 把牌从手牌移到弃牌区（王牌则标记 used）
   *   5. 如果是攻击 → 生成 pending，等对方决定要不要对应
   *      如果是行动 → 直接结算（阶段 3 里还没有行动效果，就先只记账）
   */
  function playCard(state, who, cardId) {
    const p = state.players[who];

    // 牌可能在手牌里，也可能是一张「还没用过的王牌」
    // （王牌不占手牌，放在王牌区，随时可以打）
    let card = null, fromSpecial = false, idx = handIndexOf(p, cardId);
    if (idx >= 0) {
      card = p.hand[idx];
    } else {
      const sp = p.specials.find(s => s.id === cardId && !s.used);
      if (sp) { card = sp; fromSpecial = true; }
    }
    if (!card) return { ok: false, error: '手上没有这张牌' };

    const types = card.types || [];
    const isAttack = types.indexOf('attack') >= 0;
    const isEnhance = types.indexOf('enhance') >= 0;

    // 终端：本回合已经不能再用牌
    if (p.terminated) return { ok: false, error: '终端：本回合不能再使用牌或做基本动作' };
    // 用过《全力》卡之后，本回合能做的只有「结束回合」
    if (p.fullpowerUsed)
      return { ok: false, error: '全力行动：本回合只能结束回合' };
    // 规则 8-2-2：《全力》卡只能在「全力行动」里用。
    // 简化判断：本回合已经出过牌或做过基本动作 → 就进不了全力行动
    if (types.indexOf('fullpower') >= 0 &&
        (state.turnUsed[who] > 0 || p.usedBasicThisTurn)) {
      return { ok: false, error: '《全力》卡只能在全力行动中使用（本回合已经行动过了）' };
    }

    // ---- 「能不能用」的额外条件（例如底力的决死前置） ----
    const table0 = (Engine.effects && Engine.effects.cards) || {};
    const c0 = table0[card.id];
    if (c0 && c0.canUse) {
      const r0 = c0.canUse(state, who, card);
      if (r0 !== true) return { ok: false, error: r0 || '这张牌现在不能使用' };
    }

    // ---- 王牌要付费用（气）；有些牌的费用是动态的 ----
    let cost = card.cost || 0;
    if (card.kind === 'special') {
      if (c0 && c0.cost) cost = Math.max(0, c0.cost(state, who, card));
      if (p.flare < cost) return { ok: false, error: '气不够（需要 ' + cost + '）' };
    }

    // ---- 攻击要检查距离 ----
    if (isAttack && !inRange(state, card)) {
      return { ok: false, error: '距离 ' + effDistance(state) + ' 不在适正距离内' };
    }

    // 《终端》：使用之后本回合不能再出牌、也不能做基本动作（规则 9-2）。
    // 注意付与牌会在后面提前 return，所以这里就要记上，不能等到最后
    if (types.indexOf('terminal') >= 0) p.terminated = true;

    // ---- 付与：先检查总量，再让玩家自己决定「虚取几颗、装取几颗」 ----
    if (isEnhance) {
      const cap = card.capacity || 0;
      if (state.dust + p.aura < cap) {
        return { ok: false, error: '虚和装的结晶不够放「纳 ' + cap + '」' };
      }
      // 把牌暂时留在手里，等玩家分配完再真正展开
      state.nabu = {
        who: who,
        cardId: card.id,
        cap: cap,
        maxDust: Math.min(state.dust, cap),
        maxAura: Math.min(p.aura, cap)
      };
      log(state, 'P' + (who + 1) + ' 准备展开「' + card.name + '」，请分配 ' + cap + ' 颗结晶');
      return { ok: true, needNabu: true };
    }

    // ============================================================
    // 到这里所有检查都过了，下面开始真正改动状态
    // ============================================================

    if (card.kind === 'special') {
      // 用上面算好的 cost（可能是动态费用）
      p.flare -= cost;
      state.dust += cost;        // 付出去的气变成虚里的结晶
      log(state, '支付 ' + cost + ' 点气 → 虚 +' + cost);
    }

    if (!fromSpecial) {
      p.hand.splice(idx, 1);
      Engine.state.emit(state, 'cardTo', { who: who, cardId: card.id, to: 'discard' });
    }
    state.turnUsed[who] = (state.turnUsed[who] || 0) + 1;
    if ((card.types || []).indexOf('fullpower') >= 0) {
      p.fullpowerUsed = true;
      log(state, '全力行动：本回合不能再使用其他牌或基本动作');
    }
    log(state, 'P' + (who + 1) + ' 打出「' + card.name + '」');
    Engine.state.emit(state, 'play', { who: who, cardId: card.id, name: card.name });

    // ---- 王牌用掉后进"已使用"，通常札进弃牌区 ----
    if (card.kind === 'special') {
      const sp = p.specials.find(s => s.id === card.id);
      if (sp) sp.used = true;
    } else {
      p.discard.push(card);
    }

    // ---- 攻击 → 进入待处理，等对方决定要不要对应 ----
    if (isAttack) {
      const dmg = card.damage || { aura: 0, life: 0 };
      // 规则 6-4-1-4：装伤上限 5；规则 10-21：带「超克」时上限取消
      // 「本回合下一次攻击 +X/+Y」这类加成先叠上去，然后清空
      const buff = p.buff || { aura: 0, life: 0 };
      // 「-」要在后面保持 null（代表"没有这条伤害"），不能变成 0
      const ctx = {
        aura: (dmg.aura === null || dmg.aura === undefined) ? null : dmg.aura + (buff.aura || 0),
        life: (dmg.life === null || dmg.life === undefined) ? null : dmg.life + (buff.life || 0),
        range: (card.range || []).slice(),
        chokoku: false,
        both: false,
        tags: {}
      };
      p.buff = { aura: 0, life: 0 };
      // 常时效果（例如决死加伤）在这里算
      const eff = table0[card.id];
      if (eff && eff.onAttack) eff.onAttack(state, who, ctx, card);
      // 【展开中】效果：自己场上的付与札也能改这次攻击
      (p.attachments || []).forEach(function (a) {
        const ae = table0[a.id];
        if (ae && ae.onModifyAttack) ae.onModifyAttack(state, who, ctx, card, a);
      });
      // 気迫 给的「下一次其他女神的攻击」加成
      const na = p.nextOtherAttack;
      if (na) {
        const g = String(card.id).split('-')[1];
        if (g !== 'yurina') {
          if (ctx.range.length) {
            const mn = Math.min.apply(null, ctx.range);
            if (mn - 1 >= 0) ctx.range.push(mn - 1);   // 距离扩大（近1）
          }
          if (na.bonus) { ctx.aura += na.bonus.aura || 0; ctx.life += na.bonus.life || 0; }
          if (na.noRespond) ctx.noRespondNormal = true;
          p.nextOtherAttack = null;
          log(state, '気迫：这次攻击不可被通常札对应，且距离扩大（近1）');
        }
      }

      if (ctx.aura !== null && !ctx.chokoku && ctx.aura > 5) ctx.aura = 5;
      state.pending = {
        kind: 'attack',
        attacker: who,
        defender: 1 - who,
        cardId: card.id,
        cardName: card.name,
        damage: { aura: ctx.aura, life: ctx.life },
        both: !!ctx.both,
        noRespond: ctx.noRespond ? true : (ctx.noRespondNormal ? 'normal' : false),
        range: ctx.range,
        chokoku: ctx.chokoku,
        card: card,
        stage: 'respond',
        responded: false
      };
      return { ok: true };
    }

    // ---- 行动牌：走它自己的【使用时】效果 ----
    const effAction = table0[card.id];
    if (effAction && effAction.onUse) {
      effAction.onUse(state, who, card);
    } else {
      log(state, '「' + card.name + '」暂时没有实装效果');
    }
    return { ok: true };
  }

  /**
   * 对方响应攻击：要不要用一张「对应」牌。
   *
   * @param {string|null} cardId 用哪张对应牌；传 null 表示"不对应"
   *
   * 注意：对应的具体效果（比如"被对应的攻击 -2/+0"）属于**卡牌效果**，
   * 阶段 5 才做。这里只负责：
   *   - 检查这张牌能不能对应
   *   - 把它打进弃牌区
   *   - 把攻击推进到"选伤害"这一步
   */
  function respond(state, who, cardId) {
    const pd = state.pending;
    if (!pd || pd.kind !== 'attack') return { ok: false, error: '现在没有待处理的攻击' };
    if (pd.defender !== who) return { ok: false, error: '只有被攻击的一方才能对应' };
    if (pd.stage !== 'respond') return { ok: false, error: '已经过了对应时机' };

    if (cardId) {
      if (pd.noRespond === true) return { ok: false, error: '这次攻击不可被对应' };
      const p = state.players[who];

      // 对应牌可能来自手牌，也可能是还没用过的王牌
      let card = null, fromSpecial = false;
      const idx = handIndexOf(p, cardId);
      if (idx >= 0) {
        card = p.hand[idx];
      } else {
        const sp = p.specials.find(s => s.id === cardId && !s.used);
        if (sp) { card = sp; fromSpecial = true; }
      }
      if (!card) return { ok: false, error: '没有这张牌' };

      // 有《对应》类型，或者效果自己声明了"可以当对应用"
      let canReact = (card.types || []).indexOf('reaction') >= 0;
      const rtab = (Engine.effects && Engine.effects.cards) || {};
      const rcard = rtab[card.id];
      if (!canReact && rcard && rcard.canRespond) canReact = !!rcard.canRespond(state, who);
      if (!canReact) return { ok: false, error: '这张牌没有《对应》' };

      // 对应牌自己的使用条件（例如氷雨只能对应王牌）
      const etable = (Engine.effects && Engine.effects.cards) || {};
      const ecard = etable[card.id];
      if (ecard && ecard.canUse) {
        const cr = ecard.canUse(state, who, card);
        if (cr !== true) return { ok: false, error: cr || '这张牌现在不能使用' };
      }
      if (pd.noRespond === 'normal' && card.kind === 'normal')
        return { ok: false, error: '这次攻击不可被通常札对应' };

      // 王牌当对应用，一样要付气，付掉的气进虚
      if (fromSpecial) {
        const cost = card.cost || 0;
        if (p.flare < cost) return { ok: false, error: '气不够（需要 ' + cost + '）' };
        p.flare -= cost;
        state.dust += cost;
        const sp = p.specials.find(s => s.id === card.id);
        if (sp) sp.used = true;
        log(state, '支付 ' + cost + ' 点气 → 虚 +' + cost);
      } else {
        p.hand.splice(idx, 1);
        p.discard.push(card);
      }

      pd.responded = true;
      pd.responseCardId = card.id;
      Engine.state.emit(state, 'respond', { who: who, cardId: card.id });
      pd.responseCard = card;

      // 对应牌自己的效果：先走"使用它"的效果，再算减伤
      const rtable = (Engine.effects && Engine.effects.cards) || {};
      const re = rtable[card.id];
      if (re && re.onUse) re.onUse(state, who, card);
      if (re && re.onRespond) re.onRespond(state, who, pd, card);

      // 如果这张对应牌本身是《攻击》牌，并且其效果写明"作为对应时使用"，
      // 那么它自己的攻击要先打出来（嵌套解决），打完才轮到原攻击
      if (re && re.attackOnRespond && (card.types || []).indexOf('attack') >= 0) {
        const dmg = card.damage || { aura: 0, life: 0 };
        state.attackStack = state.attackStack || [];
        state.attackStack.push(pd);
        const np = Engine.effects.generateAttack(state, who, {
          cardId: card.id,
          name: card.name,
          range: (card.range || []).slice(),
          aura: dmg.aura, life: dmg.life,
          noRespond: true
        });
        if (np) np.fromResponse = true;
        log(state, '「' + card.name + '」作为对应，先打出自己的攻击');
        return { ok: true };
      }

      // 其余情况：对应牌的【攻击后】当场结算（嵌套）
      if (re && re.onAfterAttack) {
        re.onAfterAttack(state, who, Object.assign({}, pd, { usedAsResponse: true }));
      }

      log(state, 'P' + (who + 1) + ' 用「' + card.name + '」对应');
    } else {
      log(state, 'P' + (who + 1) + ' 不对应');
    }

    // 对应可能改变了间合（例如見切り），所以要重新确认适正距离（规则 9-4-ⅲ）
    if (!pd.cancelled && pd.range && pd.range.indexOf(effDistance(state)) < 0) {
      log(state, '对应改变了间合，攻击落空（间合 ' + state.distance + '）');
      state.pending = null;
      if (state.attackQueue && state.attackQueue.length) {
        const spec = state.attackQueue.shift();
        Engine.effects.generateAttack(state, pd.attacker, spec);
      }
      return { ok: true };
    }

    // 对应牌打出了新攻击 → 原攻击挂起，等它打完再继续（嵌套解决）
    if (state.pending && state.pending !== pd) {
      state.pending.noRespond = state.pending.noRespond || true;
      state.attackStack = state.attackStack || [];
      state.attackStack.push(pd);
      return { ok: true };
    }

    // 被打消了：不结算伤害，也不触发【攻击后】
    if (pd.cancelled) {
      log(state, '这次的《攻击》被打消了');
      Engine.state.emit(state, 'cancel', { who: pd.defender });
      state.pending = null;
      if (state.attackQueue && state.attackQueue.length) {
        const nextSpec = state.attackQueue.shift();
        Engine.effects.generateAttack(state, pd.attacker, nextSpec);
      }
      return { ok: true };
    }

    pd.stage = 'damage';          // 进入"选伤害"
    return { ok: true };
  }

  /**
   * 受伤方选择如何分配伤害，攻击就此结束。
   *
   * @param {'aura'|'life'} choice
   */
  function resolveDamage(state, who, choice) {
    const pd = state.pending;
    if (!pd || pd.kind !== 'attack') return { ok: false, error: '没有待结算的攻击' };
    if (pd.defender !== who) return { ok: false, error: '只有被攻击的一方能选' };
    if (pd.stage !== 'damage') return { ok: false, error: '还没到选伤害的时候' };

    const dmg = pd.damage;

    // 有「这张牌上的结晶视为在装中」的付与札（無音壁）时，
    // 装伤由玩家自己决定：多少从真装扣、多少从那张牌上扣
    if (choice === 'aura' && shadowAura(state, who) > 0) {
      pd.stage = 'auraSplit';
      state.auraSplit = { who: who, total: dmg.aura, maxAttach: Math.min(shadowAura(state, who), dmg.aura) };
      return { ok: true };
    }

    const ok = applyDamage(state, who, dmg.aura, dmg.life, pd.both ? 'both' : choice);
    if (!ok) return { ok: false, error: '装不够，不能选装' };

    return finishAttack(state, pd, who);
  }

  /**
   * 一次攻击的收尾：攻击后 → 接回外层 / 多段 → 即再起。
   * resolveDamage 和「装伤分配」都会走到这里。
   */
  function finishAttack(state, pd, who) {
    // 【攻击后】效果（规则 9-4-ⅶ）——先跑，因为它可能生成新的攻击
    const table = (Engine.effects && Engine.effects.cards) || {};
    if (pd.cardId && table[pd.cardId] && table[pd.cardId].onAfterAttack)
      table[pd.cardId].onAfterAttack(state, pd.attacker,
        Object.assign({}, pd, { usedAsResponse: !!pd.fromResponse }));

    // 只有"还是这次攻击"时才清空
    if (state.pending === pd) state.pending = null;

    // 攻击后生成了新攻击（八方振り / 石突き的追击 / 破弃时）→ 让它先打完，
    // 外层攻击还挂在栈里等
    if (state.pending) {
      tryRevive(state, 1 - who);
      tryRevive(state, who);
      return { ok: true };
    }

    // 嵌套打完了 → 把挂起的原攻击接回来
    while (!state.pending && state.attackStack && state.attackStack.length) {
      const outer = state.attackStack.pop();
      outer.stage = 'damage';
      state.pending = outer;
      if (!recheckRange(state)) break;   // 落空了就继续取下一个
    }
    if (state.pending) {
      tryRevive(state, 1 - who);
      tryRevive(state, who);
      return { ok: true };
    }

    // 多段攻击队列（律動弧戟那种）
    if (state.attackQueue && state.attackQueue.length) {
      const nextSpec = state.attackQueue.shift();
      Engine.effects.generateAttack(state, pd.attacker, nextSpec);
      return { ok: true };
    }

    tryRevive(state, 1 - who);    // 伤害之后检查「即再起」
    tryRevive(state, who);
    return { ok: true };
  }

  /**
   * 「装伤分配」：玩家决定多少从真装扣、多少从無音壁那张牌上扣。
   */
  function resolveAuraSplit(state, who, fromAttach) {
    const sp = state.auraSplit;
    if (!sp || sp.who !== who) return { ok: false, error: '现在没有要分配的装伤' };
    const pd = state.pending;
    if (!pd || pd.stage !== 'auraSplit') return { ok: false, error: '现在没有待结算的装伤' };

    fromAttach = Math.max(0, fromAttach | 0);
    if (fromAttach > sp.maxAttach) return { ok: false, error: '这张牌上没那么多结晶' };
    const fromAura = sp.total - fromAttach;
    if (fromAura < 0) return { ok: false, error: '分配不对' };
    if (fromAura > state.players[who].aura) return { ok: false, error: '装不够' };

    // 先从付与札上扣
    if (fromAttach > 0) {
      let left = fromAttach;
      const p = state.players[who];
      const keep = [];
      (p.attachments || []).forEach(function (a) {
        const e = (Engine.effects && Engine.effects.cards && Engine.effects.cards[a.id]);
        if (left > 0 && e && e.auraShield) {
          const take = Math.min(a.crystals, left);
          a.crystals -= take; left -= take;
          state.dust += take;
        }
        if (a.crystals > 0) keep.push(a);
        else p.discard.push(Object.assign({}, a, { crystals: 0 }));
      });
      p.attachments = keep;
    }
    if (fromAura > 0) moveCrystal(state, who, 'aura', 'dust', fromAura);

    Engine.state.emit(state, 'damage', { who: who, kind: 'aura', n: sp.total });
    log(state, 'P' + (who + 1) + ' 装伤 -' + sp.total +
      '（真装 -' + fromAura + '，付与札 -' + fromAttach + '）');

    state.auraSplit = null;
    pd.stage = 'damage';
    return finishAttack(state, pd, who);
  }

  /* ==========================================================================
   * 五·四、畏缩
   * ==========================================================================
   *
   * 畏缩是状态，不是伤害。中了之后直到被清除前，某些效果会触发。
   * 这里只负责"挂上 + 发事件"，具体影响由卡牌效果判断。
   */
  function stagger(state, who) {
    state.players[who].staggered = true;
    Engine.state.emit(state, 'stagger', { who: who });
    log(state, 'P' + (who + 1) + ' 畏缩');
  }

  /* ==========================================================================
   * 五·五、再起 / 即再起
   * ==========================================================================
   *
   * 王牌用掉之后不是就永远没了。
   *
   *   【再起】   在自己的回合，满足条件时可以把这张王牌恢复成未使用
   *   【即再起】 条件一满足就立刻恢复（不用等回合）
   *
   * 这里只管"检查条件 → 恢复"。
   * 每张王牌的条件写在 Engine.effects.revive[cardId] 里（阶段 5 填），
   * 现在表是空的，所以暂时没有王牌会自动恢复。
   */
  function tryRevive(state, who, mode) {
    const p = state.players[who];
    const table = (Engine.effects && Engine.effects.revive) || {};
    let revived = 0;
    p.specials.forEach(function (sp) {
      if (!sp.used || !sp.revive) return;
      // mode: 'normal' = 结束阶段的再起；'instant' = 随时触发的即再起
      if (mode && sp.revive !== mode) return;
      const cond = table[sp.id];
      if (typeof cond !== 'function') return;
      if (cond(state, who, sp)) {
        sp.used = false;
        revived++;
        log(state, '「' + sp.name + '」再起');
      }
    });
    return revived;
  }

  /* ==========================================================================
   * 六、胜负
   * ========================================================================== */

  /**
   * 检查有没有人倒下。
   * 命 ≤ 0 就输。两人同时倒下算平局（winner = -1）。
   */
  function checkWin(state) {
    if (state.winner !== null) return;

    const dead = state.players
      .map((p, i) => (p.life <= 0 ? i : -1))
      .filter(i => i >= 0);

    if (dead.length === 1) {
      state.winner = 1 - dead[0];
      log(state, 'P' + (state.winner + 1) + ' 获胜');
    } else if (dead.length === 2) {
      state.winner = -1;
      log(state, '双方同时倒下，平局');
    }
  }

  /* ==========================================================================
   * 导出
   * ========================================================================== */
  Engine.rules = {
    // 抽牌
    draw, reshuffle, sufferExhaustion,
    // 伤害
    applyDamage, canTakeAura,
    // 回合
    startTurn, endTurn, tickAttachments,
    // 基本动作
    BASIC, canBasic, basicAction, hideCard, taijinOf, shadowAura, moveCrystal, recheckRange, effDistance, resolveAuraSplit, confirmNabu, cancelNabu, confirmEndTurn,
    // 再起
    tryRevive, stagger,
    // 出牌与攻防
    inRange, playCard, respond, resolveDamage,
    // 胜负
    checkWin
  };
})(typeof window !== 'undefined' ? window : globalThis);
