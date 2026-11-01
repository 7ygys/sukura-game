/* ============================================================
 * net/proto.js —— 联机协议 + 主机权威
 *
 * 设计要点
 * ----------
 * 1) **主机权威**：只有主机能改状态。客机把"我想做什么"发过去，
 *    主机用同一套 applyAction 校验并执行，然后把新视图广播回去。
 * 2) **双方对等**：两边能做的操作完全一样（出牌/对应/基本动作/结束回合），
 *    区别只是"改了状态的人"是主机。客机本地不跑规则，只渲染。
 * 3) **可见性**：主机发给客机的永远是 redact 过的视图。
 *
 * 传输层是抽出来的（transport），这样可以在 Node 里用"内存管道"
 * 完整测对局流程，不需要真开 WebRTC。
 *
 * transport 接口：
 *   send(obj)             发一条消息（对象）
 *   onMessage(handler)    收到消息时调用 handler(obj)
 *   onClose(handler)      断开时回调
 * ============================================================ */
(function (root) {
  'use strict';

  const Redact = (root.Redact) || (typeof require !== 'undefined' ? require('./redact.js') : null);

  const VERSION = 1;
  // 协议自己处理的消息类型；其它类型交给上层（大厅分配女神之类的）
  const KNOWN = ['hello', 'welcome', 'state', 'action', 'reject', 'ping', 'pong'];

  /* ============================================================
   * 主机侧
   * ============================================================ */
  function createHost(opts) {
    const transport = opts.transport;
    const applyAction = opts.applyAction;
    const engine = opts.engine;
    let state = opts.state;
    let guestSeat = 1;                 // 默认客机坐对面
    let seq = 0;
    const onLocalView = opts.onLocalView || function () {};
    const onError = opts.onError || function () {};
    let connected = false;

    function bump() { seq++; return seq; }

    function view(seat) {
      return { t: 'state', seq: seq, view: Redact.redact(state, seat) };
    }

    function sendBoth(extra) {
      // 主机自己渲染
      onLocalView(Redact.redact(state, hostSeat()));
      // 客机收
      transport.send(Object.assign({ t: 'state', seq: seq, view: Redact.redact(state, guestSeat) }, extra || {}));
    }

    function hostSeat() { return guestSeat === 0 ? 1 : 0; }

    transport.onMessage(function (msg) {
      if (!msg || !msg.t) return;
      if (KNOWN.indexOf(msg.t) < 0) { if (opts.onCustom) opts.onCustom(msg); return; }

      if (msg.t === 'hello') {
        // 客机报到：认下座位；如果带了牌组，就据此建立初始局面
        if (msg.seat !== undefined) guestSeat = msg.seat === 0 ? 0 : 1;
        if (opts.makeState && msg.deck) {
          state = opts.makeState(msg.deck, guestSeat);
        }
        connected = true;
        bump();
        transport.send({ t: 'welcome', seq: seq, seat: guestSeat, version: VERSION });
        sendBoth();
        return;
      }

      if (msg.t === 'action') {
        const action = msg.action;
        if (!action || typeof action !== 'object') {
          transport.send({ t: 'reject', seq: seq, reason: '动作格式不对', view: Redact.redact(state, guestSeat) });
          return;
        }
        // 只允许客机操作自己的座位，防止串位
        if (action.player !== guestSeat) {
          transport.send({
            t: 'reject', seq: seq,
            reason: '这个动作不是你的（座位 ' + guestSeat + '）',
            view: Redact.redact(state, guestSeat)
          });
          return;
        }
        const r = applyAction(state, action);
        if (!r.ok) {
          onError(r.error);
          transport.send({ t: 'reject', seq: seq, reason: r.error, view: Redact.redact(state, guestSeat) });
          return;
        }
        state = r.state;
        bump();
        sendBoth();
        return;
      }

      if (msg.t === 'ping') {
        transport.send({ t: 'pong', seq: seq, at: msg.at });
        return;
      }
    });

    if (transport.onClose) {
      transport.onClose(function () {
        connected = false;
        onError('连接断开了');
      });
    }

    return {
      /** 主机自己做一个动作（走同一套校验） */
      act: function (action) {
        const r = applyAction(state, action);
        if (!r.ok) { onError(r.error); return r; }
        state = r.state;
        bump();
        sendBoth();
        return r;
      },
      /** 当前权威状态（主机自己用） */
      get state() { return state; },
      set state(s) { state = s; },
      get connected() { return connected; },
      get guestSeat() { return guestSeat; },
      /** 手动推一次视图（例如开局） */
      push: function () { bump(); sendBoth(); },
      /** 发自定义消息（大厅协议用，不走权威状态） */
      sendCustom: function (obj) { transport.send(obj); }
    };
  }

  /* ============================================================
   * 客机侧
   * ============================================================ */
  function createGuest(opts) {
    const transport = opts.transport;
    const onView = opts.onView || function () {};
    const onError = opts.onError || function () {};
    const onWelcome = opts.onWelcome || function () {};
    let lastSeq = -1;
    let seat = 1;

    transport.onMessage(function (msg) {
      if (!msg || !msg.t) return;
      if (KNOWN.indexOf(msg.t) < 0) { if (opts.onCustom) opts.onCustom(msg); return; }

      if (msg.t === 'welcome') {
        if (msg.seat !== undefined) seat = msg.seat;
        onWelcome(seat);
        return;
      }
      if (msg.t === 'state') {
        if (typeof msg.seq === 'number' && msg.seq <= lastSeq) return;   // 旧的丢掉
        lastSeq = msg.seq;
        onView(msg.view, msg.seq);
        return;
      }
      if (msg.t === 'reject') {
        onError(msg.reason || '动作被拒绝');
        if (msg.view) onView(msg.view, msg.seq);
        return;
      }
      if (msg.t === 'pong') {
        if (opts.onPong) opts.onPong(msg);
        return;
      }
    });

    if (transport.onClose) {
      transport.onClose(function () { onError('连接断开了'); });
    }

    return {
      /** 报到 */
      hello: function (mySeat, deck) {
        seat = (mySeat === 0) ? 0 : 1;
        transport.send({ t: 'hello', seat: seat, deck: deck || null, version: VERSION });
      },
      /** 发一个动作给主机 */
      act: function (action) {
        transport.send({ t: 'action', action: action });
      },
      ping: function () {
        transport.send({ t: 'ping', at: Date.now() });
      },
      /** 发自定义消息（大厅协议用） */
      sendCustom: function (obj) { transport.send(obj); },
      get seat() { return seat; }
    };
  }

  /* ============================================================
   * 内存传输（测试用，也能当"同屏双人"的调试通道）
   * ============================================================ */
  function createMemoryPair() {
    const a = { msg: null, close: null };
    const b = { msg: null, close: null };
    const A = {
      send: function (m) { if (b.msg) b.msg(JSON.parse(JSON.stringify(m))); },
      onMessage: function (f) { a.msg = f; },
      onClose: function (f) { a.close = f; }
    };
    const B = {
      send: function (m) { if (a.msg) a.msg(JSON.parse(JSON.stringify(m))); },
      onMessage: function (f) { b.msg = f; },
      onClose: function (f) { b.close = f; }
    };
    return [A, B];
  }

  const api = {
    VERSION: VERSION,
    createHost: createHost,
    createGuest: createGuest,
    createMemoryPair: createMemoryPair
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Net = api;
})(typeof window !== 'undefined' ? window : globalThis);
