/* ============================================================
 * tests/spec_combat.js —— 白盒测试：攻击与伤害结算
 * ============================================================
 *
 * 覆盖任务清单 1–18：
 *    1  普通攻击全流程：出牌 → 对应时机 → 不对应 → 选气/选命
 *    2  气伤超过装的数量时不能选气
 *    3  气伤上限 5
 *    4  「-」与「0」的区别
 *    5  both（フルバースト）：两种都吃，装不足按现有的扣
 *    6  用对应牌对应 → 减伤生效
 *    7  王牌当对应要付气，付不出气时不能选
 *    8  不可被对应（noRespond）
 *    9  石突当对应：先打自己的 2/1，再【攻击后】，最后原攻击（嵌套解决）
 *   10  对应后距离变了 → 原攻击打空（适正距离再确认）
 *   11  打消（雅打ち）：非王牌可以打消，王牌打不掉
 *   12  终端（晴舞台）：用后只能结束回合
 *   13  全力（居合）：时机限制 + 用后只能结束回合
 *   14  距离扩大（気迫）：给下一发非王牌攻击，王牌不吃
 *   15  攻击后生成的攻击（八方振り）
 *   16  多段攻击（律動弧戟）
 *   17  破弃时的攻击（衝音晶）
 *   18  装伤分配（無音壁）+ 结晶守恒
 *   19  结晶守恒：连打 5 发，每一步都查
 *
 * 另外 20–22 是**本次写测试时发现的引擎问题**（已被引擎侧修好）：
 * 断言按官方规则保留为回归测试，防止再退回去；每组注释里都写了
 * 「复现 / 期望 / 当时的实际」。
 *
 * 写法约定：
 *   - 推演一律走 Engine.actions.applyAction（界面同一入口）；
 *   - 造数值（装 / 气 / 间合）时**搬结晶**而不是直接赋新值，
 *     这样"结晶总数恒为 36"这条守恒断言才有意义；
 *   - 断言说明用中文。
 * ============================================================ */
const H = require('./harness');
const { E, ok, eq, group, report, fresh, withHand, cardById, autoNabu, endTurnAuto, cardTotal, settleResponse } = H;

const A = E.actions.applyAction;

/* ============================================================
 * 白盒小工具
 * ============================================================ */

/** 适正距离列表 → 从小到大的字符串（比较时不看引擎内部的排列顺序） */
function rangeStr(list) {
  return (list || []).slice().sort(function (a, b) { return a - b; }).join(',');
}

/**
 * 场上樱花结晶总数。
 * 36 = 双方(命 10 + 装 3) + 间合 10 + 虚 0；付与札上的结晶也是这 36 颗的一部分。
 * 任何操作（伤害、付与、破弃、支付王牌费用……）都不允许让这个数字变。
 */
function crystals(s) {
  let n = (s.dust || 0) + (s.distance || 0);
  s.players.forEach(function (p) {
    n += p.life + p.aura + p.flare;
    (p.attachments || []).forEach(function (a) { n += (a.crystals || 0); });
  });
  return n;
}
/** 每个场景收尾都查一次守恒（任务 18） */
function eqc(s, label) {
  const n = crystals(s);
  ok(label + ' · 结晶总数仍为 36', n === 36, n);
}

/** 把虚（不够就间合）里的结晶搬进某人的数值区域：白盒造数值，总数不变 */
function give(s, who, area, n) {
  const p = s.players[who];
  for (let i = 0; i < n; i++) {
    if (s.dust > 0) s.dust -= 1;
    else if (s.distance > 0) s.distance -= 1;
    else throw new Error('没有结晶可以搬进 ' + area);
    p[area] += 1;
  }
}
/** 把某人数值区域里的结晶搬回虚（总数不变） */
function toDust(s, who, area, n) {
  const p = s.players[who];
  for (let i = 0; i < n; i++) { p[area] -= 1; s.dust += 1; }
}
/** 让某人某数值区域正好等于 n（靠搬结晶，不凭空造） */
function setNum(s, who, area, n) {
  const p = s.players[who];
  if (p[area] < n) give(s, who, area, n - p[area]);
  else if (p[area] > n) toDust(s, who, area, p[area] - n);
}
/** 让间合正好等于 n（靠搬结晶） */
function setDist(s, n) {
  while (s.distance > n) { s.distance -= 1; s.dust += 1; }
  while (s.distance < n) {
    if (s.dust < 1) throw new Error('虚里没有结晶，无法拉近间合');
    s.dust -= 1; s.distance += 1;
  }
}
/** 直接把一张付与札放上场（结晶从虚/装扣，总数不变） */
function putAttach(s, who, id, n) {
  const p = s.players[who];
  p.attachments.push(Object.assign(cardById(id), { crystals: n }));
  let left = n;
  while (left > 0 && s.dust > 0) { s.dust -= 1; left -= 1; }
  while (left > 0 && p.aura > 0) { p.aura -= 1; left -= 1; }
  if (left > 0) throw new Error('结晶不够放到付与札上');
}
/** 换手牌：旧手牌塞回牌库底（不丢牌，牌总数不变） */
function setHand(s, who, ids) {
  const p = s.players[who];
  p.deck = p.deck.concat(p.hand);
  p.hand = ids.map(function (id) { return cardById(id); });
}
/**
 * 统一起手：让 P0 先行动，并把「随机先手带来的集中力差」清零。
 * 集中力不是樱花结晶，清零不破坏守恒；不清的话 harness 的
 * 「后手多 1 点集中力」会让断言随着随机先手一起摆动。
 */
function prep(s) {
  s.active = 0;
  s.players[0].firstTurnDone = true;
  s.players[1].firstTurnDone = true;
  s.players[0].focus = 0;
  s.players[1].focus = 0;
  return s;
}
/** withHand 的包装：额外做统一起手 */
function wh(cards) { return prep(withHand(cards)); }
/** 开一局，指定双方女神与手牌，并让 P0 先行动 */
function mk(myKey, oppKey, p0, p1) {
  const s = prep(fresh(myKey, oppKey));
  if (p0) setHand(s, 0, p0);
  if (p1) setHand(s, 1, p1);
  return s;
}
/** 结束当前回合并顺路处理「选盖牌」「是否重组」两种待办 */
function passTurn(s) {
  let r = A(s, { type: 'endTurn', player: s.active });
  if (!r.ok) return r;
  let st = r.state;
  if (st.endTurnPending) {
    const who = st.endTurnPending.who, need = st.endTurnPending.need;
    const ids = st.players[who].hand.slice(0, need).map(function (c) { return c.id; });
    r = A(st, { type: 'confirmEndTurn', player: who, cardIds: ids });
    if (!r.ok) return r;
    st = r.state;
  }
  if (st.choice) {
    r = A(st, { type: 'choose', player: st.choice.who, option: 'no' });
    if (!r.ok) return r;
    st = r.state;
  }
  return { ok: true, state: st };
}

/* ============================================================
 * 1. 普通攻击：出牌 → 对应时机 → 不对应 → 选气 / 选命
 * ============================================================ */
group('1. 普通攻击全流程（斬 3/1，间合 3）');
{
  // 斩：3/1，适正距离 3-4
  let s = wh(['01-yurina-o-n-1']);
  setDist(s, 3);
  eq('准备：间合 = 3', s.distance, 3);
  eqc(s, '准备');

  const dust0 = s.dust;
  const cards0 = cardTotal(s);

  let r = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('间合 3 时 斬(3-4) 可以打出', r.ok, r.error);
  s = r.state;
  eq('出牌后进入「对应」时机', s.pending.stage, 'respond');
  eq('受害者是 P1', s.pending.defender, 1);
  eq('伤害 3/1 原样挂在 pending 上', s.pending.damage, { aura: 3, life: 1 });
  eq('攻击牌从手牌进弃牌区', [s.players[0].hand.length, s.players[0].discard.length], [0, 1]);
  eq('本回合出牌数 +1（连火计数）', s.turnUsed[0], 1);

  // 攻击没结算完，不许做别的事
  const blocked = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('攻击待结算时不能再出牌', !blocked.ok, blocked.error);
  const wrongResp = A(s, { type: 'respond', player: 0, cardId: null });
  ok('攻击方不能替受害者做对应', !wrongResp.ok, wrongResp.error);
  const early = A(s, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('还在对应时机时不能先选伤害', !early.ok, early.error);

  // 不对应
  r = A(s, { type: 'respond', player: 1, cardId: null });
  ok('选择「不对应」', r.ok, r.error);
  s = r.state;
  eq('推进到「选伤害」时机', s.pending.stage, 'damage');
  const late = A(s, { type: 'respond', player: 1, cardId: null });
  ok('过了对应时机不能再对应', !late.ok, late.error);
  const wrongPick = A(s, { type: 'resolveDamage', player: 0, choice: 'aura' });
  ok('攻击方不能替受害者选伤害', !wrongPick.ok, wrongPick.error);

  // 选「气」
  r = A(s, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('受害者选「气」结算成功', r.ok, r.error);
  s = r.state;
  eq('装 3 → 0', s.players[1].aura, 0);
  eq('命没动', s.players[1].life, 10);
  eq('气 3 颗从装飞进虚', s.dust, dust0 + 3);
  eq('结算完 pending 清空', s.pending, null);
  eq('牌总数不变（出牌只是换区域）', cardTotal(s), cards0);
  const twice = A(s, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('同一次攻击不能结算两遍', !twice.ok, twice.error);
  eqc(s, '选气结算后');

  // 同样的攻击，改选「命」：命里的结晶飞去「气」，不会消失
  let s2 = wh(['01-yurina-o-n-1']);
  setDist(s2, 3);
  const dust1 = s2.dust;
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  r2 = A(r2.state, { type: 'respond', player: 1, cardId: null });
  r2 = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('受害者选「命」结算成功', r2.ok, r2.error);
  eq('命 10 → 9', r2.state.players[1].life, 9);
  eq('装没动', r2.state.players[1].aura, 3);
  eq('命里的 1 颗进「气」（结晶不消失）', r2.state.players[1].flare, 1);
  eq('虚没动（命伤不走虚）', r2.state.dust, dust1);
  eqc(r2.state, '选命结算后');
}

/* ============================================================
 * 2. 气伤超过装的数量 → 不能选「气」
 * ============================================================ */
group('2. 装不够时不能选「气」');
{
  let s = wh(['01-yurina-o-n-1']);   // 斬 3/1
  setDist(s, 3);
  setNum(s, 1, 'aura', 2);                 // 受害者只有 2 点装
  let r = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('打出斬', r.ok, r.error);
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  const bad = A(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('装 2 < 气伤 3 → 选气被拒', !bad.ok, bad.error);
  eq('被拒后装仍是 2', bad.state.players[1].aura, 2);
  eq('攻击还挂在 pending（可以改选命）', !!bad.state.pending, true);
  const good = A(bad.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('改选「命」可以结算', good.ok, good.error);
  eq('命 10 → 9', good.state.players[1].life, 9);
  eq('装没有被动过', good.state.players[1].aura, 2);
  eqc(good.state, '装不够 · 改选命');

  // 边界：装正好等于气伤 → 可以选气
  let s2 = wh(['01-yurina-o-n-1']);
  setDist(s2, 3);
  setNum(s2, 1, 'aura', 3);
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  r2 = A(r2.state, { type: 'respond', player: 1, cardId: null });
  const exactly = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('装正好 3 = 气伤 3 → 可以选气', exactly.ok, exactly.error);
  eq('装 3 → 0', exactly.state.players[1].aura, 0);

  // 边界：装 0 时选气被拒（不能扣成负数）
  let s3 = wh(['01-yurina-o-n-1']);
  setDist(s3, 3);
  setNum(s3, 1, 'aura', 0);
  let r3 = A(s3, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  r3 = A(r3.state, { type: 'respond', player: 1, cardId: null });
  const zero = A(r3.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('装 0 时选气同样被拒', !zero.ok, zero.error);
  eq('装不会变成负数', zero.state.players[1].aura, 0);
  eqc(zero.state, '装 0 选气被拒');
}

/* ============================================================
 * 3. 气伤上限 5（超克解除）
 * ============================================================ */
group('3. 气伤上限 5');
{
  // 居合 4/3（2-4）。用"本回合下一次攻击 +4/+0"把气伤抬到 8，看是否被压到 5
  let s = wh(['01-yurina-o-n-4']);
  setDist(s, 4);
  setNum(s, 1, 'aura', 5);                       // 受害者装满 5 颗
  s.players[0].buff = { aura: 4, life: 0 };      // 造 8 点气伤
  let r = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-4' });
  ok('打出居合（间合 4，不吃「间合≤2 时 -1/-1」）', r.ok, r.error);
  s = r.state;
  eq('4 + 4 = 8 → 气伤被压到上限 5', s.pending.damage.aura, 5);
  eq('命伤不受上限影响，仍是 3', s.pending.damage.life, 3);
  eq('加成一用即清空', s.players[0].buff, { aura: 0, life: 0 });

  r = A(s, { type: 'respond', player: 1, cardId: null });
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('装 5 正好吃得下被压到 5 的气伤（若仍是 8 这里会因装不够被拒）', r.ok, r.error);
  eq('装 5 → 0（扣的是 5，不是 8）', r.state.players[1].aura, 0);
  eqc(r.state, '气伤上限');

  // 边界：上限只压气伤，不压命伤
  let s2 = wh(['01-yurina-o-n-1']);
  setDist(s2, 3);
  s2.players[0].buff = { aura: 0, life: 6 };     // 命伤 1 + 6 = 7
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  eq('命伤 1 + 6 = 7，不被压到 5', r2.state.pending.damage, { aura: 3, life: 7 });
  eqc(r2.state, '命伤无上限');

  // 边界：带「超克」时上限取消（気炎万丈：决死时其他女神的攻击 +1/+1 且超克）
  let s3 = mk('yurina', 'saine', ['02-saine-o-n-2'], []);   // 薙斬り 3/1（其他女神）
  setDist(s3, 5);
  putAttach(s3, 0, '01-yurina-o-n-7', 4);        // 気炎万丈（纳 4）已在场上
  setNum(s3, 0, 'life', 3);                      // 决死
  s3.players[0].buff = { aura: 5, life: 0 };     // 气伤 3 + 1 + 5 = 9
  let r3 = A(s3, { type: 'playCard', player: 0, cardId: '02-saine-o-n-2' });
  ok('决死 + 気炎万丈：打出薙斬り', r3.ok, r3.error);
  eq('超克取消上限：3 + 1（気炎万丈）+ 5 = 9，不被压到 5', r3.state.pending.damage.aura, 9);
  eq('命伤同样 +1 → 2', r3.state.pending.damage.life, 2);
  eqc(r3.state, '超克取消气伤上限');

  // 对照：非决死时気炎万丈 不生效，也就没有超克，8 点照旧压到 5
  let s4 = mk('yurina', 'saine', ['02-saine-o-n-2'], []);
  setDist(s4, 5);
  putAttach(s4, 0, '01-yurina-o-n-7', 4);
  s4.players[0].buff = { aura: 5, life: 0 };     // 3 + 5 = 8
  let r4 = A(s4, { type: 'playCard', player: 0, cardId: '02-saine-o-n-2' });
  eq('非决死：没有超克，3 + 5 = 8 → 还是压到 5', r4.state.pending.damage.aura, 5);
  eqc(r4.state, '非决死 · 上限照旧');
}

/* ============================================================
 * 4. 「-」与「0」的区别
 * ============================================================ */
group('4. 「-」与「0」的区别');
{
  // 梳流し（-/1，间合 4）：气伤那条是「-」，不能选
  let s = wh(['04-tokoyo-o-n-1']);
  setDist(s, 4);
  let r = A(s, { type: 'playCard', player: 0, cardId: '04-tokoyo-o-n-1' });
  ok('打出梳流し（-/1，间合 4）', r.ok, r.error);
  eq('「-」保留为 null，不是 0', r.state.pending.damage.aura, null);
  eq('命伤 1', r.state.pending.damage.life, 1);
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  const bad = A(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('「-」那条不能选气', !bad.ok, bad.error);
  eq('被拒后装没动', bad.state.players[1].aura, 3);
  const good = A(bad.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('只能选命 → 命 10 → 9', good.ok && good.state.players[1].life === 9,
     good.state && good.state.players[1].life);
  eqc(good.state, '-/1 只能选命');

  // 3/0：两条都能选；选命不扣命，选气照扣 3
  let s2 = wh([]);
  setDist(s2, 3);
  E.effects.generateAttack(s2, 0, {
    name: '测试用 3/0', range: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], aura: 3, life: 0
  });
  eq('「0」保留为 0，不是 null', s2.pending.damage.life, 0);
  let r2 = A(s2, { type: 'respond', player: 1, cardId: null });
  const lifePick = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('3/0 选命是合法选择', lifePick.ok, lifePick.error);
  eq('选命：命不扣', lifePick.state.players[1].life, 10);
  eq('选命：气也不增加（0 点命伤不搬结晶）', lifePick.state.players[1].flare, 0);
  eq('选命：装不动', lifePick.state.players[1].aura, 3);
  eqc(lifePick.state, '3/0 选命');

  let s3 = wh([]);
  setDist(s3, 3);
  E.effects.generateAttack(s3, 0, {
    name: '测试用 3/0', range: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], aura: 3, life: 0
  });
  let r3 = A(s3, { type: 'respond', player: 1, cardId: null });
  const auraPick = A(r3.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('3/0 选气是合法选择', auraPick.ok, auraPick.error);
  eq('选气：装照扣 3', auraPick.state.players[1].aura, 0);
  eq('选气：命不动', auraPick.state.players[1].life, 10);
  eqc(auraPick.state, '3/0 选气');
}

/* ============================================================
 * 5. both（フルバースト）：两种伤害都吃
 * ============================================================ */
group('5. both：两种伤害都吃（フルバースト 3/1）');
{
  let s = wh(['03-himika-o-n-4']);
  setDist(s, 5);
  const dust0 = s.dust;
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-4' });
  ok('打出フルバースト（间合 5）', r.ok, r.error);
  eq('这次攻击被标成「两种都吃」', r.state.pending.both, true);
  eq('伤害 3/1', r.state.pending.damage, { aura: 3, life: 1 });
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  // 受害者选「命」，但 both 之下两种都要吃
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('both 结算成功', r.ok, r.error);
  eq('装 3 → 0（气伤照吃）', r.state.players[1].aura, 0);
  eq('命 10 → 9（命伤也吃）', r.state.players[1].life, 9);
  eq('3 颗从装进虚', r.state.dust, dust0 + 3);
  eq('1 颗从命进「气」', r.state.players[1].flare, 1);
  eqc(r.state, 'both 完整结算');

  // 装不足：按现有的扣，溢出的那部分凭空丢失（不会补到别处）
  let s2 = wh(['03-himika-o-n-4']);
  setDist(s2, 5);
  setNum(s2, 1, 'aura', 1);
  const dust1 = s2.dust;
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '03-himika-o-n-4' });
  r2 = A(r2.state, { type: 'respond', player: 1, cardId: null });
  r2 = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('装只有 1 也能结算（both 不因装不够而报错）', r2.ok, r2.error);
  eq('装只扣现有的 1', r2.state.players[1].aura, 0);
  eq('虚只 +1（溢出的 2 丢失，不会变出来）', r2.state.dust, dust1 + 1);
  eq('命伤照扣 1 → 9', r2.state.players[1].life, 9);
  eqc(r2.state, 'both · 装不足');

  // 边界：装 0 时 both 只剩命伤
  let s3 = wh(['03-himika-o-n-4']);
  setDist(s3, 5);
  setNum(s3, 1, 'aura', 0);
  const dust2 = s3.dust;
  let r3 = A(s3, { type: 'playCard', player: 0, cardId: '03-himika-o-n-4' });
  r3 = A(r3.state, { type: 'respond', player: 1, cardId: null });
  r3 = A(r3.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('装 0 时 both 也能结算', r3.ok, r3.error);
  eq('装 0 不变', r3.state.players[1].aura, 0);
  eq('虚不增加（气伤全额溢出）', r3.state.dust, dust2);
  eq('命伤照扣', r3.state.players[1].life, 9);
  eqc(r3.state, 'both · 装 0');
}

/* ============================================================
 * 6. 用对应牌对应 → 减伤生效
 * ============================================================ */
group('6. 用《对应》牌对应：减伤生效');
{
  // 浦波嵐（王牌·对应）：被对应的攻击 -2/+0。P0 用薙斬り 3/1 打过去
  let s = mk('saine', 'yurina', ['02-saine-o-n-2'], []);
  setDist(s, 4);
  give(s, 1, 'flare', 3);
  let r = A(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-2' });
  ok('打出薙斬り（3/1，间合 4）', r.ok, r.error);
  eq('对应前是 3/1', r.state.pending.damage, { aura: 3, life: 1 });
  const dust0 = r.state.dust;
  r = A(r.state, { type: 'respond', player: 1, cardId: '01-yurina-o-s-2' });
  ok('用浦波嵐对应', r.ok, r.error);
  eq('浦波嵐 自己那一发先打（2/-）', r.state.pending.damage, { aura: 2, life: null });
  eq('王牌当对应要付 3 点气 → 气归 0', r.state.players[1].flare, 0);
  eq('付掉的 3 点气变成虚里的结晶', r.state.dust, dust0 + 3);
  r = settleResponse(r);
  eq('被对应的攻击 -2/+0 → 1/1', r.state.pending.damage, { aura: 1, life: 1 });
  const sp = r.state.players[1].specials.find(function (x) { return x.id === '01-yurina-o-s-2'; });
  eq('王牌标记为已使用', sp.used, true);
  eq('攻击方还能选伤害（没被打消）', r.state.pending.stage, 'damage');
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('减伤后的 1 点照样结算', r.ok, r.error);
  eq('装 3 → 2', r.state.players[1].aura, 2);
  eqc(r.state, '浦波嵐 对应');

  // 通常札对应也生效：衝音晶 -1/+0，而且不用付气
  let s2 = mk('yurina', 'saine', ['01-yurina-o-n-1'], ['02-saine-o-n-6']);
  setDist(s2, 3);
  const flare0 = s2.players[1].flare;
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  r2 = A(r2.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-6' });
  ok('通常札「衝音晶」可以当对应', r2.ok, r2.error);
  eq('减伤 -1/+0 → 2/1', r2.state.pending.damage, { aura: 2, life: 1 });
  eq('通常札对应不花气', r2.state.players[1].flare, flare0);
  eq('付与牌当对应 → 进付与区', r2.state.players[1].attachments.length, 1);
  eq('手牌少一张', r2.state.players[1].hand.length, 0);
  eqc(r2.state, '衝音晶 对应');

  // 音無砕氷 -1/-1：把命伤减到 0（0 可以选，但不扣）
  let s3 = mk('yurina', 'saine', ['01-yurina-o-n-1'], []);
  setDist(s3, 3);
  give(s3, 1, 'flare', 2);
  let r3 = A(s3, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  r3 = A(r3.state, { type: 'respond', player: 1, cardId: '02-saine-o-s-3' });
  ok('用音無砕氷对应', r3.ok, r3.error);
  eq('音無砕氷 自己那一发先打（1/1）', r3.state.pending.damage, { aura: 1, life: 1 });
  r3 = settleResponse(r3);
  eq('减伤 -1/-1 → 2/0', r3.state.pending.damage, { aura: 2, life: 0 });
  r3 = A(r3.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('命伤被减到 0 时选命仍然合法', r3.ok, r3.error);
  eq('命不变（0 点）', r3.state.players[1].life, 10);
  eq('气也不变', r3.state.players[1].flare, 0);
  eqc(r3.state, '音無砕氷 减到 0');
}

/* ============================================================
 * 7. 王牌当对应要付气，付不出气时不能选
 * ============================================================ */
group('7. 王牌当对应要付气');
{
  let s = mk('saine', 'yurina', ['02-saine-o-n-2'], []);
  setDist(s, 4);
  let r = A(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-2' });
  ok('打出薙斬り', r.ok, r.error);
  eq('P1 现在没有气', r.state.players[1].flare, 0);
  const bad = A(r.state, { type: 'respond', player: 1, cardId: '01-yurina-o-s-2' });
  ok('气 0 时不能用浦波嵐（需要 3）对应', !bad.ok, bad.error);
  const sp = bad.state.players[1].specials.find(function (x) { return x.id === '01-yurina-o-s-2'; });
  eq('失败后王牌仍是「未使用」', sp.used, false);
  eq('攻击还停在对应时机', bad.state.pending.stage, 'respond');
  eq('伤害没被改动', bad.state.pending.damage, { aura: 3, life: 1 });
  eqc(bad.state, '付不出气');

  // 给够气 → 可以用
  const s2 = E.state.clone(bad.state);
  give(s2, 1, 'flare', 3);
  const dustNow = s2.dust;
  const good = A(s2, { type: 'respond', player: 1, cardId: '01-yurina-o-s-2' });
  ok('气够了就能用王牌对应', good.ok, good.error);
  eq('气 3 → 0', good.state.players[1].flare, 0);
  eq('3 点气进虚（结晶总数不变）', good.state.dust, dustNow + 3);
  eqc(good.state, '付气后对应');
}

/* ============================================================
 * 8. 不可被对应（noRespond）
 * ============================================================ */
group('8. 不可被对应');
{
  // 無窮ノ風（王牌攻击 1/1，3-8，不可被对应）
  let s = mk('tokoyo', 'saine', [], ['02-saine-o-n-3']);
  setDist(s, 3);
  give(s, 0, 'flare', 1);
  let r = A(s, { type: 'playCard', player: 0, cardId: '04-tokoyo-o-s-3' });
  ok('打出無窮ノ風', r.ok, r.error);
  eq('pending 上标了 noRespond', r.state.pending.noRespond, true);
  const bad = A(r.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-3' });
  ok('不可被对应：石突（间合 3 本来打得到）也被拒', !bad.ok, bad.error);
  eq('石突还在手里（没被误打进弃牌区）', bad.state.players[1].hand.length, 1);
  eq('攻击还挂在 pending', bad.state.pending.stage, 'respond');
  // 仍然可以「不对应」
  let r2 = A(bad.state, { type: 'respond', player: 1, cardId: null });
  ok('不可被对应 ≠ 不能推进：仍然可以声明「不对应」', r2.ok, r2.error);
  r2 = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('照常结算 1 点气伤', r2.ok, r2.error);
  eq('装 3 → 2', r2.state.players[1].aura, 2);
  eqc(r2.state, '無窮ノ風');

  // 边界：クリムゾンゼロ 在间合 0 时也不可被对应，且 both
  let s2 = mk('himika', 'saine', [], ['02-saine-o-n-3']);
  setDist(s2, 0);
  give(s2, 0, 'flare', 5);
  let r3 = A(s2, { type: 'playCard', player: 0, cardId: '03-himika-o-s-2' });
  ok('间合 0 时打出クリムゾンゼロ', r3.ok, r3.error);
  eq('间合 0 → 不可被对应', r3.state.pending.noRespond, true);
  eq('同时也是 both', r3.state.pending.both, true);
  const bad2 = A(r3.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-3' });
  ok('间合 0 时也不能拿石突对应', !bad2.ok, bad2.error);
  eqc(r3.state, 'クリムゾンゼロ');
}

/* ============================================================
 * 9. 石突当对应：嵌套解决
 * ============================================================ */
group('9. 石突当对应：先打自己的 2/1，再【攻击后】，最后原攻击');
{
  // 間合 3：斬(3-4) 打过来，P1 拿石突(2-3) 对应
  let s = mk('yurina', 'saine', ['01-yurina-o-n-1'], ['02-saine-o-n-3']);
  setDist(s, 3);
  setNum(s, 1, 'aura', 1);            // 满足八相（自装 ≤1），【攻击后】才会发动
  let r = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('P0 打出斬（3/1）', r.ok, r.error);
  r = A(r.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-3' });
  ok('石突当对应成功', r.ok, r.error);
  s = r.state;
  // 此时先打石突自己那一发，原攻击被压栈
  eq('先打出石突自己的攻击', s.pending.cardName, '石突き');
  eq('石突的攻击是 2/1', s.pending.damage, { aura: 2, life: 1 });
  eq('石突这一发的攻方是 P1', s.pending.attacker, 1);
  eq('石突这一发不可被对应（由对应产生的攻击不能再被对应）', s.pending.noRespond, true);
  eq('原攻击被压进栈里等待', (s.attackStack || []).length, 1);
  eq('栈里那一发是斬', s.attackStack[0].cardName, '斬');
  const dustBefore = s.dust;

  // P0 吃石突这一发
  let r2 = A(s, { type: 'respond', player: 0, cardId: null });
  ok('P0 推进石突那一发（不可被对应，只能不表态）', r2.ok, r2.error);
  r2 = A(r2.state, { type: 'resolveDamage', player: 0, choice: 'aura' });
  ok('P0 吃下石突的 2 点气伤', r2.ok, r2.error);
  s = r2.state;
  eq('P0 装 3 → 1', s.players[0].aura, 1);
  // 【攻击后】八相：虚 → 间合 1 颗
  eq('石突【攻击后】八相：间合 3 → 4', s.distance, 4);
  eq('对应地虚的净变化 = +2（P0 的装伤）− 1（攻击后搬去间合）', s.dust, dustBefore + 1);
  // 原攻击接回来
  eq('原攻击接回来了', s.pending && s.pending.cardName, '斬');
  eq('原攻击直接进入选伤害（对应时机已经过去）', s.pending.stage, 'damage');
  eq('原攻击伤害没变（3/1）', s.pending.damage, { aura: 3, life: 1 });
  // P1 吃原攻击：装只有 1，不够 3 → 只能选命
  const bad = A(s, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('P1 装 1 < 3 → 选气被拒', !bad.ok, bad.error);
  const fin = A(bad.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('改选命结算原攻击', fin.ok, fin.error);
  eq('P1 命 10 → 9', fin.state.players[1].life, 9);
  eq('全部结算完 pending 清空', [fin.state.pending, fin.state.attackStack.length], [null, 0]);
  eqc(fin.state, '石突 嵌套解决');

  // 边界：间合不在 2-3 时不能拿石突当对应
  let s2 = mk('yurina', 'saine', ['01-yurina-o-n-1'], ['02-saine-o-n-3', '02-saine-o-n-2']);
  setDist(s2, 4);                     // 斬 3-4 打得到，石突 2-3 打不到
  let r3 = A(s2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('间合 4 时斬可以打出', r3.ok, r3.error);
  const badResp = A(r3.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-3' });
  ok('间合 4 时不能拿石突(2-3)当对应', !badResp.ok, badResp.error);
  const stillHave = badResp.state.players[1].hand.some(function (c) { return c.id === '02-saine-o-n-3'; });
  ok('失败后石突还在手里（使用不正的牌原样退回）', stillHave, stillHave);
  eq('攻击还停在对应时机', badResp.state.pending.stage, 'respond');
  // 同距离下 薙斬り(4-5) 是合法对应，但没有减伤效果
  const okResp = A(badResp.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-2' });
  ok('间合 4 时薙斬り(4-5)可以当对应', okResp.ok, okResp.error);
  eq('薙斬り 只对应不减伤：伤害仍是 3/1', okResp.state.pending.damage, { aura: 3, life: 1 });
  eqc(okResp.state, '对应牌的距离确认');
}

/* ============================================================
 * 10. 对应后距离变了 → 原攻击打空
 * ============================================================ */
group('10. 对应后重新确认适正距离');
{
  // 見切り：八相时才能当对应；把间合(1) ⇔ 虚
  let s = mk('yurina', 'saine', ['01-yurina-o-n-1'], ['02-saine-o-n-4']);
  setDist(s, 3);
  setNum(s, 1, 'aura', 1);            // 八相
  let r = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('打出斬（间合 3）', r.ok, r.error);
  r = A(r.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-4' });
  ok('八相时見切り可以当对应', r.ok, r.error);
  s = r.state;
  eq('見切り 挂起「选方向」', s.choice && s.choice.sourceId, 'mikiri');
  eq('伤害还在（方向还没选）', s.pending.damage, { aura: 3, life: 1 });
  // 把间合 3 → 2：斬 的适正距离 3-4，立刻落空
  r = A(s, { type: 'choose', player: 1, option: 'dist_to_dust' });
  ok('选「间合 → 虚」', r.ok, r.error);
  s = r.state;
  eq('间合 3 → 2', s.distance, 2);
  eq('距离变了 → 原攻击落空，pending 清空', s.pending, null);
  eq('P1 一点伤都没吃：命 10', s.players[1].life, 10);
  eq('P1 装没动', s.players[1].aura, 1);
  const gone = A(s, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('落空之后没有可结算的伤害', !gone.ok, gone.error);
  eqc(s, '見切り 打空');

  // 边界：距离变了但仍在他的适正距离内 → 照常命中
  let s2 = mk('yurina', 'saine', ['01-yurina-o-n-1'], ['02-saine-o-n-4']);
  setDist(s2, 3);
  setNum(s2, 1, 'aura', 1);
  const dust2 = s2.dust;
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  r2 = A(r2.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-4' });
  r2 = A(r2.state, { type: 'choose', player: 1, option: 'dust_to_dist' });
  ok('选「虚 → 间合」', r2.ok, r2.error);
  eq('间合 3 → 4（仍在 3-4 内）', r2.state.distance, 4);
  eq('攻击还在', !!r2.state.pending, true);
  ok('虚先少了 1 颗（見切り 花掉），再被攻击结算影响', r2.state.dust < dust2, r2.state.dust);
  r2 = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('距离变了但仍在适正内 → 照常命中', r2.ok && r2.state.players[1].life === 9,
     r2.state && r2.state.players[1].life);
  eqc(r2.state, '見切り 命中');

  // 对应后【攻击后】把距离推出原攻击范围 → 原攻击发空
  // 一閃 的适正距离只有 3；石突 的【攻击后】会把间合 3 → 4
  let s3 = mk('yurina', 'saine', ['01-yurina-o-n-2'], ['02-saine-o-n-3']);
  setDist(s3, 3);
  setNum(s3, 1, 'aura', 1);
  let r3 = A(s3, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-2' });
  ok('打出一閃（2/2，适正距离只有 3）', r3.ok, r3.error);
  r3 = A(r3.state, { type: 'respond', player: 1, cardId: '02-saine-o-n-3' });
  ok('石突当对应（2-3）', r3.ok, r3.error);
  r3 = A(r3.state, { type: 'respond', player: 0, cardId: null });
  r3 = A(r3.state, { type: 'resolveDamage', player: 0, choice: 'aura' });
  ok('P0 吃下石突的 2 点气伤', r3.ok, r3.error);
  eq('石突【攻击后】把间合推到 4', r3.state.distance, 4);
  eq('一閃 的适正距离只有 3 → 原攻击落空', r3.state.pending, null);
  eq('P1 毫发无伤（一閃 没打出来）', [r3.state.players[1].life, r3.state.players[1].aura], [10, 1]);
  eqc(r3.state, '攻击后推走距离 → 打空');
}

/* ============================================================
 * 11. 打消（雅打ち）
 * ============================================================ */
group('11. 打消');
{
  // 境地（集中力 = 2）时，雅打ち 打消非王牌攻击
  let s = mk('yurina', 'tokoyo', ['01-yurina-o-n-1'], ['04-tokoyo-o-n-2']);
  setDist(s, 3);
  s.players[1].focus = 2;                     // 境地
  const dust0 = s.dust;
  let r = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('打出斬（通常札攻击）', r.ok, r.error);
  r = A(r.state, { type: 'respond', player: 1, cardId: '04-tokoyo-o-n-2' });
  ok('雅打ち 可以对应', r.ok, r.error);
  eq('雅打ち 自己那一发先打（2/1）', r.state.pending.damage, { aura: 2, life: 1 });
  r = settleResponse(r);
  s = r.state;
  eq('攻击被打消：pending 清空', s.pending, null);
  eq('P1 命没掉', s.players[1].life, 10);
  eq('P1 装没掉', s.players[1].aura, 3);
  // 雅打ち 自己那一发（2/1）打在攻击方 P0 身上 → 虚 +2
  eq('虚只多了雅打ち自己那 2 点气伤', s.dust, dust0 + 2);
  eq('攻击方 P0 的装被打掉 2', s.players[0].aura, 1);
  eq('雅打ち 进弃牌区', s.players[1].discard.length, 1);
  eqc(s, '打消');

  // 不是境地时：雅打ち 可以打出，但打不掉
  let s2 = mk('yurina', 'tokoyo', ['01-yurina-o-n-1'], ['04-tokoyo-o-n-2']);
  setDist(s2, 3);
  s2.players[1].focus = 1;                    // 不是境地
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  r2 = A(r2.state, { type: 'respond', player: 1, cardId: '04-tokoyo-o-n-2' });
  ok('非境地时也能打出雅打ち', r2.ok, r2.error);
  r2 = settleResponse(r2);
  eq('但攻击没被打消', !!r2.state.pending, true);
  eq('雅打ち 的气伤打在攻击方身上 → P1 的装还没动', r2.state.players[1].aura, 3);
  eq('攻击方 P0 的装 3 → 1', r2.state.players[0].aura, 1);
  r2 = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('攻击照常结算', r2.ok, r2.error);
  eq('再吃下斬的 3 点气伤 → 装归 0', r2.state.players[1].aura, 0);
  eqc(r2.state, '非境地的雅打ち');

  // 王牌攻击 → 打不掉（音無砕氷 1/1，0-10）
  let s3 = mk('saine', 'tokoyo', [], ['04-tokoyo-o-n-2']);
  setDist(s3, 3);
  give(s3, 0, 'flare', 2);
  s3.players[1].focus = 2;
  let r3 = A(s3, { type: 'playCard', player: 0, cardId: '02-saine-o-s-3' });
  ok('打出王牌攻击（音無砕氷）', r3.ok, r3.error);
  eq('这次攻击来自王牌', r3.state.pending.fromSpecial, true);
  r3 = A(r3.state, { type: 'respond', player: 1, cardId: '04-tokoyo-o-n-2' });
  ok('雅打ち 可以对应王牌攻击', r3.ok, r3.error);
  r3 = settleResponse(r3);
  eq('但打消不掉王牌攻击', !!r3.state.pending, true);
  r3 = A(r3.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('王牌攻击照常结算', r3.ok, r3.error);
  eq('P1 只吃音無砕氷 的 1 点气伤 → 装 3 → 2', r3.state.players[1].aura, 2);
  eqc(r3.state, '王牌攻击打不掉');
}

/* ============================================================
 * 12. 终端（晴舞台）
 * ============================================================ */
group('12. 终端：用后只能结束回合');
{
  let s = wh(['04-tokoyo-o-n-7', '01-yurina-o-n-1']);
  setDist(s, 3);
  let r = A(s, { type: 'playCard', player: 0, cardId: '04-tokoyo-o-n-7' });
  ok('打出晴舞台（付与 + 终端，纳 2）', r.ok, r.error);
  eq('进入「纳」分配', r.state.nabu && r.state.nabu.cap, 2);
  r = autoNabu(r);
  ok('分配完成', r.ok, r.error);
  s = r.state;
  eq('晴舞台 展开，纳 2', s.players[0].attachments[0].crystals, 2);
  eq('【展开时】集中力变成 2', s.players[0].focus, 2);
  // 注：下面这一串断言抓到过一次回归——confirmNabu（**成功展开**）末尾误把
  // terminated 清掉，导致《终端》完全不生效（展开晴舞台后还能继续出牌）。
  // 正确的做法是只在 cancelNabu（取消展开）里撤销终端。
  eq('终端标记已立起', s.players[0].terminated, true);
  eqc(s, '晴舞台 展开');

  const badCard = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('终端：不能再出牌', !badCard.ok, badCard.error);
  const badBasic = A(s, { type: 'basic', player: 0, which: 'advance' });
  ok('终端：不能做基本动作', !badBasic.ok, badBasic.error);
  const badFree = A(s, { type: 'basic', player: 0, which: 'charge', free: true });
  ok('终端：连免费的基本动作也不行', !badFree.ok, badFree.error);

  const end = endTurnAuto(s);
  ok('终端：仍然可以结束回合', end.ok, end.error);
  eq('回合交给了 P1', end.state.active, 1);
  eq('终端标记不带到下个回合（P1 没有终端）', end.state.players[1].terminated, false);
  eqc(end.state, '终端 · 结束回合');
}

/* ============================================================
 * 13. 全力（居合）
 * ============================================================ */
group('13. 全力：只能在「本回合还没行动过」时使用');
{
  // 什么都没做 → 能用；用完之后只能结束回合
  let s = wh(['01-yurina-o-n-4', '01-yurina-o-n-1']);
  setDist(s, 3);
  let r = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-4' });
  ok('本回合还没行动过 → 居合可以使用', r.ok, r.error);
  s = r.state;
  eq('全力标记已立起', s.players[0].fullpowerUsed, true);
  eq('居合的伤害 4/3（间合 3 > 2，不吃 -1/-1）', s.pending.damage, { aura: 4, life: 3 });
  const badCard = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('用过全力后不能再出通常札', !badCard.ok, badCard.error);
  const badSpecial = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-s-1' });
  ok('用过全力后连王牌也不能出', !badSpecial.ok, badSpecial.error);
  const badBasic = A(s, { type: 'basic', player: 0, which: 'charge' });
  ok('用过全力后不能做基本动作', !badBasic.ok, badBasic.error);
  let r2 = A(s, { type: 'respond', player: 1, cardId: null });
  r2 = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('居合 照常结算 3 点命伤', r2.ok && r2.state.players[1].life === 7,
     r2.state && r2.state.players[1].life);
  eqc(r2.state, '全力 · 结算');

  // 已经出过牌 → 不能用
  let s2 = wh(['01-yurina-o-n-1', '01-yurina-o-n-4']);
  setDist(s2, 3);
  let r3 = A(s2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('先打出斬', r3.ok, r3.error);
  r3 = A(r3.state, { type: 'respond', player: 1, cardId: null });
  r3 = A(r3.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  r3 = A(r3.state, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-4' });
  ok('本回合已经出过牌 → 居合不能用', !r3.ok, r3.error);

  // 已经做过基本动作 → 不能用
  let s3 = wh(['01-yurina-o-n-4']);
  setDist(s3, 3);
  s3.players[0].focus = 1;
  let r4 = A(s3, { type: 'basic', player: 0, which: 'charge' });   // 装 → 气
  ok('先做一个基本动作（宿命）', r4.ok, r4.error);
  r4 = A(r4.state, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-4' });
  ok('本回合已经做过基本动作 → 居合不能用', !r4.ok, r4.error);
  eqc(r4.state, '全力 · 时机限制');

  // 边界：间合 ≤2 时居合 -1/-1
  let s4 = wh(['01-yurina-o-n-4']);
  setDist(s4, 2);
  let r5 = A(s4, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-4' });
  ok('间合 2 时居合可以打出', r5.ok, r5.error);
  eq('间合 ≤2 → 4/3 减成 3/2', r5.state.pending.damage, { aura: 3, life: 2 });
  eqc(r5.state, '居合 · 间合≤2');
}

/* ============================================================
 * 14. 距离扩大（気迫）
 * ============================================================ */
group('14. 距离扩大：気迫 给下一发「非王牌」攻击');
{
  // 気迫 之后打一张"其他女神"的非王牌攻击：适正距离向近处扩 1，且不可被通常札对应
  let s = mk('yurina', 'saine', ['01-yurina-o-n-5', '02-saine-o-n-2'], ['02-saine-o-n-2']);
  setDist(s, 4);
  let r = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-5' });
  ok('打出気迫', r.ok, r.error);
  eq('気迫：集中力 0 → 1', r.state.players[0].focus, 1);
  ok('気迫：挂上「下一次攻击」的加成', !!r.state.players[0].nextOtherAttack);
  r = A(r.state, { type: 'playCard', player: 0, cardId: '02-saine-o-n-2' });
  ok('打出薙斬り（4-5，间合 4）', r.ok, r.error);
  s = r.state;
  eq('适正距离 4-5 向近处扩 1 → 3-5', rangeStr(s.pending.range), '3,4,5');
  eq('同时挂上「不可被通常札对应」', s.pending.noRespond, 'normal');
  eq('加成用掉即清空', !!s.players[0].nextOtherAttack, false);
  const badNormal = A(s, { type: 'respond', player: 1, cardId: '02-saine-o-n-2' });
  ok('不可被通常札对应：P1 的薙斬り（间合 4 本来打得中）被拒', !badNormal.ok, badNormal.error);
  give(s, 1, 'flare', 2);
  let okSpecial = A(s, { type: 'respond', player: 1, cardId: '02-saine-o-s-3' });
  ok('但王牌对应仍然可以（只禁通常札）', okSpecial.ok, okSpecial.error);
  okSpecial = settleResponse(okSpecial);
  eq('音無砕氷 -1/-1 → 2/0', okSpecial.state.pending.damage, { aura: 2, life: 0 });
  eqc(okSpecial.state, '気迫 加成');

  // 王牌攻击不吃这个加成（卡面写的是「切り札でない」）
  // 注：这三条刚写出来时是失败的——playCard 算 ctx 时没有把 fromSpecial 传进去，
  // 「非王牌」这条限制形同虚设：王牌攻击白拿距离扩大 + 不可被通常札对应，
  // 还把加成消耗掉。引擎后来补了 ctx.fromSpecial，现在通过，保留为回归。
  let s2 = mk('himika', 'saine', ['01-yurina-o-n-5'], []);
  setDist(s2, 6);
  let r2 = A(s2, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-5' });
  ok('P0 打出気迫', r2.ok, r2.error);
  r2 = A(r2.state, { type: 'playCard', player: 0, cardId: '03-himika-o-s-1' });
  ok('打出王牌攻击レッドバレット（5-10，费 0）', r2.ok, r2.error);
  ok('王牌攻击不吃気迫的「距离扩大」（适正距离仍应是 5-10）',
     rangeStr(r2.state.pending.range) === '5,6,7,8,9,10', rangeStr(r2.state.pending.range));
  ok('王牌攻击也不会获得「不可被通常札对应」',
     !r2.state.pending.noRespond, r2.state.pending.noRespond);
  ok('気迫的加成应该留给下一次「非王牌」攻击（这次不该被消耗）',
     !!r2.state.players[0].nextOtherAttack, !!r2.state.players[0].nextOtherAttack);
  eqc(r2.state, '気迫 · 王牌不吃加成');
}

/* ============================================================
 * 15. 攻击后生成的攻击（八方振り）
 * ============================================================ */
group('15. 攻击后生成的攻击：八方振り');
{
  // 八相（自装 ≤1）时，【攻击后】再打一发 4-5 / 2/1
  let s = mk('saine', 'yurina', ['02-saine-o-n-1'], []);
  setDist(s, 4);
  setNum(s, 0, 'aura', 1);            // 八相
  let r = A(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-1' });
  ok('打出八方振り（2/1，间合 4）', r.ok, r.error);
  let r1 = A(r.state, { type: 'respond', player: 1, cardId: null });
  r1 = A(r1.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('第一发结算成功', r1.ok, r1.error);
  s = r1.state;
  eq('P1 装 3 → 1', s.players[1].aura, 1);
  eq('八相 → 生成了第二发攻击', s.pending && s.pending.cardName, '八方振り（追加）');
  eq('第二发仍是 4-5 / 2/1', s.pending.damage, { aura: 2, life: 1 });
  eq('生成出来的攻击自己没有卡（cardId 为空）', s.pending.cardId, null);
  eq('第二发还在对应时机', s.pending.stage, 'respond');
  // P1 装只有 1，不够 2 → 只能选命
  let r2 = A(s, { type: 'respond', player: 1, cardId: null });
  const bad = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('第二发：装 1 < 2 → 选气被拒', !bad.ok, bad.error);
  r2 = A(bad.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('第二发改选命结算', r2.ok, r2.error);
  eq('命 10 → 9', r2.state.players[1].life, 9);
  eq('两发都打完，pending 清空', r2.state.pending, null);
  eqc(r2.state, '八方振り 两发');

  // 边界：没有八相（自装 3）→ 不会生成第二发
  let s2 = mk('saine', 'yurina', ['02-saine-o-n-1'], []);
  setDist(s2, 4);
  let r3 = A(s2, { type: 'playCard', player: 0, cardId: '02-saine-o-n-1' });
  r3 = A(r3.state, { type: 'respond', player: 1, cardId: null });
  r3 = A(r3.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('第一发结算成功', r3.ok, r3.error);
  eq('自装 3 不是八相 → 没有第二发', r3.state.pending, null);
  eqc(r3.state, '八方振り · 非八相');

  // 边界：八相 + 间合 5（8 方振り 4-5 的远端）→ 第二发照样生成
  let s3 = mk('saine', 'yurina', ['02-saine-o-n-1'], []);
  setDist(s3, 5);
  setNum(s3, 0, 'aura', 1);
  let r4 = A(s3, { type: 'playCard', player: 0, cardId: '02-saine-o-n-1' });
  ok('间合 5（射程远端）也能打出八方振り', r4.ok, r4.error);
  r4 = A(r4.state, { type: 'respond', player: 1, cardId: null });
  r4 = A(r4.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('第一发结算成功', r4.ok, r4.error);
  eq('第二发是独立的一次攻击，也要自己走一遍对应时机', r4.state.pending.stage, 'respond');
  eq('间合 5 仍在 4-5 内 → 第二发照常生成', r4.state.pending && r4.state.pending.cardName, '八方振り（追加）');
  eqc(r4.state, '八方振り · 间合 5');
}

/* ============================================================
 * 16. 多段攻击（律動弧戟）
 * ============================================================ */
group('16. 多段攻击：律動弧戟');
{
  let s = mk('saine', 'yurina', [], []);
  setDist(s, 4);                      // ①3-4 ②4-5 ③3-5 都在射程内
  give(s, 0, 'flare', 5);
  const dust0 = s.dust;
  let r = A(s, { type: 'playCard', player: 0, cardId: '02-saine-o-s-1' });
  ok('打出律動弧戟（王牌·行动，费 5）', r.ok, r.error);
  s = r.state;
  eq('费 5 点气全部付出', s.players[0].flare, 0);
  eq('付掉的 5 颗进虚', s.dust, dust0 + 5);
  eq('第一段打出来', s.pending.cardName, '律動弧戟①');
  eq('第一段 1/1', s.pending.damage, { aura: 1, life: 1 });
  eq('剩下两段在队列里', s.attackQueue.length, 2);

  let r1 = A(s, { type: 'respond', player: 1, cardId: null });
  r1 = A(r1.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('①结算成功', r1.ok, r1.error);
  eq('P1 装 3 → 2', r1.state.players[1].aura, 2);
  eq('接着打出②', r1.state.pending && r1.state.pending.cardName, '律動弧戟②');
  eq('②是 1/1', r1.state.pending.damage, { aura: 1, life: 1 });

  let r2 = A(r1.state, { type: 'respond', player: 1, cardId: null });
  r2 = A(r2.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('②结算成功', r2.ok, r2.error);
  eq('P1 装 2 → 1', r2.state.players[1].aura, 1);
  eq('接着打出③', r2.state.pending && r2.state.pending.cardName, '律動弧戟③');
  eq('③是 2/2', r2.state.pending.damage, { aura: 2, life: 2 });

  let r3 = A(r2.state, { type: 'respond', player: 1, cardId: null });
  const bad = A(r3.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('③：装 1 < 2 → 选气被拒', !bad.ok, bad.error);
  r3 = A(bad.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('③改选命结算', r3.ok, r3.error);
  eq('命 10 → 8（2 点命伤）', r3.state.players[1].life, 8);
  eq('三段打完：pending 清空', r3.state.pending, null);
  eq('队列也清空', r3.state.attackQueue.length, 0);
  eqc(r3.state, '律動弧戟 三段');
}

/* ============================================================
 * 17. 破弃时的攻击（衝音晶）
 * ============================================================ */
group('17. 破弃时的攻击：衝音晶');
{
  let s = mk('saine', 'yurina', ['02-saine-o-n-6'], []);
  setDist(s, 4);
  let r = A(s, { type: 'playCard', player: 0, cardId: '02-saine-o-n-6' });
  ok('打出衝音晶（付与，纳 1）', r.ok, r.error);
  r = autoNabu(r);
  ok('纳 1 展开', r.ok, r.error);
  s = r.state;
  eq('付与区有衝音晶，带 1 颗结晶', [s.players[0].attachments[0].id, s.players[0].attachments[0].crystals],
     ['02-saine-o-n-6', 1]);
  eqc(s, '衝音晶 展开');

  // 规则 8-1-3-ⅱ：每个回合开始时**双方**付与札各掉 1 颗。
  // 所以 P0 一结束、P1 的回合开始，纳 1 的衝音晶立刻就破弃了。
  let r2 = passTurn(s);
  ok('P0 结束回合', r2.ok, r2.error);
  eq('轮到 P1', r2.state.active, 1);
  s = r2.state;
  eq('付与札结晶耗尽 → 破弃，付与区清空', s.players[0].attachments.length, 0);
  const broke = s.players[0].discard.filter(function (c) { return c.id === '02-saine-o-n-6'; });
  eq('破弃的牌进弃牌区', broke.length, 1);
  eq('【破弃时】打出了攻击', s.pending && s.pending.cardName, '衝音晶（破弃）');
  eq('伤害是 1/-（只有气伤那条）', s.pending.damage, { aura: 1, life: null });
  eq('这一发不可被对应', s.pending.noRespond, true);
  eq('破弃时先做了 虚 → 间合 1 颗', s.distance, 5);

  let r3 = A(s, { type: 'respond', player: 1, cardId: null });
  const bad = A(r3.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  ok('「-」那条不能选命', !bad.ok, bad.error);
  r3 = A(bad.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('只能选气 → 结算成功', r3.ok, r3.error);
  eq('P1 装 3 → 2', r3.state.players[1].aura, 2);
  eq('命不动', r3.state.players[1].life, 10);
  eqc(r3.state, '衝音晶 破弃攻击');
}

/* ============================================================
 * 18. 装伤分配（無音壁）—— 与「选气」联动
 * ============================================================ */
group('18. 装伤分配：無音壁上的结晶视为装');
{
  let s = mk('yurina', 'saine', ['01-yurina-o-n-1'], []);
  setDist(s, 3);
  putAttach(s, 1, '02-saine-o-n-7', 2);        // 無音壁：上面 2 颗视为装
  eq('准备：無音壁带 2 颗结晶', s.players[1].attachments[0].crystals, 2);
  eqc(s, '無音壁 展开');

  let r = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('打出斬（3/1）', r.ok, r.error);
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('有無音壁时选气要先做「分配」', r.ok, r.error);
  eq('装伤分配：共 3 点', r.state.auraSplit && r.state.auraSplit.total, 3);
  eq('装伤分配：最多 2 点能从牌上走', r.state.auraSplit && r.state.auraSplit.maxAttach, 2);
  eq('装伤分配：由受害者自己分配', r.state.auraSplit && r.state.auraSplit.who, 1);
  const tooMuch = A(r.state, { type: 'resolveAuraSplit', player: 1, fromAttach: 3 });
  ok('从牌上扣超过它拥有的结晶数 → 被拒', !tooMuch.ok, tooMuch.error);
  const split = A(r.state, { type: 'resolveAuraSplit', player: 1, fromAttach: 2 });
  ok('从牌上扣 2 颗、真装扣 1 颗', split.ok, split.error);
  s = split.state;
  eq('真装 3 → 2', s.players[1].aura, 2);
  eq('無音壁 上的结晶耗尽 → 破弃', s.players[1].attachments.length, 0);
  eq('牌进弃牌区', s.players[1].discard.length, 1);
  eq('分配完 pending 清空', s.pending, null);
  eqc(s, '無音壁 分配后');
}

/* ============================================================
 * 19. 结晶守恒（多步连续结算）
 * ============================================================ */
group('19. 结晶守恒：连续多次攻击');
{
  let s = mk('yurina', 'saine', [], []);
  setDist(s, 3);
  const cards0 = cardTotal(s);
  let steps = 0;
  let st = s;
  for (let i = 0; i < 5; i++) {
    E.effects.generateAttack(st, 0, {
      name: '连打' + (i + 1), range: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], aura: 3, life: 1
    });
    let r = A(st, { type: 'respond', player: 1, cardId: null });
    if (!r.ok) { ok('第 ' + (i + 1) + ' 发可以推进', false, r.error); break; }
    const choice = r.state.players[1].aura >= 3 ? 'aura' : 'life';
    r = A(r.state, { type: 'resolveDamage', player: 1, choice: choice });
    if (!r.ok) { ok('第 ' + (i + 1) + ' 发可以结算', false, r.error); break; }
    st = r.state;
    steps += 1;
    eqc(st, '第 ' + (i + 1) + ' 发（' + choice + '）');
  }
  eq('5 发全部打完', steps, 5);
  eq('牌总数没变', cardTotal(st), cards0);
  eq('命掉了 4 点（第一发选气，其余选命）', st.players[1].life, 6);
  eq('装全空', st.players[1].aura, 0);
  eq('最终 pending 清空', st.pending, null);
}

/* ============================================================
 * 20–22. 写这份测试时发现的引擎问题 → 保留为回归测试
 * ------------------------------------------------------------
 * 这三组刚写出来时都是**失败**的（引擎不满足规则），随后引擎侧
 * 改了 rules.js，现在通过。断言保留下来当回归，防止再退回去；
 * 每组都写清了「复现 / 期望 / 当时的实际」。
 * ============================================================ */
group('20. 回归：無音壁 上结晶不足时「选气」不能把攻击卡死');
{
  // 复现：真装 1 + 無音壁 1 = 2 < 气伤 3，受害者选「气」
  // 期望：像普通的"装不够"一样被直接拒绝，攻击停在选伤害时机，可以改选「命」
  // 当时的实际：进了 auraSplit；分配怎么选都报「装不够」，改选命报
  //   「还没到选伤害的时候」，结束回合报「有一张攻击还没结算」→ 这局永久卡死
  let s = mk('yurina', 'saine', ['01-yurina-o-n-1'], []);
  setDist(s, 3);
  putAttach(s, 1, '02-saine-o-n-7', 1);
  setNum(s, 1, 'aura', 1);
  let r = A(s, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  s = r.state;
  eq('引擎自己也算出"这次吃不下 3 点气伤"', E.rules.canTakeAura(s, 1, 3), false);
  const bad = A(s, { type: 'resolveDamage', player: 1, choice: 'aura' });
  ok('装不够时「选气」应当被直接拒绝', !bad.ok,
     bad.ok ? (bad.state.pending && bad.state.pending.stage) : bad.error);
  const alt = A(bad.state, { type: 'resolveDamage', player: 1, choice: 'life' });
  const end = A(bad.state, { type: 'endTurn', player: 0 });
  ok('仍应有出路（改选「命」或结束回合），不能把这一局卡死', alt.ok || end.ok,
     [alt.error, end.error].join(' / '));
}

group('21. 回归：both 攻击遇上無音壁，走装伤分配后命伤也要照吃');
{
  // 复现：フルバースト（both 3/1）打向有 無音壁(2) 的受害者，受害者选「气」→ 分配 2 颗
  // 期望：both = 两种伤害都吃，命伤 1 点照扣（规则 10-26）
  // 当时的实际：只结算了气伤，命和「气」都没动
  let s = mk('himika', 'saine', ['03-himika-o-n-4'], []);
  setDist(s, 5);
  putAttach(s, 1, '02-saine-o-n-7', 2);
  let r = A(s, { type: 'playCard', player: 0, cardId: '03-himika-o-n-4' });
  ok('打出フルバースト（both 3/1）', r.ok, r.error);
  r = A(r.state, { type: 'respond', player: 1, cardId: null });
  r = A(r.state, { type: 'resolveDamage', player: 1, choice: 'aura' });
  eq('选气 → 进入装伤分配：共 3 点', r.state.auraSplit && r.state.auraSplit.total, 3);
  eq('最多 2 点从牌上走', r.state.auraSplit && r.state.auraSplit.maxAttach, 2);
  r = A(r.state, { type: 'resolveAuraSplit', player: 1, fromAttach: 2 });
  ok('分配完成', r.ok, r.error);
  s = r.state;
  eq('真装 3 → 2（只扣 1 点）', s.players[1].aura, 2);
  eq('both 的命伤也要照吃：命 10 → 9', s.players[1].life, 9);
  eq('命的那 1 颗进「气」', s.players[1].flare, 1);
  eqc(s, 'both + 無音壁');
}

group('22. 回归：「取消展开」之后不该留下「终端」');
{
  // 复现：打出带《终端》的付与札（晴舞台）→ 出现「纳」分配 → 取消
  // 期望：取消 = 这张牌没被使用过，终端不该留下，还能正常出牌
  // 当时的实际：牌回到手里，但 terminated 仍是 true → 本回合既不能出牌也不能做基本动作
  let s = mk('yurina', 'saine', ['04-tokoyo-o-n-7', '01-yurina-o-n-1'], []);
  setDist(s, 3);
  let r = A(s, { type: 'playCard', player: 0, cardId: '04-tokoyo-o-n-7' });
  ok('打出晴舞台，进入「纳」分配', r.ok && !!r.state.nabu, r.error);
  r = A(r.state, { type: 'cancelNabu', player: 0 });
  ok('取消展开', r.ok, r.error);
  eq('牌回到手里', r.state.players[0].hand.length, 2);
  eq('取消之后不该留下「终端」', r.state.players[0].terminated, false);
  const again = A(r.state, { type: 'playCard', player: 0, cardId: '01-yurina-o-n-1' });
  ok('取消之后还能正常出牌', again.ok, again.error);
  eqc(again.state, '取消展开');
}

H.report();
