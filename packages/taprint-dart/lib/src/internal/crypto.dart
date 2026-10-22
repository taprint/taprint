// SPDX-License-Identifier: Apache-2.0
// 加密原语 Dart 端（与 print-dsl-ts internal/crypto.ts / C# Internal/Crypto.cs 同构；
//  fixture 为唯一真值）。SHA-256/HMAC 用 package:crypto（FIPS 180-4 / RFC 2104）；
// HKDF（RFC 5869）无现成实现，按 SPEC  自实现（RFC 5869 官方向量锁定）。

import 'dart:convert';

import 'package:crypto/crypto.dart' as crypto;

List<int> sha256Bytes(List<int> data) => crypto.sha256.convert(data).bytes;

List<int> hmacSha256(List<int> key, List<int> msg) =>
    crypto.Hmac(crypto.sha256, key).convert(msg).bytes;

/// RFC 5869 HKDF-SHA256；salt 为空串时按规范取 32 零字节（与 TS/C# 同口径）。
List<int> hkdfSha256(List<int> ikm, List<int> salt, List<int> info, int length) {
  if (length > 32 * 255) {
    throw RangeError('hkdf: length too large');
  }
  final prk = hmacSha256(salt.isNotEmpty ? salt : List<int>.filled(32, 0), ikm);
  final okm = <int>[];
  var t = <int>[];
  var i = 1;
  while (okm.length < length) {
    final block = [...t, ...info, i];
    t = hmacSha256(prk, block);
    okm.addAll(t.take(length - okm.length));
    i++;
  }
  return okm;
}

List<int> utf8Bytes(String s) => utf8.encode(s);

String toHex(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

String toBase64(List<int> bytes) => base64.encode(bytes);

List<int> fromBase64(String s) => base64.decode(s);

/// 常量时间字符串比较（验签用；长度不等直接 false，逐码位异或累积）。
bool constantTimeEquals(String a, String b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
  }
  return diff == 0;
}
