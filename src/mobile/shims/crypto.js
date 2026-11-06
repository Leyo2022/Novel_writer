'use strict';

/**
 * crypto 的最小实现：只提供墨枢服务层使用的同步 SHA-1（版本快照去重、备份目录键）。
 * 纯 JS 实现，不依赖 WebCrypto 的异步接口。
 */

function utf8Bytes(str) {
  return new TextEncoder().encode(String(str == null ? '' : str));
}

function sha1Hex(bytes) {
  const len = bytes.length;
  const bitLen = len * 8;
  const total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 4294967296), false);
  dv.setUint32(total - 4, bitLen >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let i = 0; i < total; i += 64) {
    for (let j = 0; j < 16; j += 1) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j += 1) {
      const n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = (n << 1) | (n >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let j = 0; j < 80; j += 1) {
      let f;
      let k;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}

function createHash(algorithm) {
  const name = String(algorithm || '').toLowerCase();
  if (name !== 'sha1') throw new Error('仅支持 sha1 摘要');
  let data = '';
  return {
    update(value) {
      data += String(value == null ? '' : value);
      return this;
    },
    digest() {
      return sha1Hex(utf8Bytes(data));
    },
  };
}

module.exports = { createHash, sha1Hex };
