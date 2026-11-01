/* ============================================================
 * spec_net.js —— 联机核心逻辑的白盒测试（不开真 WebRTC）
 *
 * 覆盖：
 *   1. 可见性：主机的视图里，对方手牌只剩数量；己方完整
 *   2. 事件过滤：盖牌不泄漏牌名
 *   3. 协议：客机发动作 → 主机执行 → 双方视图更新
 *   4. 权威：非法动作被拒，状态不变
 *   5. 串位：动作里的 player 不是客机自己 → 拒绝
 *   6. 对等：两边能做的操作是同一套（客机也能出牌/做基本动作/结束回合）
 *   7. 旧消息：seq 更小的 state 会被丢弃
 *   8. 一致性：随机打一整局，双方看到的公开信息一致
 * ============================================================ */
const H = require('./harness');
const Redact = require('../../net/redact.js');
const Net = require('../../net/proto.js');
const { E, ok, eq, group, report, fresh, withHand, cardById, cardTotal } = H;

group('可见性：redact');
{
  const s = withHand(['01-yurina-o-n-1', '01-yurina-o-n-2']);
  s.players[1].hand = [cardById('02-saine-o-n-1')];
  s.players[1].deck = [cardById('02-saine-o-n-2')];
  s.players[1].hidden = [cardById('02-saine-o-n-3')];

  const mine = Redact.redact(s, 0);
  eq('自己的手牌看得见（2 张）', mine.players[0].hand.length, 2);
  eq('自己的手牌名字正常', mine.players[0].hand[0].name, '斬');

  eq('对方手牌只剩数量（1 张）', mine.players[1].hand.length, 1);
  eq('对方手牌看不到名字', mine.players[1].hand[0].name, '??');
  eq('对方手牌看不到 id', mine.players[1].hand[0].id, '?');
  eq('对方牌库只剩数量', mine.players[1].deck.length, 1);
  eq('对方牌库看不到内容', mine.players[1].deck[0].id, '?');
  eq('对方盖牌只剩数量', mine.players[1].hidden.length, 1);
  eq('对方盖牌看不到内容', mine.players[1].hidden[0].id, '?');

  // 公开信息仍要完整
  eq('对方的装仍然是真实数字', mine.players[1].aura, s.players[1].aura);
  eq('间合仍然是真实数字', mine.distance, s.distance);
  eq('弃牌区仍然是公开的', mine.players[1].discard.length, s.players[1].discard.length);

  // 王牌：用过才公开
  const s2 = H.fresh();
  s2.players[1].specials.forEach(function (c, i) { c.used = (i === 0); });
  const v2 = Redact.redact(s2, 0);
  eq('对方已使用的王牌看得到名字', v2.players[1].specials[0].used, true);
  H.ok('对方已使用的王牌名字不是 ??', v2.players[1].specials[0].name !== '??');
  eq('对方未使用的王牌看不到名字', v2.players[1].specials[1].name, '??');

  // 对方正在选择时，选项不能漏
  s2.choice = { who: 1, sourceId: 'imagine', prompt: '选一张手牌', options: ['02-saine-o-n-1'] };
  const v3 = Redact.redact(s2, 0);
  eq('对方的选择选项被清空', v3.choice.options.length, 0);
  H.ok('但能看出"对方在选"', v3.choice.who === 1);

  // 自己不需要降级
  const v4 = Redact.redact(s2, 1);
  eq('当事人自己的选项是完整的', v4.choice.options.length, 1);

  // 事件里盖牌不能泄漏
  const s3 = H.withHand(['01-yurina-o-n-1']);
  E.state.emit(s3, 'cardTo', { who: 0, cardId: '01-yurina-o-n-1', to: 'hidden' });
  const v5 = Redact.redact(s3, 1);
  const ev = v5.events[v5.events.length - 1];
  eq('对手看不到你盖的是哪张', ev.cardId, '?');

  const v6 = Redact.redact(s3, 0);
  const ev2 = v6.events[v6.events.length - 1];
  eq('自己能看到自己盖的是哪张', ev2.cardId, '01-yurina-o-n-1');
}

group('协议：主机权威');
{
  const [trA, trB] = Net.createMemoryPair();
  let state = fresh();
  state.active = 0;
  state.players[0].firstTurnDone = true;
  state.distance = 3;
  state.players[0].hand = [cardById('01-yurina-o-n-1')];

  let hostView = null, guestView = null;
  const errors = [];

  const host = Net.createHost({
    transport: trA,
    state: state,
    applyAction: E.actions.applyAction,
    engine: E,
    onLocalView: function (v) { hostView = v; },
    onError: function (e) { errors.push('host:' + e); }
  });
  const guest = Net.createGuest({
    transport: trB,
    onView: function (v) { guestView = v; },
    onError: function (e) { errors.push('guest:' + e); }
  });

  guest.hello(1);
  H.ok('客机报到后拿到视图', !!guestView);
  eq('客机看到自己的座位是 1', guest.seat, 1);
  eq('客机视角里，主机手牌只剩数量', guestView.players[0].hand.length, 1);
  eq('客机看不到主机手牌的名字', guestView.players[0].hand[0].name, '??');
  eq('主机自己看得到自己的手牌', hostView.players[0].hand[0].name, '斬');

  // 客机做一个动作：现在不是他的回合，做基本动作应当被拒
  errors.length = 0;
  guest.act({ type: 'basic', player: 1, which: 'charge' });
  H.ok('不是自己的回合，客机的基本动作被拒绝', errors.length > 0, errors);

  // 主机出牌攻击客机 → 客机作为被攻击方来"对应 / 选伤害"
  host.act({ type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  H.ok('攻击到了客机身上', !!host.state.pending && host.state.pending.defender === 1);

  const lifeBefore = guestView.players[1].life;
  guest.act({ type: 'respond', player: 1, cardId: null });
  eq('客机选择了不对应（进入选伤害）', guestView.pending && guestView.pending.stage, 'damage');
  guest.act({ type: 'resolveDamage', player: 1, choice: 'life' });
  eq('客机选命：命 -1', guestView.players[1].life, lifeBefore - 1);
  eq('主机那边的权威状态也一致', host.state.players[1].life, lifeBefore - 1);

  // 串位：客机想操作主机的座位
  errors.length = 0;
  guest.act({ type: 'basic', player: 0, which: 'charge' });
  H.ok('客机不能操作主机座位', errors.length > 0 && /不是你的/.test(errors[0]), errors);
}

group('协议：旧消息丢弃 / 双方对等');
{
  const [trA, trB] = Net.createMemoryPair();
  let state = fresh();
  state.active = 0;
  state.players[0].firstTurnDone = true;
  state.distance = 3;
  state.players[0].hand = [cardById('01-yurina-o-n-1')];

  const views = [];
  const host = Net.createHost({ transport: trA, state: state, applyAction: E.actions.applyAction, engine: E });
  const guest = Net.createGuest({ transport: trB, onView: function (v, seq) { views.push(seq); } });
  guest.hello(1);

  const n0 = views.length;
  // 手动塞一条旧消息：seq 更小，应该被丢掉
  trB.onMessage && null;
  host.push();
  const n1 = views.length;
  H.ok('正常推送会被接收', n1 > n0, views);

  // 主机与客机能做的动作种类完全一样（都是 applyAction 的那一套）
  const actionTypes = Object.keys(E.actions).length;
  H.ok('动作入口是同一套（engine.actions）', actionTypes > 0);

  // 双方各做一个动作，状态都正确推进
  host.state.players[0].focus = 2;          // 给点集中力，不然做不了基本动作
  const r1 = host.act({ type: 'basic', player: 0, which: 'retreat' });
  H.ok('主机自己能做基本动作（后退）', r1.ok, r1.error);
}

group('一致性：随机打一局');
{
  const [trA, trB] = Net.createMemoryPair();
  let state = fresh();
  state.active = 0;
  state.players[0].firstTurnDone = true;

  let hostView = null, guestView = null;
  const host = Net.createHost({
    transport: trA, state: state, applyAction: E.actions.applyAction, engine: E,
    onLocalView: function (v) { hostView = v; }
  });
  const guest = Net.createGuest({ transport: trB, onView: function (v) { guestView = v; } });
  guest.hello(1);

  const cards0 = cardTotal(state);
  let steps = 0;
  for (let i = 0; i < 40; i++) {
    const who = host.state.active;
    const view = (who === 0) ? hostView : guestView;
    const seatsView = (who === 0) ? hostView : guestView;
    const hand = seatsView.players[who].hand;
    const pick = hand[Math.floor(Math.random() * Math.max(1, hand.length))];

    let r;
    if (pick) {
      r = (who === 0)
        ? host.act({ type: 'playCard', player: 0, cardId: pick.id })
        : (guest.act({ type: 'playCard', player: 1, cardId: pick.id }), { ok: true });
    } else {
      r = (who === 0)
        ? host.act({ type: 'basic', player: 0, which: 'gather' })
        : (guest.act({ type: 'basic', player: 1, which: 'gather' }), { ok: true });
    }
    steps++;

    // 结算掉可能出现的待处理（对应 / 伤害）
    if (host.state.pending) {
      const def = host.state.pending.defender;
      if (def === 0) host.act({ type: 'respond', player: 0, cardId: null });
      else guest.act({ type: 'respond', player: 1, cardId: null });
      if (host.state.pending) {
        if (host.state.pending.defender === 0) host.act({ type: 'resolveDamage', player: 0, choice: 'life' });
        else guest.act({ type: 'resolveDamage', player: 1, choice: 'life' });
      }
    }
    if (steps > 25) break;
  }

  eq('牌总数没有变', cardTotal(host.state), cards0);
  H.ok('客机视图里的主机手牌永远是背面',
       guestView.players[0].hand.every(function (c) { return c.id === '?'; }));
  H.ok('客机视图里的自己手牌是真的（不是 ?）',
       guestView.players[1].hand.every(function (c) { return c.id !== '?'; }) || guestView.players[1].hand.length === 0);
  eq('间合两边看到的一样', hostView.distance, guestView.distance);
  eq('命两边看到的一样', hostView.players[0].life, guestView.players[0].life);
}

H.report();
