/* ============================================================
 * net/webrtc.js —— WebRTC 薄封装（只负责"连上"，不管游戏）
 *
 * 没有服务器，所以用**手动邀请码**交换 SDP：
 *
 *   主机：生成邀请码 A  ──（微信/QQ 发过去）──► 客机
 *   客机：粘贴 A → 生成邀请码 B ──（发回来）──► 主机
 *   主机：粘贴 B → 连上
 *
 * 为什么是"非 trickle"：trickle 需要随时能互发候选，而我们只能
 * 一次性粘贴文本。所以等 ICE 收集完（icegatheringstate === 'complete'）
 * 再打包，SDP 里就自带全部候选了。
 * ============================================================ */
(function (root) {
  'use strict';

  const LZ = (root.LZ) || (typeof require !== 'undefined' ? require('./lz.js') : null);

  const STUN = [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun.cloudflare.com:3478'
  ];

  function rtcConfig() {
    return { iceServers: [{ urls: STUN }], iceCandidatePoolSize: 2 };
  }

  /** 等 ICE 收集完（最多 timeout 毫秒，超时就用现有的候选） */
  function waitIce(pc, timeout) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') return resolve();
      let done = false;
      const finish = function () {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };
      const onChange = function () {
        if (pc.iceGatheringState === 'complete') finish();
      };
      pc.addEventListener('icegatheringstatechange', onChange);
      setTimeout(finish, timeout || 4000);
    });
  }

  /** 把 SDP 打包成邀请码 */
  function pack(kind, sdp) {
    return LZ.encode(JSON.stringify({ v: 1, k: kind, s: sdp }));
  }

  /** 解析邀请码，失败返回 null */
  function unpack(code) {
    try {
      const obj = JSON.parse(LZ.decode(code));
      if (!obj || !obj.s) return null;
      return { kind: obj.k, sdp: obj.s };
    } catch (e) {
      return null;
    }
  }

  /** 把 DataChannel 包成 proto.js 要的 transport */
  function transportOf(dc) {
    const handlers = { msg: null, close: null };
    dc.onmessage = function (e) {
      let obj = null;
      try { obj = JSON.parse(e.data); } catch (err) { return; }
      if (handlers.msg) handlers.msg(obj);
    };
    dc.onclose = function () { if (handlers.close) handlers.close(); };
    dc.onerror = function () { if (handlers.close) handlers.close(); };
    return {
      send: function (obj) {
        if (dc.readyState === 'open') dc.send(JSON.stringify(obj));
      },
      onMessage: function (f) { handlers.msg = f; },
      onClose: function (f) { handlers.close = f; },
      get ready() { return dc.readyState === 'open'; }
    };
  }

  /**
   * 主机：生成邀请码 A。
   * 返回 { code, accept(answerCode) -> Promise<transport> }
   */
  function createHost(gameId) {
    const pc = new RTCPeerConnection(rtcConfig());
    const dc = pc.createDataChannel('sakura', { ordered: true });

    const opened = new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error('对方没有连上来（超时）')); }, 60000);
      dc.onopen = function () { clearTimeout(timer); resolve(dc); };
    });

    const ready = (async function () {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIce(pc);
      const code = pack('offer', pc.localDescription.sdp);
      return { pc: pc, code: code };
    })();

    return {
      ready: ready,
      code: function () { return ready.then(function (r) { return r.code; }); },
      /** 粘贴客机的回答码，连上后拿到 transport */
      accept: async function (answerCode) {
        const info = unpack(answerCode);
        if (!info) throw new Error('邀请码看不懂，是不是粘错了？');
        if (info.kind !== 'answer') throw new Error('这是「邀请码」不是「回答码」，主机要粘对方回传的那个');
        await ready;
        await pc.setRemoteDescription({ type: 'answer', sdp: info.sdp });
        const d = await Promise.race([
          opened,
          new Promise(function (_, rej) { setTimeout(function () { rej(new Error('连接超时，可能网络不通')); }, 20000); })
        ]);
        return transportOf(d);
      },
      close: function () { try { pc.close(); } catch (e) {} }
    };
  }

  /**
   * 客机：拿主机的邀请码 A，生成回答码 B。
   * 返回 Promise<{ answerCode, transport }>
   */
  async function joinWithCode(codeA) {
    const info = unpack(codeA);
    if (!info) throw new Error('邀请码看不懂，是不是粘错了？');
    if (info.kind !== 'offer') throw new Error('这不是「邀请码」，主机应该发给你一个以它开头的码');

    const pc = new RTCPeerConnection(rtcConfig());
    const dcPromise = new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error('连接超时，可能网络不通')); }, 60000);
      pc.ondatachannel = function (e) {
        const dc = e.channel;
        dc.onopen = function () { clearTimeout(timer); resolve(dc); };
      };
    });

    await pc.setRemoteDescription({ type: 'offer', sdp: info.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);
    const answerCode = pack('answer', pc.localDescription.sdp);

    return {
      answerCode: answerCode,
      pc: pc,
      /** 等主机把回答码粘进去、连接建立 */
      connected: async function () {
        const dc = await dcPromise;
        return transportOf(dc);
      },
      close: function () { try { pc.close(); } catch (e) {} }
    };
  }

  const api = {
    createHost: createHost,
    joinWithCode: joinWithCode,
    transportOf: transportOf,
    pack: pack,
    unpack: unpack,
    STUN: STUN
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WebRTCNet = api;
})(typeof window !== 'undefined' ? window : globalThis);
