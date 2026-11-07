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
      // スモーク：箭头效果不能把间合的结晶移走
      if (from === 'distance') {
        const blocked = (p.attachments || []).some(function (a) {
          const e = (Engine.effects.cards || {})[a.id];
          return e && e.blockArrowFromDistance;
        });
        if (blocked) {
          Engine.state.log(state, '「スモーク」：间合的结晶不能被箭头移动');
          return 0;
        }
      }

      const want2 = (n === undefined || n === null) ? 1 : n;
      let num = Math.min(get(from), want2);
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

    /** 加伤：本回合下一次《攻击》+X/+Y */
    boost(state, who, aura, life) {
      const p = state.players[who];
      p.buff = p.buff || { aura: 0, life: 0 };
      p.buff.aura += (aura || 0);
      p.buff.life += (life || 0);
      Engine.state.log(state, '本回合下一次《攻击》+' + (aura||0) + '/+' + (life||0));
    },

    /** 减伤／加伤：直接改一次正在进行中的攻击（对应时用） */
    modifyAttack(pd, aura, life) {
      pd.damage.aura = Math.max(0, pd.damage.aura + (aura || 0));
      pd.damage.life = Math.max(0, pd.damage.life + (life || 0));
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

  // 詩舞：选一项
  choices.shibu = {
    // 自气 → 自装
    flare_to_aura(state, who) { Engine.effects.fx.moveCrystal(state, who, 'flare', 'aura', 1); },
    // 自装 → 间合
    aura_to_dist(state, who) { Engine.effects.fx.moveCrystal(state, who, 'aura', 'distance', 1); }
  };

  // スカーレットイマジン：把选中的那张手牌盖成伏札
  // 雪姬：闭时的ふりはらい —— 虚⇄间合 1，自己选方向
  choices.yukihi_slide = {
    dust_to_dist(state, who) { Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 1); },
    dist_to_dust(state, who) { Engine.effects.fx.moveCrystal(state, who, 'distance', 'dust', 1); }
  };

  // 莱拉
  choices.raira_gauge1 = {
    wind(state, who) { Engine.gauge.add(state, who, 'wind', 1); },
    thunder(state, who) { Engine.gauge.add(state, who, 'thunder', 1); }
  };
  choices.raira_yobigoe = {
    both(state, who) {
      Engine.gauge.add(state, who, 'wind', 1);
      Engine.gauge.add(state, who, 'thunder', 1);
    },
    double(state, who) {
      const p = state.players[who];
      while (p.hand.length) p.hidden.push(p.hand.pop());
      Engine.gauge.set(state, who, 'thunder', Engine.gauge.thunder(state, who) * 2);
      Engine.state.log(state, '呼び声：手牌全部盖伏，雷神翻倍');
    }
  };
  choices.raira_sorakake = {
    to_dist(state, who) { Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 2); },
    to_dust(state, who) { Engine.effects.fx.moveCrystal(state, who, 'distance', 'dust', 2); }
  };
  choices.raira_enkan = {
    yes(state, who) {
      state.choice = {
        who: who, sourceId: 'raira_enkan_dir',
        prompt: '円環輪廻旋：间合⇄虚 1，往哪边？',
        options: ['to_dist', 'to_dust']
      };
    },
    no(state, who) {}
  };
  choices.raira_enkan_dir = {
    to_dist(state, who) {
      Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 1);
      Engine.gauge.add(state, who, 'wind', 1);
    },
    to_dust(state, who) {
      Engine.effects.fx.moveCrystal(state, who, 'distance', 'dust', 1);
      Engine.gauge.add(state, who, 'wind', 1);
    }
  };
  choices.raira_tengu = {
    to_dist(state, who) { Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 2); },
    to_dust(state, who) { Engine.effects.fx.moveCrystal(state, who, 'distance', 'dust', 2); },
    one_dist(state, who) { Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 1); },
    one_dust(state, who) { Engine.effects.fx.moveCrystal(state, who, 'distance', 'dust', 1); }
  };

  choices.imagine = {};
  choices.imagine.resolve = function (state, who, optionId) {
    const p = state.players[who];
    const i = p.hand.findIndex(function (c) { return c.id === optionId; });
    if (i < 0) return false;
    const card = p.hand.splice(i, 1)[0];
    p.hidden.push(card);
    Engine.state.log(state, '把「' + card.name + '」盖成伏札');
    return true;
  };


  // スカーレットイマジン：把选中的那张手牌盖成伏札
  // 雪姬：闭时的ふりはらい —— 虚⇄间合 1，自己选方向
  choices.yukihi_slide = {
    dust_to_dist(state, who) { Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 1); },
    dist_to_dust(state, who) { Engine.effects.fx.moveCrystal(state, who, 'distance', 'dust', 1); }
  };

  // 莱拉
  choices.raira_gauge1 = {
    wind(state, who) { Engine.gauge.add(state, who, 'wind', 1); },
    thunder(state, who) { Engine.gauge.add(state, who, 'thunder', 1); }
  };
  choices.raira_yobigoe = {
    both(state, who) {
      Engine.gauge.add(state, who, 'wind', 1);
      Engine.gauge.add(state, who, 'thunder', 1);
    },
    double(state, who) {
      const p = state.players[who];
      while (p.hand.length) p.hidden.push(p.hand.pop());
      Engine.gauge.set(state, who, 'thunder', Engine.gauge.thunder(state, who) * 2);
      Engine.state.log(state, '呼び声：手牌全部盖伏，雷神翻倍');
    }
  };
  choices.raira_sorakake = {
    to_dist(state, who) { Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 2); },
    to_dust(state, who) { Engine.effects.fx.moveCrystal(state, who, 'distance', 'dust', 2); }
  };
  choices.raira_enkan = {
    yes(state, who) {
      state.choice = {
        who: who, sourceId: 'raira_enkan_dir',
        prompt: '円環輪廻旋：间合⇄虚 1，往哪边？',
        options: ['to_dist', 'to_dust']
      };
    },
    no(state, who) {}
  };
  choices.raira_enkan_dir = {
    to_dist(state, who) {
      Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 1);
      Engine.gauge.add(state, who, 'wind', 1);
    },
    to_dust(state, who) {
      Engine.effects.fx.moveCrystal(state, who, 'distance', 'dust', 1);
      Engine.gauge.add(state, who, 'wind', 1);
    }
  };
  choices.raira_tengu = {
    to_dist(state, who) { Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 2); },
    to_dust(state, who) { Engine.effects.fx.moveCrystal(state, who, 'distance', 'dust', 2); },
    one_dist(state, who) { Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 1); },
    one_dust(state, who) { Engine.effects.fx.moveCrystal(state, who, 'distance', 'dust', 1); }
  };

  choices.imagine = {};
  // 选项是动态的（手牌 id），所以用 Proxy 风格：resolveChoice 找不到时按 id 处理
  choices.imagine.resolve = function (state, who, optionId) {
    const p = state.players[who];
    const i = p.hand.findIndex(function (c) { return c.id === optionId; });
    if (i < 0) return false;
    const card = p.hand.splice(i, 1)[0];
    p.hidden.push(card);
    Engine.state.log(state, '把「' + card.name + '」盖成伏札');
    return true;
  };

  // 見切り：间合(1) ⇔ 虚
  choices.mikiri = {
    dist_to_dust(state, who) { Engine.effects.fx.moveCrystal(state, who, 'distance', 'dust', 1); },
    dust_to_dist(state, who) { Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 1); }
  };

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
    if (table[optionId]) { table[optionId](state, who); return { ok: true }; }
    // 动态选项（比如"选一张手牌"）：交给 resolve 自己处理
    if (typeof table.resolve === 'function') {
      if (!table.resolve(state, who, optionId)) return { ok: false, error: '这个选项无效' };
      return { ok: true };
    }
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
      // 《隙》：带隙的付与札，在持有者受到 1 点以上命伤时（重组除外），
      // 直接变成伏札，上面的结晶全进虚——**不会**触发【破弃时】
      gap: true,
      onBreak(state, who) {
        generateAttack(state, who, {
          // 卡面是 3/-：命伤是「-」，玩家只能选装
          name: '圧気（破弃）', range: [1, 2, 3, 4], aura: 3, life: null
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
        // 卡面：他のメガミによる「切り札でない」《攻撃》——王牌的攻击不吃这个加成
        state.players[who].nextOtherAttack = { noRespond: 'normal', near: 1, notSpecial: true };
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

    // 八方振り：八相（自装≤1）→ 再打一发 4-5、2/1
    "02-saine-o-n-1": {
      onAfterAttack(state, who) {
        if (hassou(state, who)) {
          generateAttack(state, who, { name: '八方振り（追加）', range: [4, 5], aura: 2, life: 1 });
        }
      }
    },

    // 薙斬り：只是带《对应》的攻击，没有别的效果

    // 石突き：以《对应》使用时，先用它自己的攻击 2-3 / 2-1，
    // 它的【攻击后】再打一发 3-5 / 2-1（不可被对应）
    "02-saine-o-n-3": {
      attackOnRespond: true,
      // 【攻击后】八相～自装 ≤1 时，虚 → 间合 1 颗
      // （卡面是图标记法：枯树「ダスト」→ 足迹「間合」，1 枚羽饰 = 1 颗）
      onAfterAttack(state, who) {
        if (hassou(state, who)) {
          Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 1);
          Engine.state.log(state, '石突【攻击后】八相：虚 → 间合 1 颗');
        }
      }
    },

  // 見切り：间合(1) ⇔ 虚（双向箭头，由使用者选方向）
    // 另：【常时】八相时可以当《对应》用（types 里已经带 reaction，这里只做条件判断）
    "02-saine-o-n-4": {
      // 这张牌平时不能对应，只有八相（自装≤1）时才当《对应》用
      canRespond(state, who) { return hassou(state, who); },
      onUse(state, who) {
        Engine.effects.fx.ask(state, who, 'mikiri', '间合(1) ⇔ 虚：选方向', ['dist_to_dust', 'dust_to_dist']);
      }
    },

    // 圏域（付与・纳2）：达人距离 +1；这张牌上的结晶本该进虚时改为进间合
    "02-saine-o-n-5": {
      taijinPlus: 1,
      redirectTo: 'distance'      // 供 tickAttachments / 破弃时判断
    },

    // 衝音晶（付与・纳1・可对应）：
    //   对应时被对应攻击 -1/+0；破弃时打一发 0-10、1/-、不可被对应，并 虚→间合
    "02-saine-o-n-6": {
      onRespond(state, who, pd) {
        pd.damage.aura = Math.max(0, pd.damage.aura - 1);
        Engine.state.log(state, '衝音晶：被对应的攻击 -1/+0');
      },
      onBreak(state, who) {
        Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 1);
        generateAttack(state, who, {
          // 卡面是 1/-：只能选装
          name: '衝音晶（破弃）', range: [0,1,2,3,4,5,6,7,8,9,10], aura: 1, life: null, noRespond: true
        });
      }
    },

    // 無音壁（付与・纳5）：受伤害时，这张牌上的结晶视为在你的装中
    "02-saine-o-n-7": {
      auraShield: true
    },

    // 律動弧戟（王牌・费5·行动）：连续三发攻击
    "02-saine-o-s-1": {
      onUse(state, who) {
        // 卡面：3-4/1-1 → 4-5/1-1 → 3-5/2-2
        // 三段都进队列，由 nextQueuedAttack 依次打；打不到的那段自动跳过
        state.attackQueue = [
          { cardId: '02-saine-o-s-1', name: '律動弧戟①', range: [3, 4], aura: 1, life: 1 },
          { cardId: '02-saine-o-s-1', name: '律動弧戟②', range: [4, 5], aura: 1, life: 1 },
          { cardId: '02-saine-o-s-1', name: '律動弧戟③', range: [3, 4, 5], aura: 2, life: 2 }
        ];
        Engine.rules.nextQueuedAttack(state, who);
      }
    },

    // 響鳴共振（王牌・行动）：费用 = 8 - 敌装；敌装(2) → 间合
    "02-saine-o-s-2": {
      cost(state, who) {
        return 8 - state.players[1 - who].aura;
      },
      onUse(state, who) {
        Engine.effects.fx.moveCrystal(state, 1 - who, 'aura', 'distance', 2);
      }
    },

    // 音無砕氷（王牌攻击・对应）：被对应的攻击 -1/-1
    "02-saine-o-s-3": {
      onRespond(state, who, pd) {
        pd.damage.aura = Math.max(0, pd.damage.aura - 1);
        pd.damage.life = Math.max(0, pd.damage.life - 1);
        Engine.state.log(state, '音無砕氷：被对应的攻击 -1/-1');
      }
    },

    // 氷雨細音の果ての果て（王牌攻击・对应）：只能用来对应王牌
    "02-saine-o-s-4": {
      canUse(state, who, card) {
        const pd = state.pending;
        if (!pd || pd.defender !== who) return '这张牌只能用于对应';
        const atkCard = pd.card;
        if (!atkCard || atkCard.kind !== 'special') return '这张牌只能用于对王牌的对应';
        return true;
      }
    },

    /* ===== 绯弥香 ===== */

    // シュート：纯攻击

    // ラピッドファイア：【常时】连火（本回合第 3 张以后）→ +1/+1
    "03-himika-o-n-2": {
      onAttack(state, who, ctx) {
        if (renka(state, who)) { ctx.aura += 1; ctx.life += 1; }
      }
    },

    // マグナムカノン：【攻击后】自命 → 虚
    "03-himika-o-n-3": {
      onAfterAttack(state, who) {
        Engine.effects.fx.moveCrystal(state, who, 'life', 'dust', 1);
      }
    },

    // フルバースト（全力）：两种伤害都要吃
    "03-himika-o-n-4": {
      onAttack(state, who, ctx) { ctx.both = true; }
    },

    // バックステップ：抽 1 张；虚 → 间合
    "03-himika-o-n-5": {
      onUse(state, who) {
        Engine.effects.fx.draw(state, who, 1);
        Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 1);
      }
    },

    // バックドラフト：让对手畏缩；连火 → 本回合下一次其他女神的攻击 +1/+1
    "03-himika-o-n-6": {
      onUse(state, who) {
        Engine.effects.fx.stagger(state, 1 - who);
        if (renka(state, who)) {
          // 卡面：他のメガミによる《攻撃》を+1/+1 —— 记下来源女神，绯弥香自己的攻击不吃
        state.players[who].nextOtherAttack = { bonus: { aura: 1, life: 1 }, src: 'himika', notSpecial: true };
          Engine.state.log(state, '连火：下一次其他女神的《攻击》+1/+1');
        }
      }
    },

    // スモーク（付与・纳3）：【展开中】箭头效果不能移动间合里的结晶
    "03-himika-o-n-7": {
      blockArrowFromDistance: true
    },

    // レッドバレット：纯攻击（费 0）

    // クリムゾンゼロ：两种伤害都吃；间合 0 时不可被对应
    "03-himika-o-s-2": {
      onAttack(state, who, ctx) {
        ctx.both = true;
        if (state.distance === 0) ctx.noRespond = true;
      }
    },

    // スカーレットイマジン：抽 2 张，然后把 1 张手牌盖成伏札
    "03-himika-o-s-3": {
      onUse(state, who) {
        Engine.effects.fx.draw(state, who, 2);
        const p = state.players[who];
        if (!p.hand.length) return;
        Engine.effects.fx.ask(state, who, 'imagine', '选 1 张手牌盖成伏札',
          p.hand.map(function (c) { return c.id; }));
      }
    },

    // ヴァーミリオン・フィールド：连火 → 虚 → 间合
    "03-himika-o-s-4": {
      onUse(state, who) {
        if (renka(state, who)) {
          Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 1);
        }
      }
    },

    /* ===== 常世 ===== */

    // 梳流：【攻击后】境地（自集中力=2）→ 这张牌放回牌库顶
    "04-tokoyo-o-n-1": {
      onAfterAttack(state, who) {
        if (!kyouchi(state, who)) return;
        const p = state.players[who];
        const i = p.discard.findIndex(function (c) { return c.id === '04-tokoyo-o-n-1'; });
        if (i >= 0) {
          const card = p.discard.splice(i, 1)[0];
          p.deck.unshift(card);
          Engine.state.log(state, '梳流：放回牌库顶');
        }
      }
    },

    // 雅打ち：境地时，作为对应可以打消这次非全力的《攻击》
    "04-tokoyo-o-n-2": {
      onRespond(state, who, pd) {
        if (!kyouchi(state, who)) return;
        // 卡面：対応した「切札でない」《攻撃》を打ち消す
        // 这里判的是「这次攻击来自王牌（切札）吗」，不是《全力》
        if (pd.fromSpecial) {
          Engine.state.log(state, '雅打ち：对方这次是王牌攻击，打不掉');
          return;
        }
        pd.cancelled = true;
        Engine.state.log(state, '雅打ち：打消这次攻击');
      }
    },

    // 跳ね兔：间合 ≤3 → 虚→间合
    "04-tokoyo-o-n-3": {
      onUse(state, who) {
        if (state.distance <= 3) Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 2);
        else Engine.state.log(state, '跳ね兎：间合不是 3 以下，无事发生');
      }
    },

    // 詩舞：获得 1 集中力，然后从两项里选一项
    //   ・自气 → 自装（1 颗）
    //   ・自装 → 间合（1 颗）
    "04-tokoyo-o-n-4": {
      onUse(state, who) {
        Engine.effects.fx.gainFocus(state, who, 1);
        Engine.effects.fx.ask(state, who, 'shibu', '选一项', ['flare_to_aura', 'aura_to_dist']);
      }
    },

    // 要返し（全力）：弃牌/伏札至多 2 张放牌库底；虚→自装
    "04-tokoyo-o-n-5": {
      onUse(state, who) {
        const p = state.players[who];
        const pool = p.discard.concat(p.hidden).slice(0, 2);
        pool.forEach(function (c) {
          [p.discard, p.hidden].forEach(function (arr) {
            const idx = arr.findIndex(function (x) { return x.id === c.id; });
            if (idx >= 0) { arr.splice(idx, 1); p.deck.push(c); }
          });
        });
        if (pool.length) Engine.state.log(state, '要返し：把 ' + pool.length + ' 张牌放到牌库底');
        Engine.effects.fx.moveCrystal(state, who, 'dust', 'aura', 2);   // 卡面：ダスト→自オーラ：2
      }
    },

    // 風舞台（付与・纳2）
    //   【展开时】间合 → 自装（2 颗；间合不足就只移现有的）
    //   【破弃时】自装 → 间合（2 颗；自装不足就只移现有的，绝不能凭空多出来）
    "04-tokoyo-o-n-6": {
      onExpanded(state, who) {
        Engine.effects.fx.moveCrystal(state, who, 'distance', 'aura', 2);
      },
      onBreak(state, who) {
        Engine.effects.fx.moveCrystal(state, who, 'aura', 'distance', 2);
      }
    },

    // 晴舞台（付与・纳2・终端）：展开时 集中力变 2；破弃时 打 3-6 / -1
    "04-tokoyo-o-n-7": {
      onExpanded(state, who) {
        state.players[who].focus = 2;
      },
      onBreak(state, who) {
        // 卡面是 -/1：只能选命
        generateAttack(state, who, { name: '晴舞台（破弃）', range: [3,4,5,6], aura: null, life: 1 });
      }
    },

    // 久遠ノ花（王牌攻击・对应）：对应时打消这次《攻击》
    "04-tokoyo-o-s-1": {
      onRespond(state, who, pd) {
        pd.cancelled = true;
        Engine.state.log(state, '久遠ノ花：打消这次攻击');
      }
    },

    // 千歳ノ鳥：攻击后 重组牌库（不受焦燥伤害）
    "04-tokoyo-o-s-2": {
      onAfterAttack(state, who) {
        Engine.rules.reshuffle(state, who, false);
        Engine.state.log(state, '千歳ノ鳥：重组牌库（不受伤）');
      }
    },

    // 無窮ノ風：不可被对应；攻击后对手弃 1 张非攻击牌
    "04-tokoyo-o-s-3": {
      onAttack(state, who, ctx) { ctx.noRespond = true; },
      onAfterAttack(state, who) {
        const opp = state.players[1 - who];
        const i = opp.hand.findIndex(function (c) { return (c.types || []).indexOf('attack') < 0; });
        if (i >= 0) {
          opp.discard.push(opp.hand.splice(i, 1)[0]);
          Engine.state.log(state, '無窮ノ風：对手弃掉 1 张非攻击牌');
        } else {
          Engine.state.log(state, '無窮ノ風：对手手牌全是攻击，公开手牌');
        }
      }
    },

    // 常世ノ月（王牌行动・费2）：自集中力=2，敌集中力=0，对手畏缩
    "04-tokoyo-o-s-4": {
      onUse(state, who) {
        state.players[who].focus = 2;
        state.players[1 - who].focus = 0;
        Engine.effects.fx.stagger(state, 1 - who);
      }
    },

    /* ===== 雪姬（伞：闭 / 开） =====
     * 所有"当前伞状态"的数据都在 cards.json 的 dual 里，
     * 这里只写"状态不同 → 效果不同"的部分。
     */

    // しこみばり／ふくみばり：纯攻击，状态差异全在数据里
    // しこみび／ねこだまし：闭时【攻击后】这张牌回手牌 + 开合伞
    "06-yukihi-o-n-2": {
      onAfterAttack(state, who) {
        const U = Engine.umbrella;
        if(!U || U.isOpen(state, who)) return;        // 只有"闭"那一面有这效果
        const p = state.players[who];
        const i = p.discard.findIndex(function (c) { return c.id === '06-yukihi-o-n-2'; });
        if (i >= 0) {
          const card = p.discard.splice(i, 1)[0];
          p.hand.push(card);
          Engine.state.emit(state, 'cardTo', { who: who, cardId: card.id, to: 'hand' });
          Engine.state.log(state, 'しこみび：这张牌回到手牌');
        }
        Engine.rules.toggleUmbrella(state, who, 'しこみび');
      }
    },

    // ふりはらい／たぐりよせ：攻击后移动间合
    "06-yukihi-o-n-3": {
      onAfterAttack(state, who) {
        const U = Engine.umbrella;
        const fx = Engine.effects.fx;
        if (U.isOpen(state, who)) {
          // 开：间合 → 虚 2（拉近 2）
          fx.moveCrystal(state, who, 'distance', 'dust', 2);
          Engine.state.log(state, 'たぐりよせ：间合 → 虚 2');
        } else {
          // 闭：虚 ⇄ 间合 1（自己选方向）
          fx.ask(state, who, 'yukihi_slide', '虚⇄间合：选方向', ['dust_to_dist', 'dist_to_dust']);
        }
      }
    },

    // ふりまわし／つきさし：纯攻击（全力在 types 里）
    // かさまわし：【常时】伞开合时从手牌公开 → 虚 → 自装 1
    "06-yukihi-o-n-5": {
      passiveOnly: true,
      onUmbrellaToggled(state, who) {
        Engine.effects.fx.moveCrystal(state, who, 'dust', 'aura', 1);
        Engine.state.log(state, 'かさまわし：伞开合 → 虚 → 自装 1');
      }
    },

    // ひきあし／もぐりこみ：闭 虚→间合 1；开 间合→虚 1
    "06-yukihi-o-n-6": {
      onUse(state, who) {
        const U = Engine.umbrella, fx = Engine.effects.fx;
        if (U.isOpen(state, who)) {
          fx.moveCrystal(state, who, 'distance', 'dust', 1);
          Engine.state.log(state, 'もぐりこみ：间合 → 虚 1');
        } else {
          fx.moveCrystal(state, who, 'dust', 'distance', 1);
          Engine.state.log(state, 'ひきあし：虚 → 间合 1');
        }
      }
    },

    // えんむすび：箭头随伞状态反向
    //   闭：展开 间合→虚 1；破弃 虚→间合 1
    //   开：展开 虚→间合 1；破弃 间合→虚 1
    "06-yukihi-o-n-7": {
      onExpanded(state, who) {
        const open = Engine.umbrella.isOpen(state, who);
        Engine.effects.fx.moveCrystal(state, who, open ? 'dust' : 'distance',
                                               open ? 'distance' : 'dust', 1);
        Engine.state.log(state, 'えんむすび【展开时】：' + (open ? '虚 → 间合 1' : '间合 → 虚 1'));
      },
      onBreak(state, who) {
        const open = Engine.umbrella.isOpen(state, who);
        Engine.effects.fx.moveCrystal(state, who, open ? 'distance' : 'dust',
                                               open ? 'dust' : 'distance', 1);
        Engine.state.log(state, 'えんむすび【破弃时】：' + (open ? '间合 → 虚 1' : '虚 → 间合 1'));
      }
    },

    // はらりゆき：【攻击后】+1 集中力（再起条件见 revive 表）
    "06-yukihi-o-s-1": {
      // 出牌时记下"已经开合过几次"，之后多过一次才算再起条件达成
      onAttack(state, who) {
        const p = state.players[who];
        const sp = (p.specials || []).find(function (c) { return c.id === '06-yukihi-o-s-1'; });
        if (sp) sp.toggleBase = p.umbrellaCount || 0;
      },
      onAfterAttack(state, who) {
        Engine.effects.fx.gainFocus(state, who, 1);
        Engine.state.log(state, 'はらりゆき：获得 1 点集中力');
      }
    },

    // ゆらりび：纯攻击（状态差异在数据里）
    // どろりうら：【展开中】雪姬的《攻击》拥有两种状态的合并适正距离
    "06-yukihi-o-s-3": {
      mergeUmbrellaRange: true
    },

    // くるりみ：开合伞，然后 虚 → 自装 1
    "06-yukihi-o-s-4": {
      onUse(state, who) {
        Engine.rules.toggleUmbrella(state, who, 'くるりみ');
        Engine.effects.fx.moveCrystal(state, who, 'dust', 'aura', 1);
        Engine.state.log(state, 'くるりみ：开合伞 + 虚 → 自装 1');
      }
    },

    /* ===== 雪拉（计略：神谋 / 鬼谋） =====
     *
     * 「計略を実行し、次の計略を準備する」通用流程：
     *   1) plan.execute() → 公开当前计略并返回是哪一个
     *   2) 走 planEffects[cardId][plan] 分支
     *   3) plan.needPrepare() → 挂起，等玩家秘密选下一个
     */

    // 立論：对方牌库 ≥2 时改为盖对方 2 张（伤害不结算）
    "07-shinra-o-n-1": {
      insteadOfDamage(state, who) {
        return state.players[1 - who].deck.length >= 2;
      },
      replaceDamage(state, who) {
        Engine.rules.oppDeckToHidden(state, 1 - who, 2);
      }
    },

    // 反論：打消"被对应的那一发"（气伤 ≥3）；然后对方抽 1
    "07-shinra-o-n-2": {
      attackOnRespond: true,     // 攻撃+対応：作为对应使用时也会打出自己那一发
      onAfterAttack(state, who) {
        const stack = state.attackStack || [];
        const outer = stack[stack.length - 1];
        if (outer && !outer.cancelled) {
          const a = outer.damage && outer.damage.aura;
          if (a !== null && a !== undefined && a >= 3) {
            outer.cancelled = true;
            Engine.state.log(state, '反論：打消「' + (outer.cardName || '攻击') + '」的伤害');
          }
        }
        const opp = state.players[1 - who];
        if (opp.deck.length) {
          opp.hand.push(opp.deck.shift());
          Engine.state.emit(state, 'draw', { who: 1 - who, n: 1 });
          Engine.state.log(state, '反論：对方抽 1 张');
        }
      }
    },

    // 詭弁：攻击后执行计略
    "07-shinra-o-n-3": {
      onAfterAttack(state, who) { runPlan(state, who, '07-shinra-o-n-3'); }
    },

    // 引用：看对方手牌，选一张《攻击》牌 → 使用 / 盖成伏札
    "07-shinra-o-n-4": {
      onUse(state, who) {
        openCardPick(state, who, {
          target: 1 - who, zone: 'hand', filter: 'attack',
          prompt: '引用：选择对方手牌中的一张《攻击》牌（可以取消）',
          modes: ['useFromHand', 'hide'], optional: true
        });
      }
    },

    // 煽動：对应；执行计略
    "07-shinra-o-n-5": {
      onUse(state, who) { runPlan(state, who, '07-shinra-o-n-5'); }
    },

    // 壮語：破弃时执行计略
    "07-shinra-o-n-6": {
      onBreak(state, who, self) { runPlan(state, who, '07-shinra-o-n-6', self); }
    },

    // 論破：展开时封印对方弃牌区 1 张
    "07-shinra-o-n-7": {
      onExpanded(state, who, self) {
        openCardPick(state, who, {
          target: 1 - who, zone: 'discard', filter: 'any',
          prompt: '論破：选一张对方弃牌区的牌，封印在此牌之下',
          modes: ['seal'], hostId: self && self.id
        });
      }
    },

    // 完全論破：永久封印 1 张
    "07-shinra-o-s-1": {
      onUse(state, who) {
        openCardPick(state, who, {
          target: 1 - who, zone: 'discard', filter: 'any',
          prompt: '完全論破：选一张对方弃牌区的牌永久封印',
          modes: ['sealForever']
        });
      }
    },

    // 皆式理解：执行计略
    "07-shinra-o-s-2": {
      onUse(state, who) { runPlan(state, who, '07-shinra-o-s-2'); }
    },

    // 天地反駁：【展开中】气伤与命伤互换（rules 里读 swapDamage）
    "07-shinra-o-s-3": { swapDamage: true },

    // 森羅判証：展开 虚→自命；其他付与破弃 → 对方 1 命伤；破弃 → 败北
    "07-shinra-o-s-4": {
      onExpanded(state, who) {
        Engine.effects.fx.moveCrystal(state, who, 'dust', 'life', 2);
        Engine.state.log(state, '森羅判証：虚 → 自命 2');
      },
      onBreak(state, who) {
        state.winner = 1 - who;
        Engine.state.log(state, '森羅判証 破弃：P' + (who + 1) + ' 败北');
        Engine.state.emit(state, 'gameover', { winner: 1 - who, reason: '森羅判証' });
      },
      onOtherAttachmentBroken(state, who) {
        const opp = state.players[1 - who];
        if (opp.life > 0) {
          opp.life -= 1;
          Engine.state.emit(state, 'damage', { who: 1 - who, kind: 'life', n: 1 });
          Engine.state.log(state, '森羅判証：其他付与破弃 → 对方 1 点命伤');
        }
      }
    },


    /* ===== 千影（毒袋） ===== */

    // 毒針：攻击后从毒袋选一张，放到对方牌库顶
    "09-chikage-o-n-2": {
      onAfterAttack(state, who) {
        openCardPick(state, who, {
          target: who, zone: 'poisonBag', filter: 'poisonDeckTop',
          prompt: '毒针：选一张毒，放到对方牌库顶',
          modes: ['poisonTop']
        });
      }
    },

    // 遁術：自装→间合 1、虚→间合 1；本回合对方不能《前进》
    "09-chikage-o-n-3": {
      onAfterAttack(state, who) {
        Engine.effects.fx.moveCrystal(state, who, 'aura', 'distance', 1);
        Engine.effects.fx.moveCrystal(state, who, 'dust', 'distance', 1);
        const opp = state.players[1 - who];
        opp.basicBan = opp.basicBan || {};
        opp.basicBan.advance = true;
        Engine.state.log(state, '遁術：本回合对方不能《前进》');
        Engine.state.emit(state, 'basicBan', { who: 1 - who });
      }
    },

    // 暗器：对应 / 全力化（+1/+2、送毒、缠绕）
    "09-chikage-o-n-4": {
      attackOnRespond: true,
      onAttack(state, who, ctx, card) {
        // 全力化时 +1/+2（由 playCard 打上 fullpowered 标记）
        if (ctx && ctx.fullpowered) { ctx.aura += 1; ctx.life += 2; }
      },
      onAfterAttack(state, who, pd) {
        const fp = !!pd.fullpowered;
        if (fp) {
          openCardPick(state, who, {
            target: who, zone: 'poisonBag', filter: 'poison',
            prompt: '暗器（全力化）：对方从你的毒袋选一张加入其手牌',
            modes: ['poisonToHand']
          });
        }
        const opp = state.players[1 - who];
        if ((opp.hand || []).some(function (c) { return Engine.rules.isPoison(c); })) {
          Engine.rules.basicAction(state, who, 'gather', { free: true });
          Engine.state.log(state, '暗器：对方手牌有毒 → 基本动作《缠绕》');
        }
      }
    },

    // 毒霧：从毒袋选一张加入对方手牌
    "09-chikage-o-n-5": {
      onUse(state, who) {
        openCardPick(state, who, {
          target: who, zone: 'poisonBag', filter: 'poisonThree',
          prompt: '毒雾：选一张毒（麻痺毒/幻覚毒/弛緩毒）加入对方手牌',
          modes: ['poisonToHand']
        });
      }
    },

    // 抜き足：【展开中】当前间合 -2
    "09-chikage-o-n-6": { distanceMinus: 2, hasGap: true },

    // 泥濘：【展开中】对方不能《后退》《离脱》
    "09-chikage-o-n-7": { banBasics: ['retreat', 'disengage'], banOpponent: true },

    // 滅灯の魂毒：把「滅灯毒」放对方牌库顶
    "09-chikage-o-s-1": {
      onUse(state, who) {
        openCardPick(state, who, {
          target: who, zone: 'poisonBag', filter: 'poisonHoro',
          prompt: '魂毒：把「滅灯毒」放到对方牌库顶',
          modes: ['poisonTop']
        });
      }
    },

    // 叛旗の纏毒：【展开中】双方"有一边是 -"的攻击被抵消
    "09-chikage-o-s-2": { cancelDashAttacks: true },

    // 流転の霞毒：纯攻击（再起见 revive 表）
    // 闇昏千影の生きる道
    "09-chikage-o-s-4": {
      onExpanded(state, who) {
        Engine.state.log(state, '闇昏千影の生きる道 展开');
      },
      // 受到 1 点以上命伤 → 结晶全进虚、此牌回未使用（破弃时效果失败）
      onLifeDamage(state, who, self) {
        const n = (self && self.crystals) || 0;
        if (n > 0) { self.crystals = 0; state.dust += n; }
        // 从付与区拿下来，回到王牌区（已使用状态）——不走"破弃"
        const p = state.players[who];
        p.attachments = (p.attachments || []).filter(function (a) { return a !== self; });
        const back = Object.assign({}, self, { crystals: 0, used: true });
        delete back._returnToUnused;
        delete back.sealed;
        p.specials.push(back);
        Engine.state.log(state, '闇昏千影：受到命伤 → 结晶全进虚，此牌回到王牌区（已使用）');
      },
      onBreak(state, who, self) {
        if (self && self._returnToUnused) return;      // 不算破弃
        const others = (state.players[who].specials || []).filter(function (c) {
          return c.id !== '09-chikage-o-s-4';
        });
        if (others.length && others.every(function (c) { return c.used; })) {
          state.winner = who;
          Engine.state.log(state, '闇昏千影の生きる道：其他切札全部已使用 → P' + (who + 1) + ' 胜利');
          Engine.state.emit(state, 'gameover', { winner: who, reason: '闇昏千影' });
        } else {
          Engine.state.log(state, '闇昏千影：其他切札还没全用掉，没有达成胜利条件');
        }
      }
    },

    /* ---- 毒（在毒袋里，被效果塞给对方） ---- */

    // 麻痺毒：本回合做过基本动作就不能用；用掉回毒袋并结束阶段
    "09-chikage-o-p-1": {
      canUse(state, who) {
        if (state.players[who].usedBasicThisTurn) return '本回合已经做过基本动作，不能用这张毒';
        return true;
      },
      onUse(state, who, card) {
        Engine.rules.returnPoison(state, 1 - who, card);
        card.returnedToBag = true;
        state.phaseEnded = true;
        Engine.state.log(state, '麻痺毒：结束本阶段');
      }
    },

    // 幻覚毒：回毒袋，自气 → 虚 2
    "09-chikage-o-p-2": {
      onUse(state, who, card) {
        Engine.rules.returnPoison(state, 1 - who, card);
        card.returnedToBag = true;
        Engine.effects.fx.moveCrystal(state, who, 'flare', 'dust', 2);
      }
    },

    // 弛緩毒：【展开中】不能使用《攻击》牌；破弃时回毒袋
    "09-chikage-o-p-3": {
      noAttackCards: true,
      onBreak(state, who, self) {
        Engine.rules.returnPoison(state, 1 - who, self);
      }
    },

    // 滅灯毒：自装 → 虚 2，回毒袋
    "09-chikage-o-p-4": {
      onUse(state, who, card) {
        Engine.effects.fx.moveCrystal(state, who, 'aura', 'dust', 3);
        Engine.rules.returnPoison(state, 1 - who, card);
        card.returnedToBag = true;
      }
    },


    /* ===== 莱拉（风雷计略） ===== */

    // 風雷撃：气伤 = 风与雷中较小的一方
    "12-raira-o-n-2": {
      onAttack(state, who, ctx) {
        ctx.aura = Math.min(Engine.gauge.wind(state, who), Engine.gauge.thunder(state, who));
      }
    },

    // 流転爪：攻击后可以把弃牌区的一张《攻击》放回牌库顶
    "12-raira-o-n-3": {
      onAfterAttack(state, who) {
        openCardPick(state, who, {
          target: who, zone: 'discard', filter: 'attack',
          prompt: '流転爪：可以把弃牌区的 1 张《攻击》放回牌库顶（可取消）',
          modes: ['toDeckTop'], optional: true
        });
      }
    },

    // 風走り：间合 3 以上 → 间合→虚 2
    "12-raira-o-n-4": {
      onUse(state, who) {
        if (Engine.rules.effDistance(state) < 3) {
          Engine.state.log(state, '風走り：间合不到 3，没有效果');
          return;
        }
        Engine.effects.fx.moveCrystal(state, who, 'distance', 'dust', 2);
      }
    },

    // 風雷の知恵：合计 4 以上可回收其他女神的牌；然后风或雷 +1
    "12-raira-o-n-5": {
      onUse(state, who) {
        if (Engine.gauge.total(state, who) >= 4) {
          openCardPick(state, who, {
            target: who, zone: 'discard', filter: 'otherGoddess',
            prompt: '風雷の知恵：可以把弃牌区 1 张其他女神的牌放回牌库顶（可取消）',
            modes: ['toDeckTop'], optional: true
          });
        }
        state.choice = {
          who: who, sourceId: 'raira_gauge1',
          prompt: '风神或雷神 +1，加哪个？',
          options: ['wind', 'thunder']
        };
      }
    },

    // 呼び声：畏缩 + 二选一
    "12-raira-o-n-6": {
      onUse(state, who) {
        Engine.rules.stagger(state, 1 - who);
        state.choice = {
          who: who, sourceId: 'raira_yobigoe',
          prompt: '呼び声：选一项',
          options: ['both', 'double']
        };
      }
    },

    // 空駆け：间合⇄虚 2（自选方向）
    "12-raira-o-n-7": {
      onUse(state, who) {
        state.choice = {
          who: who, sourceId: 'raira_sorakake',
          prompt: '空駆け：把 2 颗结晶往哪边移？',
          options: ['to_dist', 'to_dust']
        };
      }
    },

    // 雷螺風神爪：雷神 4 以上 +1/+0
    "12-raira-o-s-1": {
      onAttack(state, who, ctx) {
        if (Engine.gauge.thunder(state, who) >= 4) { ctx.aura += 1; }
      }
    },

    // 天雷召喚陣：X 次 0-10 / 1/1
    "12-raira-o-s-2": {
      onUse(state, who) {
        const x = Math.ceil(Engine.gauge.thunder(state, who) / 2);
        if (x <= 0) { Engine.state.log(state, '天雷召喚陣：雷神 0，没有攻击'); return; }
        state.attackQueue = state.attackQueue || [];
        for (let i = 0; i < x; i++) {
          state.attackQueue.push({ name: '天雷', range: [0,1,2,3,4,5,6,7,8,9,10], aura: 1, life: 1 });
        }
        Engine.rules.nextQueuedAttack(state, who);
      }
    },

    // 風魔招来孔：按风神给追加札，然后自己移除
    "12-raira-o-s-3": {
      onUse(state, who, card) {
        const w = Engine.gauge.wind(state, who);
        const p = state.players[who];
        const ext = state.extraPool || (state.extraPool = []);
        const got = [];
        const grant = function (id) {
          const c = ext.find(function (x) { return x.id === id; });
          if (!c) return;
          p.specials.push(Object.assign({}, c, { used: false }));
          got.push(c.name);
        };
        if (w >= 3) grant('12-raira-o-s-3-ex1');
        if (w >= 7) grant('12-raira-o-s-3-ex2');
        if (w >= 12) grant('12-raira-o-s-3-ex3');
        Engine.state.log(state, '風魔招来孔：获得 ' + (got.length ? got.join('、') : '（无）'));
        // 这张牌从游戏中移除
        const i = (p.specials || []).findIndex(function (c) { return c.id === '12-raira-o-s-3'; });
        if (i >= 0) { p.removed = p.removed || []; p.removed.push(p.specials.splice(i, 1)[0]); }
      }
    },

    // 円環輪廻旋：对方攻击解决后可以移动 + 加计略
    "12-raira-o-s-4": {
      afterOpponentAttack(state, who) {
        state.choice = {
          who: who, sourceId: 'raira_enkan',
          prompt: '円環輪廻旋：要移动间合并把风或雷 +1 吗？',
          options: ['yes', 'no']
        };
      }
    },

    // 追加札•風魔旋風：纯攻击
    // 追加札•風魔纏廻：让一张使用过的切札回到未使用
    "12-raira-o-s-3-ex2": {
      costDiscount: true,
      onUse(state, who) {
        openCardPick(state, who, {
          target: who, zone: 'usedSpecials', filter: 'any',
          prompt: '風魔纏廻：选 1 张使用过的切札，使其回到未使用',
          modes: ['reviveSpecial']
        });
      }
    },

    // 追加札•風魔天狗道：间合⇄虚 最多 2，然后移除
    "12-raira-o-s-3-ex3": {
      onUse(state, who, card) {
        state.choice = {
          who: who, sourceId: 'raira_tengu',
          prompt: '風魔天狗道：移动 2 颗结晶（自选方向）',
          options: ['to_dist', 'to_dust', 'one_dist', 'one_dust']
        };
        card.removeSelf = true;
      }
    },
  };

  /* ============================================================
   * 雪拉：计略的四个分支（每张"执行计略"的牌各有一套）
   * ============================================================ */
  const planEffects = {
    // 詭弁
    '07-shinra-o-n-3': {
      kami(state, who) { Engine.rules.oppDeckToHidden(state, 1 - who, 3); },
      oni(state, who) {
        openCardPick(state, who, {
          target: 1 - who, zone: 'discard', filter: 'any',
          prompt: '诡辩·鬼谋：可以从对方弃牌区使用一张牌（可以取消）',
          modes: ['useFromDiscard'], optional: true
        });
      }
    },
    // 煽動
    '07-shinra-o-n-5': {
      kami(state, who) { fx.moveCrystal(state, who, 'dust', 'distance', 1); },
      oni(state, who) { fx.moveCrystal(state, 1 - who, 'distance', 'aura', 1); }
    },
    // 壮語
    '07-shinra-o-n-6': {
      kami(state, who, self) {
        fx.gainFocus(state, who, 1);
        const p = state.players[who];
        const i = p.discard.findIndex(function (c) { return c.id === '07-shinra-o-n-6'; });
        if (i >= 0) {
          p.deck.unshift(p.discard.splice(i, 1)[0]);
        } else if (self) {
          // 破弃时效果：这时牌还没进弃牌区，直接把它放到牌库顶
          p.deck.unshift(Object.assign({}, self, { crystals: 0 }));
          self.noDiscard = true;
        }
        Engine.state.log(state, '壮语·神谋：+1 集中力，此牌回到牌库顶');
      },
      oni(state, who) {
        const opp = state.players[1 - who];
        if (opp.hand.length > 1) { Engine.state.log(state, '壮语·鬼谋：对方手牌多于 1 张，没有效果'); return; }
        Engine.rules.stagger(state, 1 - who);
        for (let i = 0; i < 3; i++) {
          if (opp.deck.length) opp.hand.push(opp.deck.shift());
          else { Engine.rules.exhaust(state, 1 - who); }
        }
        // 手牌上限 2：多的进伏札（这里自动取末尾，简化）
        while (opp.hand.length > 2) opp.hidden.push(opp.hand.pop());
        Engine.state.log(state, '壮语·鬼谋：对方畏缩，抽 3 张后只剩 2 张');
      }
    },
    // 皆式理解
    '07-shinra-o-s-2': {
      kami(state, who) {
        openCardPick(state, who, {
          target: who, zone: 'reuse', filter: 'enhance',
          prompt: '皆式理解·神谋：从弃牌区/使用过的切札里免费展开一张《付与》',
          modes: ['reuseEnhance']
        });
      },
      oni(state, who) {
        openCardPick(state, who, {
          target: 1 - who, zone: 'attachments', filter: 'any', nonSpecial: true,
          prompt: '皆式理解·鬼谋：选一张对方（非切札）的付与札，结晶全进虚',
          modes: ['drain']
        });
      }
    }
  };

  /** 执行计略 → 走分支 → 挂起"准备下一个" */
  function runPlan(state, who, cardId, self) {
    const plan = Engine.plan.execute(state, who);
    const tbl = planEffects[cardId] || {};
    if (tbl[plan]) tbl[plan](state, who, self);
    Engine.plan.needPrepare(state, who);
  }

  /* ============================================================
   * 雪拉：从某个区域"挑一张牌"的通用待处理
   * ============================================================ */
  function openCardPick(state, who, spec) {
    // 规则 5-10：能选几张就选几张 —— 一张都没有就什么也不发生
    const cp = Object.assign({ who: who }, spec);
    if (pickCandidates(state, cp).length === 0) {
      Engine.state.log(state, '（没有可选的牌，效果跳过）');
      return null;
    }
    state.cardPick = cp;
    Engine.state.log(state, spec.prompt || '选一张牌');
    return cp;
  }

  /** 现在能选哪些牌（给界面用，也给引擎校验用） */
  function pickCandidates(state, cp) {
    const t = state.players[cp.target];
    let list = [];
    if (cp.zone === 'hand') list = t.hand.slice();
    else if (cp.zone === 'discard') list = t.discard.slice();
    else if (cp.zone === 'attachments') list = t.attachments.slice();
    else if (cp.zone === 'usedSpecials') {
      list = (t.specials || []).filter(function (c) { return c.used; });
    }
    else if (cp.zone === 'poisonBag') {
      list = (t.poisonBag || []).slice();
    }
    else if (cp.zone === 'reuse') {
      list = t.discard.filter(c => (c.types || []).indexOf('enhance') >= 0)
        .concat((t.specials || []).filter(c => c.used && (c.types || []).indexOf('enhance') >= 0));
    }
    if (cp.filter === 'attack') list = list.filter(c => (c.types || []).indexOf('attack') >= 0);
    if (cp.filter === 'enhance') list = list.filter(c => (c.types || []).indexOf('enhance') >= 0);
    if (cp.nonSpecial) list = list.filter(c => c.kind !== 'special');
    if (cp.filter === 'otherGoddess')
      list = list.filter(c => (String(c.id).split('-')[1]) !== 'raira' && c.kind !== 'poison');
    if (cp.filter === 'poison' || cp.filter === 'poisonAny')
      list = list.filter(c => c.poison || c.kind === 'poison');
    if (cp.filter === 'poisonThree')
      list = list.filter(c => ['09-chikage-o-p-1','09-chikage-o-p-2','09-chikage-o-p-3'].indexOf(c.id) >= 0);
    if (cp.filter === 'poisonDeckTop')
      list = list.filter(c => ['09-chikage-o-p-1','09-chikage-o-p-2','09-chikage-o-p-3'].indexOf(c.id) >= 0);
    if (cp.filter === 'poisonHoro') list = list.filter(c => c.id === '09-chikage-o-p-4');
    return list;
  }

  /** 拿手里的这张牌打出去（引用 / 诡辩鬼谋共用） */
  function useBorrowedAttack(state, who, card) {
    const made = Engine.effects.generateAttack(state, who, {
      name: card.name + '（借）',
      range: (card.range || []).slice(),
      aura: card.damage ? card.damage.aura : null,
      life: card.damage ? card.damage.life : null,
      cardId: card.id
    });
    return made;
  }

  /**
   * 处理"选牌"的结果。
   * @param {object} action {player, cardId, mode, cancel}
   */
  function resolveCardPick(state, action) {
    const cp = state.cardPick;
    if (!cp || cp.who !== action.player) return { ok: false, error: '现在不用选牌' };
    if (action.cancel) {
      if (!cp.optional) return { ok: false, error: '这一步必须选' };
      state.cardPick = null;
      return { ok: true };
    }

    const list = pickCandidates(state, cp);
    const card = list.find(c => c.id === action.cardId);
    if (!card) return { ok: false, error: '这张牌不能选' };

    const mode = action.mode || (cp.modes && cp.modes[0]);
    const t = state.players[cp.target];
    const me = state.players[cp.who];

    // 从当前区域里摘掉（后面再决定去哪）
    function takeFrom(zones) {
      for (const z of zones) {
        if (!t[z]) continue;
        const i = t[z].findIndex(c => c.id === card.id);
        if (i >= 0) return t[z].splice(i, 1)[0];
      }
      return null;
    }

    if (mode === 'hide') {
      takeFrom(['hand']);
      t.hidden.push(card);
      Engine.state.log(state, '「' + card.name + '」被盖成伏札');
    } else if (mode === 'useFromHand' || mode === 'useFromDiscard') {
      // 只从"那个区域"拿：手牌里可能有一模一样的同名卡，不能拿错
      takeFrom(mode === 'useFromHand' ? ['hand'] : ['discard']);
      useBorrowedAttack(state, cp.who, card);
      t.discard.push(card);
      Engine.state.log(state, '借用了对方的「' + card.name + '」');
    } else if (mode === 'seal') {
      takeFrom(['discard']);
      let host = null;
      if (cp.hostId) {
        host = me.attachments.find(a => a.id === cp.hostId) || null;
      }
      if (!host) host = me.attachments.find(a => !a.sealOnly) || null;
      if (host) Engine.rules.sealUnder(state, host, card);
      else me.attachments.push({ id: cp.hostId || card.id, name: '封印', crystals: 0, sealOnly: true, sealed: [card] });
    } else if (mode === 'sealForever') {
      takeFrom(['discard']);
      me.attachments.push({
        id: '07-shinra-o-s-1', name: '完全論破', kind: 'special',
        crystals: 0, sealOnly: true, forever: true, sealed: [card]
      });
      Engine.state.log(state, '「' + card.name + '」被永久封印');
    } else if (mode === 'toDeckTop') {
      const p2 = state.players[cp.who];
      const i = (p2.discard || []).findIndex(c => c.id === card.id);
      if (i >= 0) p2.deck.unshift(p2.discard.splice(i, 1)[0]);
      Engine.state.log(state, '「' + card.name + '」被放回牌库顶');
    } else if (mode === 'reviveSpecial') {
      const p2 = state.players[cp.who];
      const sp = (p2.specials || []).find(c => c.id === card.id && c.used);
      if (sp) { sp.used = false; Engine.state.log(state, '「' + sp.name + '」回到未使用'); }
    } else if (mode === 'poisonTop') {
      const owner = cp.target;
      const pc = Engine.rules.takePoison(state, owner, card.id);
      if (!pc) return { ok: false, error: '毒袋里没有这张毒' };
      state.players[1 - owner].deck.unshift(pc);
      Engine.state.log(state, '「' + pc.name + '」被放到 P' + (2 - owner) + ' 的牌库顶');
    } else if (mode === 'poisonToHand') {
      const owner = cp.target;
      const pc = Engine.rules.takePoison(state, owner, card.id);
      if (!pc) return { ok: false, error: '毒袋里没有这张毒' };
      state.players[1 - owner].hand.push(pc);
      Engine.state.log(state, '「' + pc.name + '」被加入 P' + (2 - owner) + ' 的手牌');
    } else if (mode === 'drain') {
      const i = t.attachments.findIndex(a => a.id === card.id);
      if (i >= 0) {
        const a = t.attachments[i];
        const n = a.crystals || 0;
        a.crystals = 0;
        state.dust += n;
        Engine.state.log(state, '「' + a.name + '」的 ' + n + ' 颗结晶全部进虚');
        if (n > 0) Engine.state.emit(state, 'damage', { who: cp.target, kind: 'attach', n: n });
        Engine.rules.sweepAttachments(state, cp.target);
      }
    } else if (mode === 'reuseEnhance') {
      // 从弃牌区或"使用过的切札"里免费展开
      let src = null;
      for (const z of ['discard', 'specials']) {
        const i = (me[z] || []).findIndex(c => c.id === card.id);
        if (i >= 0) { src = me[z].splice(i, 1)[0]; break; }
      }
      if (!src) return { ok: false, error: '找不到这张牌' };
      const cap = src.capacity || 0;
      const fromDust = Math.min(state.dust, cap);
      state.dust -= fromDust;
      const fromAura = Math.min(me.aura, cap - fromDust);
      me.aura -= fromAura;
      me.attachments.push(Object.assign({}, src, {
        crystals: fromDust + fromAura,
        fromSpecial: src.kind === 'special'
      }));
      const e2 = cards[src.id];
      if (e2 && e2.onExpanded) e2.onExpanded(state, cp.who, me.attachments[me.attachments.length - 1]);
      Engine.state.log(state, '免费展开「' + src.name + '」');
      if ((src.types || []).indexOf('fullpower') >= 0) state.phaseEnded = true;
    }

    state.cardPick = null;
    return { ok: true };
  }

  /* ---------- 效果生成的攻击 ---------- */

  /**
   * 由卡牌效果生成的攻击（规则 10-5）。
   * 这类攻击没有"卡"，但仍然要走「适正距离确认 → 对应 → 伤害」的流程。
   */
  function generateAttack(state, who, spec) {
    if (spec.range.indexOf(Engine.rules.effDistance(state)) < 0) {
      Engine.state.log(state, '「' + spec.name + '」因距离不符取消（间合 ' + state.distance + '）');
      return null;
    }
    state.pending = {
      kind: 'attack',
      attacker: who,
      defender: 1 - who,
      cardId: spec.cardId || null,
      cardName: spec.name,
      // 「-」要保留成 null：null 表示"这条没有伤害，不能选"，0 表示"可以选但不扣"
      damage: {
        aura: (spec.aura === null || spec.aura === undefined) ? null : Math.min(spec.aura, 5),
        life: (spec.life === null || spec.life === undefined) ? null : spec.life
      },
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
    "04-tokoyo-o-s-3": (state, who) => state.players[who].focus === 2,
    // 雷螺風神爪【再起】风神 4 以上
    "12-raira-o-s-1": (state, who) => (Engine.gauge.wind(state, who) >= 4),
    // 流転の霞毒【再起】对方手牌 2 张以上
    "09-chikage-o-s-3": (state, who) => (state.players[1 - who].hand.length >= 2),
    // はらりゆき【再起】你进行伞的开合：使用之后开合过就算
    "06-yukihi-o-s-1": (state, who) => {
      const p = state.players[who];
      const sp = (p.specials || []).find(function (c) { return c.id === '06-yukihi-o-s-1'; });
      if (!sp) return false;
      return (p.umbrellaCount || 0) > (sp.toggleBase || 0);
    }
  };

  Engine.effects = { cards, revive, choices, resolveChoice, fx, planEffects, runPlan, openCardPick, pickCandidates, resolveCardPick,
    kesshi, hassou, kyouchi, renka, generateAttack };
})(typeof window !== 'undefined' ? window : globalThis);
