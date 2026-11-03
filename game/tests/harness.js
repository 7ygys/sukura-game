/* ============================================================
 * tests/harness.js —— 白盒测试共用脚手架
 *
 * 用法：
 *   const H = require('./harness');
 *   H.group('某机制');
 *   H.ok('名字', 条件);
 *   H.eq('名字', 实际, 期望);
 *   ...
 *   H.report();     // 末尾调用，失败时 process.exit(1)
 *
 * 目的：让每个 spec_*.js 只关心"测什么"，不用重复写样板。
 * ============================================================ */
const path = require('path');
const fs = require('fs');

// 引擎是 UMD 写法，require 后挂在 globalThis.Engine 上
require('../engine/rng.js');
require('../engine/umbrella.js');
require('../engine/state.js');
require('../engine/rules.js');
require('../engine/effects.js');
require('../engine/actions.js');
const E = globalThis.Engine;

const db = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/cards.json'), 'utf8'));

/* ---------- 迷你断言框架 ---------- */
let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    const line = name + (extra !== undefined ? '  实际: ' + JSON.stringify(extra) : '');
    failures.push(line);
    console.log('  ✗ ' + line);
  }
}
function eq(name, actual, expected) {
  ok(name + ' = ' + JSON.stringify(expected),
     JSON.stringify(actual) === JSON.stringify(expected), actual);
}
function group(title) { console.log('\n[' + title + ']'); }
function report() {
  console.log('\n' + (fail === 0 ? '全部通过：' : '失败 ' + fail + ' 项 / 共 ') + (pass + fail) + (fail === 0 ? ' 项' : ' 项'));
  if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
}

/* ---------- 造状态 ---------- */
function cardById(id) {
  for (const g of db.goddesses) {
    const c = g.cards.find(x => x.id === id);
    if (c) return JSON.parse(JSON.stringify(c));
  }
  throw new Error('没有这张卡: ' + id);
}
function deckOf(key) {
  const g = db.goddesses.find(x => x.key === key);
  const normal = g.cards.filter(c => c.kind === 'normal').slice(0, 7);
  const special = g.cards.filter(c => c.kind === 'special').slice(0, 3);
  return normal.concat(special);
}
/** 新开一局（默认 刀 vs 薙刀） */
function fresh(myKey, oppKey) {
  return E.state.create({ myCards: deckOf(myKey || 'yurina'), oppCards: deckOf(oppKey || 'saine') });
}
/** 让 P0 成为行动方、跳过"第一个回合"的特殊处理，并塞好手牌 */
function withHand(cards) {
  const s = fresh();
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[0].hand = cards.map(cardById);
  return s;
}
/** 付与展开后要分配「纳」：默认先虚后装 */
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
/** 结束回合；需要盖牌就自动盖前 N 张 */
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
/** 双方牌的总数（守恒校验用） */
function cardTotal(s) {
  let n = 0;
  s.players.forEach(p => {
    n += p.hand.length + p.deck.length + p.discard.length
       + p.hidden.length + p.attachments.length + p.specials.length;
  });
  return n;
}

module.exports = {
  E, db,
  ok, eq, group, report,
  cardById, deckOf, fresh, withHand, autoNabu, endTurnAuto, cardTotal
};
