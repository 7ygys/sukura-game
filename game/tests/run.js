/* ============================================================
 * tests/run.js —— 用 node 跑：node game/tests/run.js
 *
 * 卡牌游戏最容易死在「牌莫名其妙多了一张或少了一张」，
 * 所以先测数量，再测流程。
 * ============================================================ */
const path = require('path');
const fs = require('fs');

// 引擎文件都是 UMD 写法，require 后挂在 globalThis.Engine 上
require('../engine/rng.js');
require('../engine/state.js');
require('../engine/rules.js');
require('../engine/effects.js');
require('../engine/actions.js');
const E = globalThis.Engine;

/* ---------- 迷你测试框架 ---------- */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  实际: ' + JSON.stringify(extra) : '')); }
}
function eq(name, actual, expected) {
  ok(name + ' = ' + JSON.stringify(expected), JSON.stringify(actual) === JSON.stringify(expected), actual);
}
function group(title) { console.log('\n[' + title + ']'); }

/* ---------- 牌库数据 ---------- */
const db = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/cards.json'), 'utf8'));
function deckOf(key) {
  const g = db.goddesses.find(x => x.key === key);
  const normal = g.cards.filter(c => c.kind === 'normal').slice(0, 7);
  const special = g.cards.filter(c => c.kind === 'special').slice(0, 3);
  return normal.concat(special);
}
function fresh() {
  return E.state.create({ myCards: deckOf('yurina'), oppCards: deckOf('saine') });
}
/** 付与展开后会自动进入「纳」分配，这里默认「先虚后装」 */
function autoNabu(r) {
  if (!r || !r.ok || !r.state || !r.state.nabu) return r;
  const nb = r.state.nabu;
  const fromDust = Math.min(r.state.dust, nb.cap);
  const fromAura = nb.cap - fromDust;
  const r2 = E.actions.applyAction(r.state, {
    type: 'confirmNabu', player: nb.who, fromDust: fromDust, fromAura: fromAura
  });
  return r2.ok ? r2 : r;
}
/** 结束回合；如果要求选盖牌，就自动选前 N 张 */
function endTurnAuto(s) {
  let r = E.actions.applyAction(s, { type: 'endTurn', player: s.active });
  if (!r.ok) return r;
  let st = r.state;
  if (st.endTurnPending) {
    const who = st.endTurnPending.who, need = st.endTurnPending.need;
    const ids = st.players[who].hand.slice(0, need).map(c => c.id);
    r = E.actions.applyAction(st, { type: 'confirmEndTurn', player: who, cardIds: ids });
  }
  return r;
}
/** 回合开始会问重组，测试里默认回答「否」 */
function answerNo(s) {
  if (!s.choice) return s;
  const r = E.actions.applyAction(s, { type: 'choose', player: s.choice.who, option: 'no' });
  return r.ok ? r.state : s;
}
/** 固定先手为 P0 的状态：避免"谁先手"是随机的导致测试时灵时不灵 */
function freshP0() {
  const s = fresh();
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[1].firstTurnDone = false;
  s.players[0].focus = 2;      // 基本动作要花集中力，测试里先给满
  return s;
}

/* ---------- 1. 洗牌 ---------- */
group('洗牌');
{
  const arr = [1,2,3,4,5,6,7,8,9,10];
  const sh = E.rng.shuffle(arr);
  eq('洗牌后数量不变', sh.length, 10);
  eq('洗牌后元素集合不变', sh.slice().sort((x,y)=>x-y), arr);
  eq('原数组没被改动', arr, [1,2,3,4,5,6,7,8,9,10]);

  // 随机性：洗 200 次，应该出现很多种不同顺序
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(E.rng.shuffle(arr).join(','));
  ok('200 次洗牌出现多种顺序（>=100 种）', seen.size >= 100, seen.size);
}

/* ---------- 2. 开局 ---------- */
group('开局状态');
{
  const s = fresh();
  eq('间合', s.distance, 10);
  eq('虚初始为空（36 颗都在命/装/间合）', s.dust, 0);
  eq('我的装', s.players[0].aura, 3);
  eq('我的命', s.players[0].life, 10);
  eq('我的手牌', s.players[0].hand.length, 3);
  eq('我的牌库', s.players[0].deck.length, 4);
  eq('手牌+牌库 = 7（通常札总数）', s.players[0].hand.length + s.players[0].deck.length, 7);
  eq('王牌单独放', s.players[0].specials.length, 3);
  ok('后手集中力为 1',
    s.players[1 - s.active].focus === 1 && s.players[s.active].focus === 0,
    s.players.map(p => p.focus));
}

/* ---------- 3. 回合流程 ---------- */
group('回合流程');
{
  let s = fresh();
  const first = s.active;
  eq('第一个回合开始时手牌不增加', s.players[first].hand.length, 3);
  eq('第一个回合集中力不增加', s.players[first].focus, 0);

  let r = endTurnAuto(s);
  ok('结束回合成功', r.ok);
  s = r.state;
  eq('结束时手牌弃到 2', s.players[first].hand.length, 2);
  eq('多出的手牌进伏札区（不是弃牌区）', s.players[first].hidden.length, 1);
  eq('弃牌区仍是 0', s.players[first].discard.length, 0);
  eq('换人', s.active, 1 - first);
  eq('回合数 +1', s.turn, 2);

  r = endTurnAuto(s);
  s = answerNo(r.state);
  eq('第二个回合集中力 +1', s.players[first].focus, 1);
  eq('第二个回合抽 2 张 → 手牌 4', s.players[first].hand.length, 4);
}

/* ---------- 4. 基本动作 ---------- */
group('基本动作（结晶移动）');
{
  // 前进：距→装
  let r = E.actions.applyAction(freshP0(), { type: 'basic', player: 0, which: 'advance' });
  ok('前进可用', r.ok);
  eq('前进后距离 10→9', r.state.distance, 9);
  eq('前进后装 3→4', r.state.players[0].aura, 4);

  // 后退：装→距（间合已满 10，不能后退）
  r = E.actions.applyAction(freshP0(), { type: 'basic', player: 0, which: 'retreat' });
  ok('间合 10 时后退被拒绝', !r.ok);

  // 缠绕：尘→装（虚一开始是空的，先靠伤害攒出虚）
  let sg = freshP0();
  sg.dust = 3;
  r = E.actions.applyAction(sg, { type: 'basic', player: 0, which: 'gather' });
  ok('缠绕可用', r.ok);
  eq('缠绕后虚 3→2', r.state.dust, 2);
  eq('缠绕后装 3→4', r.state.players[0].aura, 4);

  // 宿命：装→气
  r = E.actions.applyAction(freshP0(), { type: 'basic', player: 0, which: 'charge' });
  ok('宿命可用', r.ok);
  eq('宿命后装 3→2', r.state.players[0].aura, 2);
  eq('宿命后气 0→1', r.state.players[0].flare, 1);

  // 离脱：尘→距（只在间合 ≤2 时）
  let s = freshP0(); s.distance = 3;
  r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'disengage' });
  ok('间合 3 时离脱被拒绝', !r.ok);

  s = freshP0(); s.distance = 2; s.dust = 3;
  r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'disengage' });
  ok('间合 2 时离脱可用', r.ok);
  eq('离脱后间合 2→3', r.state.distance, 3);
  eq('离脱后虚 3→2', r.state.dust, 2);
}

group('集中力（基本动作的代价）');
{
  let s = freshP0();
  s.players[0].focus = 2;
  let r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'charge' });
  ok('有集中力时可以行动', r.ok, r.error);
  eq('行动后集中力 2→1', r.state.players[0].focus, 1);

  r = E.actions.applyAction(r.state, { type: 'basic', player: 0, which: 'charge' });
  ok('第二次还能行动', r.ok, r.error);
  eq('行动后集中力 1→0', r.state.players[0].focus, 0);

  r = E.actions.applyAction(r.state, { type: 'basic', player: 0, which: 'charge' });
  ok('集中力 0 时不能再行动', !r.ok);

  // 数量检查：一个回合最多两次基本动作
  const s2 = freshP0();
  s2.players[0].focus = 2;
  let cnt = 0;
  let cur = s2;
  for (let i = 0; i < 5; i++) {
    const rr = E.actions.applyAction(cur, { type: 'basic', player: 0, which: 'charge' });
    if (!rr.ok) break;
    cur = rr.state; cnt++;
  }
  eq('集中力 2 → 最多做 2 次基本动作', cnt, 2);
}

group('基本动作的边界');
{
  let s = freshP0(); s.distance = 0;
  ok('间合 0 时不能前进', !E.actions.applyAction(s, { type: 'basic', player: 0, which: 'advance' }).ok);

  s = freshP0(); s.players[0].aura = 5;
  ok('装满 5 时不能前进', !E.actions.applyAction(s, { type: 'basic', player: 0, which: 'advance' }).ok);

  s = freshP0(); s.players[0].aura = 0;
  ok('装 0 时不能后退', !E.actions.applyAction(s, { type: 'basic', player: 0, which: 'retreat' }).ok);
  ok('装 0 时不能宿命', !E.actions.applyAction(s, { type: 'basic', player: 0, which: 'charge' }).ok);

  s = freshP0(); s.dust = 0;
  ok('虚 0 时不能缠绕', !E.actions.applyAction(s, { type: 'basic', player: 0, which: 'gather' }).ok);
  s.distance = 2;
  ok('虚 0 时不能离脱', !E.actions.applyAction(s, { type: 'basic', player: 0, which: 'disengage' }).ok);

  s = freshP0();
  ok('非当前回合玩家不能行动',
    !E.actions.applyAction(s, { type: 'basic', player: 1 - s.active, which: 'advance' }).ok);
}

/* ---------- 5. 焦燥与重组 ---------- */
group('焦燥与重组');
{
  const s = fresh();
  const who = 0;
  E.rules.draw(s, who, 4);                 // 把牌库抽干
  eq('牌库空了', s.players[who].deck.length, 0);

  s.players[who].discard = s.players[who].hand.splice(0, 3);   // 造 3 张弃牌
  const auraBefore = s.players[who].aura;
  const lifeBefore = s.players[who].life;

  E.rules.draw(s, who, 1);                 // 空牌库再抽 → 记 1 点焦燥
  ok('记录了 1 点焦燥，没有自动扣血', s.exhaust && s.exhaust.remaining === 1);
  eq('装还没变', s.players[who].aura, auraBefore);

  let r = E.actions.applyAction(s, { type: 'resolveExhaust', player: who, choice: 'aura' });
  ok('选装结算焦燥', r.ok, r.error);
  eq('焦燥扣了 1 点装', r.state.players[who].aura, auraBefore - 1);
  eq('焦燥没有扣命', r.state.players[who].life, lifeBefore);
  ok('结算完焦燥清空', !r.state.exhaust);
  eq('焦燥不会自动重组', r.state.players[who].deck.length, 0);
  eq('弃牌区还在', r.state.players[who].discard.length, 3);
}

{
  // 空牌库抽 2 张 → 2 点焦燥，可以一点点分开扛
  const s2 = fresh();
  const who2 = 0;
  E.rules.draw(s2, who2, 4);
  E.rules.draw(s2, who2, 2);
  ok('抽 2 张记 2 点焦燥', s2.exhaust && s2.exhaust.remaining === 2);

  const a0 = s2.players[who2].aura, l0 = s2.players[who2].life;
  let r1 = E.actions.applyAction(s2, { type: 'resolveExhaust', player: who2, choice: 'aura' });
  eq('第一点扣装', r1.state.players[who2].aura, a0 - 1);
  let r2 = E.actions.applyAction(r1.state, { type: 'resolveExhaust', player: who2, choice: 'life' });
  eq('第二点扣命', r2.state.players[who2].life, l0 - 1);
  ok('两点结算完', !r2.state.exhaust);
}

{
  const s = fresh();
  const who = 0;
  E.rules.draw(s, who, 4);
  s.players[who].discard = s.players[who].hand.splice(0, 3);
  const lifeBefore = s.players[who].life;
  const flareBefore = s.players[who].flare;

  const did = E.rules.reshuffle(s, who, true);   // 规则重组：付 1 点命
  ok('重组成功', !!did);
  eq('重组要先失去 1 点命', s.players[who].life, lifeBefore - 1);
  eq('失去的命进到气', s.players[who].flare, flareBefore + 1);
  eq('弃牌区清空', s.players[who].discard.length, 0);
  eq('3 张洗回牌库', s.players[who].deck.length, 3);
}

{
  // 王牌不进牌库
  const s = fresh();
  const who = 0;
  s.players[who].discard = [cardById('01-yurina-o-s-1')];
  s.players[who].deck = [];
  const did2 = E.rules.reshuffle(s, who, false);
  ok('只有王牌时不能重组', !did2);
}

group('回合开始的重组询问');
{
  const s = fresh();
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[0].deck = s.players[0].deck.slice(0, 1);   // 只剩 1 张
  s.players[0].discard = [cardById('01-yurina-o-n-1'), cardById('01-yurina-o-n-2')];

  E.rules.startTurn(s);
  ok('回合开始会询问是否重组', !!s.choice && s.choice.sourceId === 'reshuffle');

  const lifeBefore = s.players[0].life;
  const handBefore = s.players[0].hand.length;
  const r = E.actions.applyAction(s, { type: 'choose', player: 0, option: 'yes' });
  ok('选「是」可以重组', r.ok, r.error);
  eq('重组的代价：命 -1', r.state.players[0].life, lifeBefore - 1);
  eq('重组后抽了 2 张', r.state.players[0].hand.length, handBefore + 2);
  ok('重组后询问消失', !r.state.choice);
}

{
  const s = fresh();
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[0].deck = s.players[0].deck.slice(0, 1);
  s.players[0].discard = [cardById('01-yurina-o-n-1')];
  E.rules.startTurn(s);
  const r = E.actions.applyAction(s, { type: 'choose', player: 0, option: 'no' });
  ok('选「否」也能抽牌', r.ok, r.error);
  eq('不重组：命不变', r.state.players[0].life, 10);
}

/* ---------- 6. 伤害 ---------- */
group('伤害分配');
{
  const s = freshP0();
  const a = E.actions.applyAction(s, { type: 'damage', who: 0, aura: 2, life: 1, choice: 'aura' });
  ok('选装成功', a.ok);
  eq('装 3-2', a.state.players[0].aura, 1);

  const b = E.actions.applyAction(a.state, { type: 'damage', who: 0, aura: 2, life: 1, choice: 'aura' });
  ok('装不够时选装被拒绝', !b.ok);

  const c = E.actions.applyAction(a.state, { type: 'damage', who: 0, aura: 2, life: 1, choice: 'life' });
  ok('选命成功', c.ok);
  eq('命 10-1', c.state.players[0].life, 9);
  eq('命伤转成气（0+1）', c.state.players[0].flare, 1);

  const t = E.state.clone(s);
  t.players[0].life = 1;
  E.rules.applyDamage(t, 0, 0, 1, 'life');
  eq('命归零时对方获胜', t.winner, 1);
}

/* ---------- 7. 出牌与攻防（阶段 3） ---------- */
group('出牌与攻防');

// 下面几组需要"指定的手牌"，所以先写两个小工具
function cardById(id) {
  for (const g of db.goddesses) {
    const c = g.cards.find(x => x.id === id);
    if (c) return JSON.parse(JSON.stringify(c));
  }
  throw new Error('找不到卡：' + id);
}
function withHand(who, ids) {
  const s = freshP0();
  s.players[who].hand = ids.map(cardById);
  s.players[who].discard = [];
  return s;
}

{
  // 斩：攻击，适正距离 3-4，伤害 3/1
  let s = withHand(0, ['01-yurina-o-n-1']);
  s.distance = 3;

  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('距离合适时可以打出「斩」', r.ok, r.error);
  eq('打出后手牌 -1', r.state.players[0].hand.length, 0);
  eq('打出的牌进弃牌区', r.state.players[0].discard.length, 1);
  eq('生成待处理的攻击', r.state.pending.kind, 'attack');
  eq('伤害记在 pending 里（装）', r.state.pending.damage.aura, 3);
  eq('伤害记在 pending 里（命）', r.state.pending.damage.life, 1);
  eq('先进入「是否对应」阶段', r.state.pending.stage, 'respond');

  // 距离不对
  s = withHand(0, ['01-yurina-o-n-1']);
  s.distance = 8;
  r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('距离 8 时不能打出「斩」（3-4）', !r.ok);

  ok('待处理攻击存在时，不能做别的事',
    !E.actions.applyAction(
      Object.assign(E.state.clone(withHand(0, ['01-yurina-o-n-1'])), {
        distance: 3,
        pending: { kind: 'attack', attacker: 0, defender: 1, stage: 'respond', damage: { aura: 1, life: 1 } }
      }),
      { type: 'basic', player: 0, which: 'charge' }
    ).ok);
}

{
  // 对应：一闪(2/2, 距离3) 被 石突(攻击+对应) 对应
  let s = withHand(0, ['01-yurina-o-n-2']);
  s.players[1].hand = [cardById('02-saine-o-n-3')];
  s.distance = 3;

  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-2' });
  ok('打出「一闪」', r.ok, r.error);
  s = r.state;

  r = E.actions.applyAction(s, { type: 'respond', player: 1, cardId: '02-saine-o-n-3' });
  ok('用「石突き」对应成功', r.ok, r.error);
  s = r.state;

  // 石突き 作为对应：先用它自己的攻击 2-3 / 2-1，
  // 再跑它的【攻击后】3-5 / 2-1，最后才轮到原攻击
  ok('石突き 自身攻击先上桌', !!s.pending && s.pending.cardName === '石突き');
  eq('石突き 自身攻击 2/1', s.pending.damage, { aura: 2, life: 1 });
  eq('原攻击挂在栈里', s.attackStack.length, 1);
  eq('对应牌进弃牌区', s.players[1].discard.length, 1);

  let r2 = E.actions.applyAction(s, { type: 'respond', player: 0, cardId: null });
  r2 = E.actions.applyAction(r2.state, { type: 'resolveDamage', player: 0, choice: 'life' });
  eq('原攻击者命 10→9（石突き 2/1 选命）', r2.state.players[0].life, 9);
  ok('接着是【攻击后】那发', !!r2.state.pending && r2.state.pending.cardName.indexOf('石突き') === 0);

  r2 = E.actions.applyAction(r2.state, { type: 'respond', player: 0, cardId: null });
  r2 = E.actions.applyAction(r2.state, { type: 'resolveDamage', player: 0, choice: 'life' });
  eq('原攻击者命 10→8（【攻击后】2/1）', r2.state.players[0].life, 8);

  ok('最后原攻击接回来', !!r2.state.pending && r2.state.pending.cardName === '一閃');
  r2 = E.actions.applyAction(r2.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('被攻击方命 10→8（一閃 2/2）', r2.state.players[1].life, 8);
}

{
  // 不对应：直接进入选伤害
  let s = withHand(0, ['01-yurina-o-n-2']);
  s.players[1].hand = [];
  s.distance = 3;

  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-2' });
  s = r.state;
  r = E.actions.applyAction(s, { type: 'respond', player: 1, cardId: null });
  ok('可以选择不对应', r.ok, r.error);
  eq('不对应后也是进入选伤害', r.state.pending.stage, 'damage');

  // 装不够时不能选装（一闪 2/2，装 0）
  const s2 = E.state.clone(r.state);
  s2.players[1].aura = 0;
  const r2 = E.actions.applyAction(s2, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('装 0 时不能选装（2/2）', !r2.ok);

  const r3 = E.actions.applyAction(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('装 3 时选装成功', r3.ok, r3.error);
  eq('装 3-2=1', r3.state.players[1].aura, 1);
}

{
  // 王牌费用：浦波岚 cost 3
  let s = withHand(0, ['01-yurina-o-s-2']);   // 浦波岚：王牌，攻击+对应，0-10，2/-
  s.players[0].flare = 0;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-s-2' });
  ok('气 0 时打不出 3 费王牌', !r.ok);

  s.players[0].flare = 3;
  r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-s-2' });
  ok('气 3 时可以打出王牌', r.ok, r.error);
  eq('打出后气 3→0', r.state.players[0].flare, 0);
  eq('付出去的气进虚（0+3=3）', r.state.dust, 3);
  eq('王牌标记为已使用', r.state.players[0].specials.find(x => x.id === '01-yurina-o-s-2').used, true);
  eq('王牌不进弃牌区', r.state.players[0].discard.length, 0);
}

/* ---------- 8. 付与与破弃（阶段 4） ---------- */
group('付与（展开 / 纳 / 破弃）');
{
  // 气合斩：付与，纳 2
  const ENH = '01-yurina-o-n-6';

  // 虚足够时，全部从虚取
  let s = withHand(0, [ENH]);
  s.dust = 8; s.players[0].aura = 3;
  let r = autoNabu(E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: ENH }));
  ok('付与可以展开', r.ok, r.error);
  s = r.state;
  eq('付与区 1 张', s.players[0].attachments.length, 1);
  eq('纳 2 颗结晶', s.players[0].attachments[0].crystals, 2);
  eq('虚 8→6', s.dust, 6);
  eq('装没被动过', s.players[0].aura, 3);
  eq('付与不进弃牌区', s.players[0].discard.length, 0);

  // 虚不够时，差额从装补
  s = withHand(0, [ENH]);
  s.dust = 0; s.players[0].aura = 3;
  r = autoNabu(E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: ENH }));
  ok('虚 0 时从装补足结晶', r.ok, r.error);
  eq('装 3→1', r.state.players[0].aura, 1);
  eq('虚还是 0', r.state.dust, 0);
  eq('纳仍然是 2', r.state.players[0].attachments[0].crystals, 2);

  // 虚和装都不够
  s = withHand(0, [ENH]);
  s.dust = 0; s.players[0].aura = 1;
  r = autoNabu(E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: ENH }));
  ok('虚+装都不够时不能展开', !r.ok);
}

{
  const ENH = '01-yurina-o-n-6';
  let s = withHand(0, [ENH]);
  s.dust = 8; s.players[0].aura = 3;
  let r = autoNabu(E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: ENH }));
  s = r.state;

  // 每回合开始：付与札各送 1 颗结晶到虚
  const dustBefore = s.dust;              // 6
  E.rules.tickAttachments(s, 0);
  eq('回合开始移 1 颗到虚（纳 2→1）', s.players[0].attachments[0].crystals, 1);
  eq('虚 6→7', s.dust, dustBefore + 1);

  // 再移一次，结晶耗尽 → 破弃
  E.rules.tickAttachments(s, 0);
  eq('结晶耗尽后付与区清空', s.players[0].attachments.length, 0);
  eq('破弃的牌进弃牌区', s.players[0].discard.length, 1);
  eq('破弃牌名字正确', s.players[0].discard[0].name, '圧気');
  eq('虚 7→8', s.dust, dustBefore + 2);
}

{
  // 多张付与可以同时存在（注意：気炎万丈是《全力》，同一回合不能连开两张）
  const A = '01-yurina-o-n-6';   // 圧気 纳 2
  const B = '02-saine-o-n-5';    // 圏域 纳 2
  let s = withHand(0, [A, B]);
  s.dust = 10; s.players[0].aura = 5; s.distance = 5;
  let r = autoNabu(E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: A }));
  ok('展开第一张付与', r.ok, r.error);
  r = autoNabu(E.actions.applyAction(r.state, { type: 'playCard', player: 0, cardId: B }));
  ok('展开第二张付与', r.ok, r.error);
  eq('付与区 2 张', r.state.players[0].attachments.length, 2);
  eq('虚 10-2-2=6', r.state.dust, 6);

  // 两张一起走回合开始
  E.rules.tickAttachments(r.state, 0);
  // 圏域 会把结晶送到间合，所以虚只 +1、间合 +1
  eq('一张进虚一张进间合（虚）', r.state.dust, 7);
  eq('间合 5→6', r.state.distance, 6);
  eq('第一张纳 2→1', r.state.players[0].attachments[0].crystals, 1);
  eq('第二张纳 2→1', r.state.players[0].attachments[1].crystals, 1);
}

/* ---------- 9. 卡牌效果（阶段 11） ---------- */
group('卡牌效果');
{
  // 一閃：决死（自命 ≤3）时 +1/+0
  let s = withHand(0, ['01-yurina-o-n-2']);
  s.distance = 3;
  s.players[0].life = 5;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-2' });
  eq('非决死时一閃 = 2/2', r.state.pending.damage, { aura: 2, life: 2 });

  s = withHand(0, ['01-yurina-o-n-2']);
  s.distance = 3;
  s.players[0].life = 3;
  r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-2' });
  eq('决死时一閃 = 3/2', r.state.pending.damage, { aura: 3, life: 2 });
}

{
  // 柄打ち：攻击后若决死 → 下一次攻击 +1/+0
  let s = withHand(0, ['01-yurina-o-n-3']);
  s.distance = 2;
  s.players[0].life = 3;
  s.players[1].aura = 3;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-3' });
  s = r.state;
  eq('柄打ち伤害 2/1', s.pending.damage, { aura: 2, life: 1 });
  r = E.actions.applyAction(s, { type: 'respond', player: 1, cardId: null });
  r = E.actions.applyAction(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('结算成功', r.ok, r.error);
  eq('攻击后获得 +1 加成', r.state.players[0].buff.aura, 1);

  // 下一次攻击吃到加成
  let s2 = E.state.clone(r.state);
  s2.players[0].hand = [cardById('01-yurina-o-n-1')];   // 斬 3/1
  s2.distance = 3;
  const r2 = E.actions.applyAction(s2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  eq('斬吃到加成 → 4/1', r2.state.pending.damage, { aura: 4, life: 1 });
  eq('加成用掉了', r2.state.players[0].buff.aura, 0);
}

{
  // 圧気：破弃时打一发 1-4、3/-
  let s = withHand(0, ['01-yurina-o-n-6']);
  s.dust = 8;
  let r = autoNabu(E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-6' }));
  ok('展开圧気', r.ok, r.error);
  s = r.state;
  eq('付与区 1 张', s.players[0].attachments.length, 1);

  // 手动把结晶耗光
  s.players[0].attachments[0].crystals = 1;
  s.distance = 3;
  E.rules.tickAttachments(s, 0);
  eq('破弃后付与区清空', s.players[0].attachments.length, 0);
  ok('破弃时生成了攻击', !!s.pending);
  eq('生成攻击的伤害 3/0', s.pending.damage, { aura: 3, life: 0 });
}

/* ---------- 10. 摇波剩下几张 ---------- */
group('摇波的其余效果');
{
  // 居合：间合 ≤2 时 -1/-1
  let s = withHand(0, ['01-yurina-o-n-4']);
  s.distance = 4;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-4' });
  eq('间合 4 时居合 = 4/3', r.state.pending.damage, { aura: 4, life: 3 });

  s = withHand(0, ['01-yurina-o-n-4']);
  s.distance = 2;
  r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-4' });
  eq('间合 2 时居合 = 3/2', r.state.pending.damage, { aura: 3, life: 2 });
}

{
  // 気迫：加 1 集中力
  const s = withHand(0, ['01-yurina-o-n-5']);
  s.players[0].focus = 0;
  const r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-5' });
  ok('打出気迫', r.ok, r.error);
  eq('集中力 0→1', r.state.players[0].focus, 1);
  ok('记下了下一次其他女神的攻击加成', !!r.state.players[0].nextOtherAttack);
}

{
  // 浦波嵐：对应时被对应的攻击 -2/+0
  let s = withHand(0, ['01-yurina-o-n-1']);      // 斬 3/1
  s.distance = 3;
  s.players[1].hand = [cardById('01-yurina-o-s-2')];
  s.players[1].flare = 3;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  s = r.state;
  eq('对应前 3/1', s.pending.damage, { aura: 3, life: 1 });
  r = E.actions.applyAction(s, { type: 'respond', player: 1, cardId: '01-yurina-o-s-2' });
  ok('用浦波嵐对应', r.ok, r.error);
  eq('对应后 1/1', r.state.pending.damage, { aura: 1, life: 1 });
}

{
  // 底力：决死未达成时不能用
  let s = withHand(0, ['01-yurina-o-s-4']);
  s.players[0].flare = 5;
  s.players[0].life = 8;
  s.distance = 3;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-s-4' });
  ok('命 8 时不能用底力', !r.ok);

  s.players[0].life = 3;
  r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-s-4' });
  ok('命 3 时可以用底力', r.ok, r.error);
  eq('底力 5/5', r.state.pending.damage, { aura: 5, life: 5 });
}

{
  // 浮舟宿：虚 5 → 装
  let s = withHand(0, ['01-yurina-o-s-3']);
  s.players[0].flare = 2;
  s.dust = 8;
  s.players[0].aura = 1;
  const r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-s-3' });
  ok('打出浮舟宿', r.ok, r.error);
  eq('装被填到上限 5', r.state.players[0].aura, 5);
  eq('虚 8+2（付的费）-4（装只收得下 4 颗）= 6', r.state.dust, 6);
}

/* ---------- 11. 结晶守恒 ---------- */
group('樱花结晶总数守恒');
{
  function total(s) {
    let n = s.distance + s.dust;
    s.players.forEach(p => {
      n += p.life + p.aura + p.flare;
      (p.attachments || []).forEach(a => { n += a.crystals || 0; });
    });
    return n;
  }
  const s = fresh();
  eq('开局总数 = 36（间合10 + 装6 + 命20）', total(s), 36);

  // 打一套操作，看总数有没有变
  let cur = s;
  const ops = [
    { type: 'basic', player: 0, which: 'charge' },
    { type: 'basic', player: 0, which: 'charge' },
    { type: 'basic', player: 0, which: 'retreat' },
    { type: 'basic', player: 0, which: 'charge' }
  ];
  ops.forEach(op => { const r = E.actions.applyAction(cur, op); if (r.ok) cur = r.state; });
  eq('做了一堆基本动作后仍是 36', total(cur), 36);

  // 受伤也守恒
  const d = E.state.clone(cur);
  E.rules.applyDamage(d, 0, 0, 2, 'life');
  eq('失去 2 点命后仍是 36', total(d), 36);
  const d2 = E.state.clone(cur);
  E.rules.applyDamage(d2, 1, 3, 0, 'aura');
  eq('失去 3 点装后仍是 36', total(d2), 36);
}

/* ---------- 12. 细音 11 张 ---------- */
group('细音的效果');
{
  // 見切り：间合 ⇔ 虚（双向）
  let s = withHand(0, ['02-saine-o-n-4']);
  s.distance = 5; s.dust = 3;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-4' });
  ok('打出見切り', r.ok, r.error);
  ok('弹出了方向选择', !!r.state.choice);
  r = E.actions.applyAction(r.state, { type: 'choose', player: 0, option: 'dist_to_dust' });
  eq('间合 5→4', r.state.distance, 4);
  eq('虚 3→4', r.state.dust, 4);

  s = withHand(0, ['02-saine-o-n-4']);
  s.distance = 5; s.dust = 3;
  r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-4' });
  r = E.actions.applyAction(r.state, { type: 'choose', player: 0, option: 'dust_to_dist' });
  eq('虚 3→2', r.state.dust, 2);
  eq('间合 5→6', r.state.distance, 6);
}

{
  // 圏域：达人距离 +1；付与札的结晶改为进间合
  let s = withHand(0, ['02-saine-o-n-5']);
  s.distance = 6; s.dust = 4; s.players[0].aura = 3;
  let r = autoNabu(E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-5' }));
  ok('展开圏域', r.ok, r.error);
  s = r.state;
  eq('达人距离 2→3', E.rules.taijinOf(s), 3);
  ok('间合 2 已不能前进', !E.actions.applyAction(Object.assign(E.state.clone(s), { distance: 2 }), { type: 'basic', player: 0, which: 'advance' }).ok);

  const before = { dust: s.dust, dist: s.distance };
  E.rules.tickAttachments(s, 0);
  eq('结晶进间合而不是虚', s.distance, before.dist + 1);
  eq('虚没增加', s.dust, before.dust);
}

{
  // 衝音晶：对应时 -1/+0
  let s = withHand(0, ['02-saine-o-n-2']);      // 薙斬り 4-5 3/1
  s.distance = 4;
  s.players[1].hand = [cardById('02-saine-o-n-6')];
  s.dust = 3;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-2' });
  s = r.state;
  r = E.actions.applyAction(s, { type: 'respond', player: 1, cardId: '02-saine-o-n-6' });
  ok('用衝音晶对应', r.ok, r.error);
  eq('对应后 2/1', r.state.pending.damage, { aura: 2, life: 1 });
}

{
  // 無音壁：付与札上的结晶可以当装用
  let s = withHand(0, ['02-saine-o-n-7']);
  s.distance = 7; s.dust = 6; s.players[0].aura = 3;
  let r = autoNabu(E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-7' }));
  ok('展开無音壁', r.ok, r.error);
  s = r.state;
  eq('纳 5 颗', s.players[0].attachments[0].crystals, 5);

  // 装只剩 0，但付与札上有 5 颗 → 仍可选装
  s.players[0].aura = 0;
  eq('视为装的总数 = 5', E.rules.shadowAura(s, 0), 5);
  ok('装 0 但可以选装', E.rules.canTakeAura(s, 0, 3));
  E.rules.applyDamage(s, 0, 3, 0, 'aura');
  eq('付与札结晶 5→2', s.players[0].attachments[0].crystals, 2);
  eq('真装没有变负', s.players[0].aura, 0);
}

{
  // 律動弧戟：三连击
  let s = withHand(0, ['02-saine-o-s-1']);
  s.players[0].flare = 5;
  s.distance = 4;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '02-saine-o-s-1' });
  ok('打出律動弧戟', r.ok, r.error);
  eq('第一发 3-4 / 1-1', r.state.pending.damage, { aura: 1, life: 1 });
  ok('排队里还有 2 发', r.state.attackQueue.length === 2);

  s = r.state;
  r = E.actions.applyAction(s, { type: 'respond', player: 1, cardId: null });
  r = E.actions.applyAction(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('第二发自动接上', r.ok && !!r.state.pending);
  eq('第二发 4-5 / 1-1', r.state.pending.damage, { aura: 1, life: 1 });
}

{
  // 響鳴共振：费用 = 8 - 敌装
  let s = withHand(0, ['02-saine-o-s-2']);
  s.players[0].flare = 8;
  s.players[1].aura = 3;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '02-saine-o-s-2' });
  ok('敌装 3 → 费用 5，气 8 够', r.ok, r.error);
  eq('付了 5 点气', r.state.players[0].flare, 3);
}

{
  // 音無砕氷：对应时 -1/-1
  let s = withHand(0, ['02-saine-o-n-2']);   // 薙斬り 3/1
  s.distance = 4;
  s.players[1].hand = [cardById('02-saine-o-s-3')];
  s.players[1].flare = 2;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-2' });
  r = E.actions.applyAction(r.state, { type: 'respond', player: 1, cardId: '02-saine-o-s-3' });
  ok('用音無砕氷对应', r.ok, r.error);
  eq('对应后 2/0', r.state.pending.damage, { aura: 2, life: 0 });
}

{
  // 氷雨：只能用于对应王牌
  let s = withHand(0, ['01-yurina-o-n-1']);  // 斬（通常札）
  s.distance = 3;
  s.players[1].hand = [cardById('02-saine-o-s-4')];
  s.players[1].flare = 5;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  r = E.actions.applyAction(r.state, { type: 'respond', player: 1, cardId: '02-saine-o-s-4' });
  ok('对通常札攻击不能用氷雨', !r.ok);
}

/* ---------- 13. 纳的分配 & 两种伤害 ---------- */
group('付与的「纳」分配');
{
  let s = withHand(0, ['01-yurina-o-n-6']);     // 圧気 纳2
  s.dust = 3; s.players[0].aura = 3;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-6' });
  ok('先进入分配状态，还没展开', r.ok && !!r.state.nabu);
  eq('付与区还是空的', r.state.players[0].attachments.length, 0);

  // 分配错总数
  let bad = E.actions.applyAction(r.state, { type: 'confirmNabu', player: 0, fromDust: 1, fromAura: 0 });
  ok('总数不对会被拒绝', !bad.ok);

  let good = E.actions.applyAction(r.state, { type: 'confirmNabu', player: 0, fromDust: 1, fromAura: 1 });
  ok('分配 1+1 成功', good.ok, good.error);
  eq('虚 3→2', good.state.dust, 2);
  eq('装 3→2', good.state.players[0].aura, 2);
  eq('付与区 1 张，纳 2', good.state.players[0].attachments[0].crystals, 2);

  // 取消
  const c = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-6' });
  const cc = E.actions.applyAction(c.state, { type: 'cancelNabu', player: 0 });
  ok('可以取消展开', cc.ok);
  eq('取消后牌还在手里', cc.state.players[0].hand.length, 1);
}

group('两种伤害都要吃');
{
  let s = withHand(0, ['03-himika-o-n-4']);   // フルバースト 5-9 3/1 both
  s.distance = 6;
  s.players[1].aura = 4; s.players[1].life = 10;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-4' });
  ok('打出フルバースト', r.ok, r.error);
  ok('标记为两种都吃', r.state.pending.both === true);

  r = E.actions.applyAction(r.state, { type: 'respond', player: 1, cardId: null });
  r = E.actions.applyAction(r.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('结算成功', r.ok, r.error);
  eq('装 4→1', r.state.players[1].aura, 1);
  eq('命 10→9', r.state.players[1].life, 9);

  // 装不够时只扣现有的，多的溢出
  let s2 = withHand(0, ['03-himika-o-n-4']);
  s2.distance = 6;
  s2.players[1].aura = 2; s2.players[1].life = 10;
  let r2 = E.actions.applyAction(s2, { type: 'playCard', player: 0, cardId: '03-himika-o-n-4' });
  r2 = E.actions.applyAction(r2.state, { type: 'respond', player: 1, cardId: null });
  r2 = E.actions.applyAction(r2.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('装只有 2 → 扣到 0，不会变负', r2.state.players[1].aura, 0);
  eq('命仍然 -1', r2.state.players[1].life, 9);
}

/* ---------- 14. 绯弥香 11 张 ---------- */
group('绯弥香的效果');
{
  // ラピッドファイア：连火（本回合第 3 张以后）→ +1/+1
  let s = withHand(0, ['03-himika-o-n-2']);
  s.distance = 7;
  s.turnUsed[0] = 0;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-2' });
  eq('不是连火时 2/1', r.state.pending.damage, { aura: 2, life: 1 });

  s = withHand(0, ['03-himika-o-n-2']);
  s.distance = 7;
  s.turnUsed[0] = 2;                       // 之前已经用了 2 张
  r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-2' });
  eq('连火时 3/2', r.state.pending.damage, { aura: 3, life: 2 });
}

{
  // マグナムカノン：攻击后 自命 → 虚
  let s = withHand(0, ['03-himika-o-n-3']);
  s.distance = 6;
  s.dust = 1;
  s.players[1].aura = 3;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-3' });
  r = E.actions.applyAction(r.state, { type: 'respond', player: 1, cardId: null });
  const dustBefore = r.state.dust;
  r = E.actions.applyAction(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  eq('自命 10→9', r.state.players[0].life, 9);
  // 虚的增加 = 对方装伤 3 颗 + 自己自命→虚 1 颗
  eq('虚 +4（对方装伤 3 + 自命→虚 1）', r.state.dust, dustBefore + 4);
}

{
  // バックステップ：抽 1 + 虚→间合
  let s = withHand(0, ['03-himika-o-n-5']);
  s.distance = 5; s.dust = 3;
  s.players[0].deck = [cardById('03-himika-o-n-1')];   // 保证牌库有牌，不触发焦燥
  const handBefore = s.players[0].hand.length;
  const r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-5' });
  ok('打出バックステップ', r.ok, r.error);
  eq('手牌 -1+1 = 不变', r.state.players[0].hand.length, handBefore);
  eq('间合 5→6', r.state.distance, 6);
  eq('虚 3→2', r.state.dust, 2);
}

{
  // バックドラフト：让对手畏缩
  let s = withHand(0, ['03-himika-o-n-6']);
  s.dust = 3;
  const r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-6' });
  ok('打出バックドラフト', r.ok, r.error);
  eq('对手畏缩', r.state.players[1].staggered, true);
}

{
  // スモーク：间合的结晶不能被箭头移动（見切り 的 dist→dust 会被挡）
  let s = withHand(0, ['03-himika-o-n-7']);
  s.dust = 5; s.distance = 8; s.players[0].aura = 3;
  let r = autoNabu(E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-7' }));
  ok('展开スモーク', r.ok, r.error);
  s = r.state;
  eq('达人距离不变（スモーク 不加达人距离）', E.rules.taijinOf(s), 2);

  const d0 = s.distance;
  E.effects.fx.moveCrystal(s, 0, 'distance', 'dust', 1);
  eq('箭头被挡住，间合不变', s.distance, d0);
}

{
  // スカーレットイマジン：抽 2 然后盖 1 张
  let s = withHand(0, ['03-himika-o-s-3']);
  s.players[0].flare = 3;
  s.players[0].hand = [cardById('03-himika-o-s-3'), cardById('03-himika-o-n-1')];
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '03-himika-o-s-3' });
  ok('打出スカーレットイマジン', r.ok, r.error);
  ok('弹出了「盖哪张」的选择', !!r.state.choice);
  const pick = r.state.players[0].hand[0].id;
  const r2 = E.actions.applyAction(r.state, { type: 'choose', player: 0, option: pick });
  ok('选择生效', r2.ok, r2.error);
  eq('盖了 1 张伏札', r2.state.players[0].hidden.length, 1);
}

{
  // ヴァーミリオン：连火时 虚→间合
  let s = withHand(0, ['03-himika-o-s-4']);
  s.players[0].flare = 2;
  s.dust = 3; s.distance = 5;
  s.turnUsed[0] = 2;
  const r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '03-himika-o-s-4' });
  ok('打出ヴァーミリオン', r.ok, r.error);
  eq('间合 5→6', r.state.distance, 6);
  // 虚 3 + 付掉的 2 点气 - 移走的 1 颗 = 4
  eq('虚 3+2(费)-1 = 4', r.state.dust, 4);
}

/* ---------- 15. 常世 11 张 ---------- */
group('常世的效果');
{
  // 跳ね兔：间合 ≤3 才生效
  let s = withHand(0, ['04-tokoyo-o-n-3']);
  s.distance = 3; s.dust = 3;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '04-tokoyo-o-n-3' });
  ok('打出跳ね兔', r.ok, r.error);
  eq('间合 3→4', r.state.distance, 4);
  eq('虚 3→2', r.state.dust, 2);

  s = withHand(0, ['04-tokoyo-o-n-3']);
  s.distance = 5; s.dust = 3;
  r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '04-tokoyo-o-n-3' });
  eq('间合 5 时不生效', r.state.distance, 5);
}

{
  // 詩舞：+1 集中力，然后选一项
  let s = withHand(0, ['04-tokoyo-o-n-4']);
  s.players[0].focus = 0; s.players[0].aura = 3; s.dust = 3;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '04-tokoyo-o-n-4' });
  ok('打出詩舞', r.ok, r.error);
  eq('集中力 0→1', r.state.players[0].focus, 1);
  ok('弹出了选项', !!r.state.choice);
  const r2 = E.actions.applyAction(r.state, { type: 'choose', player: 0, option: 'aura_to_flare' });
  eq('装 3→2', r2.state.players[0].aura, 2);
  eq('气 0→1', r2.state.players[0].flare, 1);
}

{
  // 雅打ち：境地时可以打消攻击
  let s = withHand(0, ['01-yurina-o-n-1']);     // 斬 3/1
  s.distance = 3;
  s.players[1].hand = [cardById('04-tokoyo-o-n-2')];
  s.players[1].focus = 2;                       // 境地
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  r = E.actions.applyAction(r.state, { type: 'respond', player: 1, cardId: '04-tokoyo-o-n-2' });
  ok('用雅打ち对应', r.ok, r.error);
  ok('攻击被打消（没有待结算）', !r.state.pending);
  eq('命没掉', r.state.players[1].life, 10);
}

{
  // 久遠ノ花：打消攻击
  let s = withHand(0, ['01-yurina-o-n-1']);
  s.distance = 3;
  s.players[1].hand = [cardById('04-tokoyo-o-s-1')];
  s.players[1].flare = 5;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  r = E.actions.applyAction(r.state, { type: 'respond', player: 1, cardId: '04-tokoyo-o-s-1' });
  ok('用久遠ノ花对应', r.ok, r.error);
  ok('攻击被打消', !r.state.pending);
}

{
  // 常世ノ月：双方集中力重设 + 畏缩
  let s = withHand(0, ['04-tokoyo-o-s-4']);
  s.players[0].flare = 2;
  s.players[0].focus = 0;
  s.players[1].focus = 2;
  const r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '04-tokoyo-o-s-4' });
  ok('打出常世ノ月', r.ok, r.error);
  eq('自集中力 = 2', r.state.players[0].focus, 2);
  eq('敌集中力 = 0', r.state.players[1].focus, 0);
  eq('对手畏缩', r.state.players[1].staggered, true);
}

{
  // 風舞台：展开时 自装→虚
  let s = withHand(0, ['04-tokoyo-o-n-6']);
  s.dust = 3; s.players[0].aura = 3;
  const r = autoNabu(E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '04-tokoyo-o-n-6' }));
  ok('展开風舞台', r.ok, r.error);
  // 纳 2 颗从虚取（3→1），展开时 自装→虚 +1（1→2）
  eq('虚 3-2+1 = 2', r.state.dust, 2);
  eq('装 3-1 = 2（展开时效果）', r.state.players[0].aura, 2);
}

{
  // 無窮ノ風：不可被对应
  let s = withHand(0, ['04-tokoyo-o-s-3']);
  s.distance = 5;
  s.players[0].flare = 1;
  s.players[1].hand = [cardById('02-saine-o-n-2')];   // 薙斬り（带对应）
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '04-tokoyo-o-s-3' });
  ok('打出無窮ノ風', r.ok, r.error);
  r = E.actions.applyAction(r.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-2' });
  ok('不可被对应', !r.ok);
}

/* ---------- 16. 全力与适正距离再确认 ---------- */
group('全力 / 距离再确认');
{
  // 本回合已经做过基本动作 → 不能再用《全力》卡
  let s = withHand(0, ['01-yurina-o-n-4']);   // 居合（全力）
  s.players[0].focus = 2;
  s.distance = 5;
  const r1 = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'charge' });
  ok('先做一次基本动作', r1.ok, r1.error);
  const r2 = E.actions.applyAction(r1.state, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-4' });
  ok('做过基本动作后不能用《全力》', !r2.ok);
}

{
  // 本回合已经出过牌 → 不能再用《全力》卡
  let s = withHand(0, ['01-yurina-o-n-4', '01-yurina-o-n-1']);
  s.distance = 3;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('先出一张斬', r.ok, r.error);
  r = E.actions.applyAction(r.state, { type: 'respond', player: 1, cardId: null });
  r = E.actions.applyAction(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  const r2 = E.actions.applyAction(r.state, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-4' });
  ok('出过牌后不能用《全力》', !r2.ok);
}

{
  // 什么都没做的回合可以用《全力》
  let s = withHand(0, ['01-yurina-o-n-4']);
  s.distance = 4;
  const r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-4' });
  ok('本回合没行动过 → 可以用《全力》', r.ok, r.error);
}

{
  // 对应改变了间合 → 攻击落空
  let s = withHand(0, ['01-yurina-o-n-2']);   // 一閃 适正距离 3
  s.distance = 3;
  s.players[1].hand = [cardById('02-saine-o-n-4')];   // 見切り（八相时才能当对应用）
  s.dust = 5;                                         // 虚是全场共享的
  s.players[1].aura = 1;                              // 八相：自装 ≤1
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-2' });
  ok('打出一閃', r.ok, r.error);
  r = E.actions.applyAction(r.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-4' });
  ok('用見切り对应', r.ok, r.error);
  // 見切り 会问方向，选 虚→间合（间合变 4，一閃 打不到）
  r = E.actions.applyAction(r.state, { type: 'choose', player: 1, option: 'dust_to_dist' });
  ok('选择方向', r.ok, r.error);
  eq('间合 3→4', r.state.distance, 4);
  ok('间合变了，攻击落空（没有待结算）', !r.state.pending);
  eq('命没掉', r.state.players[1].life, 10);
}

/* ---------- 17. 牌不会凭空消失 ---------- */
group('卡牌守恒');
{
  function countCards(s) {
    let n = 0;
    s.players.forEach(p => {
      n += p.hand.length + p.deck.length + p.discard.length
         + p.hidden.length + p.attachments.length + p.specials.length;
    });
    return n;
  }
  let s = fresh();
  eq('开局 20 张（双方各 7 通常 + 3 王牌）', countCards(s), 20);

  // 反复洗牌不应该丢牌
  const who = s.active;
  s.players[who].discard = s.players[who].deck.splice(0, 2);
  const before = countCards(s);
  E.rules.reshuffle(s, who, true);
  eq('重组之后总牌数不变', countCards(s), before);
  eq('牌库 = 剩下的 2 张 + 洗回的 2 张 = 4', s.players[who].deck.length, 4);
}

/* ---------- 18. 临时间合修正 / 即再起 ---------- */
group('临时间合修正');
{
  // distanceMod 不改结晶，只改"现在的间合"
  const s = fresh();
  s.distance = 5;
  s.distanceMod = 1;
  eq('结晶数没变', s.distance, 5);
  eq('实际间合 +1', E.rules.effDistance(s), 6);
  s.distanceMod = -2;
  eq('减 2 也可以', E.rules.effDistance(s), 3);

  // 攻击判断用的是实际间合
  let t2 = withHand(0, ['01-yurina-o-n-1']);   // 斬 3-4
  t2.distance = 2;
  t2.distanceMod = 1;                           // 实际间合 3
  const r = E.actions.applyAction(t2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('实际间合 3 时可以打出斬（3-4）', r.ok, r.error);
}

group('即再起');
{
  // 浮舟宿：自命降到 3 以下 → 立刻回未使用
  let s = withHand(0, []);
  s.players[0].flare = 2;
  const sp = s.players[0].specials.find(x => x.id === '01-yurina-o-s-3');
  s.players[0].hand = [cardById('01-yurina-o-s-3')];
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-s-3' });
  ok('打出浮舟宿', r.ok, r.error);
  eq('用掉后是已使用', r.state.players[0].specials.find(x => x.id === '01-yurina-o-s-3').used, true);

  // 现在让命掉到 3（即再起条件）
  const s2 = E.state.clone(r.state);
  s2.players[0].life = 4;
  const d = E.actions.applyAction(s2, { type: 'damage', who: 0, aura: 0, life: 1, choice: 'life' });
  ok('扣到 3 点命', d.ok, d.error);
  eq('即再起：浮舟宿 回到未使用',
    d.state.players[0].specials.find(x => x.id === '01-yurina-o-s-3').used, false);
}

/* ---------- 19. 全部 44 张卡的冒烟测试 ---------- */
group('44 张卡都能打出且不丢牌');
{
  function countCards(s) {
    let n = 0;
    s.players.forEach(p => {
      n += p.hand.length + p.deck.length + p.discard.length
         + p.hidden.length + p.attachments.length + p.specials.length;
    });
    return n;
  }

  // 把各种待处理状态都推进到底
  function settle(st) {
    let guard = 0;
    while (guard++ < 30) {
      if (st.exhaust && st.exhaust.remaining > 0) {
        const r = E.actions.applyAction(st, { type: 'resolveExhaust', player: st.exhaust.who, choice: 'life' });
        if (r.ok) { st = r.state; continue; }
      }
      if (st.nabu) {
        const nb = st.nabu;
        const fd = Math.min(st.dust, nb.cap);
        const r = E.actions.applyAction(st, { type: 'confirmNabu', player: nb.who, fromDust: fd, fromAura: nb.cap - fd });
        if (r.ok) { st = r.state; continue; }
        break;
      }
      if (st.choice) {
        const r = E.actions.applyAction(st, { type: 'choose', player: st.choice.who, option: st.choice.options[0] });
        if (r.ok) { st = r.state; continue; }
      }
      if (st.pending) {
        const pd = st.pending;
        const r = pd.stage === 'respond'
          ? E.actions.applyAction(st, { type: 'respond', player: pd.defender, cardId: null })
          : E.actions.applyAction(st, { type: 'resolveDamage', player: pd.defender, choice: 'life' });
        if (r.ok) { st = r.state; continue; }
      }
      break;
    }
    return st;
  }

  const allCards = [];
  db.goddesses.forEach(g => g.cards.forEach(c => allCards.push({ c: c, g: g.key })));

  let okCount = 0, failList = [];
  allCards.forEach(function (item) {
    const c = item.c;
    let s = freshP0();
    s.players[0].focus = 2;
    s.players[0].flare = 10;
    s.dust = 10;
    s.players[0].life = 3;         // 让「决死」类条件成立
    // 攻击牌要站在它自己的适正距离里
    s.distance = (c.range && c.range.length) ? c.range[0] : 4;
    s.players[0].hand = c.kind === 'special' ? [] : [JSON.parse(JSON.stringify(c))];
    // 王牌：换成这张，其余两张换掉
    s.players[0].specials = [Object.assign(JSON.parse(JSON.stringify(c)), { used: false })];

    const before = countCards(s);
    let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: c.id });
    if (!r.ok) {
      // 「只能用于对应」这类是设计如此，不算失败
      if (r.error && r.error.indexOf('只能用于对应') >= 0) { okCount++; return; }
      failList.push(c.id + ' 打出失败：' + r.error);
      return;
    }
    let st = settle(r.state);
    if (countCards(st) !== before) {
      failList.push(c.id + ' 打出后牌数变了 ' + before + '→' + countCards(st));
      return;
    }
    okCount++;
  });

  ok('44 张卡全部能打出／结算且不丢牌（' + okCount + '/' + allCards.length + '）', failList.length === 0, failList.slice(0, 6));
}

/* ---------- 20. 「-」不是 0 ---------- */
group('伤害里的「-」');
{
  // 三日月（2/-）：只能选装，不能选命
  let s = withHand(0, ['01-yurina-o-s-2']);   // 浦波嵐 0-10 / 2/-
  s.distance = 5;
  s.players[0].flare = 3;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-s-2' });
  ok('打出浦波嵐', r.ok, r.error);
  eq('命伤是 null（不是 0）', r.state.pending.damage.life, null);

  r = E.actions.applyAction(r.state, { type: 'respond', player: 1, cardId: null });
  ok('进入选伤害', r.ok, r.error);
  const bad = E.actions.applyAction(r.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('「-」的那条不能选', !bad.ok);
  const good = E.actions.applyAction(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('装可以选', good.ok, good.error);
}

/* ---------- 21. 全力之后只能结束回合 ---------- */
group('全力之后');
{
  let s = withHand(0, ['01-yurina-o-n-4']);   // 居合（全力）
  s.distance = 4; s.players[0].flare = 10;
  let r = E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-4' });
  ok('打出居合', r.ok, r.error);
  r = E.actions.applyAction(r.state, { type: 'respond', player: 1, cardId: null });
  r = E.actions.applyAction(r.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('居合结算完成', r.ok && !r.state.pending, r.error);

  const s2 = r.state;
  eq('标记为全力行动', s2.players[0].fullpowerUsed, true);

  // 王牌也不能出
  const sp = s2.players[0].specials.find(x => !x.used);
  const r2 = E.actions.applyAction(s2, { type: 'playCard', player: 0, cardId: sp.id });
  ok('全力之后不能出王牌', !r2.ok);

  // 通常札也不能出
  const s3 = E.state.clone(s2);
  s3.players[0].hand = [cardById('01-yurina-o-n-1')];
  const r3 = E.actions.applyAction(s3, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('全力之后不能出通常札', !r3.ok);

  // 基本动作也不能
  const s4 = E.state.clone(s2);
  s4.players[0].focus = 2;
  const r4 = E.actions.applyAction(s4, { type: 'basic', player: 0, which: 'charge' });
  ok('全力之后不能做基本动作', !r4.ok);

  // 但可以结束回合
  const r5 = E.actions.applyAction(s2, { type: 'endTurn', player: 0 });
  ok('全力之后可以结束回合', r5.ok, r5.error);
}

/* ---------- 22. 零伤害不动结晶 ---------- */
group('伤害为 0 时不动结晶');
{
  const s = fresh();
  const life0 = s.players[0].life, flare0 = s.players[0].flare;
  const dust0 = s.dust;
  E.rules.applyDamage(s, 0, 2, 0, 'life');   // 命伤 0
  eq('命伤 0 → 命不变', s.players[0].life, life0);
  eq('命伤 0 → 气不变', s.players[0].flare, flare0);
  eq('装没被碰', s.dust, dust0);
}

/* ---------- 23. 無音壁：装伤自己分配 ---------- */
group('無音壁 的装伤分配');
{
  let s = withHand(0, ['02-saine-o-n-7']);    // 無音壁 纳5
  s.distance = 7; s.dust = 8; s.players[0].aura = 3;
  let r = autoNabu(E.actions.applyAction(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-7' }));
  s = r.state;
  eq('無音壁 纳 5', s.players[0].attachments[0].crystals, 5);

  // 挨 3 点装伤：选择从無音壁扣 2、真装扣 1
  s.players[0].aura = 3;
  const dustBefore = s.dust;
  // 直接走分配接口
  const st = E.state.clone(s);
  st.pending = { kind: 'attack', attacker: 1, defender: 0, stage: 'auraSplit',
                 damage: { aura: 3, life: 0 }, range: [0,1,2,3,4,5,6,7,8,9,10] };
  st.auraSplit = { who: 0, total: 3, maxAttach: 5 };
  const r2 = E.actions.applyAction(st, { type: 'resolveAuraSplit', player: 0, fromAttach: 2 });
  ok('分配结算成功', r2.ok, r2.error);
  eq('装 3→2（扣 1）', r2.state.players[0].aura, 2);
  eq('無音壁 5→3（扣 2）', r2.state.players[0].attachments[0].crystals, 3);
  eq('虚多了 3 颗', r2.state.dust, dustBefore + 3);
}

/* ---------- 24. 不可变性 ---------- */
group('不可变性');
{
  const s = freshP0();
  const before = JSON.stringify(s);
  E.actions.applyAction(s, { type: 'endTurn', player: s.active });
  E.actions.applyAction(s, { type: 'basic', player: s.active, which: 'charge' });
  ok('applyAction 不修改原状态', JSON.stringify(s) === before);
}

console.log('\n----------------------------------------');
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '失败 ' + fail + ' 项 / 共 ' + (pass + fail) + ' 项');
process.exit(fail === 0 ? 0 : 1);
