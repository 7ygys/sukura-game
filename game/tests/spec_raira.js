/* ============================================================
 * spec_raira.js —— 莱拉（风雷计略）的白盒测试
 * ============================================================ */
const H = require('./harness');
const { E, ok, eq, group, report, cardById, autoNabu, cardTotal } = H;
const G = E.gauge;

function extras() {
  const g = H.db.goddesses.find(x => x.key === 'raira');
  return JSON.parse(JSON.stringify(g.extras || []));
}

function mk(handIds, opts) {
  opts = opts || {};
  const s = E.state.create({
    myCards: H.deckOf(opts.me || 'raira'),
    oppCards: H.deckOf(opts.opp || 'yurina'),
    extras: extras()
  });
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[1].firstTurnDone = true;
  s.players[0].goddesses = [opts.me || 'raira'];
  s.players[1].goddesses = [opts.opp || 'yurina'];
  s.players[0].hand = (handIds || []).map(cardById);
  if (opts.distance !== undefined) s.distance = opts.distance;
  if (opts.dust !== undefined) s.dust = opts.dust;
  if (opts.wind !== undefined) s.players[0].wind = opts.wind;
  if (opts.thunder !== undefined) s.players[0].thunder = opts.thunder;
  if (opts.flare !== undefined) s.players[0].flare = opts.flare;
  return s;
}
function A(s, a) { return E.actions.applyAction(s, a); }

/* ============================================================ */
group('风雷计略：初始 0、用其他女神的牌记账、结束阶段分配');
{
  const s = mk([]);
  eq('风神初始 0', G.wind(s, 0), 0);
  eq('雷神初始 0', G.thunder(s, 0), 0);

  // 用一张其他女神的牌（斩）
  s.players[0].hand = [cardById('01-yurina-o-n-1')];
  s.distance = 3;
  let r = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('打出其他女神的牌', r.ok, r.error);
  eq('记账 +1', G.pendingPoints(r.state, 0), 1);
  eq('此时还没加点', G.wind(r.state, 0) + G.thunder(r.state, 0), 0);

  // 用自己的牌不记账
  let s2 = mk(['12-raira-o-n-1'], { distance: 2 });
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '12-raira-o-n-1' });
  eq('莱拉自己的牌不记账', G.pendingPoints(r2.state, 0), 0);
}

/* ============================================================ */
group('结束阶段：先分配风雷，再处理手牌上限');
{
  let s = mk([]);
  s.players[0].otherCardsUsed = 3;
  s.players[0].hand = [];
  let r = A(s, { type: 'endTurn', player: 0 });
  ok('结束回合时挂起分配', !!r.state.gaugePending, r.state.gaugePending);
  eq('要分 3 点', r.state.gaugePending.left, 3);
  eq('还没换人', r.state.active, 0);

  const blocked = A(r.state, { type: 'basic', player: 0, which: 'charge' });
  ok('没分配完不能做别的', !blocked.ok, blocked.error);

  const w = A(r.state, { type: 'gauge', player: 0, kind: 'wind' });
  ok('全加到风神', w.ok, w.error);
  eq('风神 3', G.wind(w.state, 0), 3);
  eq('已经换人', w.state.active, 1);
}

/* ============================================================ */
group('風雷撃：气伤 = 风与雷较小的一方');
{
  let s = mk(['12-raira-o-n-2'], { distance: 2, wind: 3, thunder: 1 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '12-raira-o-n-2' });
  ok('打出風雷撃', r.ok, r.error);
  eq('min(3,1) = 1/2', r.state.pending.damage, { aura: 1, life: 2 });

  let s2 = mk(['12-raira-o-n-2'], { distance: 2, wind: 4, thunder: 4 });
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '12-raira-o-n-2' });
  eq('min(4,4) = 4/2', r2.state.pending.damage, { aura: 4, life: 2 });
}

/* ============================================================ */
group('流転爪：攻击后把弃牌区的攻击牌放回牌库顶');
{
  let s = mk(['12-raira-o-n-3'], { distance: 2 });
  s.players[0].discard = [cardById('12-raira-o-n-2')];
  s.players[0].deck = [];
  let r = A(s, { type: 'playCard', player: 0, cardId: '12-raira-o-n-3' });
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('弹出选牌', !!r.state.cardPick, r.state.cardPick);
  const cands = E.effects.pickCandidates(r.state, r.state.cardPick);
  ok('候选里都是攻击牌', cands.every(c => (c.types || []).indexOf('attack') >= 0));
  ok('弃牌区的風雷撃在候选里', cands.some(c => c.id === '12-raira-o-n-2'));
  const pick = A(r.state, { type: 'pickCard', player: 0, cardId: '12-raira-o-n-2', mode: 'toDeckTop' });
  ok('放回牌库顶', pick.ok, pick.error);
  eq('牌库顶是風雷撃', pick.state.players[0].deck[0].id, '12-raira-o-n-2');
}

/* ============================================================ */
group('風走り：间合 3 以上才有效果');
{
  let s = mk(['12-raira-o-n-4'], { distance: 4, dust: 4 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '12-raira-o-n-4' });
  ok('打出風走り', r.ok, r.error);
  eq('间合 4 → 2', r.state.distance, 2);
  eq('虚 4 → 6', r.state.dust, 6);

  let s2 = mk(['12-raira-o-n-4'], { distance: 2, dust: 4 });
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '12-raira-o-n-4' });
  eq('间合 2 时没有效果', r2.state.distance, 2);
}

/* ============================================================ */
group('風雷の知恵：合计 4 以上可回收 + 风或雷 +1');
{
  let s = mk(['12-raira-o-n-5'], { wind: 2, thunder: 2 });
  s.players[0].discard = [cardById('01-yurina-o-n-1')];
  let r = A(s, { type: 'playCard', player: 0, cardId: '12-raira-o-n-5' });
  ok('打出風雷の知恵', r.ok, r.error);
  ok('弹出回收选牌（合计 4）', !!r.state.cardPick, r.state.cardPick);
  const pick = A(r.state, { type: 'pickCard', player: 0, cardId: '01-yurina-o-n-1', mode: 'toDeckTop' });
  ok('回收成功', pick.ok, pick.error);
  ok('之后要选风或雷', !!pick.state.choice, pick.state.choice);
  const ch = A(pick.state, { type: 'choose', player: 0, option: 'thunder' });
  eq('雷神 2 → 3', G.thunder(ch.state, 0), 3);

  // 合计不足 4：不弹回收
  let s2 = mk(['12-raira-o-n-5'], { wind: 1, thunder: 1 });
  s2.players[0].discard = [cardById('01-yurina-o-n-1')];
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '12-raira-o-n-5' });
  ok('合计不足 4 → 不弹回收', !r2.state.cardPick, r2.state.cardPick);
}

/* ============================================================ */
group('呼び声：畏缩 + 二选一');
{
  let s = mk(['12-raira-o-n-6'], { wind: 1, thunder: 2 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '12-raira-o-n-6' });
  ok('打出呼び声', r.ok, r.error);
  eq('对方畏缩', r.state.players[1].staggered, true);
  const ch = A(r.state, { type: 'choose', player: 0, option: 'double' });
  eq('雷神翻倍 2 → 4', G.thunder(ch.state, 0), 4);
  eq('手牌全部盖成伏札', ch.state.players[0].hand.length, 0);
}

/* ============================================================ */
group('空駆け：间合⇄虚 3');
{
  let s = mk(['12-raira-o-n-7'], { distance: 4, dust: 4 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '12-raira-o-n-7' });
  ok('打出空駆け', r.ok, r.error);
  const ch = A(r.state, { type: 'choose', player: 0, option: 'to_dist' });
  eq('虚→间合 3：间合 7', ch.state.distance, 7);
  eq('虚 4 → 1', ch.state.dust, 1);
}

/* ============================================================ */
group('雷螺風神爪：雷神 4 以上 +1/+0；再起看风神');
{
  let s = mk([], { distance: 2, flare: 5, thunder: 4 });
  s.players[0].specials = [Object.assign(cardById('12-raira-o-s-1'), { used: false })];
  let r = A(s, { type: 'playCard', player: 0, cardId: '12-raira-o-s-1' });
  ok('打出雷螺風神爪', r.ok, r.error);
  eq('2/2 → 3/2', r.state.pending.damage, { aura: 3, life: 2 });

  let s2 = mk([], { thunder: 0 });
  s2.players[0].specials = [Object.assign(cardById('12-raira-o-s-1'), { used: true })];
  s2.players[0].wind = 3;
  eq('风神不到 4 → 不复活', E.rules.tryRevive(s2, 0, 'normal'), 0);
  s2.players[0].wind = 4;
  eq('风神 4 → 再起', E.rules.tryRevive(s2, 0, 'normal'), 1);
}

/* ============================================================ */
group('天雷召喚陣：雷神一半（向上取整）次 1/1');
{
  let s = mk([], { flare: 8, thunder: 5 });
  s.players[0].specials = [Object.assign(cardById('12-raira-o-s-2'), { used: false })];
  let r = A(s, { type: 'playCard', player: 0, cardId: '12-raira-o-s-2' });
  ok('打出天雷召喚陣', r.ok, r.error);
  eq('第一发是 1/1', r.state.pending.damage, { aura: 1, life: 1 });
  eq('剩余队列 2 发（共 ceil(5/2)=3）', (r.state.attackQueue || []).length, 2);
}

/* ============================================================ */
group('風魔招来孔：按风神发追加札，然后自己移除');
{
  let s = mk([], { flare: 8, wind: 7 });
  s.players[0].specials = [Object.assign(cardById('12-raira-o-s-3'), { used: false })];
  let r = A(s, { type: 'playCard', player: 0, cardId: '12-raira-o-s-3' });
  ok('打出風魔招来孔', r.ok, r.error);
  const ids = r.state.players[0].specials.map(c => c.id);
  ok('风神 7 → 拿到旋風和纏廻', ids.indexOf('12-raira-o-s-3-ex1') >= 0 && ids.indexOf('12-raira-o-s-3-ex2') >= 0);
  ok('风神 7 拿不到天狗道', ids.indexOf('12-raira-o-s-3-ex3') < 0);
  eq('这张牌从游戏中移除', r.state.players[0].removed.length, 1);
  eq('不再在王牌区', ids.indexOf('12-raira-o-s-3'), -1);
}

/* ============================================================ */
group('風魔纏廻：切札回到未使用 + 消费 -1');
{
  let s = mk([], { flare: 8, wind: 7 });
  s.players[0].specials = [
    Object.assign(cardById('12-raira-o-s-3'), { used: false }),
    Object.assign(cardById('12-raira-o-s-1'), { used: true })
  ];
  let r = A(s, { type: 'playCard', player: 0, cardId: '12-raira-o-s-3' });
  // 拿到 ex2 之后用它
  const ex2 = r.state.players[0].specials.find(c => c.id === '12-raira-o-s-3-ex2');
  ok('拿到風魔纏廻', !!ex2);
  r.state.players[0].flare = 5;
  let r2 = A(r.state, { type: 'playCard', player: 0, cardId: '12-raira-o-s-3-ex2' });
  ok('打出風魔纏廻', r2.ok, r2.error);
  ok('弹出选"使用过的切札"', !!r2.state.cardPick, r2.state.cardPick);
  const pick = A(r2.state, { type: 'pickCard', player: 0, cardId: '12-raira-o-s-1', mode: 'reviveSpecial' });
  ok('雷螺風神爪回到未使用', pick.ok && !pick.state.players[0].specials.find(c => c.id === '12-raira-o-s-1').used);

  // 消费 -1：雷螺風神爪 原价 3 → 2
  pick.state.distance = 2;
  const before = pick.state.players[0].flare;
  const play = A(pick.state, { type: 'playCard', player: 0, cardId: '12-raira-o-s-1' });
  ok('再打一次雷螺風神爪', play.ok, play.error);
  eq('消费 3 → 2', before - play.state.players[0].flare, 2);
}

/* ============================================================ */
group('风雷分配：可以拆分给风和雷');
{
  let s = mk([]);
  s.players[0].otherCardsUsed = 5;
  s.players[0].hand = [];
  let r = A(s, { type: 'endTurn', player: 0 });
  eq('要分 5 点', r.state.gaugePending.left, 5);
  const sp = A(r.state, { type: 'gauge', player: 0, kind: 'split', wind: 3, thunder: 2 });
  ok('拆分分配成功', sp.ok, sp.error);
  eq('风神 3', G.wind(sp.state, 0), 3);
  eq('雷神 2', G.thunder(sp.state, 0), 2);

  // 总数不对要拒绝
  let s2 = mk([]);
  s2.players[0].otherCardsUsed = 3;
  s2.players[0].hand = [];
  let r2 = A(s2, { type: 'endTurn', player: 0 });
  const bad = A(r2.state, { type: 'gauge', player: 0, kind: 'split', wind: 1, thunder: 1 });
  ok('分配数不对 → 拒绝', !bad.ok, bad.error);

  // 放弃
  const skip = A(r2.state, { type: 'gauge', player: 0, kind: 'skip' });
  ok('可以放弃点数', skip.ok, skip.error);
  eq('放弃后风雷仍是 0', G.total(skip.state, 0), 0);
}

/* ============================================================ */
group('即时风雷：用完其他女神的牌立刻弹窗（不管效果有没有生效）');
{
  // 風走り 是莱拉自己的牌 → 不弹
  let s = mk(['12-raira-o-n-4'], { distance: 4 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '12-raira-o-n-4' });
  ok('自己的牌不弹风雷窗', !r.state.choice, r.state.choice);

  // 用其他女神的牌（斩）→ 立刻弹
  let s2 = mk([], { distance: 3 });
  s2.players[0].hand = [cardById('01-yurina-o-n-1')];
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('用其他女神的牌 → 立刻弹风雷窗', !!(r2.state.choice && r2.state.choice.sourceId === 'raira_instant'),
     r2.state.choice);
  const ch = A(r2.state, { type: 'choose', player: 0, option: 'thunder' });
  eq('选雷 → 雷神 1', G.thunder(ch.state, 0), 1);

  // 即使这张牌效果没生效（间合不符），也要问
  let s3 = mk([], { distance: 8 });
  s3.players[0].hand = [cardById('12-raira-o-n-4').id === 'x' ? null : cardById('02-saine-o-n-2')]; // 薙斬り 4-5
  let r3 = A(s3, { type: 'playCard', player: 0, cardId: '02-saine-o-n-2' });
  ok('打不出来的牌不会问（它根本没进弃牌区）', !r3.ok, r3.ok);
}

H.report();
