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

  Engine.effects = { cards, revive, kesshi, hassou, kyouchi, renka, generateAttack };
})(typeof window !== 'undefined' ? window : globalThis);
