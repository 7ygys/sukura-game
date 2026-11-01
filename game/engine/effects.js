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
        state.attackQueue = [
          { name: '律動弧戟②', range: [4, 5], aura: 1, life: 1 },
          { name: '律動弧戟③', range: [3, 4, 5], aura: 2, life: 2 }
        ];
        generateAttack(state, who, { name: '律動弧戟①', range: [3, 4], aura: 1, life: 1 });
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
          state.players[who].nextOtherAttack = { bonus: { aura: 1, life: 1 } };
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
    }
  };

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
    "04-tokoyo-o-s-3": (state, who) => state.players[who].focus === 2
  };

  Engine.effects = { cards, revive, choices, resolveChoice, fx,
    kesshi, hassou, kyouchi, renka, generateAttack };
})(typeof window !== 'undefined' ? window : globalThis);
