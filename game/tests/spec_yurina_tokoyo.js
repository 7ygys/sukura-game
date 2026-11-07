/* ============================================================================
 * game/tests/spec_yurina_tokoyo.js
 * ============================================================================
 * 刀（ユリナ / yurina）11 张 + 扇（トコヨ / tokoyo）11 张 = 22 张卡的白盒测试。
 *
 * 「白盒」= 不看界面，直接读引擎算出来的状态来断言：
 *   - 条件满足：效果真的发生了，且数值 / 区域 / 时机都对
 *   - 条件不满足：效果完全不发生，或者这张牌根本不能用
 *
 * 三件事写在最前面，方便以后改卡时对照：
 *   1. 卡面（素材/卡面/yurina|tokoyo/*.png）是唯一真相，本文件所有数值都对着
 *      卡面核过；JSON 只当索引用。
 *   2. 断言说明一律用中文，并且写清"这一步在验什么规则"。
 *   3. 发现引擎 bug 就保留会失败的断言（不改成"实际行为"），
 *      在文件末尾 BUG 清单里写期望 / 实际 / 复现。
 *
 * 跑法：node game/tests/spec_yurina_tokoyo.js
 * ========================================================================== */
const H = require('./harness');
const { E, ok, eq, group, report, fresh, withHand, cardById, autoNabu, cardTotal, settleResponse } = H;

/* ============================================================================
 * 一、本地小工具
 * ========================================================================== */

/**
 * 造一个"干净"的局面。
 *
 * 为什么不用 fresh() 直接用？
 *   create() 是**随机先手**的，还会给后手 1 点集中力。而「境地」判的是
 *   「集中力 = 2」、「决死」判的是「命 ≤ 3」—— 不把数值写死，
 *   同一个测试跑两次可能一次过、一次不过（假绿）。
 *   所以这里把双方所有资源、状态、回合内计数器全部显式归零。
 *
 * @param {string[]} cards  P0 手牌（卡 id）
 * @param {object}   o      { distance, dust, hand1, p0:{...}, p1:{...} }
 */
function scene(cards, o) {
  o = o || {};
  const s = withHand(cards || []);
  s.active = 0;
  s.phase = 'main';
  s.distance = o.distance === undefined ? 5 : o.distance;
  s.dust = o.dust === undefined ? 0 : o.dust;
  s.distanceMod = 0;
  s.turnUsed = [0, 0];
  s.pending = null;
  s.nabu = null;
  s.choice = null;
  s.attackStack = [];
  s.attackQueue = [];
  [0, 1].forEach(function (i) {
    const p = s.players[i];
    p.life = 10;
    p.aura = 3;
    p.flare = 0;
    p.focus = 0;
    p.staggered = false;
    p.terminated = false;
    p.fullpowerUsed = false;
    p.buff = { aura: 0, life: 0 };
    p.usedBasicThisTurn = false;
    p.nextOtherAttack = null;
    p.hidden = [];
    p.attachments = [];
  });
  s.players[1].hand = (o.hand1 || []).map(cardById);
  if (o.p0) Object.assign(s.players[0], o.p0);
  if (o.p1) Object.assign(s.players[1], o.p1);
  return s;
}

/** 直接调动作层（和界面走同一条路） */
function act(s, a) { return E.actions.applyAction(s, a); }

/** 出牌（默认当前行动方） */
function play(s, cardId, who) {
  return act(s, { type: 'playCard', player: who === undefined ? s.active : who, cardId: cardId });
}

/** 受攻击方放弃对应 */
function noRespond(s) {
  return act(s, { type: 'respond', player: s.pending.defender, cardId: null });
}

/** 受攻击方用某张牌对应 */
function respondCard(s, cardId) {
  return act(s, { type: 'respond', player: s.pending.defender, cardId: cardId });
}

/** 受攻击方选伤害 */
function takeDamage(s, choice) {
  return act(s, { type: 'resolveDamage', player: s.pending.defender, choice: choice });
}

/** 当下待结算攻击的伤害，返回 [装, 命]（「-」保留成 null） */
function dmg(s) {
  const d = s.pending && s.pending.damage;
  return d ? [d.aura, d.life] : null;
}

/** 王牌准备：specials 里没有就塞一张未使用的（王牌不占手牌） */
function giveSpecial(s, who, id) {
  let c = s.players[who].specials.find(function (x) { return x.id === id; });
  if (!c) { c = cardById(id); c.used = false; s.players[who].specials.push(c); }
  c.used = false;
  return c;
}

/**
 * 打完一次攻击（对方不对应）：出牌 → 放弃对应 → 结算伤害。
 * 返回 { ok, state, error }，其中 state 是结算完之后的状态。
 */
function swing(s, cardId, choice) {
  const r1 = play(s, cardId);
  if (!r1.ok) return { ok: false, error: r1.error, state: s };
  const r2 = noRespond(r1.state);
  if (!r2.ok) return { ok: false, error: r2.error, state: r1.state };
  if (!r2.state.pending) return { ok: true, state: r2.state };
  return takeDamage(r2.state, choice || 'life');
}

/** 给某方塞一张牌进弃牌区（要返し / 千歳ノ鳥 用） */
function toDiscard(s, who, id) {
  const c = cardById(id);
  s.players[who].discard.push(c);
  return c;
}

/** 攻防全部走完之后，这次攻击的余波状态（用于看【攻击后】） */
const BUGS = [];


/* ============================================================================
 * 二、刀（yurina）
 * ========================================================================== */

/* -------------------------------------------------------------------------
 * 01 斬（3-4 / 3/1）—— 纯攻击，所有加伤的"基线"
 * ---------------------------------------------------------------------- */
group('刀·斬（01-yurina-o-n-1）：3-4 / 3/1 的基线攻击');
{
  const s = scene(['01-yurina-o-n-1'], { distance: 3 });
  const r = play(s, '01-yurina-o-n-1');
  ok('间合 3 在适正距离内 → 可以打出', r.ok, r.error);
  eq('斩的伤害是 3/1', dmg(r.state), [3, 1]);
  eq('适正距离是 3-4', r.state.pending.range, [3, 4]);

  const out = play(scene(['01-yurina-o-n-1'], { distance: 5 }), '01-yurina-o-n-1');
  ok('间合 5 超出适正距离 → 不能打出', !out.ok, out.error);
  ok('被拒绝时报的是"距离"错误', /距离/.test(out.error || ''), out.error);
}

/* -------------------------------------------------------------------------
 * 02 一閃（3 / 2/2）—— 【常时】决死（自命 ≤ 3）→ +1/+0
 * ---------------------------------------------------------------------- */
group('刀·一閃（01-yurina-o-n-2）：决死时 +1/+0');
{
  const s3 = scene(['01-yurina-o-n-2'], { distance: 3, p0: { life: 3 } });
  const r3 = play(s3, '01-yurina-o-n-2');
  ok('命 3（决死达成）可以打出', r3.ok, r3.error);
  eq('命 3 时一閃 = 2+1 / 2 = 3/2', dmg(r3.state), [3, 2]);

  const s4 = scene(['01-yurina-o-n-2'], { distance: 3, p0: { life: 4 } });
  const r4 = play(s4, '01-yurina-o-n-2');
  ok('命 4（决死未达成）也可以打出', r4.ok, r4.error);
  eq('命 4 时没有加成 = 2/2', dmg(r4.state), [2, 2]);

  // 边界：命 3 是决死的上边界，命 4 就掉出条件
  const s2 = scene(['01-yurina-o-n-2'], { distance: 3, p0: { life: 2 } });
  eq('命 2（更深决死）仍然是 +1/+0', dmg(play(s2, '01-yurina-o-n-2').state), [3, 2]);
}

/* -------------------------------------------------------------------------
 * 03 柄打ち（1-2 / 2/1）—— 【攻击后】决死 → 本回合下一次《攻击》+1/+0
 * ---------------------------------------------------------------------- */
group('刀·柄打ち（01-yurina-o-n-3）：决死时给下一发 +1/+0');
{
  // 满足条件：决死 → 打完挂上 buff，下一发真的 +1
  const s = scene(['01-yurina-o-n-3'], { distance: 2, p0: { life: 3 } });
  eq('柄打ち本身 2/1（决死不加自己的伤）', dmg(play(s, '01-yurina-o-n-3').state), [2, 1]);

  const s1 = scene(['01-yurina-o-n-3'], { distance: 2, p0: { life: 3 } });
  const done = swing(s1, '01-yurina-o-n-3', 'life');
  ok('柄打ち打完', done.ok, done.error);
  eq('【攻击后】决死 → 挂上 +1/+0 的加成', done.state.players[0].buff.aura, 1);

  // 把间合挪到 3（斩的适正），验证加成真的进了下一发的伤害
  const next = E.state.clone(done.state);
  next.distance = 3;
  next.players[0].hand.push(cardById('01-yurina-o-n-1'));
  const r = play(next, '01-yurina-o-n-1');
  eq('下一发《攻击》吃到了 +1/+0：斬 3/1 → 4/1', dmg(r.state), [4, 1]);
  eq('加成用完就清空', r.state.players[0].buff.aura, 0);

  // 不满足条件：命 4 → 什么都没有
  const s4 = scene(['01-yurina-o-n-3'], { distance: 2, p0: { life: 4 } });
  const done4 = swing(s4, '01-yurina-o-n-3', 'life');
  eq('命 4（非决死）→ 不给加成', done4.state.players[0].buff.aura, 0);

  const next4 = E.state.clone(done4.state);
  next4.distance = 3;
  next4.players[0].hand.push(cardById('01-yurina-o-n-1'));
  eq('命 4 时下一发仍是 3/1', dmg(play(next4, '01-yurina-o-n-1').state), [3, 1]);
}

/* -------------------------------------------------------------------------
 * 04 居合（2-4 / 4/3，全力）—— 【常时】间合 ≤ 2 → -1/-1
 * ---------------------------------------------------------------------- */
group('刀·居合（01-yurina-o-n-4）：间合 ≤2 时 -1/-1，且是全力');
{
  const s2 = scene(['01-yurina-o-n-4'], { distance: 2 });
  const r2 = play(s2, '01-yurina-o-n-4');
  ok('间合 2 可以打出（适正 2-4）', r2.ok, r2.error);
  eq('间合 2 时居合 = 4-1 / 3-1 = 3/2', dmg(r2.state), [3, 2]);

  const s4 = scene(['01-yurina-o-n-4'], { distance: 4 });
  const r4 = play(s4, '01-yurina-o-n-4');
  ok('间合 4 可以打出', r4.ok, r4.error);
  eq('间合 4 时居合没有减值 = 4/3', dmg(r4.state), [4, 3]);

  const s3 = scene(['01-yurina-o-n-4'], { distance: 3 });
  eq('间合 3（差一格）也没有减值 = 4/3', dmg(play(s3, '01-yurina-o-n-4').state), [4, 3]);
}

/* -------------------------------------------------------------------------
 * 05 気迫（行动）—— +1 集中力；下一次「其他女神的非王牌攻击」
 *                   获得 不可被对应（通常札）+ 距离扩大（近1）
 * ---------------------------------------------------------------------- */
group('刀·気迫（01-yurina-o-n-5）：只加强"其他女神的非王牌攻击"');
{
  // ---- 基线：没有気迫时，间合 3 打不出 4-5 的薙斬り（细音，其他女神）----
  const boss = play(scene(['02-saine-o-n-2'], { distance: 3 }), '02-saine-o-n-2');
  ok('没有気迫时，间合 3 打不出「4-5」的薙斬り', !boss.ok, boss.error);

  // ---- 打出気迫：集中力 +1，记下加成 ----
  const s = scene(['01-yurina-o-n-5'], { distance: 4 });
  const r = play(s, '01-yurina-o-n-5');
  ok('気迫可以打出（行动牌）', r.ok, r.error);
  eq('気迫：集中力 0 → 1', r.state.players[0].focus, 1);
  ok('気迫：记下了"下一次其他女神的攻击"的加成', !!r.state.players[0].nextOtherAttack);

  // ---- 集中力上限 2：已经 2 点时不再增加（畏缩除外，另测）----
  const sTop = scene(['01-yurina-o-n-5'], { distance: 4, p0: { focus: 2 } });
  eq('気迫：集中力已经是 2（上限）时不再增加', play(sTop, '01-yurina-o-n-5').state.players[0].focus, 2);

  // ---- 距离扩大：pending.range 里多出"近 1"那一格 ----
  const s2 = scene(['01-yurina-o-n-5'], { distance: 4 });
  let st = play(s2, '01-yurina-o-n-5').state;
  st.players[0].hand.push(cardById('02-saine-o-n-2'));     // 薙斬り 4-5
  const atk = play(st, '02-saine-o-n-2');
  ok('気迫：可以让其他女神的薙斬り吃到加成后打出', atk.ok, atk.error);
  eq('気迫：适正距离被扩大成 3-5',
    (atk.state.pending.range || []).slice().sort(function (a, b) { return a - b; }), [3, 4, 5]);
  eq('気迫：这次攻击不可被「通常札」对应', atk.state.pending.noRespond, 'normal');
  eq('気迫：伤害本身不变（薙斬り 3/1）', dmg(atk.state), [3, 1]);
  ok('気迫：加成用掉后清空', !atk.state.players[0].nextOtherAttack);

  // ---- 距离扩大（近1）真正该干的事：让「4-5」的攻击在间合 3 也能打出去 ----
  // 规则 10-4 / 讨论记录「距离扩大/缩小：按官方实现」：它改的是**适正距离**，
  // 所以 4-5 的薙斬り 在「近1」之后是 3-5，间合 3 必须可用。
  const sNear = scene(['01-yurina-o-n-5', '02-saine-o-n-2'], { distance: 3 });
  const near = play(play(sNear, '01-yurina-o-n-5').state, '02-saine-o-n-2');
  ok('気迫：间合 3 时也能打出「4-5」的薙斬り（距离扩大近1）', near.ok, near.error);
  if (!near.ok) {
    BUGS.push({
      title: '気迫 的「距离扩大（近1）」在"能不能打出去"这一关完全没生效',
      expect: '気迫 之后，4-5 的《攻击》适正距离变成 3-5，间合 3 时能打出去（规则 10-4：距离扩大改的是适正距离）',
      actual: '被 playCard 的距离检查直接拒绝（"距离 3 不在适正距离内"）。' +
              '扩大只被写进了 ctx.range / pending.range，而出牌前的 inRange() 查的还是 card.range 原值',
      where: 'engine/rules.js:780 `if (isAttack && !inRange(state, card))`；' +
             'ctx.range 的扩大发生在 engine/rules.js:861-876，比这道门晚',
      repro: "気迫 → 手牌放 02-saine-o-n-2（薙斬り 4-5）→ 间合设为 3 → 出牌被拒；" +
             '同一张牌在间合 4 打出去后，pending.range 却是 [4,5,3]'
    });
  }

  // ---- 不可被通常札对应：对方拿着通常札的对应牌也用不了 ----
  const s3 = scene(['01-yurina-o-n-5'], { distance: 4, hand1: ['04-tokoyo-o-n-2'], p1: { focus: 2 } });
  let st3 = play(s3, '01-yurina-o-n-5').state;
  st3.players[0].hand.push(cardById('02-saine-o-n-2'));
  st3 = play(st3, '02-saine-o-n-2').state;
  const blocked = respondCard(st3, '04-tokoyo-o-n-2');
  ok('気迫：对方不能用通常札（雅打ち）对应这次攻击', !blocked.ok, blocked.error);

  // ---- 只对"其他女神"生效：刀自己的攻击不吃 ----
  const s4 = scene(['01-yurina-o-n-5', '01-yurina-o-n-1'], { distance: 3 });
  const st4 = play(play(s4, '01-yurina-o-n-5').state, '01-yurina-o-n-1').state;
  eq('気迫：刀自己的斬 伤害不变 3/1', dmg(st4), [3, 1]);
  eq('気迫：刀自己的攻击不吃「不可被对应」', st4.pending.noRespond, false);
  ok('気迫：加成没有被刀自己的攻击吃掉，留给其他女神', !!st4.players[0].nextOtherAttack);

  // ---- 非王牌限定：其他女神的"王牌攻击"不该吃加成 ----
  const s5 = scene(['01-yurina-o-n-5'], { distance: 5, p0: { flare: 3 } });
  let st5 = play(s5, '01-yurina-o-n-5').state;
  giveSpecial(st5, 0, '02-saine-o-s-3');                   // 音無砕氷：细音的王牌攻击 0-10 / 1/1
  const sp = play(st5, '02-saine-o-s-3');
  ok('気迫：其他女神的王牌攻击可以正常打出', sp.ok, sp.error);
  ok('気迫：王牌（切札）攻击不该吃到「不可被对应」',
    sp.ok && sp.state.pending.noRespond === false, sp.ok ? sp.state.pending.noRespond : sp.error);
  ok('気迫：王牌攻击不该消耗掉这次加成（还要留给下一发通常札攻击）',
    sp.ok && !!sp.state.players[0].nextOtherAttack);
  if (sp.ok && sp.state.pending.noRespond !== false) {
    BUGS.push({
      title: '気迫 的「非王牌」限定完全没生效（ctx.fromSpecial 从未被赋值）',
      expect: '其他女神的「王牌（切札）」攻击不吃加成：pending.noRespond === false，且 nextOtherAttack 保留',
      actual: 'pending.noRespond === "normal"，且 nextOtherAttack 被清空 —— 和通常札攻击一样待遇',
      where: 'engine/rules.js:862-876 读 ctx.fromSpecial，但全引擎没有任何地方给 ctx.fromSpecial 赋值（playCard 里的局部变量 fromSpecial 没传进 ctx）',
      repro: "気迫 → 打 02-saine-o-s-3（细音王牌攻击）→ 看 pending.noRespond"
    });
  }
}

/* -------------------------------------------------------------------------
 * 06 圧気（付与・纳2・带《隙》）—— 破弃时 3/- 的攻击；受命伤时收进伏札
 * ---------------------------------------------------------------------- */
group('刀·圧気（01-yurina-o-n-6）：破弃打 3/-，带《隙》受命伤就收起');
{
  // ---- 展开：纳 2 从虚取 ----
  const s = scene(['01-yurina-o-n-6'], { distance: 3, dust: 6 });
  const r = autoNabu(play(s, '01-yurina-o-n-6'));
  ok('圧気可以展开（付与・纳2）', r.ok, r.error);
  eq('圧気：纳 2 颗结晶', r.state.players[0].attachments[0].crystals, 2);
  eq('圧気：结晶从虚取 2 颗', r.state.dust, 4);

  // ---- 正常破弃：结晶一颗颗掉光 → 触发【破弃时】的 1-4 / 3/- 攻击 ----
  let st = E.state.clone(r.state);
  E.rules.tickAttachments(st, 0);
  eq('第 1 次损耗后牌上还剩 1 颗', st.players[0].attachments[0].crystals, 1);
  ok('还有结晶时不会破弃、也不生成攻击', !st.pending);

  E.rules.tickAttachments(st, 0);
  eq('结晶耗尽 → 付与区清空（破弃）', st.players[0].attachments.length, 0);
  ok('破弃 → 生成了【破弃时】的攻击', !!st.pending);
  eq('破弃攻击的伤害是 3/-（「-」必须是 null，不能被当成 0）', dmg(st), [3, null]);
  eq('破弃攻击的适正距离是 1-4', st.pending.range, [1, 2, 3, 4]);
  ok('破弃的这张牌进了弃牌区',
    st.players[0].discard.some(function (c) { return c.id === '01-yurina-o-n-6'; }));

  // ---- 破弃攻击只能选装（命伤是「-」）----
  const mid = noRespond(st);
  const badChoice = takeDamage(mid.state, 'life');
  ok('圧気的破弃攻击（3/-）不能选命', !badChoice.ok, badChoice.error);
  const goodChoice = takeDamage(mid.state, 'aura');
  ok('圧気的破弃攻击可以选装', goodChoice.ok, goodChoice.error);
  eq('对方掉 3 点装', goodChoice.state.players[1].aura, 0);

  // ---- 《隙》：受到命伤 → 收进伏札、结晶进虚、不触发破弃攻击 ----
  const s2 = scene(['01-yurina-o-n-6'], { distance: 3, dust: 6 });
  const st2 = autoNabu(play(s2, '01-yurina-o-n-6')).state;
  const dustBefore = st2.dust;
  E.rules.applyDamage(st2, 0, 0, 1, 'life');
  eq('《隙》：命 -1', st2.players[0].life, 9);
  eq('《隙》：付与区清空（牌被收起）', st2.players[0].attachments.length, 0);
  eq('《隙》：牌进了伏札区', st2.players[0].hidden.length, 1);
  eq('《隙》：牌上 2 颗结晶全部进虚', st2.dust, dustBefore + 2);
  ok('《隙》：不会生成【破弃时】的攻击', !st2.pending);
  ok('《隙》：没有走"破弃"这条路（弃牌区里没有这张牌）',
    !st2.players[0].discard.some(function (c) { return c.id === '01-yurina-o-n-6'; }));

  // ---- 对照：换一张没有「隙」的付与札，受命伤时不该被收起 ----
  const s3 = scene(['04-tokoyo-o-n-6'], { distance: 3, dust: 6 });
  const st3 = autoNabu(play(s3, '04-tokoyo-o-n-6')).state;
  E.rules.applyDamage(st3, 0, 0, 1, 'life');
  eq('对照：风舞台没有「隙」，受命伤后仍然留在付与区', st3.players[0].attachments.length, 1);

  // ---- 《隙》不该被"重组牌库"的命伤触发（规则：山札再構成以外的来源）----
  const s4 = scene(['01-yurina-o-n-6'], { distance: 3, dust: 6 });
  const st4 = autoNabu(play(s4, '01-yurina-o-n-6')).state;
  toDiscard(st4, 0, '01-yurina-o-n-1');       // 弃牌区要有通常札，重组才有意义
  const totalBefore = cardTotal(st4);
  const beforeAttach = st4.players[0].attachments.length;
  E.rules.reshuffle(st4, 0, true);            // 重组的代价：命 -1
  eq('《隙》：重组的命伤不该触发（牌该留在付与区）',
    st4.players[0].attachments.length, beforeAttach);
  eq('《隙》+ 重组：牌总数守恒（不能凭空少一张）', cardTotal(st4), totalBefore);
  if (st4.players[0].attachments.length !== beforeAttach || cardTotal(st4) !== totalBefore) {
    BUGS.push({
      title: '《隙》被"重组牌库"的命伤误触发，并把那张付与札吞掉',
      expect: '规则写的是「山札再構成以外的来源」：reshuffle 扣的 1 点命不该让《隙》发动，付与札连同其结晶应留在付与区',
      actual: 'applyDamage 里只要 lifeDmg > 0 就无条件 triggerGap；更糟的是 reshuffle 先算好 back 列表再扣命，' +
              '《隙》把牌塞进 p.hidden 之后又被 `p.hidden = []` 清空 → 这张牌既没进牌库也没进伏札，直接消失（牌数 -1）',
      where: 'engine/rules.js:362 无条件 triggerGap；engine/rules.js:111-131 reshuffle 的顺序问题',
      repro: '展开圧気 → 弃牌区放 1 张通常札 → E.rules.reshuffle(state, 0, true) → 付与区空了、牌总数少 1'
    });
  }
}

/* -------------------------------------------------------------------------
 * 07 気炎万丈（付与・纳4・全力）—— 【展开中】决死 → 其他女神的攻击 +1/+1 且超克
 * ---------------------------------------------------------------------- */
group('刀·気炎万丈（01-yurina-o-n-7）：决死时其他女神攻击 +1/+1 + 超克');
{
  /**
   * 展开気炎万丈（纳4，从虚取）并把"全力"的锁解开。
   * 为什么手动解 fullpowerUsed：这张牌是「付与＋全力」，本回合展开后就不能再动了，
   * 它的效果是"展开中"持续的 —— 真实的玩法是下个回合才拿别的女神的攻击去打。
   * startTurn 会清掉 fullpowerUsed，这里直接等价处理，避免顺带跑回合开始的一堆事。
   */
  function expanded(life) {
    const s = scene(['01-yurina-o-n-7'], { distance: 4, dust: 8, p0: { life: life } });
    const st = autoNabu(play(s, '01-yurina-o-n-7')).state;
    st.players[0].fullpowerUsed = false;     // 等价于"到了下一个回合"
    return st;
  }

  // ---- 决死：其他女神的攻击 +1/+1 且带超克 ----
  const st = expanded(3);
  eq('気炎万丈展开：纳 4 颗挂在牌上', st.players[0].attachments[0].crystals, 4);
  eq('展开从虚取 4 颗（8→4）', st.dust, 4);
  st.players[0].hand.push(cardById('02-saine-o-n-2'));       // 薙斬り（细音）3/1
  const r = play(st, '02-saine-o-n-2');
  ok('决死时气炎万丈在场，其他女神的薙斬り可以打出', r.ok, r.error);
  eq('决死：+1/+1 → 薙斬り 3/1 变成 4/2', dmg(r.state), [4, 2]);
  eq('决死：这次攻击获得「超克」', r.state.pending.chokoku, true);

  // ---- 非决死：什么都没有 ----
  const st4 = expanded(4);
  st4.players[0].hand.push(cardById('02-saine-o-n-2'));
  const r4 = play(st4, '02-saine-o-n-2');
  eq('命 4（非决死）：没有 +1/+1，仍是 3/1', dmg(r4.state), [3, 1]);
  eq('命 4（非决死）：没有超克', r4.state.pending.chokoku, false);

  // ---- 只对"其他女神"生效：刀自己的《攻击》不加 ----
  const stY = expanded(3);
  stY.players[0].hand.push(cardById('01-yurina-o-n-1'));     // 斬（刀）3/1
  const rY = play(stY, '01-yurina-o-n-1');
  eq('刀自己的斬不吃加成：仍 3/1', dmg(rY.state), [3, 1]);
  eq('刀自己的攻击没有超克', rY.state.pending.chokoku, false);

  // ---- 全力：展开这张牌之后，本回合不能再出别的牌 ----
  const sFull = scene(['01-yurina-o-n-7'], { distance: 4, dust: 8 });
  const rFull = autoNabu(play(sFull, '01-yurina-o-n-7'));
  eq('気炎万丈是《全力》：展开后进入全力行动', rFull.state.players[0].fullpowerUsed, true);
  rFull.state.players[0].hand.push(cardById('01-yurina-o-n-1'));
  ok('全力行动中不能再打《攻击》', !play(rFull.state, '01-yurina-o-n-1').ok);

  // ---- 付与会被每回合损耗，但只要还有结晶就仍然生效 ----
  const stTick = expanded(3);
  E.rules.tickAttachments(stTick, 0);
  eq('回合开始损耗 1 颗后还剩 3 颗', stTick.players[0].attachments[0].crystals, 3);
  stTick.players[0].hand.push(cardById('02-saine-o-n-2'));
  eq('还有结晶时加成效力不变', dmg(play(stTick, '02-saine-o-n-2').state), [4, 2]);
}

/* -------------------------------------------------------------------------
 * 08 月影落（3-4 / 4/4，费 7）—— 纯攻击，看费用门槛
 * ---------------------------------------------------------------------- */
group('刀·月影落（01-yurina-o-s-1）：3-4 / 4/4，费 7');
{
  const s = scene([], { distance: 3, p0: { flare: 7 } });
  giveSpecial(s, 0, '01-yurina-o-s-1');
  const r = play(s, '01-yurina-o-s-1');
  ok('气 7 时月影落可以打出', r.ok, r.error);
  eq('月影落伤害 4/4', dmg(r.state), [4, 4]);
  eq('王牌是特殊札（会影响雅打ち等"非切札"判定）', r.state.pending.fromSpecial, true);
  eq('付出的 7 点气进了虚', r.state.dust, 7);

  const s6 = scene([], { distance: 3, p0: { flare: 6 } });
  giveSpecial(s6, 0, '01-yurina-o-s-1');
  const r6 = play(s6, '01-yurina-o-s-1');
  ok('气 6 时不能打出（费 7）', !r6.ok, r6.error);
  eq('气不够时没有扣气', r6.state.players[0].flare, 6);

  const sOut = scene([], { distance: 5, p0: { flare: 7 } });
  giveSpecial(sOut, 0, '01-yurina-o-s-1');
  ok('间合 5 超出 3-4 → 打不出', !play(sOut, '01-yurina-o-s-1').ok);
}

/* -------------------------------------------------------------------------
 * 09 浦波嵐（王牌攻击・对应 0-10 / 2/-，费3）—— 对应时 -2/+0
 * ---------------------------------------------------------------------- */
group('刀·浦波嵐（01-yurina-o-s-2）：2/- 是攻击；对应时把对方攻击 -2/+0');
{
  // ---- 作为普通攻击：2/- ----
  const sa = scene([], { distance: 5, p0: { flare: 3 } });
  giveSpecial(sa, 0, '01-yurina-o-s-2');
  const ra = play(sa, '01-yurina-o-s-2');
  ok('浦波嵐可以作为攻击打出', ra.ok, ra.error);
  eq('浦波嵐的伤害是 2/-（命伤必须是 null）', dmg(ra.state), [2, null]);

  // ---- 作为对应：把被对应的攻击 -2/+0 ----
  const s = scene([], { distance: 3, hand1: ['01-yurina-o-n-1'], p0: { flare: 3 } });
  giveSpecial(s, 0, '01-yurina-o-s-2');
  s.active = 1;                                        // 让对方（P1）来打
  const atk = play(s, '01-yurina-o-n-1');
  eq('对方打出斬 3/1', dmg(atk.state), [3, 1]);
  const res = respondCard(atk.state, '01-yurina-o-s-2');
  ok('浦波嵐可以作为《对应》使用', res.ok, res.error);
  eq('浦波嵐 自己那一发先打（2/-）', dmg(res.state), [2, null]);
  const settle1 = settleResponse(res);
  eq('对应后：3-2 / 1 = 1/1', dmg(settle1.state), [1, 1]);

  const done = takeDamage(settle1.state, 'aura');
  ok('结算成功', done.ok, done.error);
  eq('P0 只掉了 1 点装（3-1=2）', done.state.players[0].aura, 2);
  eq('命没掉', done.state.players[0].life, 10);

  // ---- 气不够不能当对应用 ----
  const sPoor = scene([], { distance: 3, hand1: ['01-yurina-o-n-1'], p0: { flare: 2 } });
  giveSpecial(sPoor, 0, '01-yurina-o-s-2');
  sPoor.active = 1;
  const atkPoor = play(sPoor, '01-yurina-o-n-1');
  const poor = respondCard(atkPoor.state, '01-yurina-o-s-2');
  ok('气 2 不够付 3 → 不能拿浦波嵐对应', !poor.ok, poor.error);
}

/* -------------------------------------------------------------------------
 * 10 浮舟宿（王牌行动・费2）—— 虚(5)→自装；【即再起】决死
 * ---------------------------------------------------------------------- */
group('刀·浮舟宿（01-yurina-o-s-3）：虚5→装，决死时即再起');
{
  // 费和效果的先后顺序很重要：先付气（气→虚），再从虚搬到装
  const s = scene([], { dust: 5, p0: { flare: 2, aura: 0, life: 4 } });
  giveSpecial(s, 0, '01-yurina-o-s-3');
  const r = play(s, '01-yurina-o-s-3');
  ok('浮舟宿可以打出', r.ok, r.error);
  eq('虚 5 + 付的 2 点气 = 7，搬 5 颗到装 → 装 5（上限）', r.state.players[0].aura, 5);
  eq('虚剩下 2 颗', r.state.dust, 2);
  eq('付的 2 点气清零', r.state.players[0].flare, 0);

  // 装已经 4 颗时只能再收 1 颗（装上限 5，多出来的留在虚）
  const s2 = scene([], { dust: 5, p0: { flare: 2, aura: 4, life: 4 } });
  giveSpecial(s2, 0, '01-yurina-o-s-3');
  const r2 = play(s2, '01-yurina-o-s-3');
  eq('装 4 时只收得下 1 颗 → 装 5', r2.state.players[0].aura, 5);
  eq('虚 5+2-1 = 6', r2.state.dust, 6);

  // ---- 非决死：用掉就是用掉了 ----
  ok('命 4（非决死）→ 王牌保持"已使用"', r.state.players[0].specials
    .find(function (c) { return c.id === '01-yurina-o-s-3'; }).used === true);

  // ---- 【即再起】决死：一满足条件就立刻回到未使用 ----
  const s3 = scene([], { dust: 5, p0: { flare: 2, aura: 0, life: 3 } });
  giveSpecial(s3, 0, '01-yurina-o-s-3');
  const r3 = play(s3, '01-yurina-o-s-3');
  ok('命 3（决死）时浮舟宿可以用', r3.ok, r3.error);
  eq('【即再起】决死 → 打完立刻回到未使用', r3.state.players[0].specials
    .find(function (c) { return c.id === '01-yurina-o-s-3'; }).used, false);

  // 同一张牌在同一个回合里还能再用一次（即再起是真即时）
  r3.state.players[0].flare = 2;
  r3.state.dust = 5;
  const again = play(r3.state, '01-yurina-o-s-3');
  ok('【即再起】之后同一回合可以再用一次', again.ok, again.error);
}

/* -------------------------------------------------------------------------
 * 11 天音揺波の底力（王牌攻击・全力 1-4 / 5/5，费5）—— 非决死不能用
 * ---------------------------------------------------------------------- */
group('刀·天音揺波の底力（01-yurina-o-s-4）：非决死时不能使用');
{
  // 非决死：直接用不了（不是"打出来没伤害"，是使用被禁止）
  const s = scene(['01-yurina-o-s-4'], { distance: 3, p0: { flare: 5, life: 4 } });
  const r = play(s, '01-yurina-o-s-4');
  ok('命 4（非决死）时底力不能使用', !r.ok, r.error);
  ok('报错说的是"决死未达成"', /决死/.test(r.error || ''), r.error);
  eq('被拒绝时不扣气', r.state.players[0].flare, 5);
  eq('被拒绝时没有生成攻击', r.state.pending, null);

  // 决死：可以用，5/5
  const s3 = scene(['01-yurina-o-s-4'], { distance: 3, p0: { flare: 5, life: 3 } });
  const r3 = play(s3, '01-yurina-o-s-4');
  ok('命 3（决死）时底力可以用', r3.ok, r3.error);
  eq('底力伤害 5/5', dmg(r3.state), [5, 5]);
  eq('底力的适正距离 1-4', r3.state.pending.range, [1, 2, 3, 4]);

  // 距离也要对：间合 5 超出 1-4
  const sOut = scene(['01-yurina-o-s-4'], { distance: 5, p0: { flare: 5, life: 3 } });
  ok('间合 5 超出 1-4 → 打不出', !play(sOut, '01-yurina-o-s-4').ok);
}


/* ============================================================================
 * 三、扇（tokoyo）
 * ========================================================================== */

/* -------------------------------------------------------------------------
 * 12 梳流し（4 / -/1）—— 气伤是「-」；【攻击后】境地 → 回牌库顶
 * ---------------------------------------------------------------------- */
group('扇·梳流し（04-tokoyo-o-n-1）：-/1，境地时打完回牌库顶');
{
  // ---- 伤害里的「-」：只有命伤，装伤不能选 ----
  const s = scene(['04-tokoyo-o-n-1'], { distance: 4 });
  const r = play(s, '04-tokoyo-o-n-1');
  ok('间合 4 可以打出（适正 4）', r.ok, r.error);
  eq('梳流し的伤害是 -/1（装伤必须是 null）', dmg(r.state), [null, 1]);

  const mid = noRespond(r.state);
  const bad = takeDamage(mid.state, 'aura');
  ok('「-」的装伤不能选', !bad.ok, bad.error);
  ok('“装不够/没有这条伤害”的拒绝理由', /装/.test(bad.error || ''), bad.error);

  const good = takeDamage(mid.state, 'life');
  ok('只能吃命：可以用', good.ok, good.error);
  eq('对方命 10→9', good.state.players[1].life, 9);

  // ---- 境地（集中力=2）：【攻击后】把这张牌放回牌库顶 ----
  const sK = scene(['04-tokoyo-o-n-1'], { distance: 4, p0: { focus: 2 } });
  const deckTopBefore = sK.players[0].deck.length;
  const doneK = swing(sK, '04-tokoyo-o-n-1', 'life');
  eq('境地：【攻击后】放回牌库顶（牌库第一张就是它）',
    doneK.state.players[0].deck[0].id, '04-tokoyo-o-n-1');
  eq('境地：牌库多 1 张（从弃牌区回收）', doneK.state.players[0].deck.length, deckTopBefore + 1);
  ok('境地：弃牌区里不再有这张牌',
    !doneK.state.players[0].discard.some(function (c) { return c.id === '04-tokoyo-o-n-1'; }));

  // ---- 集中力 1（非境地）：不回牌库，正常进弃牌区 ----
  const sN = scene(['04-tokoyo-o-n-1'], { distance: 4, p0: { focus: 1 } });
  const deckN = sN.players[0].deck.length;
  const doneN = swing(sN, '04-tokoyo-o-n-1', 'life');
  eq('非境地：牌库张数不变', doneN.state.players[0].deck.length, deckN);
  ok('非境地：这张牌留在弃牌区',
    doneN.state.players[0].discard.some(function (c) { return c.id === '04-tokoyo-o-n-1'; }));
}

/* -------------------------------------------------------------------------
 * 13 雅打ち（2-4 / 2/1，对应）—— 境地时打消非王牌的攻击
 * ---------------------------------------------------------------------- */
group('扇·雅打ち（04-tokoyo-o-n-2）：境地时打消"非王牌"的攻击');
{
  // ---- 作为普通攻击 2/1 ----
  const sAtk = scene(['04-tokoyo-o-n-2'], { distance: 3 });
  const rAtk = play(sAtk, '04-tokoyo-o-n-2');
  ok('间合 3 可以当攻击打出（适正 2-4）', rAtk.ok, rAtk.error);
  eq('雅打ち的伤害 2/1', dmg(rAtk.state), [2, 1]);

  // ---- 境地：打消对方通常札的攻击 ----
  // 注意：这里 P1 负责打人、P0 负责对应，所以「境地（集中力=2）」是 **P0** 的条件
  const s = scene(['04-tokoyo-o-n-2'], { distance: 3, hand1: ['01-yurina-o-n-1'], p0: { focus: 2 } });
  s.active = 1;
  const atk = play(s, '01-yurina-o-n-1');
  ok('对方打出斬', atk.ok, atk.error);
  const res = respondCard(atk.state, '04-tokoyo-o-n-2');
  ok('雅打ち可以对应', res.ok, res.error);
  const settled = settleResponse(res);
  eq('境地：这次攻击被完全打消（没有待结算攻击）', settled.state.pending, null);
  ok('打消时发出了 cancel 事件（界面要靠它播动画）',
    settled.state.events.some(function (e) { return e.type === 'cancel'; }));
  // 雅打ち 自己那发 2/1 打在攻击方 P0 身上 → 装 3 → 1；命没掉
  // 雅打ち 自己那发 2/1 打在"攻击方 P1"身上
  eq('P1 被雅打ち 打掉 2 点装', settled.state.players[1].aura, 1);
  eq('P0 的命和装都没事', [settled.state.players[0].life, settled.state.players[0].aura], [10, 3]);

  // ---- 非境地（集中力 1）：打不掉，伤害照常 ----
  const s1 = scene(['04-tokoyo-o-n-2'], { distance: 3, hand1: ['01-yurina-o-n-1'], p0: { focus: 1 } });
  s1.active = 1;
  const atk1 = play(s1, '01-yurina-o-n-1');
  const res1 = respondCard(atk1.state, '04-tokoyo-o-n-2');
  ok('集中力 1（非境地）时雅打ち仍可对应（只是打不掉）', res1.ok, res1.error);
  const set1 = settleResponse(res1);
  ok('非境地：攻击没有被打消，还在等结算', !!set1.state.pending);
  const take1 = takeDamage(set1.state, 'life');
  eq('非境地：命照吃 10→9', take1.state.players[0].life, 9);

  // ---- 王牌攻击：境地也打不掉 ----
  const sSp = scene(['04-tokoyo-o-n-2'], { distance: 3, p1: { flare: 7 }, p0: { focus: 2 } });
  giveSpecial(sSp, 1, '01-yurina-o-s-1');           // 月影落（王牌攻击 3-4）
  sSp.active = 1;
  const atkSp = play(sSp, '01-yurina-o-s-1');
  ok('对方打出王牌攻击月影落', atkSp.ok, atkSp.error);
  const resSp = respondCard(atkSp.state, '04-tokoyo-o-n-2');
  ok('雅打ち仍能使用', resSp.ok, resSp.error);
  const setSp = settleResponse(resSp);
  ok('王牌（切札）攻击打不掉：待结算攻击还在', !!setSp.state.pending);
  eq('伤害也没被改：仍是 4/4', dmg(setSp.state), [4, 4]);
}

/* -------------------------------------------------------------------------
 * 14 跳ね兎（行动）—— 间合 ≤3 时 虚→间合 2 颗
 * ---------------------------------------------------------------------- */
group('扇·跳ね兎（04-tokoyo-o-n-3）：间合 ≤3 才把虚搬到间合');
{
  const s = scene(['04-tokoyo-o-n-3'], { distance: 3, dust: 5 });
  const r = play(s, '04-tokoyo-o-n-3');
  ok('间合 3 可以打出', r.ok, r.error);
  eq('虚→间合 2 颗：间合 3→5', r.state.distance, 5);
  eq('虚 5→3', r.state.dust, 3);
  ok('这牌进了弃牌区（行动牌用完就丢）',
    r.state.players[0].discard.some(function (c) { return c.id === '04-tokoyo-o-n-3'; }));

  // 边界：间合 2 也可以，只能搬 1 颗（间合满了就收不下）
  const s2 = scene(['04-tokoyo-o-n-3'], { distance: 2, dust: 5 });
  eq('间合 2 时也只能搬到现有的量', play(s2, '04-tokoyo-o-n-3').state.distance, 4);

  // 不满足：间合 4 → 什么都不发生
  const s4 = scene(['04-tokoyo-o-n-3'], { distance: 4, dust: 5 });
  const r4 = play(s4, '04-tokoyo-o-n-3');
  ok('间合 4 时仍然可以打出（只是没效果）', r4.ok, r4.error);
  eq('间合 4：间合没变', r4.state.distance, 4);
  eq('间合 4：虚没动', r4.state.dust, 5);
}

/* -------------------------------------------------------------------------
 * 15 詩舞（行动・对应）—— +1 集中力，然后选一项搬 1 颗
 * ---------------------------------------------------------------------- */
group('扇·詩舞（04-tokoyo-o-n-4）：+1 集中力 + 二选一');
{
  // ---- 选「自气→自装」----
  const s = scene(['04-tokoyo-o-n-4'], { distance: 5, p0: { focus: 0, flare: 3, aura: 3 } });
  const r = play(s, '04-tokoyo-o-n-4');
  ok('詩舞可以打出', r.ok, r.error);
  eq('詩舞：集中力 0→1', r.state.players[0].focus, 1);
  eq('詩舞：弹出二选一', r.state.choice && r.state.choice.sourceId, 'shibu');
  eq('詩舞：两个选项都在',
    (r.state.choice.options || []).slice().sort(), ['aura_to_dist', 'flare_to_aura']);

  const f2a = act(r.state, { type: 'choose', player: 0, option: 'flare_to_aura' });
  ok('选「自气→自装」成功', f2a.ok, f2a.error);
  eq('气 3→2', f2a.state.players[0].flare, 2);
  eq('装 3→4', f2a.state.players[0].aura, 4);
  eq('选完清空选择', f2a.state.choice, null);

  // ---- 选「自装→间合」----
  const s2 = scene(['04-tokoyo-o-n-4'], { distance: 5, p0: { focus: 1, aura: 3 } });
  const r2 = play(s2, '04-tokoyo-o-n-4');
  ok('集中力 1 时詩舞让集中力到 2（境地）', r2.ok && r2.state.players[0].focus === 2, r2.error);
  const a2d = act(r2.state, { type: 'choose', player: 0, option: 'aura_to_dist' });
  ok('选「自装→间合」成功', a2d.ok, a2d.error);
  eq('装 3→2', a2d.state.players[0].aura, 2);
  eq('间合 5→6', a2d.state.distance, 6);

  // ---- 不满足：乱选一个不存在的选项 → 被拒绝，且状态不动 ----
  const s3 = scene(['04-tokoyo-o-n-4'], { distance: 5, p0: { focus: 0, flare: 3 } });
  const r3 = play(s3, '04-tokoyo-o-n-4');
  const bogus = act(r3.state, { type: 'choose', player: 0, option: 'not_an_option' });
  ok('詩舞：不存在的选项被拒绝', !bogus.ok, bogus.error);
  eq('被拒绝后气没动', bogus.state.players[0].flare, 3);

  // ---- 集中力到顶：已經是 2 时詩舞只给选择、不再加集中力 ----
  const sTop = scene(['04-tokoyo-o-n-4'], { distance: 5, p0: { focus: 2, aura: 3 } });
  eq('集中力已是 2 时不再增加', play(sTop, '04-tokoyo-o-n-4').state.players[0].focus, 2);
}

/* -------------------------------------------------------------------------
 * 16 要返し（行动・全力）—— 弃牌/伏札至多 2 张放牌库底；虚→装 2
 * ---------------------------------------------------------------------- */
group('扇·要返し（04-tokoyo-o-n-5）：至多 2 张放牌库底 + 虚→装 2');
{
  const s = scene(['04-tokoyo-o-n-5'], { distance: 5, dust: 5, p0: { aura: 0 } });
  const c1 = toDiscard(s, 0, '01-yurina-o-n-1');
  const c2 = toDiscard(s, 0, '01-yurina-o-n-2');
  const c3 = toDiscard(s, 0, '01-yurina-o-n-3');
  s.players[0].hidden.push(cardById('01-yurina-o-n-4'));
  const deckBefore = s.players[0].deck.length;
  const totalBefore = cardTotal(s);

  const r = play(s, '04-tokoyo-o-n-5');
  ok('要返し可以打出（全力行动里）', r.ok, r.error);
  const st = r.state;
  eq('牌库 +2 张（两张被放到牌库底）', st.players[0].deck.length, deckBefore + 2);
  eq('牌库最底是第 1 张被移的牌', st.players[0].deck[deckBefore].id, c1.id);
  eq('牌库次底是第 2 张它', st.players[0].deck[deckBefore + 1].id, c2.id);
  // 引擎的实现细节：打出的这张《要返し》自己先进了弃牌区，也在"至多 2 张"的候选池里，
  // 所以弃牌区最后剩的是「柄打ち + 要返し」两张，而不是一张。
  eq('弃牌区剩下「没被搬走的柄打ち」+「刚打出的要返し」两张', st.players[0].discard.length, 2);
  eq('没被搬走的那张是柄打ち', st.players[0].discard[0].id, c3.id);
  eq('刚打出的要返し也还在弃牌区里', st.players[0].discard[1].id, '04-tokoyo-o-n-5');
  eq('伏札区没被动（至多 2 张已经用完了）', st.players[0].hidden.length, 1);
  eq('虚→自装 2 颗：装 0→2', st.players[0].aura, 2);
  eq('虚 5→3', st.dust, 3);
  eq('牌总数守恒（搬牌不会凭空多/少）', cardTotal(st), totalBefore);

  // ---- 「至多 2 张」的边界：候选池只有 1 张时只搬 1 张，不报错、也不凭空补 ----
  const s1 = scene(['04-tokoyo-o-n-5'], { distance: 5, dust: 0, p0: { aura: 3 } });
  const deck1 = s1.players[0].deck.length;
  const r1 = play(s1, '04-tokoyo-o-n-5');
  ok('候选只有 1 张时也能打', r1.ok, r1.error);
  eq('只搬 1 张：牌库 +1', r1.state.players[0].deck.length, deck1 + 1);
  eq('弃牌区空了', r1.state.players[0].discard.length, 0);
  eq('牌库底就是这张要返し（它自己也在候选池里）',
    r1.state.players[0].deck[r1.state.players[0].deck.length - 1].id, '04-tokoyo-o-n-5');
  eq('虚是 0 → 装不动', r1.state.players[0].aura, 3);

  // ---- 全力：打完这一张，本回合就不能再做别的事 ----
  ok('要返し是《全力》→ 进入全力行动', st.players[0].fullpowerUsed === true);
  st.players[0].hand.push(cardById('01-yurina-o-n-1'));
  const after = play(st, '01-yurina-o-n-1');
  ok('全力行动之后不能再出牌', !after.ok, after.error);

  // ---- 反过来：本回合已经行动过，就不能用《全力》卡 ----
  const sBusy = scene(['01-yurina-o-n-1', '04-tokoyo-o-n-5'], { distance: 3 });
  const used = swing(sBusy, '01-yurina-o-n-1', 'life');
  ok('先打了一张斬', used.ok, used.error);
  const late = play(used.state, '04-tokoyo-o-n-5');
  ok('已经行动过 → 这个回合不能用《全力》的要返し', !late.ok, late.error);
}

/* -------------------------------------------------------------------------
 * 17 風舞台（付与・纳2）—— 展开时 间合→装 2；破弃时 装→间合 2
 * ---------------------------------------------------------------------- */
group('扇·風舞台（04-tokoyo-o-n-6）：展开 间合→装2，破弃 装→间合2');
{
  // ---- 展开时：间合 → 自装 2 颗 ----
  const s = scene(['04-tokoyo-o-n-6'], { distance: 8, dust: 5, p0: { aura: 0 } });
  const r = autoNabu(play(s, '04-tokoyo-o-n-6'));
  ok('風舞台可以展开（付与・纳2）', r.ok, r.error);
  eq('展开时：间合 8→6', r.state.distance, 6);
  eq('展开时：装 0→2', r.state.players[0].aura, 2);
  eq('纳 2 颗挂在牌上', r.state.players[0].attachments[0].crystals, 2);

  // ---- 展开时间合不够：只移现有的（不能凭空变出结晶）----
  const sLow = scene(['04-tokoyo-o-n-6'], { distance: 1, dust: 5, p0: { aura: 0 } });
  const rLow = autoNabu(play(sLow, '04-tokoyo-o-n-6'));
  eq('间合只有 1 → 只能搬 1 颗：间合 1→0', rLow.state.distance, 0);
  eq('装 0→1', rLow.state.players[0].aura, 1);

  // ---- 破弃时：自装 → 间合 2 颗 ----
  let st = E.state.clone(r.state);
  st.players[0].attachments[0].crystals = 1;      // 只剩 1 颗 → 下次损耗就破弃
  const dustBefore = st.dust;
  E.rules.tickAttachments(st, 0);
  eq('结晶耗尽 → 破弃（付与区清空）', st.players[0].attachments.length, 0);
  eq('破弃时：装 2→0', st.players[0].aura, 0);
  eq('破弃时：间合 6→8', st.distance, 8);
  eq('那颗结晶按规则先进了虚', st.dust, dustBefore + 1);
  ok('破弃的牌进了弃牌区',
    st.players[0].discard.some(function (c) { return c.id === '04-tokoyo-o-n-6'; }));

  // ---- 破弃时自装不足：只移现有的 ----
  const sP = scene(['04-tokoyo-o-n-6'], { distance: 8, dust: 5, p0: { aura: 0 } });
  let stP = autoNabu(play(sP, '04-tokoyo-o-n-6')).state;   // 装=2，间合=6
  stP.players[0].aura = 1;                                  // 人为把装降到 1
  stP.players[0].attachments[0].crystals = 1;
  E.rules.tickAttachments(stP, 0);
  eq('自装只有 1 颗 → 间合只 +1（6→7）', stP.distance, 7);
  eq('装归 0', stP.players[0].aura, 0);
}

/* -------------------------------------------------------------------------
 * 18 晴舞台（付与・纳2・终端）—— 展开时集中力=2；破弃时 3-6 / -/1
 * ---------------------------------------------------------------------- */
group('扇·晴舞台（04-tokoyo-o-n-7）：集中力变 2 + 终端；破弃打 -/1');
{
  // ---- 展开时：集中力直接变 2 ----
  const s = scene(['04-tokoyo-o-n-7'], { distance: 4, dust: 5, p0: { focus: 0 } });
  const r = autoNabu(play(s, '04-tokoyo-o-n-7'));
  ok('晴舞台可以展开', r.ok, r.error);
  eq('展开时：集中力 0→2', r.state.players[0].focus, 2);
  eq('纳 2 颗挂在牌上', r.state.players[0].attachments[0].crystals, 2);

  // ---- 终端：展开后本回合不能再出牌 / 做基本动作 ----
  eq('终端标记被置上', r.state.players[0].terminated, true);
  r.state.players[0].hand.push(cardById('01-yurina-o-n-1'));
  const after = play(r.state, '01-yurina-o-n-1');
  ok('终端：不能再出牌', !after.ok, after.error);
  const noBasic = act(r.state, { type: 'basic', player: 0, which: 'retreat' });
  ok('终端：不能做基本动作', !noBasic.ok, noBasic.error);

  // ---- 破弃时：3-6 / -/1 的攻击 ----
  let st = E.state.clone(r.state);
  st.players[0].attachments[0].crystals = 1;
  E.rules.tickAttachments(st, 0);
  ok('破弃 → 生成【破弃时】的攻击', !!st.pending);
  eq('破弃攻击是「晴舞台（破弃）」', st.pending && st.pending.cardName, '晴舞台（破弃）');
  eq('伤害 -/1（装伤是 null）', dmg(st), [null, 1]);
  eq('适正距离 3-6', st.pending.range, [3, 4, 5, 6]);
  ok('破弃的牌进了弃牌区',
    st.players[0].discard.some(function (c) { return c.id === '04-tokoyo-o-n-7'; }));

  // ---- 破弃时间合不对：0 伤害、无事发生 ----
  const sFar = scene(['04-tokoyo-o-n-7'], { distance: 4, dust: 5 });
  let stFar = autoNabu(play(sFar, '04-tokoyo-o-n-7')).state;
  stFar.distance = 7;                       // 7 不在 3-6
  stFar.players[0].attachments[0].crystals = 1;
  E.rules.tickAttachments(stFar, 0);
  ok('间合 7 超出 3-6 → 破弃攻击不发生', !stFar.pending);
  ok('付与札本身还是正常破弃了', stFar.players[0].attachments.length === 0);
}

/* -------------------------------------------------------------------------
 * 19 久遠ノ花（王牌攻击・对应 0-10 / -/1，费5）—— 对应时打消攻击
 * ---------------------------------------------------------------------- */
group('扇·久遠ノ花（04-tokoyo-o-s-1）：对应时打消攻击');
{
  // ---- 作为普通攻击：-/1 ----
  const sAtk = scene([], { distance: 5, p0: { flare: 5 } });
  giveSpecial(sAtk, 0, '04-tokoyo-o-s-1');
  const rAtk = play(sAtk, '04-tokoyo-o-s-1');
  ok('久遠ノ花可以作为攻击打出', rAtk.ok, rAtk.error);
  eq('久遠ノ花的伤害是 -/1', dmg(rAtk.state), [null, 1]);

  // ---- 作为对应：打消对方的攻击 ----
  const s = scene([], { distance: 3, hand1: ['01-yurina-o-n-1'], p0: { flare: 5 } });
  giveSpecial(s, 0, '04-tokoyo-o-s-1');
  s.active = 1;
  const atk = play(s, '01-yurina-o-n-1');
  ok('对方打出斬', atk.ok, atk.error);
  const res = respondCard(atk.state, '04-tokoyo-o-s-1');
  ok('久遠ノ花可以对应', res.ok, res.error);
  const setK = settleResponse(res);
  eq('对应后攻击被完全打消：没有待结算攻击', setK.state.pending, null);
  // 久遠ノ花 自己那发 -/1 打在攻击方 P1 身上
  eq('P1 被久遠ノ花 打掉 1 点命', setK.state.players[1].life, 9);
  eq('P0 的命和装都没事', [setK.state.players[0].life, setK.state.players[0].aura], [10, 3]);
  eq('付了 5 点气', setK.state.players[0].flare, 0);

  // ---- 对王牌攻击一样能打消（卡面没有"非切札"限制）----
  const sSp = scene([], { distance: 3, p1: { flare: 7 }, p0: { flare: 5 } });
  giveSpecial(sSp, 1, '01-yurina-o-s-1');
  giveSpecial(sSp, 0, '04-tokoyo-o-s-1');
  sSp.active = 1;
  const atkSp = play(sSp, '01-yurina-o-s-1');
  ok('对方打出王牌攻击月影落', atkSp.ok, atkSp.error);
  const resSp = respondCard(atkSp.state, '04-tokoyo-o-s-1');
  ok('对王牌攻击也能对应', resSp.ok, resSp.error);
  const setKSp = settleResponse(resSp);
  eq('王牌攻击也被打消了', setKSp.state.pending, null);

  // ---- 气不够：不能当对应用 ----
  const sPoor = scene([], { distance: 3, hand1: ['01-yurina-o-n-1'], p0: { flare: 4 } });
  giveSpecial(sPoor, 0, '04-tokoyo-o-s-1');
  sPoor.active = 1;
  const atkPoor = play(sPoor, '01-yurina-o-n-1');
  ok('气 4 不够付 5 → 不能拿久遠ノ花对应', !respondCard(atkPoor.state, '04-tokoyo-o-s-1').ok);
}

/* -------------------------------------------------------------------------
 * 20 千歳ノ鳥（王牌攻击 3-4 / 2/2，费2）—— 【攻击后】重组牌库（不受焦燥伤害）
 * ---------------------------------------------------------------------- */
group('扇·千歳ノ鳥（04-tokoyo-o-s-2）：攻击后重组牌库，且不吃焦燥伤害');
{
  const s = scene([], { distance: 3, p0: { flare: 2 } });
  giveSpecial(s, 0, '04-tokoyo-o-s-2');
  const c1 = toDiscard(s, 0, '01-yurina-o-n-1');
  const c2 = toDiscard(s, 0, '01-yurina-o-n-2');
  s.players[0].hidden.push(cardById('01-yurina-o-n-3'));
  const deckBefore = s.players[0].deck.length;

  const r = play(s, '04-tokoyo-o-s-2');
  ok('千歳ノ鳥可以打出（3-4）', r.ok, r.error);
  eq('千歳ノ鳥的伤害 2/2', dmg(r.state), [2, 2]);

  // 牌已经打出去了，这里只把这次攻击走完（放弃对应 → 选命）
  const mid = noRespond(r.state);
  const fin = takeDamage(mid.state, 'life');
  ok('千歳ノ鳥打完', fin.ok, fin.error);
  const st = fin.state;
  eq('【攻击后】重组：弃牌区清空', st.players[0].discard.length, 0);
  eq('【攻击后】重组：伏札区也清空', st.players[0].hidden.length, 0);
  eq('【攻击后】重组：3 张牌回到牌库（牌库 +3）', st.players[0].deck.length, deckBefore + 3);
  eq('重组不吃焦燥伤害：命还是 10', st.players[0].life, 10);
  ok('重组会把那两张弃牌洗回去', st.players[0].deck
    .some(function (c) { return c.id === c1.id; }) &&
    st.players[0].deck.some(function (c) { return c.id === c2.id; }));
}

/* -------------------------------------------------------------------------
 * 21 無窮ノ風（王牌攻击 3-8 / 1/1，费1）—— 不可被对应；命中后对方弃非攻击牌
 * ---------------------------------------------------------------------- */
group('扇·無窮ノ風（04-tokoyo-o-s-3）：不可被对应 + 对手弃 1 张非攻击牌');
{
  const s = scene([], {
    distance: 3, p0: { flare: 1 },
    hand1: ['02-saine-o-n-2', '04-tokoyo-o-n-3']    // 薙斬り（攻击+对应）/ 跳ね兎（行动）
  });
  const bird = giveSpecial(s, 0, '04-tokoyo-o-s-3');
  const r = play(s, '04-tokoyo-o-s-3');
  ok('無窮ノ風可以打出（3-8 / 费1）', r.ok, r.error);
  eq('不可被对应', r.state.pending.noRespond, true);
  eq('伤害 1/1', dmg(r.state), [1, 1]);

  // ---- 对手想拿"带对应的攻击牌"来对应，被拒绝 ----
  const blocked = respondCard(r.state, '02-saine-o-n-2');
  ok('不可被对应：对方不能拿薙斬り对应', !blocked.ok, blocked.error);

  // ---- 【攻击后】对手弃 1 张"非攻击"手牌 ----
  const mid = noRespond(r.state);
  const fin = takeDamage(mid.state, 'life');
  ok('無窮ノ風打完', fin.ok, fin.error);
  eq('对方只掉了 1 点命', fin.state.players[1].life, 9);
  eq('对手的"非攻击"手牌（跳ね兎）被弃掉', fin.state.players[1].discard.length, 1);
  eq('被弃掉的确实是跳ね兎', fin.state.players[1].discard[0].id, '04-tokoyo-o-n-3');
  eq('攻击牌（薙斬り）留在手上', fin.state.players[1].hand.length, 1);
  eq('留下的就是薙斬り', fin.state.players[1].hand[0].id, '02-saine-o-n-2');

  // ---- 对方手牌全是攻击牌：什么都不弃（公开手牌）----
  const sAll = scene([], { distance: 3, p0: { flare: 1 }, hand1: ['02-saine-o-n-2'] });
  giveSpecial(sAll, 0, '04-tokoyo-o-s-3');
  const rAll = play(sAll, '04-tokoyo-o-s-3');
  const midAll = noRespond(rAll.state);
  const finAll = takeDamage(midAll.state, 'life');
  eq('全是攻击牌 → 不弃牌', finAll.state.players[1].discard.length, 0);
  eq('手牌原样保留', finAll.state.players[1].hand.length, 1);

  // ---- 【再起】境地（集中力=2）----
  const afterPlay = fin.state;
  eq('用掉之后是"已使用"', afterPlay.players[0].specials
    .find(function (c) { return c.id === '04-tokoyo-o-s-3'; }).used, true);
  const focus2 = E.state.clone(afterPlay);
  focus2.players[0].focus = 2;
  E.rules.tryRevive(focus2, 0, 'normal');
  eq('【再起】境地：集中力 2 → 回到未使用', focus2.players[0].specials
    .find(function (c) { return c.id === '04-tokoyo-o-s-3'; }).used, false);

  const focus1 = E.state.clone(afterPlay);
  focus1.players[0].focus = 1;
  E.rules.tryRevive(focus1, 0, 'normal');
  eq('【再起】非境地（集中力 1）→ 不再起', focus1.players[0].specials
    .find(function (c) { return c.id === '04-tokoyo-o-s-3'; }).used, true);
}

/* -------------------------------------------------------------------------
 * 22 常世ノ月（王牌行动・费2）—— 自集中力=2、敌集中力=0、对手畏缩
 * ---------------------------------------------------------------------- */
group('扇·常世ノ月（04-tokoyo-o-s-4）：自集中力2、敌集中力0、对手畏缩');
{
  const s = scene(['04-tokoyo-o-s-4'], { distance: 5, p0: { flare: 2, focus: 0 }, p1: { focus: 2 } });
  const r = play(s, '04-tokoyo-o-s-4');
  ok('常世ノ月可以打出', r.ok, r.error);
  eq('自己的集中力变成 2', r.state.players[0].focus, 2);
  eq('对手的集中力变成 0', r.state.players[1].focus, 0);
  eq('对手畏缩', r.state.players[1].staggered, true);
  eq('付了 2 点气', r.state.players[0].flare, 0);
  ok('畏缩发了事件（界面要画图标）',
    r.state.events.some(function (e) { return e.type === 'stagger'; }));

  // ---- 条件不满足：气不够就用不了 ----
  const sPoor = scene(['04-tokoyo-o-s-4'], { distance: 5, p0: { flare: 1 }, p1: { focus: 2 } });
  const rPoor = play(sPoor, '04-tokoyo-o-s-4');
  ok('气 1 不够付 2 → 不能打常世ノ月', !rPoor.ok, rPoor.error);
  eq('被拒绝时对手的集中力没被清掉', rPoor.state.players[1].focus, 2);
  eq('被拒绝时对手没有畏缩', rPoor.state.players[1].staggered, false);

  // ---- 对照：集中力已经是 2 时不会变成别的数 ----
  const sTop = scene(['04-tokoyo-o-s-4'], { distance: 5, p0: { flare: 2, focus: 2 }, p1: { focus: 0 } });
  eq('自己本来就是 2 → 还是 2', play(sTop, '04-tokoyo-o-s-4').state.players[0].focus, 2);
}


/* ============================================================================
 * 四、汇总 + BUG 清单
 * ========================================================================== */
if (BUGS.length) {
  console.log('\n================ 发现的引擎问题（期望 / 实际 / 复现）================');
  BUGS.forEach(function (b, i) {
    console.log('\n[' + (i + 1) + '] ' + b.title);
    console.log('  期望：' + b.expect);
    console.log('  实际：' + b.actual);
    console.log('  位置：' + b.where);
    console.log('  复现：' + b.repro);
  });
  console.log('\n（上面每一条都对应本文件里"会失败"的断言，没有改成迁就当前实现。）');
}

report();
