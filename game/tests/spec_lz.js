/* ============================================================
 * net/lz.js 的自测：node game/../tests/spec_lz.js
 * 主要验证「压缩 → 解压」还原得一模一样。
 * ============================================================ */
const H = require('./harness');
const LZ = require('../../net/lz.js');

// 一段接近真实 SDP 的文本（WebRTC 的 offer 大致长这样）
const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:4ZcD',
  'a=ice-pwd:2/1muCWoOi3uLifh0NuYed3O',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  'a=candidate:1467250027 1 udp 2122260223 192.168.1.7 51234 typ host generation 0 network-id 1',
  'a=candidate:1467250027 1 udp 1686052607 203.0.113.42 51234 typ srflx raddr 192.168.1.7 rport 51234 generation 0',
  'a=candidate:1467250027 1 tcp 1518280447 192.168.1.7 9 typ host tcptype active generation 0'
].join('\r\n');

H.group('邀请码压缩');
{
  const packed = LZ.encode(SDP);
  const back = LZ.decode(packed);
  H.ok('压缩后能完整还原', back === SDP);
  H.ok('压缩后只含 URL 安全字符', /^[A-Za-z0-9_-]*$/.test(packed));
  // 小段文本：base64 一定比原文长，这时应当直接选"原文"（标记 R）
  H.eq('短文本走原文（标记 R）', packed[0], 'R');

  // 真实 SDP 大约 2~4 KB，并且大量重复（candidate/ice/a= 这些前缀），压缩才有意义
  let big = SDP;
  for (let i = 0; i < 6; i++) {
    big += '\r\na=candidate:1467250027 1 udp 2122260223 192.168.1.' + (10 + i) +
           ' 51234 typ host generation 0 network-id 1';
  }
  big += '\r\na=ice-ufrag:' + 'QWERTYUI'.repeat(20);
  const bigPacked = LZ.encode(big);
  H.eq('长文本走压缩（标记 L）', bigPacked[0], 'L');
  const rawLen = ('R' + LZ.toBytes ? '' : '') + 1 + Math.ceil(big.length * 8 / 6);
  H.ok('长文本确实比 base64 短（约 ' + big.length + ' 字节 → ' + bigPacked.length + ' 字）',
       bigPacked.length < rawLen, bigPacked.length + ' vs ' + rawLen);
  H.eq('长文本往返正常', LZ.decode(bigPacked), big);

  // 中文字符也不能坏
  const cn = '散樱乱武·联机邀请码测试🐟';
  H.eq('中文与 emoji 往返正常', LZ.decode(LZ.encode(cn)), cn);

  // 空串与超长串
  H.eq('空串', LZ.decode(LZ.encode('')), '');
  const long = 'a=ice-ufrag:' + 'x'.repeat(5000);
  H.eq('超长重复串', LZ.decode(LZ.encode(long)), long);

  // 随机二进制（用字符串模拟）——压力测试字典重置
  let rnd = '';
  for (let i = 0; i < 3000; i++) rnd += String.fromCharCode(32 + (i * 7919) % 95);
  H.eq('随机 3000 字符往返正常', LZ.decode(LZ.encode(rnd)), rnd);

  // 聊天软件可能会插入换行/空格，解码要能容忍
  const wrapped = packed.slice(0, 40) + '\n' + packed.slice(40);
  H.eq('码里被插入换行也能解', LZ.decode(wrapped), SDP);
}

H.report();
