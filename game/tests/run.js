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
/** 固定先手为 P0 的状态：避免"谁先手"是随机的导致测试时灵时不灵 */
function freshP0() {
  const s = fresh();
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[1].firstTurnDone = false;
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
  eq('虚', s.dust, 8);
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

  let r = E.actions.applyAction(s, { type: 'endTurn', player: first });
  ok('结束回合成功', r.ok);
  s = r.state;
  eq('结束时手牌弃到 2', s.players[first].hand.length, 2);
  eq('弃牌区 1 张', s.players[first].discard.length, 1);
  eq('换人', s.active, 1 - first);
  eq('回合数 +1', s.turn, 2);

  r = E.actions.applyAction(s, { type: 'endTurn', player: s.active });
  s = r.state;
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

  // 缠绕：尘→装
  r = E.actions.applyAction(freshP0(), { type: 'basic', player: 0, which: 'gather' });
  ok('缠绕可用', r.ok);
  eq('缠绕后虚 8→7', r.state.dust, 7);
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

  s = freshP0(); s.distance = 2;
  r = E.actions.applyAction(s, { type: 'basic', player: 0, which: 'disengage' });
  ok('间合 2 时离脱可用', r.ok);
  eq('离脱后间合 2→3', r.state.distance, 3);
  eq('离脱后虚 8→7', r.state.dust, 7);
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
group('山札切れ（焦燥 + 重组）');
{
  const s = freshP0();
  const who = 0;
  E.rules.draw(s, who, 4);
  eq('牌库空了', s.players[who].deck.length, 0);
  s.players[who].discard = s.players[who].hand.splice(0, 3);

  const auraBefore = s.players[who].aura;
  const lifeBefore = s.players[who].life;
  E.rules.draw(s, who, 1);

  eq('焦燥扣了 1 点装', s.players[who].aura, auraBefore - 1);
  eq('焦燥没有扣命', s.players[who].life, lifeBefore);
  eq('重组后洗回 3 张、抽走 1 张', s.players[who].deck.length, 2);
  eq('弃牌区清空', s.players[who].discard.length, 0);
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

  const t = E.state.clone(s);
  t.players[0].life = 1;
  E.rules.applyDamage(t, 0, 0, 1, 'life');
  eq('命归零时对方获胜', t.winner, 1);
}

/* ---------- 7. 不可变性 ---------- */
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
