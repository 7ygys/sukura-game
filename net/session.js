/* ============================================================
 * net/session.js —— 把「连接」和「对局」粘起来
 *
 * 主机：生成邀请码 → 等对方回答码 → 连上 → 等 hello（带对方牌组）→ 建局面
 * 客机：粘邀请码 → 生成回答码 → 连上 → 发 hello（带自己牌组）→ 收局面
 *
 * UI 只需要关心这几件事：
 *   session.onInvite(code)     把这段码显示给玩家复制
 *   session.acceptAnswer(code) 玩家粘回对方的回答码
 *   session.onView(view)       拿到新视图 → 重画
 *   session.act(action)        玩家做了个操作
 * ============================================================ */
(function (root) {
  'use strict';

  const Proto = (root.Net) || (typeof require !== 'undefined' ? require('./proto.js') : null);
  const WebRTCNet = (root.WebRTCNet) || null;

  function parseDeck(str) {
    if (!str) return null;
    return String(str).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function createSession(opts) {
    const mode = opts.mode;                       // 'host' | 'guest'
    const engine = opts.engine;                   // Engine
    const myDeck = opts.myDeck || null;           // 我的 10 张牌 id
    const onStatus = opts.onStatus || function () {};
    const onView = opts.onView || function () {};
    const onError = opts.onError || function () {};
    const onInvite = opts.onInvite || function () {};
    const onConnected = opts.onConnected || function () {};
    const makeDeck = opts.makeDeck;               // (ids) => 卡牌对象数组

    let host = null, guest = null, transport = null;
    let seat = (mode === 'host') ? 0 : 1;

    /* ---------------- 主机 ---------------- */
    if (mode === 'host') {
      let hostMsg = null, closeCb = null;
      const h = WebRTCNet.createHost('sakura');
      h.ready.then(function (r) {
        onInvite(r.code);
        onStatus('把邀请码发给对方，等他回传「回答码」');
      }).catch(function (e) { onError(e.message); });

      host = Proto.createHost({
        transport: {
          send: function (m) { if (transport) transport.send(m); },
          onMessage: function (f) { hostMsg = f; },
          onClose: function (f) { closeCb = f; }
        },
        // state 先给个占位，等客机 hello 带上牌组再建真的
        state: engine.state.create({ myCards: makeDeck(opts.hostDeck), oppCards: makeDeck(opts.hostDeck) }),
        applyAction: engine.actions.applyAction,
        engine: engine,
        onLocalView: onView,
        onError: function (e) { onError(e); },
        makeState: function (guestDeckIds) {
          // 先手随机由 state.create 决定；座位固定：主机 = 0，客机 = 1
          return engine.state.create({
            myCards: makeDeck(opts.hostDeck),
            oppCards: makeDeck(guestDeckIds),
            myName: '主机', oppName: '客机'
          });
        }
      });

      return {
        mode: mode,
        get seat() { return seat; },
        get state() { return host.state; },
        /** 玩家粘回对方的回答码 */
        acceptAnswer: function (code) {
          onStatus('正在连接…');
          return h.accept(code).then(function (tr) {
            transport = tr;
            tr.onMessage(hostMsg);
            tr.onClose(closeCb);
            onConnected();
            onStatus('已连接，等对方准备…');
          }).catch(function (e) { onError(e.message); });
        },
        /** 主机的操作 */
        act: function (action) { return host.act(action); },
        close: function () { h.close(); }
      };
    }

    /* ---------------- 客机 ---------------- */
    let joinRes = null;
    return {
      mode: mode,
      get seat() { return seat; },
      get state() { return null; },
      /** 拿主机的邀请码 → 生成回答码 */
      join: function (codeA) {
        onStatus('正在解析邀请码…');
        return WebRTCNet.joinWithCode(codeA).then(function (r) {
          joinRes = r;
          onInvite(r.answerCode);
          onStatus('把「回答码」发回给主机，然后等他连上');
          r.connected().then(function (tr) {
            transport = tr;
            guest = Proto.createGuest({
              transport: tr,
              onView: onView,
              onError: function (e) { onError(e); }
            });
            guest.hello(1, myDeck);
            onConnected();
            onStatus('已连接，等主机发牌…');
          }).catch(function (e) { onError(e.message); });
        }).catch(function (e) { onError(e.message); });
      },
      act: function (action) { if (guest) guest.act(action); },
      close: function () { if (joinRes) joinRes.close(); }
    };
  }

  const api = { createSession: createSession, parseDeck: parseDeck };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NetSession = api;
})(typeof window !== 'undefined' ? window : globalThis);
