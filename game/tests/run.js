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

/* ---------- 1. 随机 ---------- */
group('随机与洗牌');
{
  const a = E.rng.makeRng(42), b = E.rng.makeRng(42);
  const sa = [1,2,3,4,5].map(() => a()), sb = [1,2,3,4,5].map(() => b());
  eq('同种子两次随机结果一样', sa, sb);

  const arr = [1,2,3,4,5,6,7,8,9,10];
  const sh = E.rng.shuffle(arr, E.rng.makeRng(7));
  eq('洗牌后数量不变', sh.length, 10);
  eq('洗牌后元素集合不变', sh.slice().sort((x,y)=>x-y), arr);
  eq('原数组没被改动', arr, [1,2,3,4,5,6,7,8,9,10]);
}

/* ---------- 2. 开局 ---------- */
group('开局状态');
{
  const s = E.state.create({ myCards: deckOf('yurina'), oppCards: deckOf('saine'), seed: 12345 });
  eq('间合', s.distance, 10);
  eq('虚', s.dust, 8);
  eq('我的装', s.players[0].aura, 3);
  eq('我的命', s.players[0].life, 10);
  eq('我的手牌', s.players[0].hand.length, 3);
  eq('我的牌库', s.players[0].deck.length, 4);
  eq('我的手牌+牌库=7', s.players[0].hand.length + s.players[0].deck.length, 7);
  eq('王牌不进牌库', s.players[0].specials.length, 3);
  ok('后手集中力为 1',
    s.players[1 - s.active].focus === 1 && s.players[s.active].focus === 0,
    s.players.map(p => p.focus));
}

/* ---------- 3. 第一个回合跳过默认处理 ---------- */
group('回合流程');
{
  let s = E.state.create({ myCards: deckOf('yurina'), oppCards: deckOf('saine'), seed: 999 });
  const first = s.active;
  eq('第一个回合开始时手牌不增加', s.players[first].hand.length, 3);
  eq('第一个回合集中力不增加', s.players[first].focus, 0);

  // 结束回合：手牌 3 → 弃到 2
  const r1 = E.actions.applyAction(s, { type: 'endTurn', player: first });
  ok('结束回合成功', r1.ok);
  s = r1.state;
  eq('结束时手牌弃到 2', s.players[first].hand.length, 2);
  eq('弃牌区 1 张', s.players[first].discard.length, 1);
  eq('换人', s.active, 1 - first);
  eq('回合数 +1', s.turn, 2);

  // 对手第一个回合也跳过
  const r2 = E.actions.applyAction(s, { type: 'endTurn', player: s.active });
  s = r2.state;

  // 回到先手：走正常开始处理（集中力+1、抽2）
  eq('第二个回合集中力 +1', s.players[first].focus, 1);
  eq('第二个回合抽 2 张 → 手牌 4', s.players[first].hand.length, 4);
}

/* ---------- 4. 焦燥与重组 ---------- */
group('山札切れ（焦燥 + 重组）');
{
  let s = E.state.create({ myCards: deckOf('yurina'), oppCards: deckOf('saine'), seed: 555 });
  const who = 0;
  // 把牌库抽干：4 张全抽走
  E.rules.draw(s, who, 4);
  eq('牌库空了', s.players[who].deck.length, 0);
  // 造 3 张弃牌，让重组有料
  s.players[who].discard = s.players[who].hand.splice(0, 3);

  const auraBefore = s.players[who].aura;
  const lifeBefore = s.players[who].life;
  E.rules.draw(s, who, 1);

  eq('焦燥扣了 1 点装', s.players[who].aura, auraBefore - 1);
  eq('焦燥没有扣命', s.players[who].life, lifeBefore);
  eq('重组后牌库 3 张', s.players[who].deck.length, 2);  // 3 张洗回，再抽走 1
  eq('弃牌区清空', s.players[who].discard.length, 0);
}

/* ---------- 5. 伤害 ---------- */
group('伤害分配');
{
  const s = E.state.create({ myCards: deckOf('yurina'), oppCards: deckOf('saine'), seed: 7 });

  const a = E.actions.applyAction(s, { type: 'damage', who: 0, aura: 2, life: 1, choice: 'aura' });
  ok('选装成功', a.ok);
  eq('装 3-2', a.state.players[0].aura, 1);

  const b = E.actions.applyAction(a.state, { type: 'damage', who: 0, aura: 2, life: 1, choice: 'aura' });
  ok('装不够时选装被拒绝', !b.ok);

  const c = E.actions.applyAction(a.state, { type: 'damage', who: 0, aura: 2, life: 1, choice: 'life' });
  ok('选命成功', c.ok);
  eq('命 10-1', c.state.players[0].life, 9);

  // 打到 0 命判负
  let t = E.state.clone(s);
  t.players[0].life = 1;
  E.rules.applyDamage(t, 0, 0, 1, 'life');
  eq('命归零时对方获胜', t.winner, 1);
}

/* ---------- 6. 接口约定 ---------- */
group('不可变性');
{
  const s = E.state.create({ myCards: deckOf('yurina'), oppCards: deckOf('saine'), seed: 3 });
  const before = JSON.stringify(s);
  E.actions.applyAction(s, { type: 'endTurn', player: s.active });
  ok('applyAction 不修改原状态', JSON.stringify(s) === before);
}

console.log('\n----------------------------------------');
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : '失败 ' + fail + ' 项 / 共 ' + (pass + fail) + ' 项');
process.exit(fail === 0 ? 0 : 1);
