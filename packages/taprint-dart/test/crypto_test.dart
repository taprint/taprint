// SPDX-License-Identifier: Apache-2.0
// 官方测试向量护栏：FIPS 180-4 / RFC 4231 / RFC 5869。
// 期望值为标准文本给定值，独立于本实现（与 TS crypto.spec.ts 同向量）。

import 'dart:convert';

import 'package:taprint/src/internal/crypto.dart';
import 'package:test/test.dart';

import 'helpers/repo_paths.dart';

void main() {
  group('sha256（FIPS 180-4 向量）', () {
    test('空输入', () {
      expect(toHex(sha256Bytes(const [])),
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    test('"abc"（单块）', () {
      expect(toHex(sha256Bytes(utf8Bytes('abc'))),
          'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    test('56 字节消息（跨双压缩块，> 55 字节路径）', () {
      expect(
          toHex(sha256Bytes(utf8Bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
          '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    });
  });

  group('hmacSha256（RFC 4231 Test Case 1）', () {
    test('key=20×0x0b, data="Hi There"', () {
      final key = List<int>.filled(20, 0x0b);
      expect(toHex(hmacSha256(key, utf8Bytes('Hi There'))),
          'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
    });
  });

  group('hkdfSha256（RFC 5869 Test Case 1）', () {
    final ikm = List<int>.filled(22, 0x0b);
    final salt = hexBytes('000102030405060708090a0b0c');
    final info = hexBytes('f0f1f2f3f4f5f6f7f8f9');

    test('Extract：PRK = HMAC-SHA256(salt, IKM)', () {
      expect(toHex(hmacSha256(salt, ikm)),
          '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5');
    });

    test('Expand：L=42 > 32 字节（跨 T(1)/T(2) 双块）', () {
      expect(
          toHex(hkdfSha256(ikm, salt, info, 42)),
          '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf'
          '34007208d5b887185865');
    });

    test('协议固定 32 字节输出为 42 字节 OKM 前缀', () {
      expect(toHex(hkdfSha256(ikm, salt, info, 32)),
          '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf');
    });

    test('空 salt 走 RFC 5869 缺省（32 零字节 HashLen）', () {
      // RFC 5869 Test Case 3：IKM=22×0x0b, salt='', info='', L=42
      final okm = hkdfSha256(ikm, const [], const [], 42);
      expect(
          toHex(okm),
          '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d'
          '9d201395faa4b61a96c8');
    });
  });

  group('constantTimeEquals', () {
    test('相等/不等/长度异', () {
      expect(constantTimeEquals('abc', 'abc'), isTrue);
      expect(constantTimeEquals('abc', 'abd'), isFalse);
      expect(constantTimeEquals('abc', 'abcd'), isFalse);
      expect(constantTimeEquals('', ''), isTrue);
    });
  });

  test('utf8 多字节往返（CJK/emoji）', () {
    const s = '单号：XS-1 🧾';
    expect(utf8.decode(utf8Bytes(s)), s);
  });
}
