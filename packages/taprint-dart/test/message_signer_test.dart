// SPDX-License-Identifier: Apache-2.0
// MessageSigner Dart 端（SPEC ；TS message-signer.spec.ts 差分移植）。
//  多语言实现一致性锚点：fixture 输入 → canonical/keyBase64/signature 与
// expected-output 逐字一致（期望值经独立实现按 RFC 5869/HMAC-SHA256 复算核对）。

import 'dart:convert';

import 'package:taprint/print_dsl.dart';
import 'package:test/test.dart';

import 'helpers/repo_paths.dart';

const signerCases = [
  ('message-signer-v1.json', 'message-signer-result.json'),
  ('message-signer-v2.json', 'message-signer-result-v2.json'),
  ('message-signer-v3.json', 'message-signer-result-v3.json'),
  ('message-signer-v4.json', 'message-signer-result-v4.json'),
  ('message-signer-v5.json', 'message-signer-result-v5.json'),
];

void main() {
  group('MessageSigner（/，fixture 锁定）', () {
    for (final (fixtureFile, expectedFile) in signerCases) {
      group(fixtureFile, () {
        final fixture = readJson('fixtures/templates/$fixtureFile');
        final message = fixture['message']! as Map<String, Object?>;
        final sessionToken = fixture['sessionToken'] as String;
        final expected = readJson('fixtures/expected/parse-results/$expectedFile');

        test('deriveMessageKey 与期望 keyBase64 逐字一致', () {
          expect(MessageSigner.deriveMessageKey(sessionToken), expected['keyBase64']);
        });

        test('canonicalize 与期望 canonical 逐字一致', () {
          expect(MessageSigner.canonicalize(message), expected['canonical']);
        });

        test('sign 与期望 signature 逐字一致', () {
          final key = MessageSigner.deriveMessageKey(sessionToken);
          expect(MessageSigner.sign(message, key), expected['signature']);
        });

        test('verify 对带有效签名与当前时间窗的消息返回 true', () {
          final key = MessageSigner.deriveMessageKey(sessionToken);
          final fresh = Map<String, Object?>.of(message)
            ..['timestamp'] = DateTime.now().millisecondsSinceEpoch;
          final signature = MessageSigner.sign(fresh, key);
          expect(MessageSigner.verify({...fresh, 'signature': signature}, key), isTrue);
        });
      });
    }

    test('verify 拒绝篡改消息', () {
      final key = MessageSigner.deriveMessageKey('session-x');
      final msg = <String, Object?>{
        'type': 'save',
        'timestamp': DateTime.now().millisecondsSinceEpoch,
        'nonce': 'n',
      };
      final signature = MessageSigner.sign(msg, key);
      expect(MessageSigner.verify({...msg, 'type': 'steal', 'signature': signature}, key),
          isFalse);
    });

    test('不同 sessionToken 必派生不同 key', () {
      expect(MessageSigner.deriveMessageKey('a'), isNot(MessageSigner.deriveMessageKey('b')));
      expect(MessageSigner.deriveMessageKey('designer-session-token-fixture'),
          isNot(MessageSigner.deriveMessageKey('another-token-✓')));
    });

    test('verify 拒绝超出 ±5 分钟时间窗的消息', () {
      final key = MessageSigner.deriveMessageKey('session-x');
      final stale = <String, Object?>{
        'type': 'save',
        'timestamp': DateTime.now().millisecondsSinceEpoch - 6 * 60 * 1000,
        'nonce': 'n',
      };
      final signature = MessageSigner.sign(stale, key);
      expect(MessageSigner.verify({...stale, 'signature': signature}, key), isFalse);
    });

    test('verify 拒绝缺失 signature/timestamp 的消息', () {
      final key = MessageSigner.deriveMessageKey('session-x');
      expect(
          MessageSigner.verify(
              {'type': 'save', 'timestamp': DateTime.now().millisecondsSinceEpoch}, key),
          isFalse);
      expect(MessageSigner.verify({'type': 'save', 'signature': 'x'}, key), isFalse);
    });

    test('canonicalize 剥离顶层 signature 且不影响嵌套', () {
      final msg = <String, Object?>{
        'b': 1,
        'a': {
          'd': 2,
          'c': [
            3,
            {'f': 4, 'e': 5}
          ]
        },
        'signature': 'ignored',
      };
      expect(MessageSigner.canonicalize(msg), '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
    });
  });

  group('canonicalize JSON-safe 防御', () {
    test('拒绝 DateTime/Function/undefined 哨兵等非 JSON-safe 值', () {
      expect(() => MessageSigner.canonicalize({'t': DateTime.now()}), throwsArgumentError);
      expect(() => MessageSigner.canonicalize({'f': () => 1}), throwsArgumentError);
      expect(() => MessageSigner.canonicalize({'u': JsUndefined.value}), throwsArgumentError);
      expect(
          () => MessageSigner.canonicalize({
                'list': [1, DateTime.now()]
              }),
          throwsArgumentError);
    });

    test('循环引用抛 ArgumentError 而非栈溢出', () {
      final cyclic = <String, Object?>{'a': <String, Object?>{}};
      cyclic['a'] = cyclic;
      expect(() => MessageSigner.canonicalize(cyclic),
          throwsA(isA<ArgumentError>().having((e) => e.message, 'message', contains('循环引用'))));
      final msg = <String, Object?>{
        'type': 'save',
        'timestamp': DateTime.now().millisecondsSinceEpoch,
        'nonce': 'n',
        'payload': cyclic,
      };
      expect(() => MessageSigner.sign(msg, 'x' * 44), throwsArgumentError);
      expect(MessageSigner.verify({...msg, 'signature': 'x' * 44}, 'x' * 44), isFalse);
    });

    test('DAG 共享子对象（非循环）不误报循环引用', () {
      final shared = <String, Object?>{'k': 1};
      final dag = <String, Object?>{
        'a': shared,
        'b': shared,
        'list': [shared, shared],
      };
      expect(MessageSigner.canonicalize(dag),
          '{"a":{"k":1},"b":{"k":1},"list":[{"k":1},{"k":1}]}');
      final cyclic = <String, Object?>{'a': shared};
      cyclic['a'] = cyclic;
      expect(() => MessageSigner.canonicalize(cyclic),
          throwsA(isA<ArgumentError>().having((e) => e.message, 'message', contains('循环引用'))));
    });
  });

  group('verify 整数时间戳（，）', () {
    test('拒绝浮点 timestamp 的消息', () {
      final msg = <String, Object?>{
        'type': 'save',
        'timestamp': DateTime.now().millisecondsSinceEpoch + 0.5,
        'nonce': 'n',
        'signature': 'x' * 44,
      };
      expect(MessageSigner.verify(msg, 'x' * 44), isFalse);
    });
  });

  group('畸形密钥', () {
    final msg = <String, Object?>{
      'type': 'save',
      'timestamp': DateTime.now().millisecondsSinceEpoch,
      'nonce': 'n',
    };

    test('sign 对非 32 字节密钥显式抛错', () {
      // base64("short") = 5 字节密钥
      final shortKey = base64Encode(utf8.encode('short'));
      expect(() => MessageSigner.sign(msg, shortKey), throwsArgumentError);
    });

    test('verify 对畸形密钥返回 false 而非抛错', () {
      expect(MessageSigner.verify({...msg, 'signature': 'x' * 44}, 'not-base64!!!'), isFalse);
      expect(MessageSigner.verify({...msg, 'signature': 'x' * 44}, base64Encode(utf8.encode('short'))),
          isFalse);
    });
  });
}
