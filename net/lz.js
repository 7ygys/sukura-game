/* ============================================================
 * net/lz.js —— 邀请码压缩（无依赖，浏览器和 Node 都能用）
 *
 * 为什么需要：WebRTC 的 SDP + ICE 候选是 2~4 KB 文本，
 *   base64 之后 5 KB 左右，让玩家在聊天框里复制粘贴很痛苦。
 *
 * 做法：
 *   - LZW（定长 12 位码，字典 4096 满就用 256 号"清空码"重置）
 *   - 输出 base64url，只含 [A-Za-z0-9_-]
 *   - **自动择优**：压缩后如果反而更长（短文本很常见），就直接用原文
 *   - 首字符是标记：'L' = 压缩过，'R' = 原文
 *
 * 为什么不用变长码：编码器和解码器的"码宽增长时机"很容易差一位，
 *   一旦错位整段就全乱。定长 12 位没有这个问题，短文本用择优兜住。
 * ============================================================ */
(function (root) {
  'use strict';

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function toBytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return Uint8Array.from(Buffer.from(str, 'utf8'));
  }
  function fromBytes(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
    return Buffer.from(bytes).toString('utf8');
  }

  /** 任意字节 → base64url */
  function bytesToText(bytes) {
    let bits = '';
    for (let i = 0; i < bytes.length; i++) bits += bytes[i].toString(2).padStart(8, '0');
    let out = '';
    for (let i = 0; i < bits.length; i += 6) {
      const chunk = bits.slice(i, i + 6);
      out += B64[parseInt(chunk.padEnd(6, '0'), 2)];
    }
    return out;
  }
  /** base64url → 字节（忽略换行、空格等聊天软件插入的东西） */
  function textToBytes(text) {
    let bits = '';
    for (const ch of text) {
      const v = B64.indexOf(ch);
      if (v < 0) continue;
      bits += v.toString(2).padStart(6, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Uint8Array.from(bytes);
  }

  const CODE_BITS = 12;
  const DICT_MAX = 1 << CODE_BITS;   // 4096
  const CLEAR = 256;
  const FIRST = 257;

  function lzwEncode(str) {
    const bytes = toBytes(str);
    if (!bytes.length) return '';

    let dict = new Map();
    let next = FIRST;
    const reset = function () {
      dict = new Map();
      for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
      next = FIRST;
    };
    reset();

    const codes = [];
    let w = '';
    for (let i = 0; i < bytes.length; i++) {
      const c = String.fromCharCode(bytes[i]);
      const wc = w + c;
      if (dict.has(wc)) { w = wc; continue; }
      codes.push(dict.get(w));
      if (next < DICT_MAX) {
        dict.set(wc, next++);
      } else {
        codes.push(CLEAR);
        reset();
      }
      w = c;
    }
    if (w) codes.push(dict.get(w));

    let bits = '';
    for (const code of codes) bits += code.toString(2).padStart(CODE_BITS, '0');
    let out = '';
    for (let i = 0; i < bits.length; i += 6) out += B64[parseInt(bits.slice(i, i + 6).padEnd(6, '0'), 2)];
    return out;
  }

  function lzwDecode(text) {
    if (!text) return '';
    let bits = '';
    for (const ch of text) {
      const v = B64.indexOf(ch);
      if (v < 0) continue;
      bits += v.toString(2).padStart(6, '0');
    }
    const codes = [];
    for (let i = 0; i + CODE_BITS <= bits.length; i += CODE_BITS) {
      codes.push(parseInt(bits.slice(i, i + CODE_BITS), 2));
    }
    if (!codes.length) return '';

    let dict = [];
    let next = FIRST;
    const reset = function () {
      dict = [];
      for (let i = 0; i < 256; i++) dict[i] = String.fromCharCode(i);
      next = FIRST;
    };
    reset();

    let out = '';
    let prev = null;
    for (const code of codes) {
      if (code === CLEAR) { reset(); prev = null; continue; }
      let entry;
      if (code < dict.length && dict[code] !== undefined) entry = dict[code];
      else entry = (prev || '') + (prev ? prev[0] : '');
      out += entry;
      if (prev !== null && next < DICT_MAX) { dict[next++] = prev + entry[0]; }
      prev = entry;
    }

    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return fromBytes(bytes);
  }

  /** 压缩：自动在「压缩」和「原文」里挑短的那个 */
  function encode(str) {
    const raw = 'R' + bytesToText(toBytes(str));
    if (!str) return raw;
    const lz = 'L' + lzwEncode(str);
    return lz.length < raw.length ? lz : raw;
  }

  function decode(text) {
    if (!text) return '';
    // 先把聊天软件可能插入的空白去掉
    const clean = String(text).replace(/[\s\r\n]/g, '');
    if (!clean) return '';
    const flag = clean[0];
    const body = clean.slice(1);
    if (flag === 'L') return lzwDecode(body);
    if (flag === 'R') return fromBytes(textToBytes(body));
    // 没有标记：当作压缩内容试着解（容错）
    return lzwDecode(clean);
  }

  const api = {
    encode: encode, decode: decode,
    toBytes: toBytes, fromBytes: fromBytes,
    lzwEncode: lzwEncode, lzwDecode: lzwDecode
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LZ = api;
})(typeof window !== 'undefined' ? window : globalThis);
