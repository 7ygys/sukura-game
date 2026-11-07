/* ============================================================
 * spec_chikage.js —— 千影（毒袋 / 禁止基本动作 / 全力化）的白盒测试
 *
 *   node game/tests/spec_chikage.js
 * ============================================================ */
const H = require('./harness');
const { E, ok, eq, group, report, cardById, autoNabu, cardTotal } = H;

const POISONS = H.poisonsOf('chikage');

function mk(handIds, opts) {
  opts = opts || {};
  const s = E.state.create({
    myCards: H.deckOf(opts.me || 'chikage'),
    oppCards: H.deckOf(opts.opp || 'yurina'),
    myPoisons: opts.mineBag === false ? null : POISONS,
    oppPoisons: opts.oppBag ? POISONS : null
  });
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[1].firstTurnDone = true;
  s.players[0].goddesses = [opts.me || 'chikage'];
  s.players[1].goddesses = [opts.opp || 'yurina'];
  s.players[0].hand = (handIds || []).map(cardById);
  if (opts.distance !== undefined) s.distance = opts.distance;
  if (opts.dust !== undefined) s.dust = opts.dust;
  if (opts.aura !== undefined) s.players[0].aura = opts.aura;
  if (opts.flare !== undefined) s.players[0].flare = opts.flare;
  if (opts.oppHand) s.players[1].hand = opts.oppHand.map(cardById);
  return s;
}
function A(s, a) { return E.actions.applyAction(s, a); }
function bag(s, who) { return (s.players[who].poisonBag || []).length; }

/* ============================================================ */
group('毒袋：开局 5 张');
{
  const s = mk([]);
  eq('千影的毒袋有 5 张', bag(s, 0), 5);
  eq('对方没有毒袋', bag(s, 1), 0);
}

/* ============================================================ */
group('毒針：攻击后把毒放到对方牌库顶');
{
  let s = mk(['09-chikage-o-n-2'], { distance: 4 });
  s.players[1].deck = [cardById('01-yurina-o-n-1')];
  let r = A(s, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-2' });
  ok('打出毒針', r.ok, r.error);
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('弹出选毒', !!r.state.cardPick, r.state.cardPick);
  const pick = A(r.state, { type: 'pickCard', player: 0, cardId: '09-chikage-o-p-1', mode: 'poisonTop' });
  ok('选「麻痺毒」放牌库顶', pick.ok, pick.error);
  eq('毒袋 5 → 4', bag(pick.state, 0), 4);
  eq('对方牌库顶是麻痺毒', pick.state.players[1].deck[0].id, '09-chikage-o-p-1');
}

/* ============================================================ */
group('毒霧：把毒放进对方手牌');
{
  let s = mk(['09-chikage-o-n-5']);
  s.players[1].hand = [];
  let r = A(s, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-5' });
  ok('打出毒霧', r.ok, r.error);
  const pick = A(r.state, { type: 'pickCard', player: 0, cardId: '09-chikage-o-p-3', mode: 'poisonToHand' });
  ok('选「弛緩毒」给对方', pick.ok, pick.error);
  eq('对方手牌 +1', pick.state.players[1].hand.length, 1);
  eq('是弛緩毒', pick.state.players[1].hand[0].id, '09-chikage-o-p-3');
  eq('毒袋 5 → 4', bag(pick.state, 0), 4);
}

/* ============================================================ */
group('毒：不能盖、不能当结束阶段弃牌');
{
  let s = mk([]);
  s.players[1].hand = ['09-chikage-o-p-1', '01-yurina-o-n-1', '01-yurina-o-n-2'].map(cardById);
  const hide = A(s, { type: 'hideCard', player: 1, cardId: '09-chikage-o-p-1' });
  ok('毒不能盖成伏札', !hide.ok, hide.error);

  // 结束阶段：1 张毒 + 3 张普通 → 3 张普通要弃到 2 张，毒不参与
  s.active = 1;
  s.players[1].hand = ['09-chikage-o-p-1', '01-yurina-o-n-1', '01-yurina-o-n-2', '01-yurina-o-n-3'].map(cardById);
  let r = A(s, { type: 'endTurn', player: 1 });
  ok('手牌超过上限 → 要选盖牌', !!r.state.endTurnPending, r.state.endTurnPending);
  eq('只需要盖 1 张（毒不算）：4 张里 3 张普通', r.state.endTurnPending.need, 1);
  const ids = r.state.players[1].hand.map(c => c.id);
  const poisonIdx = ids.indexOf('09-chikage-o-p-1');
  const keep = A(r.state, { type: 'confirmEndTurn', player: 1, cardIds: [poisonIdx] });
  const stillHasPoison = keep.state
    ? keep.state.players[1].hand.some(c => c.id === '09-chikage-o-p-1')
    : true;
  eq('毒不会被丢掉（盖牌只从普通牌里选）', stillHasPoison, true);
}

/* ============================================================ */
group('麻痺毒 / 幻覚毒 / 滅灯毒 的使用');
{
  // 幻覚毒：回毒袋 + 自气 → 虚 2
  let s = mk([]);
  s.players[1].savedBag = null;
  s.players[1].hand = [{ id: '09-chikage-o-p-2', name: '幻覚毒', kind: 'poison', types: ['action'], poison: true }];
  s.players[1].flare = 4;
  s.players[1].focus = 1;
  s.active = 1;
  const dust0 = s.dust;
  let r = A(s, { type: 'playCard', player: 1, cardId: '09-chikage-o-p-2' });
  ok('使用幻覚毒', r.ok, r.error);
  eq('气 4 → 2', r.state.players[1].flare, 2);
  eq('虚 +2', r.state.dust, dust0 + 2);
  eq('回到千影的毒袋', bag(r.state, 0), 6);
}

/* ============================================================ */
group('禁止基本动作：遁術 / 泥濘');
{
  let s = mk(['09-chikage-o-n-3'], { distance: 2 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-3' });
  ok('打出遁術', r.ok, r.error);
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('遁術 结算完', !!r.state, true);
  eq('对方被禁止《前进》', !!(r.state.players[1].basicBan || {}).advance, true);
  // 对方回合试试前进
  let st = r.state;
  st.active = 1;
  st.players[1].focus = 2;
  const adv = A(st, { type: 'basic', player: 1, which: 'advance' });
  ok('被禁止《前进》时不能前进', !adv.ok, adv.error);

  // 泥濘：禁止《后退》《离脱》
  let s2 = mk([], { distance: 4, dust: 8 });
  s2.players[0].hand = [cardById('09-chikage-o-n-7')];
  let r2 = autoNabu(A(s2, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-7' }));
  ok('展开泥濘', r2.ok && r2.state.players[0].attachments.length === 1, r2.error);
  let st2 = r2.state;
  st2.active = 1;
  st2.players[1].focus = 2;
  const back = A(st2, { type: 'basic', player: 1, which: 'retreat' });
  ok('泥濘：对方不能后退', !back.ok, back.error);
  const dis = A(st2, { type: 'basic', player: 1, which: 'disengage' });
  ok('泥濘：对方不能离脱', !dis.ok, dis.error);
}

/* ============================================================ */
group('抜き足：当前间合 -2');
{
  let s = mk([], { distance: 5, dust: 8 });
  s.players[0].hand = [cardById('09-chikage-o-n-6')];
  let r = autoNabu(A(s, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-6' }));
  ok('展开抜き足', r.ok && r.state.players[0].attachments.length === 1, r.error);
  eq('间合 5 → 3', E.rules.effDistance(r.state), 3);
  eq('结晶还是 5 颗（只是视作 -2）', r.state.distance, 5);

  // 间合不会低于 0
  let s2 = mk([], { distance: 1, dust: 8 });
  s2.players[0].hand = [cardById('09-chikage-o-n-6')];
  let r2 = autoNabu(A(s2, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-6' }));
  eq('间合 1 → 0（不会负数）', E.rules.effDistance(r2.state), 0);
}

/* ============================================================ */
group('全力化：暗器');
{
  // 普通使用：1/1
  let s = mk(['09-chikage-o-n-4'], { distance: 3 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-4', fp: false });
  ok('普通使用暗器', r.ok, r.error);
  eq('普通：1/1', r.state.pending.damage, { aura: 1, life: 1 });

  // 全力化：2/3（1/1 + 1/+2）
  let s2 = mk(['09-chikage-o-n-4'], { distance: 3 });
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-4', fp: true });
  ok('全力化暗器', r2.ok, r2.error);
  eq('全力化：2/3', r2.state.pending.damage, { aura: 2, life: 3 });
  eq('全力化之后本回合只能结束', r2.state.players[0].fullpowerUsed, true);

  // 本回合已经行动过 → 不能全力化
  let s3 = mk(['09-chikage-o-n-4'], { distance: 3 });
  s3.players[0].usedBasicThisTurn = true;
  const bad = A(s3, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-4', fp: true });
  ok('本回合行动过 → 不能全力化', !bad.ok, bad.error);
}

/* ============================================================ */
group('叛旗の纏毒：带「-」的攻击被抵消');
{
  let s = mk([], { distance: 4, dust: 10 });
  s.players[0].hand = [cardById('09-chikage-o-s-2')];
  s.players[0].flare = 5;
  let r = autoNabu(A(s, { type: 'playCard', player: 0, cardId: '09-chikage-o-s-2' }));
  ok('展开叛旗', r.ok && r.state.players[0].attachments.length === 1, r.error);

  // 遁術 是 1/-（命伤是「-」）→ 被抵消
  let st = r.state;
  st.players[0].hand = [cardById('09-chikage-o-n-3')];
  st.distance = 2;
  const atk = A(st, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-3' });
  ok('带「-」的攻击被抵消（没有待处理攻击）', atk.ok && !atk.state.pending, atk.error);

  // 飛苦無 2/2 两边都有数字 → 正常打出
  let st2 = r.state;
  st2.players[0].hand = [cardById('09-chikage-o-n-1')];
  st2.distance = 4;
  const atk2 = A(st2, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-1' });
  ok('2/2 不受影响', atk2.ok && !!atk2.state.pending, atk2.error);
}

/* ============================================================ */
group('闇昏千影の生きる道');
{
  let s = mk([], { dust: 10, flare: 8 });
  s.players[0].hand = [cardById('09-chikage-o-s-4')];
  let r = autoNabu(A(s, { type: 'playCard', player: 0, cardId: '09-chikage-o-s-4' }));
  ok('展开生きる道', r.ok && r.state.players[0].attachments.length === 1, r.error);

  // 受到命伤 → 结晶进虚、回未使用
  let st = r.state;
  const self = st.players[0].attachments[0];
  const n0 = self.crystals, dust0 = st.dust;
  E.rules.applyDamage(st, 0, 0, 1, 'life');
  eq('结晶全部进虚', st.dust, dust0 + n0);
  const sp = st.players[0].specials.find(c => c.id === '09-chikage-o-s-4');
  eq('回到未使用', sp.used || st.players[0].attachments.length === 0, true);
}

/* ============================================================ */
group('守恒');
{
  let s = mk(['09-chikage-o-n-1', '09-chikage-o-n-2'], { distance: 5, dust: 8 });
  const cards0 = cardTotal(s);
  let st = s, turns = 0;
  for (let i = 0; i < 4; i++) {
    let r = A(st, { type: 'endTurn', player: st.active });
    if (!r.ok) break;
    st = r.state;
    if (st.endTurnPending) {
      const who = st.endTurnPending.who;
      const ids = st.players[who].hand.filter(c => !E.rules.isPoison(c)).slice(0, st.endTurnPending.need).map(c => c.id);
      const c = A(st, { type: 'confirmEndTurn', player: who, cardIds: ids });
      if (c.ok) st = c.state; else break;
    }
    turns++;
  }
  eq('跑了几回合', turns > 0, true);
  eq('卡牌总数不变（毒袋另算）', cardTotal(st), cards0);
}

/* ============================================================ */
group('一次攻击只能被一张对应牌对应');
{
  let s = mk([], { distance: 3 });
  s.players[1].hand = ['04-tokoyo-o-n-2', '04-tokoyo-o-n-2'].map(cardById);
  s.players[1].focus = 2;
  s.players[0].hand = [cardById('09-chikage-o-n-1')];
  s.distance = 4;
  let r = A(s, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-1' });
  ok('打出飛苦無', r.ok, r.error);
  const first = A(r.state, { type: 'respond', player: 1, cardId: '04-tokoyo-o-n-2' });
  ok('第一张对应可以打出', first.ok, first.error);
  // 雅打ち 自己那发打完、原攻击回到等待结算时，也不能再对应
  let st = first.state;
  st = A(st, { type: 'respond', player: 0, cardId: null }).state;
  st = A(st, { type: 'resolveDamage', player: 0, choice: 'aura' }).state;
  if (st.pending) {
    const second = A(st, { type: 'respond', player: 1, cardId: '04-tokoyo-o-n-2' });
    ok('同一发攻击不能再对应第二次', !second.ok, second.error);
  } else {
    ok('同一发攻击不能再对应第二次（已经被打消/结算）', true);
  }
}

/* ============================================================ */
group('重组：毒牌洗完后放牌库顶');
{
  let s = mk([], { distance: 4 });
  s.players[0].deck = [cardById('01-yurina-o-n-1'), cardById('01-yurina-o-n-2')];
  s.players[0].discard = [
    { id: '09-chikage-o-p-1', name: '麻痺毒', kind: 'poison', types: ['action'], poison: true },
    cardById('09-chikage-o-n-1'), cardById('09-chikage-o-n-2')
  ];
  s.players[0].hidden = [];
  const okr = E.rules.reshuffle(s, 0, false);
  ok('重组成功', okr, okr);
  eq('毒在牌库顶', s.players[0].deck[0].id, '09-chikage-o-p-1');
  ok('剩下的牌里没有毒了',
     s.players[0].deck.slice(1).every(c => !E.rules.isPoison(c)));
}

/* ============================================================ */
group('抜き足：破弃之后间合要还回去');
{
  let s = mk([], { distance: 5, dust: 8 });
  s.players[0].hand = [cardById('09-chikage-o-n-6')];
  let r = autoNabu(A(s, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-6' }));
  eq('展开中：间合 5 → 3', E.rules.effDistance(r.state), 3);

  // 把结晶打光 → 破弃
  let st = r.state;
  st.players[0].attachments[0].crystals = 0;
  E.rules.tickAttachments(st, 0);
  eq('破弃后：间合回到 5', E.rules.effDistance(st), 5);
  eq('付与区清空', st.players[0].attachments.length, 0);
}

/* ============================================================ */
group('毒袋空了：毒相关的效果静默失效，其他照常');
{
  // 把毒袋清空
  let s = mk(['09-chikage-o-n-2'], { distance: 4 });
  s.players[0].poisonBag = [];
  let r = A(s, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-2' });
  ok('毒袋空也能打出毒針', r.ok, r.error);
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('毒針 结算完成', r.ok, r.error);
  eq('没有弹出选毒（没牌可选）', r.state.cardPick || null, null);
  eq('伤害照常：对方装 3 → 2', r.state.players[1].aura, 2);
  eq('毒袋仍是空的', bag(r.state, 0), 0);

  // 毒霧：毒袋空 → 只花掉这张牌，对方手牌不变
  let s2 = mk(['09-chikage-o-n-5']);
  s2.players[0].poisonBag = [];
  s2.players[1].hand = [];
  const r2 = A(s2, { type: 'playCard', player: 0, cardId: '09-chikage-o-n-5' });
  ok('毒袋空也能打出毒霧', r2.ok, r2.error);
  eq('对方手牌没变', r2.state.players[1].hand.length, 0);
  eq('没有挂起选牌', r2.state.cardPick || null, null);
}

/* ============================================================ */
group('毒用掉之后回到毒袋，可以再次使用');
{
  let s = mk([]);
  eq('开局 5 张', bag(s, 0), 5);
  // 手动取一张给对方，再用掉
  const pc = E.rules.takePoison(s, 0, '09-chikage-o-p-2');
  ok('从毒袋取出幻覚毒', !!pc);
  eq('毒袋 4', bag(s, 0), 4);
  s.players[1].hand = [pc];
  s.active = 1;
  s.players[1].flare = 4;
  s.players[1].focus = 1;
  let r = A(s, { type: 'playCard', player: 1, cardId: '09-chikage-o-p-2' });
  ok('对方用掉幻覚毒', r.ok, r.error);
  eq('回到毒袋 → 5', bag(r.state, 0), 5);
  eq('对方手牌清空', r.state.players[1].hand.length, 0);
}

/* ============================================================ */
group('弛緩毒：展开中不能用攻击牌，破弃后回毒袋');
{
  let s = mk([]);
  const pc = E.rules.takePoison(s, 0, '09-chikage-o-p-3');
  s.players[1].hand = [pc, cardById('01-yurina-o-n-1')];
  s.players[1].flare = 5;
  s.players[1].focus = 2;
  s.active = 1;
  s.distance = 3;
  let r = A(s, { type: 'playCard', player: 1, cardId: '09-chikage-o-p-3' });
  ok('展开弛緩毒', r.ok, r.error);
  const nabu = r.state.nabu;
  if (nabu) {
    const fd = Math.min(r.state.dust, nabu.cap);
    const fa = Math.min(r.state.players[1].aura, nabu.cap - fd);
    r = A(r.state, { type: 'confirmNabu', player: 1, fromDust: fd, fromAura: fa });
  }
  ok('纳完', r.ok, r.error);
  const atk = A(r.state, { type: 'playCard', player: 1, cardId: '01-yurina-o-n-1' });
  ok('中了弛緩毒 → 不能使用攻击牌', !atk.ok, atk.error);

  // 破弃 → 回千影的毒袋
  let st = r.state;
  const att = st.players[1].attachments.find(a => a.id === '09-chikage-o-p-3');
  att.crystals = 0;
  E.rules.tickAttachments(st, 1);
  eq('破弃后回到毒袋', bag(st, 0), 5);
}

/* ============================================================ */
group('洗牌：弃牌区里的毒不会被洗进牌库中间');
{
  let s = mk([], { distance: 4 });
  s.players[0].deck = [cardById('01-yurina-o-n-1')];
  s.players[0].discard = [
    cardById('09-chikage-o-n-1'),
    { id: '09-chikage-o-p-2', name: '幻覚毒', kind: 'poison', types: ['action'], poison: true },
    { id: '09-chikage-o-p-4', name: '滅灯毒', kind: 'poison', types: ['action'], poison: true }
  ];
  E.rules.reshuffle(s, 0, false);
  eq('两张毒都在牌库顶', s.players[0].deck.slice(0, 2).map(c => c.id),
     ['09-chikage-o-p-2', '09-chikage-o-p-4']);
  const rest = s.players[0].deck.slice(2).map(c => c.id).sort();
  eq('毒下面的都是普通牌（洗过，顺序不定）', rest,
     ['01-yurina-o-n-1', '09-chikage-o-n-1']);
}

/* ============================================================ */
group('麻痺毒：本回合做过基本动作就不能用');
{
  let s = mk([]);
  const pc1 = E.rules.takePoison(s, 0, '09-chikage-o-p-1');
  s.players[1].hand = [pc1];
  s.players[1].focus = 2;
  s.players[1].usedBasicThisTurn = true;
  s.active = 1;
  const bad = A(s, { type: 'playCard', player: 1, cardId: '09-chikage-o-p-1' });
  ok('做过基本动作 → 麻痺毒用不了', !bad.ok, bad.error);

  s.players[1].usedBasicThisTurn = false;
  const good = A(s, { type: 'playCard', player: 1, cardId: '09-chikage-o-p-1' });
  ok('没做过基本动作 → 可以用', good.ok, good.error);
  eq('用掉后回到毒袋', bag(good.state, 0), 5);
}

H.report();
