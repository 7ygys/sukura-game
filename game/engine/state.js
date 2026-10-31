/* ============================================================
 * engine/state.js —— 游戏状态
 *
 * 状态 = 一局游戏的全部事实。它必须是「纯数据」：
 *   - 只有对象、数组、数字、字符串
 *   - 没有函数、没有 class 实例
 *
 * 这样它才能 JSON.stringify 后：
 *   - 存档
 *   - 传给联机的另一端
 *   - 在测试里直接对比
 * ============================================================ */
(function (root) {
  const Engine = (root.Engine = root.Engine || {});

  /** 开局数值（来自官方总合规则） */
  const INIT = {
    LIFE: 10,      // 命
    AURA: 3,       // 装
    FLARE: 0,      // 气
    FOCUS: 0,      // 集中力
    DISTANCE: 10,  // 间合（0~10）
    DUST: 8,       // 虚里的结晶数
    HAND_DRAW: 3,  // 开局抽牌
    TURN_DRAW: 2,  // 每回合开始抽牌
    END_HAND: 2,   // 回合结束时手牌最多留几张
    FOCUS_MAX: 2,  // 集中力上限
    AURA_MAX: 5    // 装的上限（受伤时超过会溢出到命）
  };

  function makePlayer(name) {
    return {
      name: name || '',
      life: INIT.LIFE,
      aura: INIT.AURA,
      flare: INIT.FLARE,
      focus: INIT.FOCUS,
      staggered: false,   // 畏缩
      deck: [],           // 牌库（索引 0 = 牌堆顶）
      hand: [],
      discard: [],        // 弃牌区（双方可见）
      hidden: [],         // 伏札区（盖牌，双方只见牌背）
      attachments: [],    // 付与区
      buff: { aura: 0, life: 0 },   // 「本回合下一次攻击 +X/+Y」这类加成
      terminated: false,  // 终端：本回合不能再使用牌/基本动作
      specials: [],       // 王牌（各自带 used 标记）
      firstTurnDone: false
    };
  }

  /**
   * 创建初始状态
   * @param {object} opts
   *   opts.myCards   我的 10 张卡（7 通常 + 3 王牌，卡对象数组）
   *   opts.oppCards  对手的 10 张
   */
  function create(opts) {
    const state = {
      turn: 1,
      active: 0,             // 0 = 先手，1 = 后手
      phase: 'start',        // start | main | end
      distance: INIT.DISTANCE,
      dust: INIT.DUST,
      taijin: 2,                 // 达人距离（规则 5-2-2，默认 2）
      turnUsed: [0, 0],          // 本回合各自使用了几张牌（连火判定用）
      players: [makePlayer(opts.myName), makePlayer(opts.oppName)],
      winner: null,
      log: [],
      events: []
    };

    // 分牌：通常札进牌库（洗过），王牌单放（不进牌库）
    [opts.myCards, opts.oppCards].forEach(function (cards, i) {
      const p = state.players[i];
      const normal = cards.filter(c => c.kind === 'normal');
      const special = cards.filter(c => c.kind === 'special');
      p.deck = Engine.rng.shuffle(normal);
      p.specials = special.map(c => Object.assign({}, c, { used: false }));
    });

    // 先手随机
    state.active = Math.random() < 0.5 ? 0 : 1;
    // 后手多 1 点集中力
    state.players[1 - state.active].focus = 1;

    // 各抽 3 张
    for (let i = 0; i < 2; i++) {
      for (let k = 0; k < INIT.HAND_DRAW; k++) drawOne(state, i, true);
    }

    // 先手的第 1 回合现在就开始了：它属于「第一个回合」，跳过默认处理
    state.players[state.active].firstTurnDone = true;
    log(state, '开局：先手 P' + (state.active + 1));
    return state;
  }

  /** 深拷贝：所有改动都在副本上做，原状态不动 */
  function clone(s) {
    return JSON.parse(JSON.stringify(s));
  }

  /**
   * 事件：给界面看的"刚刚发生了什么"。
   * 规则层只负责记，怎么表现是界面的事（比如中央弹一个大图标）。
   */
  function emit(state, type, data) {
    state.events.push(Object.assign({ type: type, turn: state.turn }, data || {}));
    if (state.events.length > 50) state.events.shift();
  }

  function log(state, msg) {
    state.log.push({ turn: state.turn, msg });
    if (state.log.length > 200) state.log.shift();
  }

  // 内部用：抽一张（不触发焦燥），供 create 使用
  function drawOne(state, who, silent) {
    const p = state.players[who];
    if (!p.deck.length) return null;
    const card = p.deck.shift();
    p.hand.push(card);
    if (!silent) log(state, 'P' + (who + 1) + ' 抽到 ' + card.name);
    return card;
  }

  Engine.state = { INIT, create, clone, makePlayer, drawOne, log, emit };
})(typeof window !== 'undefined' ? window : globalThis);
