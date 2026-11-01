/* ============================================================================
 * tests/spec_core.js —— 白盒测试：回合流程与基础机制
 * ============================================================================
 *
 * 跑法：
 *   node game/tests/spec_core.js
 *
 * 覆盖范围（对应官方总合规则的「回合 / 基础机制」部分）：
 *   1. 开局状态：间合 10、装 3、命 10、集中力先手 0 后手 1、双方各 10 张牌
 *   2. 「第一个回合」跳过整个开始阶段的既定处理
 *   3. 开始阶段：集中力 +1 → 付与札各掉 1 颗结晶进虚（掉光破弃）→ 抽 2 张
 *   4. 集中力上限 2（截断）
 *   5. 畏缩：得到集中力时改为「解除畏缩」，不真的加
 *   6. 手牌上限 2：超出的在结束阶段**盖成伏札**（不是丢进弃牌区）
 *   7. 焦燥：牌库空了每缺 1 张 1 点伤害，由玩家选；不会自动洗牌
 *   8. 重组：自己主动做扣 1 点命；弃牌区+伏札区的通常札洗回；王牌不进牌库
 *   9. 五个基本动作：条件不满足不能做；满足时结晶移动方向正确
 *  10. 基本动作的两种代价：花 1 集中力 / 盖 1 张手牌成伏札
 *  11. 免费基本动作（free:true）不花集中力
 *  12. 再起：结束阶段检查
 *  13. 即再起：条件一满足就立刻触发（浮舟宿 / 决死）
 *  14. 结晶守恒（全场永远 36 颗）与牌数守恒（双方共 20 张）
 *  15. 胜负：命归零 → winner
 *  16. 已知引擎问题：焦燥点数会被后一笔抽牌覆盖（2 条**故意失败**的断言）
 *
 * 风格说明：
 *   - 能用 actions.applyAction 的地方一律走动作层（真实入口：会检查回合方、
 *     会克隆状态）。只有「想单独跑开始阶段」这类测试才直接调 E.rules.startTurn，
 *     因为动作层没有「只跑开始阶段」的动作。
 *   - 每条断言的文字都写清楚「在测什么」，失败时看名字就知道哪里坏了。
 * ========================================================================== */

const H = require('./harness');
const { E, ok, eq, group, report, fresh, withHand, cardById, deckOf, autoNabu, endTurnAuto, cardTotal } = H;

/* ==========================================================================
 * 本地小工具（只在这个 spec 里用）
 * ========================================================================== */

/**
 * 场上樱花结晶总数。
 * 结晶只会在这几处：间合、虚、双方 命/装/气、付与札上。
 * 规则：全场永远 36 颗（10 间合 + 3+3 装 + 10+10 命），虚从 0 开始。
 */
function crystals(s) {
  let n = s.distance + s.dust;
  s.players.forEach(function (p) {
    n += p.life + p.aura + p.flare;
    (p.attachments || []).forEach(function (a) { n += (a.crystals || 0); });
  });
  return n;
}

/**
 * 造一个「P0 先手、双方都已经过了第一个回合」的局面。
 *
 * 为什么要把 players[1].firstTurnDone 也设成 true：
 *   fresh() 会随机决定先手，而且只有先手的 firstTurnDone 被置位。
 *   如果不动后手的标记，后手的第一个回合会「跳过开始阶段」，
 *   那样测「正常回合」时就会莫名其妙地不抽牌、不加集中力。
 *
 * 顺便把集中力定死成官方起手值（先手 0 / 后手 1），
 * 否则先手随机会导致断言时好时坏。
 */
function p0(cards) {
  const s = withHand(cards || []);
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[1].firstTurnDone = true;
  s.players[0].focus = 0;   // 先手起手 0 点集中力
  s.players[1].focus = 1;   // 后手起手 1 点集中力
  return s;
}

/** 只跑某个人的「开始阶段」：克隆一份再调 startTurn，原状态不动 */
function startTurnOf(s, who) {
  const st = E.state.clone(s);
  st.active = who;
  E.rules.startTurn(st);
  return st;
}

/** 结算所有挂起的焦燥（先扣装，装不够了才扣命） */
function exhaustAll(s) {
  let st = s, guard = 0;
  while (st.exhaust && guard++ < 8) {
    const who = st.exhaust.who;
    const choice = st.players[who].aura >= 1 ? 'aura' : 'life';
    const r = E.actions.applyAction(st, { type: 'resolveExhaust', player: who, choice: choice });
    if (!r.ok) break;
    st = r.state;
  }
  return st;
}

/**
 * 处理回合开始时可能挂起的询问：
 *   - 「是否重组牌库」→ answer 传 'yes'/'no'/'auto'
 *     （'auto'：牌库快空了就重组，否则不重组 —— 让 8 回合循环能一直转下去）
 *   - 焦燥 → 逐点结算掉
 */
function settle(s, answer) {
  let st = s;
  if (st.choice && st.choice.sourceId === 'reshuffle') {
    const who = st.choice.who;
    let ans = answer;
    if (!ans || ans === 'auto') ans = st.players[who].deck.length <= 1 ? 'yes' : 'no';
    const r = E.actions.applyAction(st, { type: 'choose', player: who, option: ans });
    if (r.ok) st = r.state;
  }
  return exhaustAll(st);
}

/* ==========================================================================
 * 1. 开局状态
 * ========================================================================== */
group('1. 开局状态：各数值 + 双方各 10 张牌');
{
  const s = fresh();

  eq('间合 = 10', s.distance, 10);
  eq('虚 = 0（36 颗结晶一开始全在命/装/间合）', s.dust, 0);
  eq('临时距离修正 = 0', s.distanceMod, 0);
  eq('达人距离 = 2', s.taijin, 2);
  eq('还没有胜者', s.winner, null);
  eq('开局阶段标记 = start', s.phase, 'start');
  eq('回合数 = 1', s.turn, 1);

  [0, 1].forEach(function (i) {
    const p = s.players[i];
    eq('P' + i + ' 命 = 10', p.life, 10);
    eq('P' + i + ' 装 = 3', p.aura, 3);
    eq('P' + i + ' 气 = 0', p.flare, 0);
    eq('P' + i + ' 开局手牌 = 3', p.hand.length, 3);
    eq('P' + i + ' 牌库 = 4（7 张通常札 − 开局抽 3）', p.deck.length, 4);
    eq('P' + i + ' 王牌区 = 3', p.specials.length, 3);
    eq('P' + i + ' 弃牌区 = 0', p.discard.length, 0);
    eq('P' + i + ' 伏札区 = 0', p.hidden.length, 0);
    eq('P' + i + ' 付与区 = 0', p.attachments.length, 0);
    eq('P' + i + ' 一共 10 张牌（7 通常 + 3 王牌）',
      p.hand.length + p.deck.length + p.discard.length + p.hidden.length
      + p.attachments.length + p.specials.length, 10);
    eq('P' + i + ' 的三张王牌都还没用过', p.specials.every(function (sp) { return sp.used === false; }), true);
    eq('P' + i + ' 没有畏缩', p.staggered, false);
  });

  eq('双方牌总数 = 20', cardTotal(s), 20);
  eq('樱花结晶总数 = 36', crystals(s), 36);
  ok('先手集中力 0、后手集中力 1',
    s.players[s.active].focus === 0 && s.players[1 - s.active].focus === 1,
    s.players.map(function (p) { return p.focus; }));
  eq('牌库里只装通常札（王牌不进牌库）',
    s.players[0].deck.every(function (c) { return c.kind === 'normal'; }), true);
  eq('王牌不占手牌（手牌里没有 special）',
    s.players[0].hand.some(function (c) { return c.kind === 'special'; }), false);
}

/* ==========================================================================
 * 2. 「第一个回合」跳过整个开始阶段的既定处理
 * ========================================================================== */
group('2. 第一个回合跳过开始阶段（不抽牌、不加集中力）');
{
  const s = fresh();
  const first = s.active;          // 先手（随机，所以要取出来）
  const second = 1 - first;

  eq('先手的第一个回合：手牌还是开局的 3 张（没抽牌）', s.players[first].hand.length, 3);
  eq('先手的第一个回合：牌库还是 4 张（没抽牌）', s.players[first].deck.length, 4);
  eq('先手的第一个回合：集中力还是 0（没 +1）', s.players[first].focus, 0);
  eq('后手起手集中力 = 1', s.players[second].focus, 1);

  // 先手结束第一个回合 → 轮到后手的第一个回合
  let r = endTurnAuto(s);
  ok('先手结束回合成功', r.ok, r.error);
  let st = r.state;

  eq('轮到后手', st.active, second);
  eq('后手的第一个回合：手牌仍是 3 张（没抽牌）', st.players[second].hand.length, 3);
  eq('后手的第一个回合：集中力仍是 1（没 +1）', st.players[second].focus, 1);
  eq('回合数 = 2', st.turn, 2);

  // 后手结束第一个回合 → 再轮回来，这次是「正常回合」
  r = endTurnAuto(st);
  ok('后手结束回合成功', r.ok, r.error);
  st = r.state;

  eq('重新轮到先手', st.active, first);
  eq('回合数 = 3', st.turn, 3);
  eq('正常回合：集中力 0 → 1', st.players[first].focus, 1);
  eq('正常回合开始前：手牌已被压到 2 张', st.players[first].hand.length, 2);
  ok('开始阶段弹出「是否重组」询问（他上一回合盖过 1 张牌）',
    st.choice && st.choice.sourceId === 'reshuffle', st.choice);

  st = settle(st, 'no');           // 不重组 → 直接抽 2 张
  ok('回答完询问后询问被清掉', !st.choice, st.choice);
  eq('第二个回合正常抽 2 张：手牌 2 → 4', st.players[first].hand.length, 4);
  eq('牌库 4 → 2', st.players[first].deck.length, 2);
  eq('结晶总数仍是 36', crystals(st), 36);
  eq('双方牌总数仍是 20', cardTotal(st), 20);
}

/* ==========================================================================
 * 3. 开始阶段：抽 2 张 / 付与札掉 1 颗进虚 / 掉光破弃
 * ========================================================================== */
group('3. 开始阶段：集中力 +1 → 付与札掉结晶 → 抽 2 张');
{
  // --- 3.1 抽 2 张 ---
  const s = p0([]);
  const st = startTurnOf(s, 0);
  eq('开始阶段集中力 0 → 1', st.players[0].focus, 1);
  eq('开始阶段抽 2 张', st.players[0].hand.length, 2);
  eq('牌库 4 → 2', st.players[0].deck.length, 2);
  eq('开始阶段不动间合', st.distance, 10);
  eq('开始阶段不动虚', st.dust, 0);
  eq('开始阶段不动装', st.players[0].aura, 3);
  eq('结晶总数仍是 36', crystals(st), 36);
  eq('双方牌总数不变（抽牌只是换了个地方放）', cardTotal(st), cardTotal(s));
}
{
  // --- 3.2 付与札每回合掉 1 颗进虚，掉光则破弃（走真实展开流程）---
  let s = p0(['03-himika-o-n-7']);       // 《スモーク》，纳 3
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-7' });
  ok('付与牌打出后先要求分配「纳」', r.ok && !!r.state.nabu, r.error || r.state.nabu);
  eq('「纳」的数量 = 3（卡面 capacity）', r.state.nabu && r.state.nabu.cap, 3);

  r = autoNabu(r);
  ok('分配完成，付与展开', r.ok && r.state.players[0].attachments.length === 1, r.error);
  eq('付与札上带着 3 颗结晶', r.state.players[0].attachments[0].crystals, 3);
  eq('结晶是从装里拿的：装 3 → 0', r.state.players[0].aura, 0);
  eq('展开后手牌 -1', r.state.players[0].hand.length, 0);
  eq('展开后结晶总数仍是 36', crystals(r.state), 36);

  let cur = startTurnOf(r.state, 0);
  eq('开始阶段：每张付与札掉 1 颗 → 剩 2 颗', cur.players[0].attachments[0].crystals, 2);
  eq('掉下来的结晶进虚：虚 0 → 1', cur.dust, 1);
  eq('付与札还留在场上', cur.players[0].attachments.length, 1);
  eq('同一回合照常抽 2 张', cur.players[0].hand.length, 2);
  eq('结晶总数仍是 36', crystals(cur), 36);

  cur = startTurnOf(cur, 0);
  eq('再过一个回合：剩 1 颗', cur.players[0].attachments[0].crystals, 1);
  eq('虚 1 → 2', cur.dust, 2);

  cur = startTurnOf(cur, 0);
  eq('结晶掉光 → 付与札被破弃（离场）', cur.players[0].attachments.length, 0);
  eq('破弃的牌进弃牌区', cur.players[0].discard.length, 1);
  eq('进弃牌区的就是那张付与札', cur.players[0].discard[0].id, '03-himika-o-n-7');
  eq('破弃后结晶数归 0（不带着结晶进弃牌区）', cur.players[0].discard[0].crystals, 0);
  eq('虚 2 → 3', cur.dust, 3);
  eq('结晶总数仍是 36', crystals(cur), 36);
  ok('这回合才开始弹「是否重组」（弃牌区刚有了通常札）',
    cur.choice && cur.choice.sourceId === 'reshuffle', cur.choice);
}
{
  // --- 3.3 多张付与札：每张各掉 1 颗（不是只掉一张）---
  const s = p0([]);
  // 从间合挪 4 颗结晶到两张付与札上，保持全场 36 颗
  s.distance = 6;
  s.players[0].attachments = [
    Object.assign(cardById('03-himika-o-n-7'), { crystals: 2 }),
    Object.assign(cardById('04-tokoyo-o-n-6'), { crystals: 2 })
  ];
  eq('准备：结晶总数 36（4 颗在付与札上）', crystals(s), 36);

  const st2 = startTurnOf(s, 0);
  eq('两张付与札各掉 1 颗 → 虚 +2', st2.dust, 2);
  eq('第一张剩 1 颗', st2.players[0].attachments[0].crystals, 1);
  eq('第二张剩 1 颗', st2.players[0].attachments[1].crystals, 1);
  eq('两张都还在场（都没掉光）', st2.players[0].attachments.length, 2);
  eq('结晶总数仍是 36', crystals(st2), 36);
}

/* ==========================================================================
 * 4. 集中力上限 2
 * ========================================================================== */
group('4. 集中力上限 2（本来有 2 点再加 1 点仍然是 2）');
{
  let s = p0([]);
  s.players[0].focus = 2;
  let st = startTurnOf(s, 0);
  eq('集中力已经是 2，开始阶段再加也不变（上限截断）', st.players[0].focus, 2);

  s = p0([]); s.players[0].focus = 1;
  st = startTurnOf(s, 0);
  eq('集中力 1 → 2', st.players[0].focus, 2);

  s = p0([]); s.players[0].focus = 0;
  st = startTurnOf(s, 0);
  eq('集中力 0 → 1', st.players[0].focus, 1);

  // 连续三个回合都压在 2，不会累加到 3
  s = p0([]); s.players[0].focus = 2;
  for (let i = 1; i <= 3; i++) {
    s = startTurnOf(s, 0);
    eq('连续第 ' + i + ' 个回合后集中力仍是 2', s.players[0].focus, 2);
  }
  ok('集中力从不为负', s.players[0].focus >= 0, s.players[0].focus);
}

/* ==========================================================================
 * 5. 畏缩 + 得到集中力 → 解除畏缩，不加集中力
 * ========================================================================== */
group('5. 畏缩：得到集中力时改为解除畏缩');
{
  let s = p0([]);
  s.players[0].staggered = true;
  s.players[0].focus = 0;
  let st = startTurnOf(s, 0);
  eq('畏缩被解除', st.players[0].staggered, false);
  eq('「获得集中力」被替换掉 → 集中力仍然是 0', st.players[0].focus, 0);

  s = p0([]);
  s.players[0].staggered = true;
  s.players[0].focus = 2;
  st = startTurnOf(s, 0);
  eq('集中力已满时中畏缩：照样是「解除畏缩」', st.players[0].staggered, false);
  eq('集中力保持在 2（不会因为截断而"白解"以外多出东西）', st.players[0].focus, 2);

  // 解除之后的下一回合恢复正常 +1
  s = p0([]);
  s.players[0].staggered = true;
  s.players[0].focus = 1;
  st = startTurnOf(s, 0);
  eq('第一回合：解除畏缩，集中力仍是 1', st.players[0].focus, 1);
  st = startTurnOf(st, 0);
  eq('第二回合：没有畏缩了，集中力 1 → 2', st.players[0].focus, 2);

  // 畏缩只替换「获得集中力」，抽牌照常
  s = p0([]);
  s.players[0].staggered = true;
  st = startTurnOf(s, 0);
  eq('畏缩不影响抽牌：照样抽 2 张', st.players[0].hand.length, 2);
  eq('结晶总数仍是 36', crystals(st), 36);
}

/* ==========================================================================
 * 6. 手牌上限 2：超出的在结束阶段盖成伏札
 * ========================================================================== */
group('6. 手牌上限 2：超出部分盖成伏札（不是丢进弃牌区）');
{
  const s = p0(['01-yurina-o-n-1', '01-yurina-o-n-2', '01-yurina-o-n-3']);
  const before = cardTotal(s);
  const turnBefore = s.turn;

  let r = E.actions.applyAction(s, { type: 'endTurn', player: 0 });
  ok('手牌 3 张时请求结束回合', r.ok, r.error);
  ok('先挂起「要盖 1 张」的要求', r.state.endTurnPending && r.state.endTurnPending.need === 1,
    r.state.endTurnPending);
  eq('还没换人', r.state.active, 0);
  eq('回合数还没 +1', r.state.turn, turnBefore);
  eq('手牌也还没减少', r.state.players[0].hand.length, 3);
  ok('没选完盖哪张之前不能做基本动作',
    !E.actions.applyAction(r.state, { type: 'basic', player: 0, which: 'charge' }).ok);

  let bad = E.actions.applyAction(r.state, { type: 'confirmEndTurn', player: 0, cardIds: [] });
  ok('一张都不选 → 被拒绝', !bad.ok, bad.error);
  bad = E.actions.applyAction(r.state, {
    type: 'confirmEndTurn', player: 0, cardIds: ['01-yurina-o-n-1', '01-yurina-o-n-2']
  });
  ok('选的张数超过要求 → 被拒绝', !bad.ok, bad.error);

  let r2 = E.actions.applyAction(r.state, {
    type: 'confirmEndTurn', player: 0, cardIds: ['01-yurina-o-n-2']
  });
  ok('正好选 1 张 → 结束回合成功', r2.ok, r2.error);
  eq('手牌 3 → 2', r2.state.players[0].hand.length, 2);
  eq('盖的牌进伏札区（+1）', r2.state.players[0].hidden.length, 1);
  eq('盖下去的就是选中的那张', r2.state.players[0].hidden[0].id, '01-yurina-o-n-2');
  eq('没有进弃牌区', r2.state.players[0].discard.length, 0);
  eq('这时候才换人', r2.state.active, 1);
  eq('回合数 +1', r2.state.turn, turnBefore + 1);
  eq('总牌数不变（盖牌只是换了个地方放）', cardTotal(r2.state), before);
}
{
  // 手牌 5 张 → 要盖 3 张
  const ids = ['01-yurina-o-n-1', '01-yurina-o-n-2', '01-yurina-o-n-3', '01-yurina-o-n-4', '01-yurina-o-n-5'];
  const s = p0(ids);
  let r = E.actions.applyAction(s, { type: 'endTurn', player: 0 });
  eq('手牌 5 张（上限 2）→ 要盖 3 张', r.state.endTurnPending && r.state.endTurnPending.need, 3);

  r = E.actions.applyAction(r.state, {
    type: 'confirmEndTurn', player: 0,
    cardIds: ['01-yurina-o-n-1', '01-yurina-o-n-4', '01-yurina-o-n-5']
  });
  ok('选 3 张盖完', r.ok, r.error);
  eq('手牌剩 2 张', r.state.players[0].hand.length, 2);
  eq('伏札区 3 张', r.state.players[0].hidden.length, 3);
  eq('弃牌区仍是 0', r.state.players[0].discard.length, 0);
  eq('留下的正是没被选的 2 张',
    r.state.players[0].hand.map(function (c) { return c.id; }).sort(),
    ['01-yurina-o-n-2', '01-yurina-o-n-3']);
}
{
  // 手牌上限只在「结束阶段」检查：开始阶段抽到 4 张也允许
  const s = p0(['01-yurina-o-n-1', '01-yurina-o-n-2']);
  const st = startTurnOf(s, 0);
  eq('开始阶段抽到 4 张（超过上限 2 也允许）', st.players[0].hand.length, 4);

  const r = E.actions.applyAction(st, { type: 'endTurn', player: 0 });
  ok('结束回合要先选盖哪 2 张', r.ok && !!r.state.endTurnPending, r.state.endTurnPending);
  eq('要盖 2 张', r.state.endTurnPending.need, 2);
  const r2 = E.actions.applyAction(r.state, {
    type: 'confirmEndTurn', player: 0,
    cardIds: r.state.players[0].hand.slice(0, 2).map(function (c) { return c.id; })
  });
  eq('盖完只留 2 张', r2.state.players[0].hand.length, 2);
  eq('多出的 2 张进伏札区', r2.state.players[0].hidden.length, 2);
}
{
  // 手牌正好 2 张 → 不需要盖牌，直接换人
  const s = p0(['01-yurina-o-n-1', '01-yurina-o-n-2']);
  const r = endTurnAuto(s);
  ok('手牌 2 张时直接结束回合', r.ok, r.error);
  ok('没有挂起「要盖牌」', !r.state.endTurnPending, r.state.endTurnPending);
  eq('手牌仍 2 张', r.state.players[0].hand.length, 2);
  eq('伏札区 0 张', r.state.players[0].hidden.length, 0);
  eq('换人了', r.state.active, 1);
}

/* ==========================================================================
 * 7. 焦燥：牌库空了每缺 1 张 1 点伤害，玩家自己选；不会自动洗牌
 * ========================================================================== */
group('7. 焦燥：抽牌时牌库空了，每缺 1 张受 1 点伤害');
{
  // --- 7.1 牌库只剩 1 张却要抽 2 张 → 缺 1 张 ---
  const s = p0([]);
  s.players[0].deck = [cardById('01-yurina-o-n-1')];   // 只剩 1 张
  s.players[0].discard = [];
  s.players[0].hidden = [];

  const st = startTurnOf(s, 0);
  eq('只能抽到 1 张', st.players[0].hand.length, 1);
  eq('牌库被抽空', st.players[0].deck.length, 0);
  ok('缺 1 张 → 记 1 点焦燥', st.exhaust && st.exhaust.remaining === 1, st.exhaust);
  eq('焦燥还没真的扣东西（等玩家自己选）', st.players[0].life, 10);
  eq('焦燥不会自动洗牌：弃牌区仍是空的', st.players[0].discard.length, 0);
  eq('焦燥不会自动洗牌：伏札区仍是空的', st.players[0].hidden.length, 0);
  eq('焦燥不会自动洗牌：牌库仍是空的', st.players[0].deck.length, 0);

  let r = E.actions.applyAction(st, { type: 'resolveExhaust', player: 0, choice: 'life' });
  ok('选择扣「命」来结算焦燥', r.ok, r.error);
  eq('命 10 → 9', r.state.players[0].life, 9);
  eq('命的结晶飞到气：气 0 → 1', r.state.players[0].flare, 1);
  eq('装没有被扣', r.state.players[0].aura, 3);
  ok('结算完焦燥清空', !r.state.exhaust, r.state.exhaust);
  eq('结晶总数仍是 36', crystals(r.state), 36);
}
{
  // --- 7.2 同一个局面选「装」：结果完全不同（证明是玩家自己选）---
  const s = p0([]);
  s.players[0].deck = [cardById('01-yurina-o-n-1')];
  s.players[0].discard = [];
  s.players[0].hidden = [];
  const st = startTurnOf(s, 0);

  const r = E.actions.applyAction(st, { type: 'resolveExhaust', player: 0, choice: 'aura' });
  ok('选择扣「装」来结算焦燥', r.ok, r.error);
  eq('装 3 → 2', r.state.players[0].aura, 2);
  eq('命没有被扣', r.state.players[0].life, 10);
  eq('装伤进虚：虚 0 → 1', r.state.dust, 1);
  eq('气没有变化', r.state.players[0].flare, 0);
  eq('结晶总数仍是 36', crystals(r.state), 36);
}
{
  // --- 7.3 牌库全空抽 2 张 → 2 点焦燥，可以一点一点分别选 ---
  const s = p0([]);
  s.players[0].deck = [];
  s.players[0].discard = [];
  s.players[0].hidden = [];
  const st = startTurnOf(s, 0);
  eq('一张都抽不到', st.players[0].hand.length, 0);
  ok('缺 2 张 → 记 2 点焦燥', st.exhaust && st.exhaust.remaining === 2, st.exhaust);

  let r = E.actions.applyAction(st, { type: 'resolveExhaust', player: 0, choice: 'aura' });
  eq('第一点扣装：装 3 → 2', r.state.players[0].aura, 2);
  ok('还剩 1 点焦燥', r.state.exhaust && r.state.exhaust.remaining === 1, r.state.exhaust);
  r = E.actions.applyAction(r.state, { type: 'resolveExhaust', player: 0, choice: 'life' });
  eq('第二点扣命：命 10 → 9', r.state.players[0].life, 9);
  ok('两点都结算完，焦燥清空', !r.state.exhaust, r.state.exhaust);
  eq('结晶总数仍是 36', crystals(r.state), 36);
}
{
  // --- 7.4 装是 0 的时候不能选装（只能扣命）---
  const s = p0([]);
  s.players[0].aura = 0;
  s.dust = 3;                        // 装上的 3 颗先挪进虚，保持 36 颗
  s.players[0].deck = [];
  s.players[0].discard = [];
  s.players[0].hidden = [];
  const st = startTurnOf(s, 0);
  ok('先记下焦燥', st.exhaust && st.exhaust.remaining === 2, st.exhaust);
  const r = E.actions.applyAction(st, { type: 'resolveExhaust', player: 0, choice: 'aura' });
  ok('装 0 时选「装」被拒绝', !r.ok, r.error);
  const r2 = E.actions.applyAction(st, { type: 'resolveExhaust', player: 0, choice: 'life' });
  ok('装 0 时选「命」可以', r2.ok, r2.error);
  eq('命 10 → 9', r2.state.players[0].life, 9);
}
{
  // --- 7.5 就算弃牌区里有货，焦燥也不会自动重组 ---
  const s = p0([]);
  s.players[0].deck = [];
  s.players[0].discard = [cardById('01-yurina-o-n-1'), cardById('01-yurina-o-n-2')];
  s.players[0].hidden = [cardById('01-yurina-o-n-3')];
  E.rules.draw(s, 0, 2);
  eq('焦燥不会自动重组：弃牌区原样不动', s.players[0].discard.length, 2);
  eq('焦燥不会自动重组：伏札区原样不动', s.players[0].hidden.length, 1);
  eq('焦燥不会自动重组：牌库还是空的', s.players[0].deck.length, 0);
  ok('缺 2 张 → 记 2 点焦燥', s.exhaust && s.exhaust.remaining === 2, s.exhaust);
}

/* ==========================================================================
 * 8. 重组（山札の再構成）
 * ========================================================================== */
group('8. 重组：扣 1 点命，弃牌区+伏札区的通常札回牌库，王牌不进牌库');
{
  const s = p0([]);
  const n = ['01-yurina-o-n-1', '01-yurina-o-n-2', '01-yurina-o-n-3',
             '01-yurina-o-n-4', '01-yurina-o-n-5'].map(cardById);
  s.players[0].deck = [n[0], n[1]];          // 牌库剩 2 张
  s.players[0].discard = [n[2], n[3]];       // 弃牌区 2 张通常札
  s.players[0].hidden = [n[4]];              // 伏札区 1 张通常札
  const before = cardTotal(s);

  const st = startTurnOf(s, 0);
  ok('开始阶段会问「是否重组牌库」', st.choice && st.choice.sourceId === 'reshuffle', st.choice);
  eq('还没真的重组：命还是 10', st.players[0].life, 10);
  eq('还没真的重组：弃牌区还是 2 张', st.players[0].discard.length, 2);
  eq('还没真的重组：还没抽牌', st.players[0].hand.length, 0);

  let r = E.actions.applyAction(st, { type: 'choose', player: 0, option: 'yes' });
  ok('选择「重组」', r.ok, r.error);
  eq('重组要付 1 点命：10 → 9', r.state.players[0].life, 9);
  eq('付掉的命结晶飞到气：气 0 → 1', r.state.players[0].flare, 1);
  eq('弃牌区被洗空', r.state.players[0].discard.length, 0);
  eq('伏札区被洗空', r.state.players[0].hidden.length, 0);
  eq('牌库 = 2 原有 + 3 洗回 − 2 抽走 = 3', r.state.players[0].deck.length, 3);
  eq('重组后照常抽 2 张', r.state.players[0].hand.length, 2);
  eq('洗回牌库的只有通常札', r.state.players[0].deck.every(function (c) { return c.kind === 'normal'; }),
    true);
  eq('王牌不进牌库：王牌区仍是 3 张', r.state.players[0].specials.length, 3);
  eq('王牌仍然都是未使用状态',
    r.state.players[0].specials.every(function (sp) { return sp.used === false; }), true);
  eq('总牌数不变', cardTotal(r.state), before);
  eq('结晶总数仍是 36', crystals(r.state), 36);
}
{
  // 选「不重组」：不扣命，也不动弃牌区
  const s = p0([]);
  const n = ['01-yurina-o-n-1', '01-yurina-o-n-2'].map(cardById);
  s.players[0].discard = [n[0]];
  s.players[0].hidden = [n[1]];
  const st = startTurnOf(s, 0);
  ok('有可洗的牌 → 弹出询问', !!st.choice, st.choice);
  const r = E.actions.applyAction(st, { type: 'choose', player: 0, option: 'no' });
  ok('选择「不重组」', r.ok, r.error);
  eq('不重组就不扣命', r.state.players[0].life, 10);
  eq('弃牌区原样保留', r.state.players[0].discard.length, 1);
  eq('伏札区原样保留', r.state.players[0].hidden.length, 1);
  eq('照样抽 2 张', r.state.players[0].hand.length, 2);
  eq('牌库 4 → 2', r.state.players[0].deck.length, 2);
}
{
  // 没有可洗的通常札 → 不询问、不扣命，直接抽牌
  const s = p0([]);
  s.players[0].discard = [];
  s.players[0].hidden = [];
  const st = startTurnOf(s, 0);
  ok('没有可洗的牌时不弹询问', !st.choice, st.choice);
  eq('直接抽 2 张', st.players[0].hand.length, 2);
  eq('没有扣命', st.players[0].life, 10);
}
{
  // 直接调用重组：没有材料时返回 false，而且**不能**扣命
  const s = p0([]);
  s.players[0].discard = [];
  s.players[0].hidden = [];
  const c = E.state.clone(s);
  eq('没有材料时重组什么也不做（返回 false）', E.rules.reshuffle(c, 0, true), false);
  eq('没有材料时不扣命', c.players[0].life, 10);
  eq('没有材料时不改气', c.players[0].flare, 0);
}
{
  // 王牌用完不进牌库：用掉浮舟宿之后重组，它必须留在王牌区（不能混进牌库）
  const s = p0(['01-yurina-o-n-1', '01-yurina-o-n-2']);
  s.players[0].focus = 2;
  s.players[0].flare = 2;                     // 浮舟宿费 2 气
  const before = cardTotal(s);

  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-s-3' });
  ok('王牌可以从王牌区直接使用', r.ok, r.error);
  const sp = r.state.players[0].specials.find(function (x) { return x.id === '01-yurina-o-s-3'; });
  eq('用过的王牌标记为已使用', sp.used, true);
  eq('王牌不进弃牌区', r.state.players[0].discard.length, 0);
  eq('王牌仍留在王牌区', r.state.players[0].specials.length, 3);

  const c = E.state.clone(r.state);
  E.rules.hideCard(c, 0, '01-yurina-o-n-1');             // 造一点可洗的材料（手牌 → 伏札）
  eq('重组前伏札区有 1 张', c.players[0].hidden.length, 1);
  E.rules.reshuffle(c, 0, false);
  eq('重组后牌库里没有王牌',
    c.players[0].deck.some(function (x) { return x.kind === 'special'; }), false);
  eq('重组后王牌区仍是 3 张', c.players[0].specials.length, 3);
  eq('重组后王牌仍是已使用',
    c.players[0].specials.find(function (x) { return x.id === '01-yurina-o-s-3'; }).used, true);
  eq('重组前后总牌数不变（王牌没被洗走）', cardTotal(c), before);
}

/* ==========================================================================
 * 9. 五个基本动作：条件 / 结晶移动方向
 * ========================================================================== */
group('9. 基本动作：满足条件时的结晶移动方向');
{
  // 前进：间合 → 装
  const s = p0([]); s.players[0].focus = 1;
  const before = cardTotal(s);
  const r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'advance' });
  ok('前进：间合 10 > 达人距离 2，可以做', r.ok, r.error);
  eq('前进：间合 10 → 9', r.state.distance, 9);
  eq('前进：装 3 → 4', r.state.players[0].aura, 4);
  eq('前进：集中力 1 → 0', r.state.players[0].focus, 0);
  eq('前进：虚不变', r.state.dust, 0);
  eq('前进：结晶总数仍是 36', crystals(r.state), 36);
  eq('前进：双方牌总数不变', cardTotal(r.state), before);
}
{
  // 后退：装 → 间合（先把 4 颗结晶从间合挪进虚，保持全场 36 颗）
  const s = p0([]); s.players[0].focus = 1; s.distance = 6; s.dust = 4;
  eq('准备：结晶总数 36', crystals(s), 36);
  const r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'retreat' });
  ok('后退：装 ≥1 且间合未满，可以做', r.ok, r.error);
  eq('后退：装 3 → 2', r.state.players[0].aura, 2);
  eq('后退：间合 6 → 7', r.state.distance, 7);
  eq('后退：虚不变', r.state.dust, 4);
  eq('后退：结晶总数仍是 36', crystals(r.state), 36);
}
{
  // 缠绕：虚 → 装（2 颗结晶先从间合挪进虚）
  const s = p0([]); s.players[0].focus = 1; s.distance = 8; s.dust = 2;
  eq('准备：结晶总数 36', crystals(s), 36);
  const r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'gather' });
  ok('缠绕：虚 ≥1 且装未满，可以做', r.ok, r.error);
  eq('缠绕：虚 2 → 1', r.state.dust, 1);
  eq('缠绕：装 3 → 4', r.state.players[0].aura, 4);
  eq('缠绕：间合不变', r.state.distance, 8);
  eq('缠绕：结晶总数仍是 36', crystals(r.state), 36);
}
{
  // 宿命：装 → 气
  const s = p0([]); s.players[0].focus = 1;
  const r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'charge' });
  ok('宿命：装 ≥1，可以做', r.ok, r.error);
  eq('宿命：装 3 → 2', r.state.players[0].aura, 2);
  eq('宿命：气 0 → 1', r.state.players[0].flare, 1);
  eq('宿命：命不变', r.state.players[0].life, 10);
  eq('宿命：结晶总数仍是 36', crystals(r.state), 36);
}
{
  // 离脱：虚 → 间合（间合先摆到 2，剩下的 8 颗放进虚）
  const s = p0([]); s.players[0].focus = 1; s.distance = 2; s.dust = 8;
  eq('准备：结晶总数 36', crystals(s), 36);
  const r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'disengage' });
  ok('离脱：间合 2 ≤ 达人距离 2 且虚 ≥1，可以做', r.ok, r.error);
  eq('离脱：虚 8 → 7', r.state.dust, 7);
  eq('离脱：间合 2 → 3', r.state.distance, 3);
  eq('离脱：装不变', r.state.players[0].aura, 3);
  eq('离脱：结晶总数仍是 36', crystals(r.state), 36);
}

group('9b. 基本动作：条件不满足时不能做（反例）');
{
  const tryBasic = function (mut, which) {
    const s = p0([]);
    s.players[0].focus = 2;
    if (mut) mut(s);
    return { s: s, r: E.actions.applyAction(s, { type: 'basic', player: 0, which: which }) };
  };

  // 前进的反例
  let t = tryBasic(function (s) { s.distance = 2; }, 'advance');
  ok('前进：间合正好 = 达人距离 2 时不能前进', !t.r.ok, t.r.error);
  ok('被拒绝时原状态一点没动', JSON.stringify(t.r.state) === JSON.stringify(t.s));
  t = tryBasic(function (s) { s.distance = 0; }, 'advance');
  ok('前进：间合 0 时不能前进', !t.r.ok, t.r.error);
  t = tryBasic(function (s) { s.players[0].aura = 5; }, 'advance');
  ok('前进：装已满 5 时不能前进', !t.r.ok, t.r.error);

  // 后退的反例
  t = tryBasic(function (s) { s.players[0].aura = 0; }, 'retreat');
  ok('后退：装 0 时不能后退', !t.r.ok, t.r.error);
  t = tryBasic(function (s) { s.distance = 10; }, 'retreat');
  ok('后退：间合已满 10 时不能后退', !t.r.ok, t.r.error);

  // 缠绕的反例
  t = tryBasic(function (s) { s.dust = 0; }, 'gather');
  ok('缠绕：虚 0 时不能缠绕', !t.r.ok, t.r.error);
  t = tryBasic(function (s) { s.dust = 2; s.players[0].aura = 5; }, 'gather');
  ok('缠绕：装已满 5 时不能缠绕', !t.r.ok, t.r.error);

  // 宿命的反例
  t = tryBasic(function (s) { s.players[0].aura = 0; }, 'charge');
  ok('宿命：装 0 时不能宿命', !t.r.ok, t.r.error);

  // 离脱的反例
  t = tryBasic(function (s) { s.distance = 3; s.dust = 2; }, 'disengage');
  ok('离脱：间合 3 > 达人距离 2 时不能离脱', !t.r.ok, t.r.error);
  t = tryBasic(function (s) { s.distance = 2; s.dust = 0; }, 'disengage');
  ok('离脱：虚 0 时不能离脱', !t.r.ok, t.r.error);
  t = tryBasic(function (s) { s.distance = 10; s.dust = 2; }, 'disengage');
  ok('离脱：间合 10 时不能离脱', !t.r.ok, t.r.error);

  // 集中力 0（也不付手牌）→ 五个动作全都做不了
  ['advance', 'retreat', 'gather', 'charge', 'disengage'].forEach(function (which) {
    const s = p0([]);
    s.players[0].focus = 0;
    s.dust = 2;
    const r = E.actions.applyAction(s, { type: 'basic', player: 0, which: which });
    ok('集中力 0（不用手牌付）时不能做「' + which + '」', !r.ok, r.error);
  });

  // 不是自己的回合
  {
    const s = p0([]);
    s.players[1].focus = 2;
    const r = E.actions.applyAction(s, { type: 'basic', player: 1, which: 'advance' });
    ok('不是自己的回合不能做基本动作', !r.ok, r.error);
  }
  // 不存在的动作名
  {
    const s = p0([]);
    s.players[0].focus = 2;
    const r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'fly' });
    ok('不存在的动作名被拒绝', !r.ok, r.error);
  }
}

/* ==========================================================================
 * 10. 基本动作的两种代价
 * ========================================================================== */
group('10. 代价 A：花 1 点集中力');
{
  const s = p0(['01-yurina-o-n-1']);
  s.players[0].focus = 2;
  const r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'charge' });
  ok('有 2 点集中力时可以做宿命', r.ok, r.error);
  eq('集中力 2 → 1（付了 1 点）', r.state.players[0].focus, 1);
  eq('手牌没动', r.state.players[0].hand.length, 1);
  eq('伏札区没动', r.state.players[0].hidden.length, 0);

  const r2 = E.actions.applyAction(r.state, { type: 'basic', player: 0, which: 'charge' });
  ok('再付 1 点集中力做第二次', r2.ok, r2.error);
  eq('集中力 1 → 0', r2.state.players[0].focus, 0);

  const r3 = E.actions.applyAction(r2.state, { type: 'basic', player: 0, which: 'charge' });
  ok('集中力 0 时不能再花集中力做（一回合最多 2 次）', !r3.ok, r3.error);
  eq('集中力不会变成负数', r3.state.players[0].focus, 0);
}

group('10b. 代价 B：把 1 张手牌盖成伏札');
{
  const s = p0(['01-yurina-o-n-1', '01-yurina-o-n-2']);
  s.players[0].focus = 1;
  const r = E.actions.applyAction(s, {
    type: 'basic', player: 0, which: 'charge', pay: 'hand', cardId: '01-yurina-o-n-2'
  });
  ok('用手牌付代价可以做基本动作', r.ok, r.error);
  eq('手牌 -1', r.state.players[0].hand.length, 1);
  eq('伏札区 +1', r.state.players[0].hidden.length, 1);
  eq('盖下去的就是指定的那张', r.state.players[0].hidden[0].id, '01-yurina-o-n-2');
  eq('集中力不变（这次不是花集中力）', r.state.players[0].focus, 1);
  eq('动作照样生效：装 3 → 2', r.state.players[0].aura, 2);
  eq('宿命的结晶去向：气 0 → 1', r.state.players[0].flare, 1);
  eq('没有进弃牌区', r.state.players[0].discard.length, 0);
  eq('结晶总数仍是 36', crystals(r.state), 36);
}
{
  // 集中力 0 时，用盖手牌照样能行动
  const s = p0(['01-yurina-o-n-1']);
  s.players[0].focus = 0;
  const r = E.actions.applyAction(s, {
    type: 'basic', player: 0, which: 'charge', pay: 'hand', cardId: '01-yurina-o-n-1'
  });
  ok('集中力 0 也能靠盖手牌做基本动作', r.ok, r.error);
  eq('集中力仍是 0', r.state.players[0].focus, 0);
  eq('手牌 1 → 0', r.state.players[0].hand.length, 0);
  eq('伏札区 0 → 1', r.state.players[0].hidden.length, 1);
  eq('动作生效：装 3 → 2', r.state.players[0].aura, 2);
}
{
  // 要付的牌不在手上 → 拒绝，且什么都不改
  const s = p0(['01-yurina-o-n-1']);
  s.players[0].focus = 1;
  const r = E.actions.applyAction(s, {
    type: 'basic', player: 0, which: 'charge', pay: 'hand', cardId: '01-yurina-o-n-3'
  });
  ok('要盖的牌不在手上 → 被拒绝', !r.ok, r.error);
  ok('被拒绝时原状态一点没动', JSON.stringify(r.state) === JSON.stringify(s));
}
{
  // 盖的牌进伏札区后，还能被重组洗回牌库（不是丢弃）
  const s = p0(['01-yurina-o-n-1', '01-yurina-o-n-2']);
  s.players[0].focus = 1;
  let r = E.actions.applyAction(s, {
    type: 'basic', player: 0, which: 'charge', pay: 'hand', cardId: '01-yurina-o-n-1'
  });
  eq('盖牌后伏札区 1 张', r.state.players[0].hidden.length, 1);
  const c = E.state.clone(r.state);
  E.rules.reshuffle(c, 0, false);
  eq('伏札区的牌被洗回牌库', c.players[0].hidden.length, 0);
  eq('牌库里有它', c.players[0].deck.some(function (x) { return x.id === '01-yurina-o-n-1'; }), true);
}

/* ==========================================================================
 * 11. 免费基本动作（free:true）不花集中力
 * ========================================================================== */
group('11. 免费基本动作（free:true）不花集中力');
{
  const s = p0([]);
  s.players[0].focus = 0;
  const r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'charge', free: true });
  ok('免费基本动作不要求集中力', r.ok, r.error);
  eq('集中力仍是 0（没花）', r.state.players[0].focus, 0);
  eq('手牌仍是 0（也没盖牌）', r.state.players[0].hand.length, 0);
  eq('动作照样生效：装 3 → 2', r.state.players[0].aura, 2);
  eq('宿命：气 0 → 1', r.state.players[0].flare, 1);
  eq('结晶总数仍是 36', crystals(r.state), 36);
}
{
  // 集中力有 2 点，免费做一次集中力也不该被扣
  const s = p0([]);
  s.players[0].focus = 2;
  const r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'gather', free: true });
  ok('免费缠绕（虚不足时）依然要检查条件', !r.ok, r.error);

  const s2 = p0([]);
  s2.players[0].focus = 2;
  s2.dust = 2;
  const r2 = E.actions.applyAction(s2, { type: 'basic', player: 0, which: 'gather', free: true });
  ok('条件满足时免费缠绕成功', r2.ok, r2.error);
  eq('免费缠绕不扣集中力', r2.state.players[0].focus, 2);
  eq('缠绕生效：虚 2 → 1', r2.state.dust, 1);
  eq('缠绕生效：装 3 → 4', r2.state.players[0].aura, 4);
}
{
  // 免费也不能在别人的回合做
  const s = p0([]);
  const r = E.actions.applyAction(s, { type: 'basic', player: 1, which: 'charge', free: true });
  ok('免费基本动作也要轮到自己', !r.ok, r.error);
}

/* ==========================================================================
 * 12. 再起：在结束阶段检查条件
 * ========================================================================== */
group('12. 再起：结束阶段条件满足 → 王牌回未使用');
{
  // P0 用细音，音無砕氷（02-saine-o-s-3）的再起条件是「八相：自装 ≤1」
  const s = E.state.clone(fresh('saine', 'yurina'));
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[1].firstTurnDone = true;
  s.players[0].hand = [];
  s.players[1].hand = [];

  const sp = s.players[0].specials.find(function (x) { return x.id === '02-saine-o-s-3'; });
  ok('准备：细音的王牌区里有音無砕氷', !!sp);
  sp.used = true;
  s.players[0].aura = 1;                       // 八相 → 再起条件满足
  eq('准备：它是「已使用」', sp.used, true);

  const r = E.actions.applyAction(s, { type: 'endTurn', player: 0 });
  ok('结束回合成功', r.ok, r.error);
  const after = r.state.players[0].specials.find(function (x) { return x.id === '02-saine-o-s-3'; });
  eq('结束阶段检查再起 → 王牌回到未使用', after.used, false);
  eq('原状态没被改动（applyAction 不改入参）', sp.used, true);
}
{
  // 条件不满足就不复位
  const s = E.state.clone(fresh('saine', 'yurina'));
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[1].firstTurnDone = true;
  s.players[0].hand = [];
  s.players[1].hand = [];
  const sp = s.players[0].specials.find(function (x) { return x.id === '02-saine-o-s-3'; });
  sp.used = true;
  s.players[0].aura = 3;                       // 三段 → 不是八相，条件不满足

  const r = E.actions.applyAction(s, { type: 'endTurn', player: 0 });
  const after = r.state.players[0].specials.find(function (x) { return x.id === '02-saine-o-s-3'; });
  eq('条件不满足时王牌仍是已使用', after.used, true);
}
{
  // 再起只在结束阶段检查，主要阶段做动作不会让它复位
  const s = E.state.clone(fresh('saine', 'yurina'));
  s.active = 0;
  s.players[0].firstTurnDone = true;
  const sp = s.players[0].specials.find(function (x) { return x.id === '02-saine-o-s-3'; });
  sp.used = true;
  s.players[0].aura = 1;
  s.players[0].focus = 1;

  const r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'advance' });
  ok('主要阶段做基本动作成功', r.ok, r.error);
  const after = r.state.players[0].specials.find(function (x) { return x.id === '02-saine-o-s-3'; });
  eq('主要阶段不会检查「再起」', after.used, true);
}
{
  // 「再起」和「即再起」是两种时机，不能混
  const s = E.state.clone(fresh('yurina', 'saine'));
  const sp = s.players[0].specials.find(function (x) { return x.id === '01-yurina-o-s-3'; });
  sp.used = true;
  s.players[0].life = 3;                       // 决死条件满足
  eq('结束阶段的检查不处理【即再起】的王牌', E.rules.tryRevive(s, 0, 'normal'), 0);
  eq('浮舟宿仍是已使用（等它自己的时机）', sp.used, true);
  eq('【即再起】检查会让它立刻复位', E.rules.tryRevive(s, 0, 'instant'), 1);
  eq('复位后是未使用', sp.used, false);
}

/* ==========================================================================
 * 13. 即再起：条件一满足就立刻触发
 * ========================================================================== */
group('13. 即再起：命降到 3 以下时，浮舟宿立刻回未使用');
{
  const s = p0([]);
  const sp = s.players[0].specials.find(function (x) { return x.id === '01-yurina-o-s-3'; });
  sp.used = true;
  // 命从 10 调到 5：少的 5 颗先挪进虚，保持全场 36 颗
  s.players[0].life = 5;
  s.dust = 5;
  eq('准备：结晶总数 36', crystals(s), 36);

  let r = E.actions.applyAction(s, { type: 'damage', who: 0, aura: 0, life: 1, choice: 'life' });
  ok('造成 1 点命伤', r.ok, r.error);
  eq('命 5 → 4', r.state.players[0].life, 4);
  let cur = r.state.players[0].specials.find(function (x) { return x.id === '01-yurina-o-s-3'; });
  eq('命 4：还没到决死，浮舟宿仍是已使用', cur.used, true);

  r = E.actions.applyAction(r.state, { type: 'damage', who: 0, aura: 0, life: 1, choice: 'life' });
  eq('命 4 → 3', r.state.players[0].life, 3);
  cur = r.state.players[0].specials.find(function (x) { return x.id === '01-yurina-o-s-3'; });
  eq('命降到 3 → 即再起立刻回未使用', cur.used, false);
  eq('结晶总数仍是 36', crystals(r.state), 36);
}
{
  // 不是自己的回合也要立刻触发（「任何时候」）
  const s = p0([]);
  s.active = 1;
  s.turn = 4;
  const sp = s.players[0].specials.find(function (x) { return x.id === '01-yurina-o-s-3'; });
  sp.used = true;
  s.players[0].life = 4;
  s.dust = 6;                                  // 命少的 6 颗先挪进虚，保持 36 颗
  eq('准备：结晶总数 36', crystals(s), 36);

  const r = E.actions.applyAction(s, { type: 'damage', who: 0, aura: 0, life: 1, choice: 'life' });
  ok('在对手回合里受到命伤也能触发', r.ok, r.error);
  eq('命 4 → 3', r.state.players[0].life, 3);
  const cur = r.state.players[0].specials.find(function (x) { return x.id === '01-yurina-o-s-3'; });
  eq('即再起与是谁的回合无关：王牌已被复位', cur.used, false);
  eq('结晶总数仍是 36', crystals(r.state), 36);
}
{
  // 只有带 revive 标记的王牌才会复位（没标记的一直是已使用）
  const s = p0([]);
  s.players[0].life = 3;
  const sp1 = s.players[0].specials.find(function (x) { return x.id === '01-yurina-o-s-1'; });
  sp1.used = true;
  const r = E.actions.applyAction(s, { type: 'damage', who: 0, aura: 0, life: 1, choice: 'life' });
  const cur = r.state.players[0].specials.find(function (x) { return x.id === '01-yurina-o-s-1'; });
  eq('没有【即再起】的王牌不会自己复位', cur.used, true);
}

/* ==========================================================================
 * 14. 结晶守恒（36）与牌数守恒（20）：连续 8 个回合
 * ========================================================================== */
group('14. 守恒：连续 8 个回合，每回合 结晶 36 / 牌 20');
{
  let s = fresh();
  let turns = 0;
  let loopOk = true;

  for (let i = 1; i <= 8; i++) {
    s = settle(s, 'auto');

    eq('第 ' + i + ' 回合开始时：结晶总数 = 36', crystals(s), 36);
    eq('第 ' + i + ' 回合开始时：双方牌总数 = 20', cardTotal(s), 20);
    s.players.forEach(function (p, k) {
      ok('第 ' + i + ' 回合：P' + k + ' 集中力在 0~2 之间', p.focus >= 0 && p.focus <= 2, p.focus);
    });
    ok('第 ' + i + ' 回合：间合在 0~10 之间', s.distance >= 0 && s.distance <= 10, s.distance);

    const r = endTurnAuto(s);
    if (!r.ok) {
      ok('第 ' + i + ' 回合：能够正常结束回合', false, r.error);
      loopOk = false;
      break;
    }
    s = r.state;
    turns++;

    // 刚结束回合的一方，手牌必须被压到 2 张以内（而且是盖成伏札）
    const prev = 1 - s.active;
    ok('第 ' + i + ' 回合结束：P' + prev + ' 的手牌 ≤ 2',
      s.players[prev].hand.length <= 2, s.players[prev].hand.length);

    eq('第 ' + i + ' 回合结束后：结晶总数 = 36', crystals(s), 36);
    eq('第 ' + i + ' 回合结束后：双方牌总数 = 20', cardTotal(s), 20);

    if (s.winner !== null) break;
  }

  ok('8 个回合的循环全部跑通', loopOk);
  ok('至少跑完 6 个回合', turns >= 6, turns);
  ok('8 个回合内没有分出胜负（局面足够安全）', s.winner === null, s.winner);
  eq('循环结束后结晶总数仍是 36', crystals(s), 36);
  eq('循环结束后双方牌总数仍是 20', cardTotal(s), 20);
}

/* ==========================================================================
 * 15. 胜负
 * ========================================================================== */
group('15. 胜负：命归零时设置 winner');
{
  const s = p0([]);
  // 命从 10 调到 1：少的 9 颗先挪进虚，保持全场 36 颗
  s.players[0].life = 1;
  s.dust = 9;
  s.players[1].life = 10;

  const r = E.actions.applyAction(s, { type: 'damage', who: 0, aura: 0, life: 1, choice: 'life' });
  ok('致命一击可以结算', r.ok, r.error);
  eq('P0 命 1 → 0', r.state.players[0].life, 0);
  eq('winner 被设为对手 P1', r.state.winner, 1);
  eq('P1 的命没变', r.state.players[1].life, 10);
  eq('结晶总数仍是 36（命的结晶进了气，没消失）', crystals(r.state), 36);

  const r2 = E.actions.applyAction(r.state, { type: 'endTurn', player: 0 });
  ok('分出胜负后不能再继续操作', !r2.ok, r2.error);
}
{
  // 命被打到 0 以下：命区的结晶只有 1 颗，最多扣到 0
  const s = p0([]);
  s.players[1].life = 1;
  s.dust = 9;
  const r = E.actions.applyAction(s, { type: 'damage', who: 1, aura: 0, life: 3, choice: 'life' });
  eq('P1 命 1 → 0（命区只有 1 颗结晶，扣不到 -2）', r.state.players[1].life, 0);
  eq('命 ≤ 0 → winner = P0', r.state.winner, 0);
  eq('结晶总数仍是 36', crystals(r.state), 36);
}

/* ==========================================================================
 * 16. 已知引擎问题（预期失败）
 * ==========================================================================
 *
 * 【问题】焦燥的「缺几张」在同回合的多笔抽牌之间会被覆盖，伤害少算。
 *
 *   规则（官方要点第 7 条）：抽牌时牌库空了，**每缺 1 张**受到 1 点伤害。
 *   现状：rules.js 的 draw() 里写的是
 *           state.exhaust = { who: who, remaining: exhaustCount };
 *         这是**赋值**而不是**累加**。于是同一回合里第二次抽牌失败时，
 *         第一次记下的焦燥点数被直接覆盖掉。
 *
 *   期望：开始阶段缺 2 张 + 卡牌效果再缺 1 张 = 3 点焦燥伤害
 *   实际：只剩后一次的 1 点（少受 2 点）
 *
 *   复现步骤（任一）：
 *     A. 直接调规则层：state.players[0].deck = []，然后 E.rules.draw(state, 0, 2)、
 *        E.rules.draw(state, 0, 1)，读 state.exhaust.remaining。
 *     B. 真实对局流程：用绯弥香开局，把牌库清空、手牌只留《バックステップ》
 *        （03-himika-o-n-5，使用后抽 1 张）。回合开始阶段先吃 2 点焦燥，
 *        再打出这张牌抽 1 张（牌库仍为空）→ 只剩 1 点焦燥。
 *
 *   建议修法：draw() 里改成
 *     state.exhaust = state.exhaust && state.exhaust.who === who
 *       ? { who: who, remaining: state.exhaust.remaining + exhaustCount }
 *       : { who: who, remaining: exhaustCount };
 *   （注意还要处理「上一次焦燥还没结算完就换了别人」的边界，最好把 who 也一起合并判断。）
 *
 *   这两条断言**故意保留为失败**，用来盯住这个 bug；修好后它们就会变绿。
 * ========================================================================== */
group('16. 已知问题：焦燥次数会被后一笔抽牌覆盖（预期失败）');
{
  // --- 最小复现：规则层连抽两笔 ---
  const s = p0([]);
  s.players[0].deck = [];
  s.players[0].discard = [];
  s.players[0].hidden = [];

  E.rules.draw(s, 0, 2);                       // 第一笔：缺 2 张
  eq('第一笔抽 2 张全缺 → 2 点焦燥', s.exhaust.remaining, 2);

  E.rules.draw(s, 0, 1);                       // 第二笔：再缺 1 张
  ok('两笔抽牌都缺 → 焦燥应累计为 3 点（每缺 1 张 1 点伤害）',
    s.exhaust.remaining === 3, s.exhaust.remaining);
}
{
  // --- 真实流程复现：绯弥香在空牌库的上开开始阶段，再打《バックステップ》抽 1 ---
  const s = E.state.clone(fresh('himika', 'yurina'));
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[0].hand = [cardById('03-himika-o-n-5')];   // バックステップ：抽 1 张
  s.players[0].deck = [];
  s.players[0].discard = [];
  s.players[0].hidden = [];
  s.players[0].focus = 1;

  const st = startTurnOf(s, 0);
  ok('开始阶段抽 2 张全缺 → 2 点焦燥', st.exhaust && st.exhaust.remaining === 2, st.exhaust);

  const r = E.actions.applyAction(st, { type: 'playCard', player: 0, cardId: '03-himika-o-n-5' });
  ok('空牌库时也能打出《バックステップ》', r.ok, r.error);
  eq('这 1 张也抽不到（牌库还是空的）', r.state.players[0].deck.length, 0);
  ok('开始阶段缺 2 + 卡牌效果缺 1 → 总共应受 3 点焦燥伤害',
    r.state.exhaust && r.state.exhaust.remaining === 3, r.state.exhaust);
}

/* ==========================================================================
 * 汇总
 * ========================================================================== */
report();
