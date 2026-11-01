/* ============================================================
 * net/session.js —— 把「连接」和「对局」粘起来
 *
 * 现在的分工（大厅在 prep.html，战斗页用 iframe 嵌进去）：
 *   1. 连接（WebRTC）
 *   2. 大厅：主机随机分配两位不同的女神，发给客机
 *   3. 各自组卡
 *   4. 客机发 hello（带自己的牌组）→ 主机建局面 → 双方进战斗
 *
 * 因为战斗页是 iframe，DataChannel 由主界面持有，
 * 战斗页只负责「显示视图 / 上报操作」（见 scene 的 embed 模式）。
 * ============================================================ */
(function (root) {
  'use strict';

  const Proto = (root.Net) || null;
  const WebRTCNet = root.WebRTCNet || null;

  const SEAT_HOST = 0;
  const SEAT_GUEST = 1;

  function createSession(opts) {
    const mode = opts.mode;                       // 'host' | 'guest'
    const engine = opts.engine;
    const makeDeck = opts.makeDeck;               // ids => 卡牌对象数组
    const onStatus = opts.onStatus || function () {};
    const onView = opts.onView || function () {};
    const onError = opts.onError || function () {};
    const onInvite = opts.onInvite || function () {};
    const onConnected = opts.onConnected || function () {};
    const onCustom = opts.onCustom || function () {};   // 大厅消息（分配女神等）

    let myDeckIds = null;
    let transport = null;
    let proto = null;
    let conn = null;

    /* ---------------- 主机 ---------------- */
    if (mode === 'host') {
      let hostMsg = null, closeCb = null;
      conn = WebRTCNet.createHost('sakura');
      conn.ready.then(function (r) {
        onInvite(r.code);
        onStatus('把邀请码发给对方，等他回传「回答码」');
      }).catch(function (e) { onError(e.message); });

      proto = Proto.createHost({
        transport: {
          send: function (m) { if (transport) transport.send(m); },
          onMessage: function (f) { hostMsg = f; },
          onClose: function (f) { closeCb = f; }
        },
        // 先建个占位局面；等客机 hello 带上牌组，再用 makeState 换成真的
        state: engine.state.create({
          myCards: makeDeck(opts.fallbackDeck),
          oppCards: makeDeck(opts.fallbackDeck)
        }),
        applyAction: engine.actions.applyAction,
        engine: engine,
        onLocalView: onView,
        onError: onError,
        onCustom: onCustom,
        makeState: function (guestDeckIds) {
          return engine.state.create({
            myCards: makeDeck(myDeckIds || opts.fallbackDeck),
            oppCards: makeDeck(guestDeckIds),
            myName: '主机', oppName: '客机'
          });
        }
      });

      return {
        mode: mode,
        seat: SEAT_HOST,
        get state() { return proto.state; },
        setMyDeck: function (ids) { myDeckIds = ids; },
        sendCustom: function (o) { proto.sendCustom(o); },
        acceptAnswer: function (code) {
          onStatus('正在连接…');
          return conn.accept(code).then(function (tr) {
            transport = tr;
            tr.onMessage(hostMsg);
            tr.onClose(closeCb);
            onConnected();
            onStatus('已连接，等对方准备…');
          }).catch(function (e) { onError(e.message); });
        },
        act: function (action) { return proto.act(action); },
        close: function () { conn.close(); }
      };
    }

    /* ---------------- 客机 ---------------- */
    let joinRes = null;
    return {
      mode: mode,
      seat: SEAT_GUEST,
      get state() { return null; },
      setMyDeck: function (ids) { myDeckIds = ids; },
      sendCustom: function (o) { if (proto) proto.sendCustom(o); },
      join: function (codeA) {
        onStatus('正在解析邀请码…');
        return WebRTCNet.joinWithCode(codeA).then(function (r) {
          joinRes = r;
          onInvite(r.answerCode);
          onStatus('把「回答码」发回给主机，然后等他连上');
          r.connected().then(function (tr) {
            transport = tr;
            proto = Proto.createGuest({
              transport: tr,
              onView: onView,
              onError: onError,
              onCustom: onCustom
            });
            onConnected();
            onStatus('已连接，等主机分配女神…');
          }).catch(function (e) { onError(e.message); });
        }).catch(function (e) { onError(e.message); });
      },
      /** 组好卡之后才报到（hello 里带着自己的牌组） */
      hello: function () { if (proto) proto.hello(SEAT_GUEST, myDeckIds); },
      act: function (action) { if (proto) proto.act(action); },
      close: function () { if (joinRes) joinRes.close(); }
    };
  }

  const api = { createSession: createSession, SEAT_HOST: SEAT_HOST, SEAT_GUEST: SEAT_GUEST };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NetSession = api;
})(typeof window !== 'undefined' ? window : globalThis);
