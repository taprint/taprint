// SPDX-License-Identifier: Apache-2.0
// HostMessage/DesignerMessage HMAC 签名 Dart 端（与 TS/C#/Java 同构），
// 与 print-dsl-ts MessageSigner / C# MessageSigner 逐条同构。一致性由
// 共享 fixtures（templates + expected/parse-results）锁定。
//
// 数字序列化契约：canonical 串数字经 formatEcmaNumber（ECMA-262 最短
// 十进制），1.0 → "1"、0.1 → "0.1"；浮点规范化由 fixture v4 锁定。
//
// 入参必须 JSON-safe 且无循环引用（assertJsonSafe）：DateTime/自定义对象等会被 JSON
// 序列化静默变形，导致多语言实现 canonical 串不一致——显式拒绝。

import 'internal/canonical.dart';
import 'internal/crypto.dart';

const String _hkdfSalt = 'taprint-designer-v1';
const String _hkdfInfo = 'postmessage-hmac';
const int _keyBytes = 32;

/// 验签时间窗 ±5 分钟（）。
const int _timestampWindowMs = 5 * 60 * 1000;

class MessageSigner {
  MessageSigner._();

  /// HKDF-SHA256 派生（ 参数）；返回 base64(32 字节密钥)——多语言实现统一表示（v1.6）。
  static String deriveMessageKey(String sessionToken) {
    final okm = hkdfSha256(
        utf8Bytes(sessionToken), utf8Bytes(_hkdfSalt), utf8Bytes(_hkdfInfo), _keyBytes);
    return toBase64(okm);
  }

  /// 规范化：顶层剥离 signature、全深度递归 key 字典序（v1.7 锁定）、
  /// JSON 无多余空白（多语言实现同规则，fixture 锁定，）。
  static String canonicalize(Map<String, Object?> msg) =>
      canonicalizeTree(msg, excludeSignature: true);

  /// HMAC-SHA256 → Base64；密钥须 base64 解码为 32 字节原始字节后计算（ v1.6）。
  static String sign(Map<String, Object?> msg, String keyBase64) {
    final mac = hmacSha256(_decodeKey(keyBase64), utf8Bytes(canonicalize(msg)));
    return toBase64(mac);
  }

  /// 验签：时间窗 ±5 分钟 + 常量时间比较（与宿主侧  一致）。
  static bool verify(Map<String, Object?> msg, String keyBase64) {
    final signature = msg['signature'];
    if (signature is! String) return false;
    // ：毫秒时间戳必须为整数（浮点时间戳视为伪造/跨端实现错误）
    final timestamp = _tryGetIntegerTimestamp(msg['timestamp']);
    if (timestamp == null) return false;
    final now = DateTime.now().millisecondsSinceEpoch;
    if ((now - timestamp).abs() > _timestampWindowMs) return false;
    try {
      return constantTimeEquals(sign(msg, keyBase64), signature);
    } on Object {
      // 畸形密钥/消息不抛给宿主，直接判为验签失败
      return false;
    }
  }

  /// 密钥解码并校验长度（畸形密钥显式失败，避免静默产出错误签名；d）。
  static List<int> _decodeKey(String key) {
    final List<int> bytes;
    try {
      bytes = fromBase64(key);
    } on FormatException {
      throw ArgumentError('MessageSigner: 密钥必须为 $_keyBytes 字节的 base64');
    }
    if (bytes.length != _keyBytes) {
      throw ArgumentError('MessageSigner: 密钥必须为 $_keyBytes 字节的 base64');
    }
    return bytes;
  }
}

/// ：毫秒时间戳必须为整数。归一后的 double 须为整数值且 |d| < 2^53
/// （JS Number.isInteger 口径；与 C# TryGetIntegerTimestamp 逐字一致）。
int? _tryGetIntegerTimestamp(Object? ts) {
  if (ts is int) return ts;
  if (ts is double &&
      ts == ts.truncateToDouble() &&
      !ts.isNaN &&
      ts.abs() < 9007199254740992) {
    return ts.toInt();
  }
  return null;
}
