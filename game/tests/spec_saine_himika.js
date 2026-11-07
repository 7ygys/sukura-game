/* ============================================================
 * tests/spec_saine_himika.js
 * 细音（薙刀 saine）11 张 + 绯弥香（铳 himika）11 张的白盒测试。
 *
 * 跑：node game/tests/spec_saine_himika.js
 *
 * 约定
 *   1. 每条断言都用中文写清「对应卡面上的哪句话 / 哪个数字」
 *   2. 每张卡至少两条：条件满足 → 效果正确；条件不满足 → 效果不发生 / 不能使用
 *   3. 卡面是唯一真相。引擎与卡面不符时**保留会失败的断言**，
 *      在断言名里写「【期望】… 【实际】…」，方便直接看出 bug
 *   4. 状态里 players[0] = P1、players[1] = P2（和引擎日志编号一致）
 *   5. fresh() 的先手是随机的，所以 setup() 会把「谁先手 / 谁过了第一个回合」
 *      显式写死，避免测试"时灵时不灵"
 *
 * 已知的引擎问题（本文件里**故意保留 4 条会失败的断言**，修好后它们会自动变绿）
 *   ① 律動弧戟：某一段打不到时，后面的段不再继续，而且攻击队列会残留下来；
 *      队列残留会让之后一次毫不相关的攻击莫名其妙多打一发「律動弧戟③ 2/2」
 *   ② バックドラフト：卡面是「他のメガミによる《攻撃》」，
 *      但 rules.js 里的判定是硬编码 `g !== 'yurina'`，所以同一女神（绯弥香）的攻击也吃加成
 *   ③ バックドラフト：卡面写「このターン」，加成却没在回合结束时清掉，会留到下一回合
 *      （気迫 用的是同一个字段 nextOtherAttack，同样会残留）
 *   ④ 待确认（低优先级，未写成失败断言）
 *      - 衝音晶【破弃时】：引擎先做「虚→间合」再生成攻击，卡面文字顺序是反的
 *        （适正 0-10，顺序不影响命中，只是实现细节）
 *      - クリムゾンゼロ的「間合 0」判的是 state.distance，不是 effDistance
 *        （含 distanceMod 的「现在的间合」）；目前没有卡设置 distanceMod，属潜在不一致
 * ============================================================ */
const H = require('./harness');
const { E, ok, eq, group, report, fresh, withHand, cardById, autoNabu, cardTotal, settleResponse } = H;

/** 做动作（内部会 clone），成功返回新状态 */
function doAct(s, action) {
  const r = E.actions.applyAction(s, action);
  return r.ok ? r.state : s;
}
const A = E.actions.applyAction;

/** 造局面：P1 行动、P1 已过完第一个回合（照常抽牌/涨集中力），P2 还没进第一个回合 */
function setup(cards, opt) {
  opt = opt || {};
  const s = withHand(cards || []);
  s.players[1].firstTurnDone = false;
  s.players[0].focus = opt.focus === undefined ? 2 : opt.focus;
  s.players[1].focus = 0;
  if (opt.distance !== undefined) s.distance = opt.distance;
  if (opt.dust !== undefined) s.dust = opt.dust;
  if (opt.aura !== undefined) s.players[0].aura = opt.aura;
  return s;
}

/** 王牌放进「王牌区」（带 used 标记） */
function spec(id, used) {
  return Object.assign(cardById(id), { used: !!used });
}

/** 展开付与牌并自动分配「纳」（先虚后装），返回新状态 */
function expand(s, who, cardId) {
  const r = autoNabu(A(s, { type: 'playCard', player: who, cardId: cardId }));
  return r.state;
}

/* ============================================================
 * 一、薙刀 · 细音（saine）
 * ============================================================ */

/* ---------- 1. 八方振り ---------- */
group('八方振り（02-saine-o-n-1）· 八相时【攻击后】追加一发 4-5 / 2-1');
{
  // 条件满足：自装 1（八相）→ 主攻击打完再打一发
  let s = setup(['02-saine-o-n-1'], { distance: 4, aura: 1 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-1' });
  ok('主攻击（适正 4-5）可以打出', r.ok, r.error);
  eq('主攻击伤害 2/1', r.state.pending.damage, { aura: 2, life: 1 });
  s = doAct(r.state, { type: 'respond', player: 1, cardId: null });
  s = doAct(s, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('八相：主攻击结算后追加了一次攻击', !!s.pending, s.pending);
  eq('追加攻击的伤害也是 2/1', s.pending && s.pending.damage, { aura: 2, life: 1 });
  eq('追加攻击的适正距离是 4-5', s.pending && s.pending.range, [4, 5]);
  eq('追加攻击是完整攻击：还要对手处理对应', s.pending && s.pending.stage, 'respond');
  s = doAct(s, { type: 'respond', player: 1, cardId: null });
  s = doAct(s, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('两发各 1 点命伤：对手命 10→8', s.players[1].life, 8);

  // 条件不满足：自装 2（非八相）→ 没有追加攻击
  let t = setup(['02-saine-o-n-1'], { distance: 4, aura: 2 });
  let r2 = A(t, { type: 'playCard', player: 0, cardId: '02-saine-o-n-1' });
  ok('非八相也能打出主攻击', r2.ok, r2.error);
  t = doAct(r2.state, { type: 'respond', player: 1, cardId: null });
  t = doAct(t, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('非八相：主攻击结算后没有追加攻击', t.pending, null);
  eq('非八相：对手只掉 1 点命', t.players[1].life, 9);
}

/* ---------- 2. 薙斬り ---------- */
group('薙斬り（02-saine-o-n-2）· 攻击 + 对应；对应时被对应的攻击不变');
{
  let s = setup(['02-saine-o-n-2'], { distance: 4 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-2' });
  ok('间合 4 可以主动打出', r.ok, r.error);
  eq('伤害 3/1', r.state.pending.damage, { aura: 3, life: 1 });

  // 对应：距离在 4-5 内可以割入；卡面没有减伤文字
  let t = setup(['01-yurina-o-n-1'], { distance: 4 });     // 斬 3-4 / 3-1
  t.players[1].hand = [cardById('02-saine-o-n-2')];
  let r1 = A(t, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  let r2 = A(r1.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-2' });
  ok('间合 4 在 4-5 内：可以拿薙斬り当对应', r2.ok, r2.error);
  r2 = settleResponse(r2);
  eq('卡面只有「可割入使用」，没有减伤 → 被对应的攻击仍是 3/1', r2.state.pending.damage, { aura: 3, life: 1 });
  eq('对应用的薙斬り进弃牌区', r2.state.players[1].discard.map(c => c.id), ['02-saine-o-n-2']);

  // 条件不满足：间合 3 不在 4-5 → 不能这样对应
  let u = setup(['01-yurina-o-n-1'], { distance: 3 });
  u.players[1].hand = [cardById('02-saine-o-n-2')];
  let r3 = A(u, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  let r4 = A(r3.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-2' });
  ok('间合 3 不在 4-5：不能拿薙斬り当对应', !r4.ok, r4.error);
  eq('被拒绝后牌还在手上', r4.state.players[1].hand.map(c => c.id), ['02-saine-o-n-2']);
}

/* ---------- 3. 石突 ---------- */
group('石突（02-saine-o-n-3）· 对应时先打自己 2-3/2-1，再结算原攻击');
{
  // 条件满足：间合 3（既在石突的 2-3，也在原攻击的 3-4 内）
  let s = setup(['01-yurina-o-n-1'], { distance: 3, dust: 2, aura: 1 });
  s.players[1].hand = [cardById('02-saine-o-n-3')];
  s.players[1].aura = 1;                                   // 八相
  let r = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('原攻击（斬 3-4）打出', r.ok, r.error);
  let r2 = A(r.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-3' });
  ok('间合 3 在 2-3 内：石突可以当对应', r2.ok, r2.error);
  eq('对应时先打出石突自己的 2/1', r2.state.pending.damage, { aura: 2, life: 1 });
  eq('这一发由持有石突的一方打出', r2.state.pending.attacker, 1);
  eq('原攻击被压栈，等石突打完再接回来', (r2.state.attackStack || []).length, 1);

  let s3 = doAct(r2.state, { type: 'respond', player: 0, cardId: null });
  s3 = doAct(s3, { type: 'resolveDamage', player: 0, choice: 'life' });
  eq('石突【攻击后】八相：虚→间合 1 颗（间合 3→4）', s3.distance, 4);
  eq('虚 2→1', s3.dust, 1);
  eq('石突打完后原攻击接回来继续结算', s3.pending && s3.pending.cardId, '01-yurina-o-n-1');
  eq('接回来的原攻击已经过了对应时机', s3.pending && s3.pending.stage, 'damage');
  eq('石突的 1 点命伤由 P1 承受（10→9）', s3.players[0].life, 9);
  let s4 = doAct(s3, { type: 'resolveDamage', player: 1, choice: 'life' });   // 原攻击的受害者是 P2
  eq('接回来的原攻击也照常命中 P2（10→9）', s4.players[1].life, 9);

  // 条件不满足：间合 5 不在 2-3 → 不能拿它当对应
  let t = setup([], { distance: 5 });
  t.players[0].specials = [spec('03-himika-o-s-1', false)];  // レッドバレット 5-10
  t.players[1].hand = [cardById('02-saine-o-n-3')];
  t.players[1].aura = 1;
  let r3 = A(t, { type: 'playCard', player: 0, cardId: '03-himika-o-s-1' });
  let r4 = A(r3.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-3' });
  ok('间合 5 不在 2-3：不能拿石突当对应', !r4.ok, r4.error);

  // 主动打出：2-3 / 2-1，八相时【攻击后】虚→间合
  let v = setup(['02-saine-o-n-3'], { distance: 2, dust: 2, aura: 1 });
  let r5 = A(v, { type: 'playCard', player: 0, cardId: '02-saine-o-n-3' });
  ok('主动打出石突', r5.ok, r5.error);
  eq('伤害 2/1', r5.state.pending.damage, { aura: 2, life: 1 });
  let v2 = doAct(r5.state, { type: 'respond', player: 1, cardId: null });
  v2 = doAct(v2, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('八相【攻击后】间合 2→3', v2.distance, 3);
  eq('八相【攻击后】虚 2→1', v2.dust, 1);

  // 条件不满足（非八相）：结晶一颗都不动
  let w = setup(['02-saine-o-n-3'], { distance: 2, dust: 3, aura: 2 });
  let r6 = A(w, { type: 'playCard', player: 0, cardId: '02-saine-o-n-3' });
  let w2 = doAct(r6.state, { type: 'respond', player: 1, cardId: null });
  w2 = doAct(w2, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('非八相：间合不变', w2.distance, 2);
  eq('非八相：虚不变', w2.dust, 3);
}

/* ---------- 4. 見切り ---------- */
group('見切り（02-saine-o-n-4）· 只有八相能当对应；间合(1) ⇔ 虚 二选一');
{
  // 主动使用：弹出方向选择
  let s = setup(['02-saine-o-n-4'], { distance: 5, dust: 3 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-4' });
  ok('可以当行动牌打出', r.ok, r.error);
  eq('弹出「间合⇔虚」的方向选择', r.state.choice && r.state.choice.sourceId, 'mikiri');
  eq('两个方向都在选项里', r.state.choice && r.state.choice.options, ['dist_to_dust', 'dust_to_dist']);
  let a = doAct(r.state, { type: 'choose', player: 0, option: 'dist_to_dust' });
  eq('间合→虚：间合 5→4', a.distance, 4);
  eq('间合→虚：虚 3→4', a.dust, 4);
  let b = doAct(r.state, { type: 'choose', player: 0, option: 'dust_to_dist' });
  eq('虚→间合：虚 3→2', b.dust, 2);
  eq('虚→间合：间合 5→6', b.distance, 6);

  // 条件满足（八相）：可以割入当对应，并把攻击挤到打不到
  let t = setup(['01-yurina-o-n-1'], { distance: 3, dust: 4 });
  t.players[1].hand = [cardById('02-saine-o-n-4')];
  t.players[1].aura = 1;
  let r1 = A(t, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  let r2 = A(r1.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-4' });
  ok('八相：没有《对应》类型的見切り也能割入', r2.ok, r2.error);
  let c = doAct(r2.state, { type: 'choose', player: 1, option: 'dist_to_dust' });
  eq('对应时把间合 3→2', c.distance, 2);
  eq('斬 的适正距离是 3-4 → 间隔被改后落空', c.pending, null);
  eq('落空后 P1 一点命都没掉', c.players[0].life, 10);

  // 条件不满足（非八相）：不能当对应
  let u = setup(['01-yurina-o-n-1'], { distance: 3 });
  u.players[1].hand = [cardById('02-saine-o-n-4')];
  u.players[1].aura = 2;
  let r3 = A(u, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  let r4 = A(r3.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-4' });
  ok('非八相：見切り没有《对应》，不能用', !r4.ok, r4.error);

  // 边界：虚 0 时选「虚→间合」什么都不会发生
  let v = setup(['02-saine-o-n-4'], { distance: 5, dust: 0 });
  let r5 = A(v, { type: 'playCard', player: 0, cardId: '02-saine-o-n-4' });
  let v2 = doAct(r5.state, { type: 'choose', player: 0, option: 'dust_to_dist' });
  eq('虚 0：间合不动', v2.distance, 5);
  eq('虚 0：虚也不会变成负数', v2.dust, 0);
}

/* ---------- 5. 圏域 ---------- */
group('圏域（02-saine-o-n-5）· 达人距离 +1；本该进虚的结晶改为进间合');
{
  let s = setup(['02-saine-o-n-5'], { distance: 6, dust: 2, aura: 0 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-5' });
  ok('可以准备展开（纳 2）', r.ok && !!r.state.nabu, r.error);
  let r2 = A(r.state, { type: 'confirmNabu', player: 0, fromDust: 2, fromAura: 0 });
  ok('纳 2 展开成功', r2.ok, r2.error);
  let st = r2.state;
  eq('付与札上有 2 颗结晶', st.players[0].attachments[0].crystals, 2);
  eq('达人距离 2→3', E.rules.taijinOf(st), 3);

  // 达人距离真的影响「前进」：间合 3 时前进被挡
  let withK = E.state.clone(st); withK.distance = 3; withK.players[0].focus = 2;
  ok('有圏域：间合 3 = 达人距离 3，不能前进', !A(withK, { type: 'basic', player: 0, which: 'advance' }).ok);
  let noK = E.state.clone(st);
  noK.players[0].attachments = []; noK.distance = 3; noK.players[0].focus = 2;
  ok('没有圏域：间合 3 > 达人距离 2，可以前进', A(noK, { type: 'basic', player: 0, which: 'advance' }).ok);

  // 回合开始的损耗：结晶进间合而不是进虚
  let before = { d: st.distance, du: st.dust };
  E.rules.tickAttachments(st, 0);
  eq('结晶改为送进间合（6→7）', st.distance, before.d + 1);
  eq('虚没有增加', st.dust, before.du);
  eq('付与札上 2→1', st.players[0].attachments[0].crystals, 1);

  // 间合已满：结晶留在牌上（规则 10-42）
  let full = setup(['02-saine-o-n-5'], { distance: 10, dust: 2, aura: 0 });
  let f = expand(full, 0, '02-saine-o-n-5');
  E.rules.tickAttachments(f, 0);
  eq('间合已满：结晶留在牌上（还是 2 颗）', f.players[0].attachments[0].crystals, 2);
  eq('间合已满：间合还是 10', f.distance, 10);
  eq('间合已满：牌没有破弃', f.players[0].discard.length, 0);

  // 条件不满足：虚+装 凑不出纳 2
  let poor = setup(['02-saine-o-n-5'], { distance: 6, dust: 1, aura: 0 });
  ok('结晶不够放纳 2：不能展开', !A(poor, { type: 'playCard', player: 0, cardId: '02-saine-o-n-5' }).ok);
}

/* ---------- 6. 衝音晶 ---------- */
group('衝音晶（02-saine-o-n-6）· 对应 -1/+0；破弃时 1/- 攻击 + 虚→间合');
{
  // 对应时：被对应的攻击 -1/+0
  let s = setup(['01-yurina-o-n-1'], { distance: 3, dust: 3 });
  s.players[1].hand = [cardById('02-saine-o-n-6')];
  let r1 = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  let r2 = A(r1.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-6' });
  ok('衝音晶可以当对应', r2.ok, r2.error);
  r2 = settleResponse(r2);
  eq('被对应的攻击 -1/+0 → 2/1', r2.state.pending.damage, { aura: 2, life: 1 });
  // 付与牌当对应使用 → 也要展开到付与区（规则 9-2-3）
  eq('当对应时会展开到付与区', r2.state.players[1].attachments.length, 1);
  eq('付与区里是衝音晶', r2.state.players[1].attachments[0].id, '02-saine-o-n-6');
  eq('没有进弃牌区', r2.state.players[1].discard.length, 0);

  // 破弃时：1/- 攻击 + 虚→间合 1 颗
  let t = setup(['02-saine-o-n-6'], { distance: 3, dust: 1, aura: 0 });
  let tb = expand(t, 0, '02-saine-o-n-6');
  eq('纳 1 展开', tb.players[0].attachments[0].crystals, 1);
  E.rules.tickAttachments(tb, 0);
  eq('结晶耗尽 → 破弃（离开付与区）', tb.players[0].attachments.length, 0);
  eq('【破弃时】虚→间合 1 颗（3→4）', tb.distance, 4);
  ok('【破弃时】生成了一次攻击', !!tb.pending, tb.pending);
  eq('伤害是 1/-（只能选装）', tb.pending && tb.pending.damage, { aura: 1, life: null });
  eq('这次攻击「对应不可」', tb.pending && tb.pending.noRespond, true);
  eq('适正距离 0-10', tb.pending && tb.pending.range, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // 「对应不可」的验证放在副本上做，免得改坏后面要断言的真装数值
  let probe = E.state.clone(tb);
  probe.players[1].aura = 1;                                  // 八相，本来能拿見切り 对应
  probe.players[1].hand = [cardById('02-saine-o-n-4')];
  let nr = A(probe, { type: 'respond', player: 1, cardId: '02-saine-o-n-4' });
  ok('「对应不可」：连見切り 也对应不了', !nr.ok, nr.error);
  tb = doAct(tb, { type: 'respond', player: 1, cardId: null });
  let bad = A(tb, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('没有命伤：不能选「命」', !bad.ok, bad.error);
  let good = A(tb, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('选「装」正常结算', good.ok, good.error);
  eq('对手装 3→2', good.state.players[1].aura, 2);
  eq('对手命不变', good.state.players[1].life, 10);
}

/* ---------- 7. 無音壁 ---------- */
group('無音壁（02-saine-o-n-7）· 牌上的结晶视为装、装伤由玩家分配、全力');
{
  let s = setup(['02-saine-o-n-7'], { distance: 7, dust: 5, aura: 3 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-7' });
  ok('可以准备展开（纳 5）', r.ok && !!r.state.nabu, r.error);
  let st = expand(s, 0, '02-saine-o-n-7');
  eq('牌上有 5 颗结晶', st.players[0].attachments[0].crystals, 5);
  eq('真装没被动过（还是 3）', st.players[0].aura, 3);

  // 全力：展开后本回合只能结束回合
  let fp = E.state.clone(st);
  fp.players[0].hand = [cardById('02-saine-o-n-4')];
  ok('全力：不能再打别的牌', !A(fp, { type: 'playCard', player: 0, cardId: '02-saine-o-n-4' }).ok);
  ok('全力：不能做基本动作', !A(fp, { type: 'basic', player: 0, which: 'charge' }).ok);
  ok('全力：可以结束回合', A(fp, { type: 'endTurn', player: 0 }).ok);

  // 视为装：真装 0 也能选装伤
  let v = E.state.clone(st);
  v.players[0].aura = 0;
  eq('视为装的总数 = 牌上 5 颗', E.rules.shadowAura(v, 0), 5);
  ok('真装 0 仍可选「装 3」', E.rules.canTakeAura(v, 0, 3));

  // 被攻击选装：由受伤方决定「真装几颗 / 这张牌几颗」
  let w = E.state.clone(st);
  w.active = 1; w.distance = 7;
  w.players[1].hand = [cardById('03-himika-o-n-1')];          // シュート 2/1
  let w1 = A(w, { type: 'playCard', player: 1, cardId: '03-himika-o-n-1' });
  let w2 = A(w1.state, { type: 'respond', player: 0, cardId: null });
  let w3 = A(w2.state, { type: 'resolveDamage', player: 0, choice: 'aura' });
  ok('有無音壁时选「装」先进入分配', w3.ok, w3.error);
  eq('要分配的装伤总数 2', w3.state.auraSplit && w3.state.auraSplit.total, 2);
  eq('最多能从这张牌上扣 2 颗', w3.state.auraSplit && w3.state.auraSplit.maxAttach, 2);
  let over = A(w3.state, { type: 'resolveAuraSplit', player: 0, fromAttach: 3 });
  ok('分配超过牌上的结晶会被拒绝', !over.ok, over.error);
  let split = A(w3.state, { type: 'resolveAuraSplit', player: 0, fromAttach: 1 });
  ok('分配「牌上 1 颗 + 真装 1 颗」', split.ok, split.error);
  eq('真装 3→2', split.state.players[0].aura, 2);
  eq('牌上 5→4', split.state.players[0].attachments[0].crystals, 4);
  eq('换下来的 2 颗进虚', split.state.dust, 2);

  // 命伤不受影响：牌上的结晶不是命
  let x = E.state.clone(st);
  E.rules.applyDamage(x, 0, 0, 2, 'life');
  eq('命伤 -2：命 10→8', x.players[0].life, 8);
  eq('命伤不会扣牌上的结晶', x.players[0].attachments[0].crystals, 5);

  // 条件不满足：虚+装 凑不出纳 5
  let poor = setup(['02-saine-o-n-7'], { distance: 7, dust: 4, aura: 0 });
  ok('纳 5 凑不出来：不能展开', !A(poor, { type: 'playCard', player: 0, cardId: '02-saine-o-n-7' }).ok);
}

/* ---------- 8. 律動弧戟 ---------- */
group('律動弧戟（02-saine-o-s-1）· 三段攻击');
{
  let s = setup([], { distance: 4 });
  s.players[0].flare = 5;
  s.players[0].specials = [spec('02-saine-o-s-1', false)];
  let r = A(s, { type: 'playCard', player: 0, cardId: '02-saine-o-s-1' });
  ok('付 5 点气打出', r.ok, r.error);
  eq('气 5→0', r.state.players[0].flare, 0);
  eq('第一发 3-4 / 1-1', r.state.pending.damage, { aura: 1, life: 1 });
  eq('第一发适正距离 3-4', r.state.pending.range, [3, 4]);
  eq('队列里还排着两发', r.state.attackQueue.length, 2);

  let a = doAct(r.state, { type: 'respond', player: 1, cardId: null });
  a = doAct(a, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('第二发 4-5 / 1-1', a.pending.damage, { aura: 1, life: 1 });
  eq('第二发适正距离 4-5', a.pending.range, [4, 5]);
  let b = doAct(a, { type: 'respond', player: 1, cardId: null });
  b = doAct(b, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('第三发 3-5 / 2-2', b.pending.damage, { aura: 2, life: 2 });
  eq('第三发适正距离 3-5', b.pending.range, [3, 4, 5]);
  let c = doAct(b, { type: 'respond', player: 1, cardId: null });
  c = doAct(c, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('三发打完：没有待处理的攻击', c.pending, null);
  eq('三发合计 4 点命伤：命 10→6', c.players[1].life, 6);
  eq('三段打完队列清空', (c.attackQueue || []).length, 0);

  // 条件不满足：气不够付 5
  let poor = setup([], { distance: 4 });
  poor.players[0].flare = 4;
  poor.players[0].specials = [spec('02-saine-o-s-1', false)];
  ok('气 4 不够付 5：不能打出', !A(poor, { type: 'playCard', player: 0, cardId: '02-saine-o-s-1' }).ok);

  // 【引擎问题①】第一发打不到时，后面的攻击本该照打
  let mid = setup([], { distance: 5 });
  mid.players[0].flare = 5;
  mid.players[0].specials = [spec('02-saine-o-s-1', false)];
  let m = A(mid, { type: 'playCard', player: 0, cardId: '02-saine-o-s-1' });
  // 卡面三段：3-4/1-1 → 4-5/1-1 → 3-5/2-2
  // 间合 5：①(3-4) 打不到跳过，②(4-5) 打得出
  ok('间合 5：① 跳过、② 4-5 打出去', m.ok && !!m.state.pending, m.error);
  eq('间合 5 打出的那发是 ②', m.state.pending && m.state.pending.cardName, '律動弧戟②');

  // 【引擎问题②】中途一发打不到就停 → 剩下的攻击残留在队列，之后打别的牌会冒出幽灵攻击
  let leak = setup(['01-yurina-o-n-1'], { distance: 3 });
  leak.players[0].flare = 5;
  leak.players[0].specials = [spec('02-saine-o-s-1', false)];
  let l1 = A(leak, { type: 'playCard', player: 0, cardId: '02-saine-o-s-1' });
  let l2 = doAct(l1.state, { type: 'respond', player: 1, cardId: null });
  l2 = doAct(l2, { type: 'resolveDamage', player: 1, choice: 'life' });
  // 间合 3：①(3-4) 命中 → ②(4-5) 跳过 → ③(3-5) 接着打（卡面就是三段）
  ok('间合 3：① 之后接上 ③（② 因距离不符自动跳过）',
     !!l2.pending && l2.pending.cardName === '律動弧戟③',
     l2.pending && l2.pending.cardName);
  let l3 = doAct(l2, { type: 'respond', player: 1, cardId: null });
  let l4 = doAct(l3, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('三段打完：队列清空', (l4.attackQueue || []).length, 0);
  eq('三段打完：没有残留的待结算攻击', l4.pending, null);
}

/* ---------- 9. 響鳴共振 ---------- */
group('響鳴共振（02-saine-o-s-2）· 费用 = 8 − 敌装；敌装 2 颗 → 间合');
{
  let s = setup([], { distance: 5, dust: 0 });
  s.players[0].flare = 8;
  s.players[1].aura = 3;
  s.players[0].specials = [spec('02-saine-o-s-2', false)];
  let r = A(s, { type: 'playCard', player: 0, cardId: '02-saine-o-s-2' });
  ok('敌装 3 → 费用 5，气 8 够', r.ok, r.error);
  eq('付了 5 点气（8→3）', r.state.players[0].flare, 3);
  eq('敌装 3→1（搬走 2 颗）', r.state.players[1].aura, 1);
  eq('间合 5→7（搬来 2 颗）', r.state.distance, 7);
  eq('付掉的气进虚', r.state.dust, 5);

  let t = setup([], { distance: 3 });
  t.players[0].flare = 3;
  t.players[1].aura = 5;
  t.players[0].specials = [spec('02-saine-o-s-2', false)];
  let r2 = A(t, { type: 'playCard', player: 0, cardId: '02-saine-o-s-2' });
  ok('敌装 5 → 费用 3，气 3 刚好够', r2.ok, r2.error);
  eq('气 3→0', r2.state.players[0].flare, 0);
  eq('敌装 5→3', r2.state.players[1].aura, 3);
  eq('间合 3→5', r2.state.distance, 5);

  // 条件不满足：敌装 0 → 费用 8，气 7 打不出
  let u = setup([], { distance: 5 });
  u.players[0].flare = 7;
  u.players[1].aura = 0;
  u.players[0].specials = [spec('02-saine-o-s-2', false)];
  ok('敌装 0 → 费用 8，气 7 不能打', !A(u, { type: 'playCard', player: 0, cardId: '02-saine-o-s-2' }).ok);

  // 敌装 0、气够：能打，但没有结晶可搬
  u.players[0].flare = 8;
  let r3 = A(u, { type: 'playCard', player: 0, cardId: '02-saine-o-s-2' });
  ok('敌装 0、气 8：可以打出', r3.ok, r3.error);
  eq('没有结晶可搬：间合不变', r3.state.distance, 5);
  eq('敌装不会变成负数', r3.state.players[1].aura, 0);
}

/* ---------- 10. 音無砕氷 ---------- */
group('音無砕氷（02-saine-o-s-3）· 对应 -1/-1；【再起】八相');
{
  let s = setup(['01-yurina-o-n-1'], { distance: 3, dust: 0 });
  s.players[1].specials = [spec('02-saine-o-s-3', false)];
  s.players[1].flare = 2;
  let r1 = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  let r2 = A(r1.state, { type: 'respond', player: 1, cardId: '02-saine-o-s-3' });
  ok('适正 0-10：哪里都能当对应', r2.ok, r2.error);
  r2 = settleResponse(r2);
  eq('被对应的攻击 -1/-1 → 2/0', r2.state.pending.damage, { aura: 2, life: 0 });
  eq('王牌费用 2 点气（2→0）', r2.state.players[1].flare, 0);
  // 付掉的 2 点气进虚；音無砕氷 自己那发又打了 1 点气伤 → 虚 +1
  eq('付掉的气 + 自己那发的气伤都进虚', r2.state.dust, 3);
  eq('用掉的王牌标记 used', r2.state.players[1].specials[0].used, true);

  // 再起：八相（自装 ≤1）
  let t = setup([]);
  t.players[1].specials = [spec('02-saine-o-s-3', true)];
  t.players[1].aura = 1;
  eq('八相：再起发动', E.rules.tryRevive(t, 1, 'normal'), 1);
  eq('再起后回到未使用', t.players[1].specials[0].used, false);

  // 条件不满足：自装 2
  let u = setup([]);
  u.players[1].specials = [spec('02-saine-o-s-3', true)];
  u.players[1].aura = 2;
  eq('非八相：不再起', E.rules.tryRevive(u, 1, 'normal'), 0);
  eq('非八相：还是 used', u.players[1].specials[0].used, true);
}

/* ---------- 11. 氷雨 ---------- */
group('氷雨（02-saine-o-s-4）· 只能对应王牌攻击');
{
  let s = setup([], { distance: 5, dust: 0 });
  s.players[0].specials = [spec('03-himika-o-s-1', false)];   // レッドバレット（王牌攻击）
  s.players[1].specials = [spec('02-saine-o-s-4', false)];
  s.players[1].flare = 5;
  let r1 = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-s-1' });
  ok('对手用王牌攻击', r1.ok && r1.state.pending.fromSpecial, r1.error);
  let r2 = A(r1.state, { type: 'respond', player: 1, cardId: '02-saine-o-s-4' });
  ok('对王牌攻击可以拿氷雨对应', r2.ok, r2.error);
  eq('王牌费用 5 点气（5→0）', r2.state.players[1].flare, 0);
  eq('付掉的气进虚', r2.state.dust, 5);
  eq('氷雨进 used', r2.state.players[1].specials[0].used, true);

  // 条件不满足：对手是通常札攻击
  let t = setup(['01-yurina-o-n-1'], { distance: 3 });
  t.players[1].specials = [spec('02-saine-o-s-4', false)];
  t.players[1].flare = 5;
  let r3 = A(t, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  let r4 = A(r3.state, { type: 'respond', player: 1, cardId: '02-saine-o-s-4' });
  ok('对通常札攻击不能用氷雨', !r4.ok, r4.error);

  // 条件不满足：没有攻击时不能主动打出
  let u = setup([], { distance: 3 });
  u.players[0].specials = [spec('02-saine-o-s-4', false)];
  u.players[0].flare = 5;
  ok('氷雨不能当普通攻击主动打出', !A(u, { type: 'playCard', player: 0, cardId: '02-saine-o-s-4' }).ok);
}

/* ============================================================
 * 二、铳 · 绯弥香（himika）
 * ============================================================ */

/* ---------- 12. シュート ---------- */
group('シュート（03-himika-o-n-1）· 4-10 / 2-1 的纯攻击');
{
  let s = setup(['03-himika-o-n-1'], { distance: 6 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-1' });
  ok('间合 6 可以打', r.ok, r.error);
  eq('伤害 2/1', r.state.pending.damage, { aura: 2, life: 1 });
  eq('适正距离 4-10', r.state.pending.range, [4, 5, 6, 7, 8, 9, 10]);

  let s2 = setup(['03-himika-o-n-1'], { distance: 10 });
  ok('间合 10 也能打（4-10 的上限）', A(s2, { type: 'playCard', player: 0, cardId: '03-himika-o-n-1' }).ok);
  let s3 = setup(['03-himika-o-n-1'], { distance: 3 });
  ok('间合 3 不在 4-10：打不出', !A(s3, { type: 'playCard', player: 0, cardId: '03-himika-o-n-1' }).ok);
}

/* ---------- 13. ラピッドファイア ---------- */
group('ラピッドファイア（03-himika-o-n-2）· 连火（本回合第 3 张起）+1/+1');
{
  let s = setup(['03-himika-o-n-2'], { distance: 7 });
  s.turnUsed[0] = 2;                       // 这张是第 3 张
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-2' });
  ok('打出', r.ok, r.error);
  eq('连火：2/1 → 3/2', r.state.pending.damage, { aura: 3, life: 2 });

  let t = setup(['03-himika-o-n-2'], { distance: 7 });
  t.turnUsed[0] = 1;                       // 这张只是第 2 张
  let r2 = A(t, { type: 'playCard', player: 0, cardId: '03-himika-o-n-2' });
  eq('不满足连火：还是 2/1', r2.state.pending.damage, { aura: 2, life: 1 });

  let u = setup(['03-himika-o-n-2'], { distance: 7 });
  u.turnUsed[0] = 3;                       // 第 4 张也算「3 枚目以降」
  let r3 = A(u, { type: 'playCard', player: 0, cardId: '03-himika-o-n-2' });
  eq('第 4 张也算连火：3/2', r3.state.pending.damage, { aura: 3, life: 2 });
}

/* ---------- 14. マグナムカノン ---------- */
group('マグナムカノン（03-himika-o-n-3）· 【攻击后】自命 → 虚');
{
  let s = setup(['03-himika-o-n-3'], { distance: 6, dust: 2 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-3' });
  ok('打出', r.ok, r.error);
  eq('伤害 3/2', r.state.pending.damage, { aura: 3, life: 2 });
  let a = doAct(r.state, { type: 'respond', player: 1, cardId: null });
  a = doAct(a, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('对手选命：命 10→8', a.players[1].life, 8);
  eq('【攻击后】自命 10→9', a.players[0].life, 9);
  eq('那颗自命进虚（2→3）', a.dust, 3);

  // 条件不满足：攻击被打不到（被对应改了间合）→ 不触发【攻击后】
  let t = setup(['03-himika-o-n-3'], { distance: 5, dust: 2 });
  t.players[1].hand = [cardById('02-saine-o-n-4')];
  t.players[1].aura = 1;
  let r1 = A(t, { type: 'playCard', player: 0, cardId: '03-himika-o-n-3' });
  let r2 = A(r1.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-4' });
  let r3 = A(r2.state, { type: 'choose', player: 1, option: 'dist_to_dust' });
  eq('对应把间合 5→4，攻击落空', r3.state.pending, null);
  eq('落空就没有【攻击后】：自命还是 10', r3.state.players[0].life, 10);

  let u = setup(['03-himika-o-n-3'], { distance: 4 });
  ok('间合 4 不在 5-8：打不出', !A(u, { type: 'playCard', player: 0, cardId: '03-himika-o-n-3' }).ok);
}

/* ---------- 15. フルバースト ---------- */
group('フルバースト（03-himika-o-n-4）· 两种伤害都要吃；全力');
{
  let s = setup(['03-himika-o-n-4'], { distance: 6 });
  s.players[1].aura = 4;
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-4' });
  ok('打出', r.ok, r.error);
  eq('标记成「两种都吃」', r.state.pending.both, true);
  let a = doAct(r.state, { type: 'respond', player: 1, cardId: null });
  a = doAct(a, { type: 'resolveDamage', player: 1, choice: 'life' });   // 选哪边都躲不掉
  eq('选「命」也没用：装 4→1', a.players[1].aura, 1);
  eq('命 10→9', a.players[1].life, 9);

  // 装不够：只扣现有的，不溢出补偿
  let t = setup(['03-himika-o-n-4'], { distance: 6 });
  t.players[1].aura = 2;
  let r2 = A(t, { type: 'playCard', player: 0, cardId: '03-himika-o-n-4' });
  let b = doAct(r2.state, { type: 'respond', player: 1, cardId: null });
  b = doAct(b, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('装只有 2：扣到 0，不会变负', b.players[1].aura, 0);
  eq('多出来的 1 点装伤不会转成命伤', b.players[1].life, 9);

  // 全力：这一发打完本回合不能再做别的事
  let u = setup(['03-himika-o-n-4', '03-himika-o-n-1'], { distance: 6 });
  let u1 = A(u, { type: 'playCard', player: 0, cardId: '03-himika-o-n-4' });
  let u2 = doAct(u1.state, { type: 'respond', player: 1, cardId: null });
  u2 = doAct(u2, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('全力：结算完也不能再出牌', !A(u2, { type: 'playCard', player: 0, cardId: '03-himika-o-n-1' }).ok);
  ok('全力：不能做基本动作', !A(u2, { type: 'basic', player: 0, which: 'charge' }).ok);
  ok('全力：可以结束回合', A(u2, { type: 'endTurn', player: 0 }).ok);
}

/* ---------- 16. バックステップ ---------- */
group('バックステップ（03-himika-o-n-5）· 抽 1 张 + 虚→间合 1 颗');
{
  let s = setup(['03-himika-o-n-5'], { distance: 5, dust: 2 });
  s.players[0].deck = [cardById('03-himika-o-n-1')];
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-5' });
  ok('打出', r.ok, r.error);
  eq('抽 1 张（打出 1 张 + 抽 1 张 = 手牌还是 1）', r.state.players[0].hand.length, 1);
  eq('抽到的就是牌库顶那张', r.state.players[0].hand[0].id, '03-himika-o-n-1');
  eq('虚→间合：间合 5→6', r.state.distance, 6);
  eq('虚 2→1', r.state.dust, 1);

  // 条件不满足：虚 0 → 不搬结晶（抽牌照常）
  let t = setup(['03-himika-o-n-5'], { distance: 5, dust: 0 });
  t.players[0].deck = [cardById('03-himika-o-n-1')];
  let r2 = A(t, { type: 'playCard', player: 0, cardId: '03-himika-o-n-5' });
  eq('虚 0：间合不变', r2.state.distance, 5);
  eq('虚 0：还是照常抽到 1 张', r2.state.players[0].hand.length, 1);

  // 条件不满足：间合已经 10 → 无处可放，虚也不该被吃掉
  let u = setup(['03-himika-o-n-5'], { distance: 10, dust: 2 });
  u.players[0].deck = [cardById('03-himika-o-n-1')];
  let r3 = A(u, { type: 'playCard', player: 0, cardId: '03-himika-o-n-5' });
  eq('间合 10：还是 10', r3.state.distance, 10);
  eq('间合 10：虚没有被搬走', r3.state.dust, 2);
}

/* ---------- 17. バックドラフト ---------- */
group('バックドラフト（03-himika-o-n-6）· 对手畏缩；连火给下一个「其他女神」的攻击 +1/+1');
{
  let s = setup(['03-himika-o-n-6'], { distance: 5 });
  s.turnUsed[0] = 1;
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-6' });
  ok('打出', r.ok, r.error);
  eq('对手畏缩', r.state.players[1].staggered, true);
  eq('不是连火：没有记下攻击加成', r.state.players[0].nextOtherAttack || null, null);

  // 连火：其他女神（细音）的下一发攻击 +1/+1
  let t = setup(['03-himika-o-n-6', '02-saine-o-n-1'], { distance: 5 });
  t.turnUsed[0] = 2;
  let t1 = A(t, { type: 'playCard', player: 0, cardId: '03-himika-o-n-6' });
  eq('连火：记下「下一次其他女神的攻击 +1/+1」',
     t1.state.players[0].nextOtherAttack && t1.state.players[0].nextOtherAttack.bonus,
     { aura: 1, life: 1 });
  let t2 = A(t1.state, { type: 'playCard', player: 0, cardId: '02-saine-o-n-1' });
  ok('细音的攻击可以打出', t2.ok, t2.error);
  eq('细音的八方振り 2/1 → 3/2', t2.state.pending.damage, { aura: 3, life: 2 });

  // 【引擎问题①】卡面写「他のメガミによる《攻撃》」：同一女神的攻击不该吃这个加成
  let same = setup(['03-himika-o-n-6', '03-himika-o-n-1'], { distance: 6 });
  same.turnUsed[0] = 2;
  let s1 = A(same, { type: 'playCard', player: 0, cardId: '03-himika-o-n-6' });
  let s2 = A(s1.state, { type: 'playCard', player: 0, cardId: '03-himika-o-n-1' });
  ok('绯弥香的シュート也能打出', s2.ok, s2.error);
  eq('【期望】同女神（绯弥香）的シュート 应为 2/1　【实际】被当成「其他女神」加了 1/1',
     s2.state.pending.damage, { aura: 2, life: 1 });

  // 【引擎问题②】卡面写「このターン」：加成不该留到下一回合
  let persist = setup(['03-himika-o-n-6'], { distance: 5 });
  persist.turnUsed[0] = 2;
  persist.players[1].firstTurnDone = true;          // 让 P2 能正常过完自己的回合
  let p1 = A(persist, { type: 'playCard', player: 0, cardId: '03-himika-o-n-6' });
  let p2 = H.endTurnAuto(p1.state);                 // P1 结束 → P2 的回合
  let p3 = H.endTurnAuto(p2.state);                 // P2 结束 → 回到 P1
  eq('【期望】换回合后加成应该消失　【实际】还留着', p3.state.players[0].nextOtherAttack || null, null);

  // 畏缩真的有用：P2 回合开始不涨集中力，畏缩被解除
  let stag = setup([], {});
  stag.players[1].firstTurnDone = true;
  stag.players[1].staggered = true;
  stag.players[1].focus = 0;
  stag.players[1].deck = [cardById('02-saine-o-n-1'), cardById('02-saine-o-n-2')];
  let q = H.endTurnAuto(stag);
  eq('畏缩中：回合开始不涨集中力（还是 0）', q.state.players[1].focus, 0);
  eq('畏缩被解除', q.state.players[1].staggered, false);
}

/* ---------- 18. スモーク ---------- */
group('スモーク（03-himika-o-n-7）· 箭头效果不能移动间合的结晶');
{
  let s = setup(['03-himika-o-n-7', '02-saine-o-n-4'], { distance: 6, dust: 3, aura: 3 });
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-7' });
  ok('可以准备展开（纳 3）', r.ok && !!r.state.nabu, r.error);
  let r2 = A(r.state, { type: 'confirmNabu', player: 0, fromDust: 1, fromAura: 2 });
  ok('纳 3 展开成功', r2.ok, r2.error);
  let st = r2.state;
  eq('付与札上有 3 颗结晶', st.players[0].attachments[0].crystals, 3);
  eq('スモーク 不加达人距离（还是 2）', E.rules.taijinOf(st), 2);

  // 箭头效果：从间合搬走 → 被挡
  let before = { d: st.distance, du: st.dust };
  eq('从间合搬 1 颗：被挡（实际搬了 0 颗）', E.effects.fx.moveCrystal(st, 0, 'distance', 'dust', 1), 0);
  eq('间合不变', st.distance, before.d);
  eq('虚不增加', st.dust, before.du);

  // 不受影响：搬「进」间合仍然可以
  eq('虚→间合 仍然搬得动 1 颗', E.effects.fx.moveCrystal(st, 0, 'dust', 'distance', 1), 1);
  eq('间合 6→7', st.distance, 7);
  eq('虚 -1', st.dust, before.du - 1);

  // 整卡验证：見切り 的「间合→虚」也被挡住
  let viaCard = doAct(st, { type: 'playCard', player: 0, cardId: '02-saine-o-n-4' });
  let viaCard2 = doAct(viaCard, { type: 'choose', player: 0, option: 'dist_to_dust' });
  eq('見切り 的间合→虚被挡：间合还是 7', viaCard2.distance, 7);

  // 条件不满足（没有スモーク）：同样的箭头能搬
  let plain = setup([], { distance: 6, dust: 5 });
  eq('没有スモーク：间合→虚 搬得动', E.effects.fx.moveCrystal(plain, 0, 'distance', 'dust', 1), 1);
  eq('间合 6→5', plain.distance, 5);
}

/* ---------- 19. レッドバレット ---------- */
group('レッドバレット（03-himika-o-s-1）· 费 0 的 5-10 / 3-1 王牌攻击');
{
  let s = setup([], { distance: 5, dust: 0 });
  s.players[0].flare = 0;
  s.players[0].specials = [spec('03-himika-o-s-1', false)];
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-s-1' });
  ok('气 0 也能打（费用 0）', r.ok, r.error);
  eq('伤害 3/1', r.state.pending.damage, { aura: 3, life: 1 });
  eq('适正距离 5-10', r.state.pending.range, [5, 6, 7, 8, 9, 10]);
  eq('王牌标记 used', r.state.players[0].specials[0].used, true);
  eq('费用 0：虚不增加', r.state.dust, 0);

  let a = doAct(r.state, { type: 'respond', player: 1, cardId: null });
  a = doAct(a, { type: 'resolveDamage', player: 1, choice: 'aura' });
  eq('对手装 3→0', a.players[1].aura, 0);
  ok('用过的王牌不能再打', !A(a, { type: 'playCard', player: 0, cardId: '03-himika-o-s-1' }).ok);

  let t = setup([], { distance: 4 });
  t.players[0].specials = [spec('03-himika-o-s-1', false)];
  ok('间合 4 不在 5-10：打不出', !A(t, { type: 'playCard', player: 0, cardId: '03-himika-o-s-1' }).ok);
}

/* ---------- 20. クリムゾンゼロ ---------- */
group('クリムゾンゼロ（03-himika-o-s-2）· 两种伤害都吃；间合 0 时不可被对应');
{
  let s = setup([], { distance: 1, dust: 0 });
  s.players[0].flare = 5;
  s.players[1].aura = 3;
  s.players[0].specials = [spec('03-himika-o-s-2', false)];
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-s-2' });
  ok('间合 1 可以打（0-2）', r.ok, r.error);
  eq('标记「两种都吃」', r.state.pending.both, true);
  eq('间合不是 0：还没获得「不可被对应」', r.state.pending.noRespond, false);
  let a = doAct(r.state, { type: 'respond', player: 1, cardId: null });
  a = doAct(a, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('选「命」也躲不掉装伤：装 3→1', a.players[1].aura, 1);
  eq('命 10→8', a.players[1].life, 8);

  // 间合 0：获得「不可被对应」
  let t = setup([], { distance: 0 });
  t.players[0].flare = 5;
  t.players[0].specials = [spec('03-himika-o-s-2', false)];
  t.players[1].hand = [cardById('02-saine-o-n-4')];
  t.players[1].aura = 1;                       // 八相（本来可以拿見切り对应）
  let r2 = A(t, { type: 'playCard', player: 0, cardId: '03-himika-o-s-2' });
  eq('间合 0：获得「不可被对应」', r2.state.pending.noRespond, true);
  let reject = A(r2.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-4' });
  ok('间合 0：見切り 也对应不了', !reject.ok, reject.error);

  let u = setup([], { distance: 3 });
  u.players[0].flare = 5;
  u.players[0].specials = [spec('03-himika-o-s-2', false)];
  ok('间合 3 不在 0-2：打不出', !A(u, { type: 'playCard', player: 0, cardId: '03-himika-o-s-2' }).ok);
  u.players[0].flare = 4;
  u.distance = 1;
  ok('气 4 不够付 5：打不出', !A(u, { type: 'playCard', player: 0, cardId: '03-himika-o-s-2' }).ok);
}

/* ---------- 21. スカーレットイマジン ---------- */
group('スカーレットイマジン（03-himika-o-s-3）· 抽 2 后把 1 张手牌盖成伏札');
{
  let s = setup([], { distance: 5, dust: 0, focus: 0 });
  s.players[0].flare = 3;
  s.players[0].hand = [];
  s.players[0].specials = [spec('03-himika-o-s-3', false)];
  s.players[0].deck = [cardById('01-yurina-o-n-1'), cardById('01-yurina-o-n-2'), cardById('01-yurina-o-n-3')];
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-s-3' });
  ok('付 3 点气打出', r.ok, r.error);
  eq('气 3→0', r.state.players[0].flare, 0);
  eq('付掉的气进虚', r.state.dust, 3);
  eq('抽了 2 张', r.state.players[0].hand.length, 2);
  eq('弹出「盖哪张」的选择', r.state.choice && r.state.choice.sourceId, 'imagine');
  eq('选项就是当前手牌', r.state.choice && r.state.choice.options, r.state.players[0].hand.map(c => c.id));

  let pick = r.state.players[0].hand[0].id;
  let a = doAct(r.state, { type: 'choose', player: 0, option: pick });
  eq('盖了 1 张伏札', a.players[0].hidden.map(c => c.id), [pick]);
  eq('手牌 2→1', a.players[0].hand.length, 1);
  eq('盖完选择关闭', a.choice, null);

  let poor = setup([], { distance: 5 });
  poor.players[0].flare = 2;
  poor.players[0].specials = [spec('03-himika-o-s-3', false)];
  ok('气 2 不够付 3：打不出', !A(poor, { type: 'playCard', player: 0, cardId: '03-himika-o-s-3' }).ok);
}

/* ---------- 22. ヴァーミリオン・フィールド ---------- */
group('ヴァーミリオン・フィールド（03-himika-o-s-4）· 连火时 虚→间合；【再起】手牌 0 张');
{
  let s = setup([], { distance: 5, dust: 3 });
  s.players[0].flare = 2;
  s.turnUsed[0] = 2;
  s.players[0].specials = [spec('03-himika-o-s-4', false)];
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-s-4' });
  ok('连火时打出', r.ok, r.error);
  eq('连火：间合 5→6', r.state.distance, 6);
  eq('虚：3 + 付掉的 2 气 - 搬走的 1 颗 = 4', r.state.dust, 4);

  // 条件不满足：不是连火 → 不搬结晶（只付费用）
  let t = setup([], { distance: 5, dust: 3 });
  t.players[0].flare = 2;
  t.turnUsed[0] = 1;
  t.players[0].specials = [spec('03-himika-o-s-4', false)];
  let r2 = A(t, { type: 'playCard', player: 0, cardId: '03-himika-o-s-4' });
  eq('不是连火：间合不动', r2.state.distance, 5);
  eq('不是连火：虚只多了付掉的 2 气', r2.state.dust, 5);

  // 再起：手牌 0 张
  let u = setup([], {});
  u.players[0].specials = [spec('03-himika-o-s-4', true)];
  u.players[0].hand = [];
  eq('手牌 0 张：再起发动', E.rules.tryRevive(u, 0, 'normal'), 1);
  eq('再起后回到未使用', u.players[0].specials[0].used, false);

  // 条件不满足：手牌 1 张
  let v = setup([], {});
  v.players[0].specials = [spec('03-himika-o-s-4', true)];
  v.players[0].hand = [cardById('03-himika-o-n-1')];
  eq('手牌 1 张：不再起', E.rules.tryRevive(v, 0, 'normal'), 0);
  eq('还是 used', v.players[0].specials[0].used, true);
}

/* ============================================================
 * 三、横向检查：这些流程里一张牌都不能凭空消失
 * ============================================================ */
group('牌数守恒（白盒兜底）');
{
  eq('开局双方牌总数', cardTotal(fresh()), 20);

  // 八方振り 两连击：主攻击 + 追加攻击 + 对应，全程牌数不变
  let s = setup(['02-saine-o-n-1'], { distance: 4, aura: 1 });
  s.players[1].hand = [cardById('02-saine-o-n-2')];
  const before = cardTotal(s);
  let c1 = doAct(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-1' });
  let c2 = doAct(c1, { type: 'respond', player: 1, cardId: '02-saine-o-n-2' });
  c2 = doAct(c2, { type: 'resolveDamage', player: 1, choice: 'life' });
  c2 = doAct(c2, { type: 'respond', player: 1, cardId: null });
  c2 = doAct(c2, { type: 'resolveDamage', player: 1, choice: 'life' });
  eq('八方振り 两连击 + 对应后牌数不变', cardTotal(c2), before);

  // 律動弧戟 三段：王牌不进弃牌区，只在王牌区标记 used
  let t = setup([], { distance: 4 });
  t.players[0].flare = 5;
  t.players[0].specials = [spec('02-saine-o-s-1', false)];
  const tBefore = cardTotal(t);
  let d = doAct(t, { type: 'playCard', player: 0, cardId: '02-saine-o-s-1' });
  for (let i = 0; i < 3; i++) {
    d = doAct(d, { type: 'respond', player: 1, cardId: null });
    d = doAct(d, { type: 'resolveDamage', player: 1, choice: 'life' });
  }
  eq('律動弧戟 三段打完牌数不变', cardTotal(d), tBefore);
  eq('王牌还在王牌区（只是标记 used）', d.players[0].specials.length, 1);
}

/* ---------- 结果 ---------- */
H.report();
