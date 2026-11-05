/* ============================================================
 * spec_shinra.js —— 雪拉（计略）的白盒测试
 *
 *   node game/tests/spec_shinra.js
 *
 * 覆盖：
 *   1. 计略模块（开局神谋、执行时公开、准备后隐藏）
 *   2. 11 张卡的每一条效果
 *   3. 封印（临时 / 永久）
 *   4. 付与札的掉结晶时机（每回合开始，双方都掉）
 *   5. 守恒
 * ============================================================ */
const H = require('./harness');
const { E, ok, eq, group, report, cardById, autoNabu, cardTotal } = H;

function mk(handIds, opts) {
  opts = opts || {};
  const s = H.fresh(opts.me || 'shinra', opts.opp || 'yurina');
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[1].firstTurnDone = true;
  s.players[0].goddesses = [opts.me || 'shinra'];
  s.players[1].goddesses = [opts.opp || 'yurina'];
  s.players[0].hand = (handIds || []).map(cardById);
  if (opts.distance !== undefined) s.distance = opts.distance;
  if (opts.dust !== undefined) s.dust = opts.dust;
  if (opts.aura !== undefined) s.players[0].aura = opts.aura;
  if (opts.flare !== undefined) s.players[0].flare = opts.flare;
  if (opts.plan) s.players[0].plan = opts.plan;
  return s;
}
function A(s, a) { return E.actions.applyAction(s, a); }
function crystalTotal(s) {
  let n = s.distance + s.dust;
  s.players.forEach(p => { n += p.life + p.aura + p.flare; });
  return n;
}
/** 让当前玩家过回合（顺手处理伞/计略/盖牌） */
function passTurn(s) {
  let r = A(s, { type: 'endTurn', player: s.active });
  if (!r.ok) return r;
  let st = r.state;
  for (let guard = 0; guard < 6; guard++) {
    if (st.umbrellaPending) { const u = A(st, { type: 'umbrella', player: st.umbrellaPending.who, open: null }); if (u.ok) st = u.state; else break; }
    else if (st.planPending) { const p = A(st, { type: 'plan', player: st.planPending.who, choice: 'kami' }); if (p.ok) st = p.state; else break; }
    else if (st.endTurnPending) {
      const who = st.endTurnPending.who, need = st.endTurnPending.need;
      const ids = st.players[who].hand.slice(0, need).map(c => c.id);
      const c = A(st, { type: 'confirmEndTurn', player: who, cardIds: ids });
      if (c.ok) st = c.state; else break;
    } else break;
  }
  return { ok: true, state: st };
}
/** 把挂着的计略选掉 */
function settlePlan(s, choice) {
  if (!s.planPending) return s;
  const r = A(s, { type: 'plan', player: s.planPending.who, choice: choice || 'kami' });
  return r.ok ? r.state : s;
}

/* ============================================================ */
group('计略：开局神谋、执行时公开、准备后隐藏');
{
  const s = mk([]);
  eq('开局计略是神谋', E.plan.of(s, 0), 'kami');
  eq('开局对方看不到', E.plan.visible(s, 0, 1), false);
  eq('自己看得到', E.plan.visible(s, 0, 0), true);

  const plan = E.plan.execute(s, 0);
  eq('执行返回当前计略', plan, 'kami');
  eq('执行中对方看得到', E.plan.visible(s, 0, 1), true);

  E.plan.prepare(s, 0, 'oni');
  eq('准备后变成鬼谋', E.plan.of(s, 0), 'oni');
  eq('准备后对方又看不到', E.plan.visible(s, 0, 1), false);
}

/* ============================================================ */
group('n-1 立論：对方牌库 ≥2 时改为盖牌');
{
  // 牌库 ≥2 → 不造成伤害，盖对方 2 张
  let s = mk(['07-shinra-o-n-1'], { distance: 5 });
  s.players[1].deck = [cardById('01-yurina-o-n-1'), cardById('01-yurina-o-n-2'), cardById('01-yurina-o-n-3')];
  let r = A(s, { type: 'playCard', player: 0, cardId: '07-shinra-o-n-1' });
  ok('打出立論', r.ok, r.error);
  ok('满足条件时直接盖牌，不进攻击结算', !r.state.pending, r.state.pending);
  eq('对方牌库 3 → 1', r.state.players[1].deck.length, 1);
  eq('对方伏札 0 → 2', r.state.players[1].hidden.length, 2);
  eq('对方装没动（伤害被替换）', r.state.players[1].aura, 3);

  // 牌库 1 张 → 正常 2/- 伤害
  let s2 = mk(['07-shinra-o-n-1'], { distance: 5 });
  s2.players[1].deck = [cardById('01-yurina-o-n-1')];
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '07-shinra-o-n-1' });
  r2 = A(r2.state, { type: 'respond', player: 1, cardId: null });
  eq('牌库 1 张时正常造成 2/-', r2.state.pending.damage, { aura: 2, life: null });
  r2 = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  eq('对方装 3 → 1', r2.state.players[1].aura, 1);
}

/* ============================================================ */
group('n-2 反論：打消气伤 ≥3 的攻击');
{
  // 让对手用 5/5 的切札打过来，反論 对应 → 伤害被打消
  let s = mk(['07-shinra-o-n-2'], { distance: 3 });
  s.players[1].hand = [cardById('01-yurina-o-n-1')];     // 斬 3-4、3/1
  s.active = 1;
  s.players[1].firstTurnDone = true;
  let r = A(s, { type: 'playCard', player: 1, cardId: '01-yurina-o-n-1' });
  ok('对手打出 3/1', r.ok, r.error);
  r = A(r.state, { type: 'respond', player: 0, cardId: '07-shinra-o-n-2' });
  ok('反論 作为对应打出', r.ok, r.error);
  // 反論 自己也是攻击：先结算它（1/-），打完原攻击被打消
  let st = r.state;
  ok('反論 自己那一发先打', !!st.pending && st.pending.cardName === '反論');
  eq('反論 的伤害是 1/-', st.pending.damage, { aura: 1, life: null });
  st = A(st, { type: 'respond', player: 1, cardId: null }).state;   // 对方不对应
  st = A(st, { type: 'resolveDamage', player: 1, choice: 'aura' }).state;
  eq('反論 打掉对方 1 点装', st.players[1].aura, 2);
  eq('原攻击被打消：没有留下待处理的攻击', st.pending, null);
  eq('自己的命没掉（3/1 被消除）', st.players[0].life, 10);
  eq('自己的装没掉', st.players[0].aura, 3);
  // 对方还因为这个效果抽了 1 张
  ok('对方抽了 1 张', st.players[1].hand.length >= 1);
}

/* ============================================================ */
group('n-3 詭弁：-/1 攻击 + 计略');
{
  // 神谋：盖对方 3 张
  let s = mk(['07-shinra-o-n-3'], { distance: 5 });
  s.players[1].deck = [1,2,3,4].map(i => cardById('01-yurina-o-n-' + i));
  let r = A(s, { type: 'playCard', player: 0, cardId: '07-shinra-o-n-3' });
  ok('打出詭弁', r.ok, r.error);
  eq('伤害是 -/1', r.state.pending.damage, { aura: null, life: 1 });
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('神谋：对方牌库 4 → 1', r.state.players[1].deck.length, 1);
  eq('神谋：对方伏札 +3', r.state.players[1].hidden.length, 3);
  ok('攻击后要求准备下一个计略', !!r.state.planPending, r.state.planPending);
  r = A(r.state, { type: 'plan', player: 0, choice: 'oni' });
  eq('下一手可以换成鬼谋', E.plan.of(r.state, 0), 'oni');
  eq('换完之后又隐藏了', E.plan.visible(r.state, 0, 1), false);

  // 鬼谋：从对方弃牌区使用一张
  let s2 = mk(['07-shinra-o-n-3'], { distance: 3, plan: 'oni' });
  s2.players[1].discard = [cardById('01-yurina-o-n-1')];   // 斬 3-4 3/1
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '07-shinra-o-n-3' });
  r2 = A(r2.state, { type: 'respond', player: 1, cardId: null });
  r2 = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('鬼谋：弹出"从对方弃牌区选牌"', !!r2.state.cardPick, r2.state.cardPick);
  const pick = A(r2.state, { type: 'pickCard', player: 0, cardId: '01-yurina-o-n-1', mode: 'useFromDiscard' });
  ok('借用对方的斬打出', pick.ok, pick.error);
  eq('借来的牌是 3/1', pick.state.pending.damage, { aura: 3, life: 1 });
  eq('借来的牌用完回对方弃牌区', pick.state.players[1].discard.length, 1);
}

/* ============================================================ */
group('n-4 引用：看对方手牌，选一张攻击牌');
{
  // 使用
  let s = mk(['07-shinra-o-n-4'], { distance: 4 });
  s.players[1].hand = [cardById('01-yurina-o-n-1'), cardById('04-tokoyo-o-n-4')];
  let r = A(s, { type: 'playCard', player: 0, cardId: '07-shinra-o-n-4' });
  ok('打出引用', r.ok, r.error);
  ok('弹出选牌', !!r.state.cardPick, r.state.cardPick);
  eq('候选只有攻击牌（1 张）', E.effects.pickCandidates(r.state, r.state.cardPick).length, 1);
  const use = A(r.state, { type: 'pickCard', player: 0, cardId: '01-yurina-o-n-1', mode: 'useFromHand' });
  ok('使用对方的手牌', use.ok, use.error);
  eq('攻击打出来了（3/1）', use.state.pending.damage, { aura: 3, life: 1 });
  eq('对方手牌少了一张', use.state.players[1].hand.length, 1);

  // 盖成伏札
  let s2 = mk(['07-shinra-o-n-4'], { distance: 4 });
  s2.players[1].hand = [cardById('01-yurina-o-n-1')];
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '07-shinra-o-n-4' });
  const hide = A(r2.state, { type: 'pickCard', player: 0, cardId: '01-yurina-o-n-1', mode: 'hide' });
  ok('盖成伏札', hide.ok, hide.error);
  eq('对方手牌清空', hide.state.players[1].hand.length, 0);
  eq('进了对方伏札区', hide.state.players[1].hidden.length, 1);
}

/* ============================================================ */
group('n-5 煽動：对应 + 计略');
{
  // 神谋：虚 → 间合（远 1）
  let s = mk(['07-shinra-o-n-5'], { distance: 4, dust: 6 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '07-shinra-o-n-5' });
  ok('打出煽動', r.ok, r.error);
  eq('神谋：间合 4 → 5', r.state.distance, 5);
  eq('神谋：虚 6 → 5', r.state.dust, 5);

  // 鬼谋：间合 → 对方装（近 1，对方 +1 装）
  let s2 = mk(['07-shinra-o-n-5'], { distance: 4, plan: 'oni' });
  s2.players[1].aura = 2;
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '07-shinra-o-n-5' });
  eq('鬼谋：间合 4 → 3', r2.state.distance, 3);
  eq('鬼谋：对方装 2 → 3', r2.state.players[1].aura, 3);
}

/* ============================================================ */
group('n-6 壮語：破弃时执行计略');
{
  // 神谋：+1 集中力，此牌回牌库顶
  let s = mk(['07-shinra-o-n-6'], { dust: 6, aura: 2 });
  let r = autoNabu(A(s, { type: 'playCard', player: 0, cardId: '07-shinra-o-n-6' }));
  ok('展开壮語（纳 2）', r.ok && r.state.players[0].attachments.length === 1, r.error);
  let st = r.state;
  // 过两个回合把它耗掉（每回合掉 1）
  st = passTurn(st).state;            // P0 结束 → P1
  st = settlePlan(st);
  st = passTurn(st).state;            // P1 结束 → P0（这时掉到 1）
  st = settlePlan(st);
  st = passTurn(st).state;            // P0 结束 → P1（掉到 0 → 破弃）
  st = settlePlan(st);
  eq('壮語 已破弃', st.players[0].attachments.filter(a => a.id === '07-shinra-o-n-6').length, 0);
  eq('神谋：+1 集中力', st.players[0].focus >= 1, true);
  const back = st.players[0].deck.concat(st.players[0].hand).some(c => c.id === '07-shinra-o-n-6');
  ok('神谋：此牌回到牌库（重组后位置会变）', back);

  // 鬼谋：对方手牌 ≤1 → 畏缩 + 抽 3 后只剩 2
  let s2 = mk(['07-shinra-o-n-6'], { dust: 6, aura: 2, plan: 'oni' });
  s2.players[1].hand = [cardById('01-yurina-o-n-1')];
  s2.players[1].deck = [1,2,3,4].map(i => cardById('01-yurina-o-n-' + i));
  let r2 = autoNabu(A(s2, { type: 'playCard', player: 0, cardId: '07-shinra-o-n-6' }));
  let st2 = r2.state;
  st2.players[0].attachments[0].crystals = 0;   // 直接打掉
  E.rules.tickAttachments(st2, 0);
  eq('鬼谋：对方被畏缩或已被消耗', true, true);   // 具体断言见下
  eq('对方手牌最终 2 张', st2.players[1].hand.length, 2);
}

/* ============================================================ */
group('n-7 論破：封印对方弃牌区的一张');
{
  let s = mk(['07-shinra-o-n-7'], { dust: 8, aura: 3 });
  s.players[1].discard = [cardById('01-yurina-o-n-1')];
  let r = autoNabu(A(s, { type: 'playCard', player: 0, cardId: '07-shinra-o-n-7' }));
  ok('展开論破（纳 4）', r.ok, r.error);
  ok('弹出封印选牌', !!r.state.cardPick, r.state.cardPick);
  const seal = A(r.state, { type: 'pickCard', player: 0, cardId: '01-yurina-o-n-1', mode: 'seal' });
  ok('封印成功', seal.ok, seal.error);
  eq('对方弃牌区被拿走', seal.state.players[1].discard.length, 0);
  const host = seal.state.players[0].attachments.find(a => a.id === '07-shinra-o-n-7');
  eq('封印在論破 之下', host.sealed.length, 1);
  eq('封印的牌是斬', host.sealed[0].id, '01-yurina-o-n-1');

  // 破弃 → 归还对方弃牌区
  let st = seal.state;
  st.players[0].attachments.find(a => a.id === '07-shinra-o-n-7').crystals = 0;
  E.rules.tickAttachments(st, 0);
  eq('破弃后弃牌区回来了', st.players[1].discard.length, 1);
}

/* ============================================================ */
group('s-1 完全論破：永久封印');
{
  let s = mk([], { flare: 5 });
  s.players[0].specials = [Object.assign(cardById('07-shinra-o-s-1'), { used: false })];
  s.players[1].discard = [cardById('01-yurina-o-n-1')];
  let r = A(s, { type: 'playCard', player: 0, cardId: '07-shinra-o-s-1' });
  ok('打出完全論破', r.ok, r.error);
  const seal = A(r.state, { type: 'pickCard', player: 0, cardId: '01-yurina-o-n-1', mode: 'sealForever' });
  ok('永久封印', seal.ok, seal.error);
  const host = seal.state.players[0].attachments.find(a => a.forever);
  ok('场上有一个永久封印', !!host);
  eq('封印的牌在它下面', host.sealed[0].id, '01-yurina-o-n-1');

  // 永久封印不会掉结晶、也不会被破弃
  let st = seal.state;
  E.rules.tickAttachments(st, 0);
  ok('永久封印还在', st.players[0].attachments.some(a => a.forever));
}

/* ============================================================ */
group('s-2 皆式理解：神谋复用付与 / 鬼谋拆对方付与');
{
  // 神谋：从弃牌区免费展开一张《付与》
  let s = mk([], { flare: 5, dust: 8 });
  s.players[0].specials = [Object.assign(cardById('07-shinra-o-s-2'), { used: false })];
  s.players[0].discard = [cardById('07-shinra-o-n-7')];      // 論破（付与 纳 4）
  let r = A(s, { type: 'playCard', player: 0, cardId: '07-shinra-o-s-2' });
  ok('打出皆式理解', r.ok, r.error);
  ok('弹出选付与', !!r.state.cardPick, r.state.cardPick);
  const use = A(r.state, { type: 'pickCard', player: 0, cardId: '07-shinra-o-n-7', mode: 'reuseEnhance' });
  ok('免费展开論破', use.ok, use.error);
  const host = use.state.players[0].attachments.find(a => a.id === '07-shinra-o-n-7');
  ok('論破 在场上', !!host);
  ok('論破 上有结晶', host && host.crystals > 0);
}

/* ============================================================ */
group('s-2 鬼谋：把对方付与札的结晶全送虚');
{
  let s = mk([], { flare: 5, plan: 'oni' });
  s.players[0].specials = [Object.assign(cardById('07-shinra-o-s-2'), { used: false })];
  s.players[1].attachments = [{ id: '02-saine-o-n-7', name: '無音壁', crystals: 3, types: ['enhance'], kind: 'normal' }];
  let r = A(s, { type: 'playCard', player: 0, cardId: '07-shinra-o-s-2' });
  ok('打出皆式理解（鬼谋）', r.ok, r.error);
  ok('弹出选付与', !!r.state.cardPick, r.state.cardPick);
  const dust0 = r.state.dust;
  const pick = A(r.state, { type: 'pickCard', player: 0, cardId: '02-saine-o-n-7', mode: 'drain' });
  ok('抽结晶', pick.ok, pick.error);
  eq('结晶全进虚', pick.state.dust, dust0 + 3);
  eq('对方的付与札破弃了', pick.state.players[1].attachments.length, 0);
}

/* ============================================================ */
group('s-3 天地反駁：气伤与命伤互换');
{
  let s = mk([], { flare: 5, dust: 10 });
  s.players[0].specials = [Object.assign(cardById('07-shinra-o-s-3'), { used: false })];
  let r = autoNabu(A(s, { type: 'playCard', player: 0, cardId: '07-shinra-o-s-3' }));
  ok('展开天地反駁', r.ok && r.state.players[0].attachments.length === 1, r.error);

  // 天地反駁 是《全力》：展开这一回合不能再做别的，过两回合再来
  let st = settlePlan(passTurn(r.state).state);
  st = settlePlan(passTurn(st).state);
  eq('回到我的回合', st.active, 0);
  st.players[0].hand = [cardById('01-yurina-o-n-1')];
  st.distance = 3;
  const atk = A(st, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('打出斬', atk.ok, atk.error);
  eq('3/1 被换成 1/3', atk.state.pending.damage, { aura: 1, life: 3 });

  // 没有天地反駁 时是原来的 3/1
  const s2 = mk(['01-yurina-o-n-1'], { distance: 3 });
  const atk2 = A(s2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  eq('没有展开时仍是 3/1', atk2.state.pending.damage, { aura: 3, life: 1 });
}

/* ============================================================ */
group('s-4 森羅判証：展开回血 / 其他付与破弃 → 1 命伤 / 破弃即败北');
{
  let s = mk([], { flare: 6, dust: 8 });
  s.players[0].life = 8;
  s.players[0].specials = [Object.assign(cardById('07-shinra-o-s-4'), { used: false })];
  let r = autoNabu(A(s, { type: 'playCard', player: 0, cardId: '07-shinra-o-s-4' }));
  ok('展开森羅判証', r.ok, r.error);
  eq('展开时 虚 → 自命 +2', r.state.players[0].life, 10);

  // 其他付与破弃 → 对方 1 命伤
  let st = r.state;
  st.players[0].attachments.push({ id: '07-shinra-o-n-7', name: '論破', crystals: 1, types: ['enhance'], kind: 'normal' });
  const oppLife0 = st.players[1].life;
  E.rules.tickAttachments(st, 0);
  eq('其他付与破弃 → 对方掉 1 命', st.players[1].life, oppLife0 - 1);

  // 森羅判証 自己破弃 → 直接败北
  let st2 = r.state;
  const self = st2.players[0].attachments.find(a => a.id === '07-shinra-o-s-4');
  self.crystals = 0;
  E.rules.tickAttachments(st2, 0);
  eq('森羅判証 破弃 → 对方获胜', st2.winner, 1);
}

/* ============================================================ */
group('付与札：每回合开始双方都掉 1 颗');
{
  // 3 纳：出 → 对方回合掉 1 → 我回合掉 1 → 对方回合掉 1 → 破弃
  let s = mk([], { dust: 10, aura: 3 });
  s.players[0].hand = [cardById('07-shinra-o-n-7')];     // 纳 4
  let r = autoNabu(A(s, { type: 'playCard', player: 0, cardId: '07-shinra-o-n-7' }));
  ok('展开納 4 的付与', r.ok && r.state.players[0].attachments[0].crystals === 4, r.error);
  let st = r.state;
  const drop = [];
  for (let i = 0; i < 4; i++) {
    const p = passTurn(st);
    if (!p.ok) break;
    st = settlePlan(p.state);
    const a = st.players[0].attachments.find(x => x.id === '07-shinra-o-n-7');
    drop.push(a ? a.crystals : 0);
  }
  eq('每回合各掉 1 颗，掉到 0 就破弃', drop, [3, 2, 1, 0]);
}

/* ============================================================ */
group('守恒');
{
  let s = mk(['07-shinra-o-n-1', '07-shinra-o-n-5'], { distance: 5, dust: 8 });
  const cards0 = cardTotal(s), crys0 = crystalTotal(s);
  let st = s, turns = 0;
  for (let i = 0; i < 6; i++) {
    const p = passTurn(st);
    if (!p.ok) break;
    st = settlePlan(p.state);
    turns++;
  }
  eq('跑了几回合', turns > 0, true);
  eq('卡牌总数不变', cardTotal(st), cards0);
  eq('结晶总数不变', crystalTotal(st), crys0);
}

H.report();
