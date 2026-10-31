/* ============================================================================
 * engine/effects.js —— 卡牌效果
 * ============================================================================
 *
 * 【这个文件干什么】
 *   每张卡"具体做什么"，一行一行写清楚。
 *
 * 【为什么要按 cardId 建表】
 *   因为卡的效果太自由了，没有通用的解析方式。
 *   一张卡一个函数，是这类游戏最省心的写法。
 *
 * 【四女神的关键词】
 *   决死（ユリナ）：自命 ≤ 3
 *   八相（サイネ）：自装 ≤ 1
 *   连火（ヒミカ）：本回合使用的第 3 张以后的牌
 *   境地（トコヨ）：自集中力 = 2
 *
 * 【效果时机】
 *   onAttack(state, who, ctx, card)       出攻击牌时，改 ctx 里的数值（常时）
 *   onAfterAttack(state, who, pd)         攻击结算完之后
 *   onBreak(state, who, attach)           付与札结晶耗尽、破弃时
 *   onUse(state, who, card)               行动牌使用后
 * ========================================================================== */

(function (root) {
  const Engine = (root.Engine = root.Engine || {});

  /* ---------- 关键词条件 ---------- */

  /** 决死：你自己的命（ライフ）≤ 3 */
  function kesshi(state, who) {
    return state.players[who].life <= 3;
  }

  /** 八相：你自己的装（オーラ）≤ 1 */
  function hassou(state, who) {
    return state.players[who].aura <= 1;
  }

  /** 境地：你自己的集中力 = 2 */
  function kyouchi(state, who) {
    return state.players[who].focus === 2;
  }

  /** 连火：这是本回合你使用的第 3 张以后的牌（own 计数从 1 开始） */
  function renka(state, who) {
    return (state.turnUsed || [0, 0])[who] >= 3;
  }

  /* ==========================================================================
   * 效果工具集（Engine.fx）
   * ==========================================================================
   *
   * 卡牌效果千变万化，但底层动作其实就那么几种：
   *   抽牌、加集中力、加气、造成伤害、生成攻击、搬结晶、让对手畏缩、重组牌库……
   *
   * 这里把它们各做成一个小函数，写卡的时候直接调用，不用每次重写一遍细节。
   * ========================================================================== */
  const fx = {

    /** 抽 n 张（会自己处理焦燥） */
    draw(state, who, n) {
      return Engine.rules.draw(state, who, n);
    },

    /** 获得集中力（畏缩中会先解除畏缩，规则 5-1-4） */
    gainFocus(state, who, n) {
      const p = state.players[who];
      for (let i = 0; i < (n || 1); i++) {
        if (p.staggered) { p.staggered = false; log(state, 'P' + (who + 1) + ' 解除畏缩'); }
        else if (p.focus < Engine.state.INIT.FOCUS_MAX) p.focus++;
      }
    },

    /** 失去集中力 */
    loseFocus(state, who, n) {
      const p = state.players[who];
      p.focus = Math.max(0, p.focus - (n || 1));
    },

    /** 气 +n（直接从虚取，气没有上限） */
    gainFlare(state, who, n) {
      const p = state.players[who];
      const take = Math.min(state.dust, n || 1);
      state.dust -= take;
      p.flare += take;
    },

    /** 直接造成伤害（不是攻击，不走对应流程） */
    damage(state, who, aura, life, choice) {
      return Engine.rules.applyDamage(state, who, aura, life, choice || 'life');
    },

    /** 让某个玩家畏缩 */
    stagger(state, who) {
      return Engine.rules.stagger(state, who);
    },

    /** 生成一次攻击（走完整流程） */
    attack(state, who, spec) {
      return generateAttack(state, who, spec);
    },

    /** 搬结晶：from/to ∈ dust/distance/aura/flare/life */
    moveCrystal(state, who, from, to, n) {
      const p = state.players[who];
      const get = (k) => (k === 'dust' || k === 'distance') ? state[k] : p[k];
      const set = (k, v) => { if (k === 'dust' || k === 'distance') state[k] = v; else p[k] = v; };
      let num = Math.min(get(from), n || 1);
      // 目标区域有上限：装 5、间合 10。
      // 收不下的**留在原处**——全场结晶总数永远是 36 颗，不会凭空消失。
      if (to === 'aura') num = Math.min(num, Engine.state.INIT.AURA_MAX - p.aura);
      if (to === 'distance') num = Math.min(num, 10 - state.distance);
      if (num <= 0) return 0;
      set(from, get(from) - num);
      set(to, get(to) + num);
      Engine.state.emit(state, 'move', { who: who, from: from, to: to, n: num });
      return num;
    },

    /** 弃手牌 */
    discardHand(state, who, n, filter) {
      const p = state.players[who];
      let done = 0;
      for (let i = p.hand.length - 1; i >= 0 && done < (n || 1); i--) {
        const c = p.hand[i];
        if (filter && !filter(c)) continue;
        p.hand.splice(i, 1);
        p.discard.push(c);
        done++;
      }
      return done;
    },

    /** 盖成伏札 */
    hideHand(state, who, n, filter) {
      const p = state.players[who];
      let done = 0;
      for (let i = p.hand.length - 1; i >= 0 && done < (n || 1); i--) {
        const c = p.hand[i];
        if (filter && !filter(c)) continue;
        p.hand.splice(i, 1);
        p.hidden.push(c);
        done++;
      }
      return done;
    },

    /** 重组牌库（规则 9-7：由规则生成的再构成要先失去 1 点命） */
    reshuffle(state, who) {
      return Engine.rules.reshuffle(state, who, true);
    },

    /** 让玩家做选择：options 是 {id: 显示文字} */
    ask(state, who, sourceId, prompt, options) {
      state.choice = {
        who: who,
        sourceId: sourceId,
        prompt: prompt,
        options: options
      };
    }
  };

  /**
   * 选择分支表：sourceId → { optionId: function(state, who) }
   * 卡牌效果里用 fx.ask 提问，玩家点了哪个就执行对应的函数。
   */
  const choices = {};

  // 回合开始时的「要不要重组牌库」
  choices.reshuffle = {
    yes(state, who) {
      Engine.rules.reshuffle(state, who, true);
      Engine.rules.draw(state, who, Engine.state.INIT.TURN_DRAW);
    },
    no(state, who) {
      Engine.rules.draw(state, who, Engine.state.INIT.TURN_DRAW);
    }
  };

  /** 解决一次选择 */
  function resolveChoice(state, who, optionId) {
    const c = state.choice;
    if (!c) return { ok: false, error: '现在没有待选择的事项' };
    if (c.who !== who) return { ok: false, error: '不该由你来选' };
    if (!c.options || c.options.indexOf(optionId) < 0)
      return { ok: false, error: '没有这个选项：' + optionId };

    const table = choices[c.sourceId] || {};
    state.choice = null;
    if (table[optionId]) table[optionId](state, who);
    return { ok: true };
  }

  /** 小工具：写日志 */
  function log(state, msg) { Engine.state.log(state, msg); }

  /* ---------- 一张卡一个函数 ---------- */

  const cards = {

    /* ===== 摇波 ===== */

    // 斬：纯攻击，没有效果（4-1 不需要写）
    // "01-yurina-o-n-1": {},

    // 一閃：【常时】决死 → 此攻击 +1/+0
    "01-yurina-o-n-2": {
      onAttack(state, who, ctx) {
        if (kesshi(state, who)) { ctx.aura += 1; }
      }
    },

    // 柄打ち：【攻击后】决死 → 本回合你下一次《攻击》+1/+0
    "01-yurina-o-n-3": {
      onAfterAttack(state, who) {
        if (kesshi(state, who)) {
          const p = state.players[who];
          p.buff = p.buff || { aura: 0, life: 0 };
          p.buff.aura += 1;
          Engine.state.log(state, '决死发动：下一次《攻击》+1/+0');
        }
      }
    },

    // 圧気（付与・纳2）：【破弃时】进行一次 1-4、3/- 的攻击
    "01-yurina-o-n-6": {
      onBreak(state, who) {
        generateAttack(state, who, {
          name: '圧気（破弃）', range: [1, 2, 3, 4], aura: 3, life: 0
        });
      }
    },

    // 居合：全力 + 【常时】间合 ≤2 时 -1/-1
    "01-yurina-o-n-4": {
      onAttack(state, who, ctx) {
        if (state.distance <= 2) { ctx.aura = Math.max(0, ctx.aura - 1); ctx.life = Math.max(0, ctx.life - 1); }
      }
    },

    // 気迫（行动）：获得 1 集中力；本回合下一次"其他女神"的攻击
    //   获得「不可被对应（通常札）」与「距离扩大（近1）」
    "01-yurina-o-n-5": {
      onUse(state, who) {
        const fx = Engine.effects.fx;
        fx.gainFocus(state, who, 1);
        state.players[who].nextOtherAttack = { noRespond: 'normal', near: 1 };
        Engine.state.log(state, '本回合下一次其他女神的《攻击》+不可被对应（通常札）+距离扩大（近1）');
      }
    },

    // 気炎万丈（付与・纳4・全力）：【展开中】决死 → 你"其他女神"的攻击 +1/+1 且获得超克
    "01-yurina-o-n-7": {
      onModifyAttack(state, who, ctx, card) {
        if (!kesshi(state, who)) return;
        const g = (card && card.id || '').split('-')[1];
        if (g === 'yurina') return;            // 只对自己以外的女神生效
        ctx.aura += 1;
        ctx.life += 1;
        ctx.chokoku = true;
      }
    },

    // 浦波嵐（王牌攻击・对应）：【攻击后】被对应的攻击 -2/+0
    "01-yurina-o-s-2": {
      onRespond(state, who, pd) {
        pd.damage.aura = Math.max(0, pd.damage.aura - 2);
        Engine.state.log(state, '浦波嵐：被对应的攻击 -2/+0');
      }
    },

    // 浮舟宿（王牌行动・费2）：虚（5）→ 自装
    "01-yurina-o-s-3": {
      onUse(state, who) {
        Engine.effects.fx.moveCrystal(state, who, 'dust', 'aura', 5);
      }
    },

    // 天音揺波の底力（王牌攻击・全力）：【常时】不是决死就不能用
    "01-yurina-o-s-4": {
      canUse(state, who) {
        if (!kesshi(state, who)) return '决死未达成（自命不是 3 以下），不能使用此牌';
        return true;
      }
    },

    /* ===== 细音 ===== */

    // 八方振り：【攻击后】八相 → 再打一次 4-5、2/1
    "02-saine-o-n-1": {
      onAfterAttack(state, who) {
        if (hassou(state, who)) {
          generateAttack(state, who, { name: '八方振り（追加）', range: [4, 5], aura: 2, life: 1 });
        }
      }
    },

    // 石突き：【攻击后】若这张牌是以《对应》使用的 → 攻击 3-5、2/1、不可被对应
    "02-saine-o-n-3": {
      onAfterAttack(state, who, pd) {
        if (pd && pd.usedAsResponse) {
          generateAttack(state, who, { name: '石突き（对应后）', range: [3, 4, 5], aura: 2, life: 1, noRespond: true });
        }
      }
    }
  };

  /* ---------- 效果生成的攻击 ---------- */

  /**
   * 由卡牌效果生成的攻击（规则 10-5）。
   * 这类攻击没有"卡"，但仍然要走「适正距离确认 → 对应 → 伤害」的流程。
   */
  function generateAttack(state, who, spec) {
    if (spec.range.indexOf(state.distance) < 0) {
      Engine.state.log(state, '「' + spec.name + '」因距离不符取消（间合 ' + state.distance + '）');
      return null;
    }
    state.pending = {
      kind: 'attack',
      attacker: who,
      defender: 1 - who,
      cardId: null,
      cardName: spec.name,
      damage: { aura: Math.min(spec.aura || 0, 5), life: spec.life || 0 },
      range: spec.range.slice(),
      noRespond: !!spec.noRespond,
      stage: 'respond',
      responded: false,
      generated: true
    };
    Engine.state.log(state, '生成攻击「' + spec.name + '」');
    return state.pending;
  }

  /* ---------- 再起条件（10-7 / 10-8） ---------- */

  const revive = {
    // 浮舟宿【即再起】决死：自命 ≤ 3
    "01-yurina-o-s-3": (state, who) => state.players[who].life <= 3,
    // 音無砕氷【再起】八相：自装 ≤ 1
    "02-saine-o-s-3": (state, who) => state.players[who].aura <= 1,
    // 真紅領域【再起】
    "03-himika-o-s-4": (state, who) => state.players[who].hand.length === 0,
    // 無窮ノ風【再起】境地：自集中力 = 2
    "04-tokoyo-o-s-3": (state, who) => state.players[who].focus === 2
  };

  Engine.effects = { cards, revive, choices, resolveChoice, fx,
    kesshi, hassou, kyouchi, renka, generateAttack };
})(typeof window !== 'undefined' ? window : globalThis);
