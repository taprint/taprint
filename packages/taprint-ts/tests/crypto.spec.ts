// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { hkdfSha256, hmacSha256, sha256, toHex, utf8 } from '../src/internal/crypto';

// 官方测试向量护栏：FIPS 180-4 / RFC 4231 / RFC 5869。
// 期望值为标准文本给定值，独立于本实现（Node crypto 复核一致）。

const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

describe('sha256（FIPS 180-4 向量）', () => {
  it('空输入', () => {
    expect(toHex(sha256(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('"abc"（单块）', () => {
    expect(toHex(sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('56 字节消息（跨双压缩块，> 55 字节路径）', () => {
    expect(toHex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
});

describe('hmacSha256（RFC 4231 Test Case 1）', () => {
  it('key=20×0x0b, data="Hi There"', () => {
    const key = new Uint8Array(20).fill(0x0b);
    expect(toHex(hmacSha256(key, utf8('Hi There')))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });
});

describe('hkdfSha256（RFC 5869 Test Case 1）', () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  const salt = hex('000102030405060708090a0b0c');
  const info = hex('f0f1f2f3f4f5f6f7f8f9');

  it('Extract：PRK = HMAC-SHA256(salt, IKM)', () => {
    expect(toHex(hmacSha256(salt, ikm))).toBe(
      '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5',
    );
  });

  it('Expand：L=42 > 32 字节（跨 T(1)/T(2) 双块）', () => {
    expect(toHex(hkdfSha256(ikm, salt, info, 42))).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('协议固定 32 字节输出为 42 字节 OKM 前缀', () => {
    expect(toHex(hkdfSha256(ikm, salt, info, 32))).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf',
    );
  });
});
