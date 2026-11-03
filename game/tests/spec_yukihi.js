/* ============================================================
 * spec_yukihi.js —— 雪姬（伞：闭 / 开）的白盒测试
 *
 *   node game/tests/spec_yukihi.js
 *
 * 覆盖：
 *   1. 伞模块本身（开局闭、开合、合并距离、文本）
 *   2. 11 张卡在「闭」「开」两种状态下的表现
 *   3. 结束阶段的开合流程（先伞 → 再盖牌 → 才换人）
 *   4. 对手没有雪姬时不受影响
 *   5. 结晶 / 卡牌守恒
 * ============================================================ */
const H = require('./harness');
const U = require('../../game/engine/umbrella.js');
const { E, ok, eq, group, report, cardById, autoNabu, endTurnAuto, cardTotal } = H;

/* ---------- 造局面的小工具 ---------- */
function yuki(handIds, opts) {
  opts = opts || {};
  const s = H.fresh(opts.me || 'yukihi', opts.opp || 'yurina');
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[0].goddesses = [opts.me || 'yukihi'];
  s.players[1].goddesses = [opts.opp || 'yurina'];
  s.players[0].hand = (handIds || []).map(cardById);
  if (opts.umbrella) s.players[0].umbrella = opts.umbrella;
  if (opts.distance !== undefined) s.distance = opts.distance;
  if (opts.aura !== undefined) s.players[0].aura = opts.aura;
  if (opts.dust !== undefined) s.dust = opts.dust;
  if (opts.flare !== undefined) s.players[0].flare = opts.flare;
  if (opts.focus !== undefined) s.players[0].focus = opts.focus;
  return s;
}
function A(s, a) { return E.actions.applyAction(s, a); }
/** 让当前玩家结束回合：伞 → 盖牌 → 换人，全部自动处理 */
function passTurn(s) {
  let r = A(s, { type: 'endTurn', player: s.active });
  if (!r.ok) return r;
  let st = r.state;
  if (st.umbrellaPending) {
    const u = A(st, { type: 'umbrella', player: st.umbrellaPending.who, open: null });
    if (u.ok) st = u.state;
  }
  if (st.endTurnPending) {
    const who = st.endTurnPending.who, need = st.endTurnPending.need;
    const ids = st.players[who].hand.slice(0, need).map(c => c.id);
    const c = A(st, { type: 'confirmEndTurn', player: who, cardIds: ids });
    if (c.ok) st = c.state;
  }
  return { ok: true, state: st };
}

function crystalTotal(s) {
  let n = s.distance + s.dust;
  s.players.forEach(p => { n += p.life + p.aura + p.flare; });
  return n;
}

/* ============================================================ */
group('伞：模块本身');
{
  const s = yuki([], {});
  eq('开局是「闭」', U.raw(s, 0), 'closed');
  ok('isClosed 为真', U.isClosed(s, 0));
  eq('中文标签', U.label(s, 0), '闭');

  const r = E.rules.toggleUmbrella(s, 0, '测试');
  eq('开合之后是「开」', U.raw(s, 0), 'open');
  eq('toggleUmbrella 的返回值', r, 'open');
  E.rules.toggleUmbrella(s, 0, '测试');
  eq('再开合一次回到「闭」', U.raw(s, 0), 'closed');

  // 合并距离：闭 4-6 + 开 0-2 → 0-6
  const n1 = cardById('06-yukihi-o-n-1');
  eq('合并距离 = 0-6', U.unionRange(n1), [0, 1, 2, 3, 4, 5, 6]);
  eq('距离文本', U.rangeText(U.unionRange(n1)), '0-6');
  eq('闭时的距离', U.viewOf(n1, false).range, [4, 5, 6]);
  eq('开时的距离', U.viewOf(n1, true).range, [0, 1, 2]);
  eq('闭时的伤害', U.viewOf(n1, false).damage, { aura: 3, life: 1 });
  eq('开时的伤害', U.viewOf(n1, true).damage, { aura: 1, life: 2 });
}

/* ============================================================ */
group('n-1 しこみばり／ふくみばり');
{
  // 闭：4-6 才能打，伤害 3/1
  let s = yuki(['06-yukihi-o-n-1'], { distance: 4 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-1' });
  ok('闭 / 间合 4 可以打出', r.ok, r.error);
  eq('闭的伤害 3/1', r.state.pending.damage, { aura: 3, life: 1 });

  // 闭：间合 2 打不到
  let s2 = yuki(['06-yukihi-o-n-1'], { distance: 2 });
  ok('闭 / 间合 2 打不到', !A(s2, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-1' }).ok);

  // 开：0-2 才能打，伤害 1/2
  let s3 = yuki(['06-yukihi-o-n-1'], { distance: 2, umbrella: 'open' });
  let r3 = A(s3, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-1' });
  ok('开 / 间合 2 可以打出', r3.ok, r3.error);
  eq('开的伤害 1/2', r3.state.pending.damage, { aura: 1, life: 2 });

  let s4 = yuki(['06-yukihi-o-n-1'], { distance: 4, umbrella: 'open' });
  ok('开 / 间合 4 打不到', !A(s4, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-1' }).ok);
}

/* ============================================================ */
group('n-2 しこみび／ねこだまし');
{
  // 闭：攻击后这张牌回手牌 + 开合伞
  let s = yuki(['06-yukihi-o-n-2'], { distance: 5 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-2' });
  ok('闭 / 5-6 打出', r.ok, r.error);
  eq('闭的伤害 1/1', r.state.pending.damage, { aura: 1, life: 1 });
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('攻击后：这张牌回到手牌', r.state.players[0].hand.length, 1);
  eq('攻击后：弃牌区没有它', r.state.players[0].discard.length, 0);
  eq('攻击后：伞变成「开」', r.state.players[0].umbrella, 'open');

  // 开：打完不回手、不开合
  let s2 = yuki(['06-yukihi-o-n-2'], { distance: 1, umbrella: 'open' });
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-2' });
  r2 = A(r2.state, { type: 'respond', player: 1, cardId: null });
  r2 = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('开：牌留在弃牌区', r2.state.players[0].discard.length, 1);
  eq('开：伞仍是「开」', r2.state.players[0].umbrella, 'open');
}

/* ============================================================ */
group('n-3 ふりはらい／たぐりよせ');
{
  // 闭：攻击后 虚⇄间合 1，自己选方向
  let s = yuki(['06-yukihi-o-n-3'], { distance: 4, dust: 4 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-3' });
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('闭：弹出方向选择', !!r.state.choice, r.state.choice);
  const before = r.state.distance;
  const r2 = A(r.state, { type: 'choose', player: 0, option: 'dust_to_dist' });
  eq('闭：虚 → 间合（间合 +1）', r2.state.distance, before + 1);

  // 开：攻击后 间合 → 虚 2
  let s2 = yuki(['06-yukihi-o-n-3'], { distance: 2, umbrella: 'open', dust: 4 });
  let q = A(s2, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-3' });
  q = A(q.state, { type: 'respond', player: 1, cardId: null });
  q = A(q.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('开：间合 2 → 0', q.state.distance, 0);
  eq('开：虚 4 → 6', q.state.dust, 6);
}

/* ============================================================ */
group('n-4 ふりまわし／つきさし（全力）');
{
  // 闭：4-6，5/-（气伤 5，命伤无）
  let s = yuki(['06-yukihi-o-n-4'], { distance: 5 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-4' });
  ok('闭 / 间合 5 打出', r.ok, r.error);
  eq('闭的伤害 5/-', r.state.pending.damage, { aura: 5, life: null });

  // 开：0-2，-/2
  let s2 = yuki(['06-yukihi-o-n-4'], { distance: 1, umbrella: 'open' });
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-4' });
  ok('开 / 间合 1 打出', r2.ok, r2.error);
  eq('开的伤害 -/2', r2.state.pending.damage, { aura: null, life: 2 });

  // 全力：用过之后不能再出牌
  let s3 = yuki(['06-yukihi-o-n-4', '06-yukihi-o-n-1'], { distance: 5 });
  let r3 = A(s3, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-4' });
  r3 = A(r3.state, { type: 'respond', player: 1, cardId: null });
  r3 = A(r3.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  const r4 = A(r3.state, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-1' });
  ok('全力之后不能再出牌', !r4.ok);
}

/* ============================================================ */
group('n-5 かさまわし（常时）');
{
  // 手里有它时，开合伞 → 虚 → 自装 1
  let s = yuki(['06-yukihi-o-n-5'], { dust: 4, aura: 2 });
  E.rules.toggleUmbrella(s, 0, '测试');
  eq('虚 4 → 3', s.dust, 3);
  eq('装 2 → 3', s.players[0].aura, 3);

  // 手里没有就不触发
  let s2 = yuki([], { dust: 4, aura: 2 });
  E.rules.toggleUmbrella(s2, 0, '测试');
  eq('没有这张牌：虚不变', s2.dust, 4);
}

/* ============================================================ */
group('n-6 ひきあし／もぐりこみ（行动＋对应）');
{
  // 闭：虚 → 间合 1
  let s = yuki(['06-yukihi-o-n-6'], { dust: 4, distance: 4 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-6' });
  ok('闭：打出', r.ok, r.error);
  eq('闭：间合 4 → 5', r.state.distance, 5);
  eq('闭：虚 4 → 3', r.state.dust, 3);

  // 开：间合 → 虚 1
  let s2 = yuki(['06-yukihi-o-n-6'], { dust: 4, distance: 4, umbrella: 'open' });
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-6' });
  eq('开：间合 4 → 3', r2.state.distance, 3);
  eq('开：虚 4 → 5', r2.state.dust, 5);

  // 它也能当对应用
  let s3 = yuki(['06-yukihi-o-n-1'], { distance: 5 });
  s3.players[1].hand = [cardById('06-yukihi-o-n-6')];
  s3.players[1].goddesses = ['yukihi'];
  s3.players[1].umbrella = 'closed';
  let r3 = A(s3, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-1' });
  const r4 = A(r3.state, { type: 'respond', player: 1, cardId: '06-yukihi-o-n-6' });
  ok('n-6 可以当对应', r4.ok, r4.error);
}

/* ============================================================ */
group('n-7 えんむすび（付与，箭头随伞反向）');
{
  // 闭：展开 间合→虚；破弃 虚→间合
  let s = yuki(['06-yukihi-o-n-7'], { dust: 6, distance: 5 });
  let r = autoNabu(A(s, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-7' }));
  ok('闭：展开付与', r.ok, r.error);
  eq('闭 展开：间合 5 → 4', r.state.distance, 4);

  let s2 = E.state.clone(r.state);
  s2.players[0].attachments[0].crystals = 0;
  E.rules.tickAttachments(s2, 0);
  eq('闭 破弃：间合 4 → 5', s2.distance, 5);

  // 开：展开 虚→间合；破弃 间合→虚
  let s3 = yuki(['06-yukihi-o-n-7'], { dust: 6, distance: 5, umbrella: 'open' });
  let r3 = autoNabu(A(s3, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-7' }));
  eq('开 展开：间合 5 → 6', r3.state.distance, 6);
  let s4 = E.state.clone(r3.state);
  s4.players[0].attachments[0].crystals = 0;
  E.rules.tickAttachments(s4, 0);
  eq('开 破弃：间合 6 → 5', s4.distance, 5);
}

/* ============================================================ */
group('s-1 はらりゆき（王牌）');
{
  // 闭：4-5、3/1，攻击后 +1 集中力
  let s = yuki([], { distance: 4, flare: 5, focus: 0 });
  s.players[0].specials = [Object.assign(cardById('06-yukihi-o-s-1'), { used: false })];
  let r = A(s, { type: 'playCard', player: 0, cardId: '06-yukihi-o-s-1' });
  ok('闭：打出', r.ok, r.error);
  eq('闭的伤害 3/1', r.state.pending.damage, { aura: 3, life: 1 });
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('攻击后 +1 集中力', r.state.players[0].focus, 1);

  // 开：0-2、0/0
  let s2 = yuki([], { distance: 1, flare: 5, umbrella: 'open' });
  s2.players[0].specials = [Object.assign(cardById('06-yukihi-o-s-1'), { used: false })];
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '06-yukihi-o-s-1' });
  eq('开的伤害 0/0', r2.state.pending.damage, { aura: 0, life: 0 });
}

/* ============================================================ */
group('s-2 ゆらりび（王牌）');
{
  // 闭：4-6 才能打，但伤害 0/0
  let s = yuki([], { distance: 5, flare: 6 });
  s.players[0].specials = [Object.assign(cardById('06-yukihi-o-s-2'), { used: false })];
  let r = A(s, { type: 'playCard', player: 0, cardId: '06-yukihi-o-s-2' });
  ok('闭：间合 5 打出（伤害 0/0）', r.ok, r.error);
  eq('闭的伤害 0/0', r.state.pending.damage, { aura: 0, life: 0 });

  // 开：只有间合 0 能打，伤害 4/5
  let s2 = yuki([], { distance: 0, flare: 6, umbrella: 'open' });
  s2.players[0].specials = [Object.assign(cardById('06-yukihi-o-s-2'), { used: false })];
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '06-yukihi-o-s-2' });
  ok('开：间合 0 打出', r2.ok, r2.error);
  eq('开的伤害 4/5', r2.state.pending.damage, { aura: 4, life: 5 });

  // 开：间合 1 打不到
  let s3 = yuki([], { distance: 1, flare: 6, umbrella: 'open' });
  s3.players[0].specials = [Object.assign(cardById('06-yukihi-o-s-2'), { used: false })];
  ok('开：间合 1 打不到', !A(s3, { type: 'playCard', player: 0, cardId: '06-yukihi-o-s-2' }).ok);
}

/* ============================================================ */
group('s-3 どろりうら（合并两种状态的距离）');
{
  // 展开之后，闭状态下的 n-1 应该能打到 0-6
  const s = yuki(['06-yukihi-o-n-1'], { distance: 2, dust: 10, aura: 5 });
  s.players[0].specials = [Object.assign(cardById('06-yukihi-o-s-3'), { used: false })];
  s.players[0].flare = 5;

  let r = A(s, { type: 'playCard', player: 0, cardId: '06-yukihi-o-s-3' });
  r = autoNabu(r);
  ok('どろりうら 展开', r.ok && !!r.state.players[0].attachments.length, r.error);

  // どろりうら 是《全力》：用完这一回合只能结束。过一回合再验证合并效果
  let st = r.state;
  st.players[0].hand = [cardById('06-yukihi-o-n-1')];
  const e1 = passTurn(st);
  const e2 = passTurn(e1.state);
  const sMerged = e2.state;
  eq('回到我的回合', sMerged.active, 0);
  eq('付与还在场上', sMerged.players[0].attachments.length, 1);

  // 现在闭状态下，间合 2 也能打出 n-1（原来是 4-6）
  sMerged.distance = 2;
  const r2 = A(sMerged, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-1' });
  ok('合并之后：闭状态下间合 2 也能打', r2.ok, r2.error);
  eq('伤害仍然是闭的 3/1（只合并距离，不改伤害）',
     r2.state && r2.state.pending && r2.state.pending.damage, { aura: 3, life: 1 });

  // 没有どろりうら 时打不到
  const s2 = yuki(['06-yukihi-o-n-1'], { distance: 2 });
  ok('没有合并时打不到', !A(s2, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-1' }).ok);
}

/* ============================================================ */
group('s-4 くるりみ（王牌：开合 + 虚→自装）');
{
  const s = yuki([], { dust: 4, aura: 2, flare: 2 });
  s.players[0].specials = [Object.assign(cardById('06-yukihi-o-s-4'), { used: false })];
  const r = A(s, { type: 'playCard', player: 0, cardId: '06-yukihi-o-s-4' });
  ok('くるりみ 打出', r.ok, r.error);
  eq('伞被撑开', r.state.players[0].umbrella, 'open');
  // 付 1 点气 → 虚 +1；くるりみ 再 虚 -1 → 净不变
  eq('虚：付费用 +1、效果 -1 → 仍是 4', r.state.dust, 4);
  eq('装 2 → 3', r.state.players[0].aura, 3);
}

/* ============================================================ */
group('结束阶段：先伞，再盖牌，最后才换人');
{
  // 没有雪姬的牌组不受影响：endTurn 直接换人
  let plain = H.fresh('yurina', 'saine');
  plain.active = 0; plain.players[0].firstTurnDone = true;
  plain.players[0].hand = [];
  const rp = A(plain, { type: 'endTurn', player: 0 });
  ok('普通牌组：直接结束回合', rp.ok && !rp.state.umbrellaPending, rp.error);

  // 有雪姬：先挂起伞
  let s = yuki(['06-yukihi-o-n-1'], { distance: 4 });
  s.players[0].hand = [];
  let r = A(s, { type: 'endTurn', player: 0 });
  ok('雪姬：结束回合时先问伞', r.ok && !!r.state.umbrellaPending, r.error);
  eq('此时还没换人', r.state.active, 0);
  eq('伞还没变', r.state.players[0].umbrella, 'closed');

  // 伞没处理完之前，别的动作都不许
  const blocked = A(r.state, { type: 'basic', player: 0, which: 'charge' });
  ok('伞没处理完：其他动作被拒', !blocked.ok);
  const blocked2 = A(r.state, { type: 'endTurn', player: 0 });
  ok('伞没处理完：不能再次结束回合', !blocked2.ok);

  // 选择不变
  const keep = A(r.state, { type: 'umbrella', player: 0, open: null });
  ok('选择「保持不变」', keep.ok, keep.error);
  eq('伞仍是闭', keep.state.players[0].umbrella, 'closed');
  eq('处理完就换人了', keep.state.active, 1);

  // 选择撑开
  let s2 = yuki([], { distance: 4 });
  s2.players[0].hand = [];
  let r2 = A(s2, { type: 'endTurn', player: 0 });
  const sw = A(r2.state, { type: 'umbrella', player: 0, open: true });
  ok('选择「撑开」', sw.ok, sw.error);
  eq('伞变成开', sw.state.players[0].umbrella, 'open');

  // 每回合只有一次：换回来的时候又会问
  eq('下一位玩家是对方', sw.state.active, 1);
}

/* ============================================================ */
group('守恒');
{
  let s = yuki(['06-yukihi-o-n-1', '06-yukihi-o-n-3'], { distance: 4, dust: 5 });
  const cards0 = cardTotal(s), crys0 = crystalTotal(s);
  let turn = 0;
  for (let i = 0; i < 6; i++) {
    const r = endTurnAuto(s);
    if (!r.ok) break;
    let st = r.state;
    if (st.umbrellaPending) {
      const u = A(st, { type: 'umbrella', player: st.umbrellaPending.who, open: null });
      if (u.ok) st = u.state;
    }
    s = st; turn++;
  }
  eq('打了几回合', turn > 0, true);
  eq('卡牌总数不变', cardTotal(s), cards0);
  eq('结晶总数不变', crystalTotal(s), crys0);
}

/* ============================================================ */
group('规则 5-8-3-2：伤害只有一边有数字时不能挑');
{
  // ふりまわし（闭 5/-）：命伤是「-」→ 只能吃装伤；装不够也照吃（5-10 尽量扣）
  const s = yuki(['06-yukihi-o-n-4'], { distance: 5 });
  s.players[1].aura = 2;                    // 对方只有 2 点装
  let r = A(s, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-4' });
  ok('打出 5/-', r.ok, r.error);
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  const life = A(r.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('没有命伤 → 不能选「命」', !life.ok, life.error);

  const aura = A(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('只能选「装」，而且能结算（不会卡死）', aura.ok, aura.error);
  eq('装被打空（只扣得掉 2）', aura.state.players[1].aura, 0);
  eq('命没动（这条没有命伤）', aura.state.players[1].life, 10);
  eq('攻击结算完了', aura.state.pending, null);

  // 两边都有数字时，装不够仍然不能选装
  const s2 = yuki(['06-yukihi-o-n-1'], { distance: 4 });  // 3/1
  s2.players[1].aura = 2;
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '06-yukihi-o-n-1' });
  r2 = A(r2.state, { type: 'respond', player: 1, cardId: null });
  const bad = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('3/1 且装只有 2 → 不能选装', !bad.ok, bad.error);
  const good = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('改选「命」可以', good.ok, good.error);
  eq('命 10 → 9', good.state.players[1].life, 9);
}

H.report();
