// SPDX-License-Identifier: Apache-2.0
// canonical JSON Dart 端口单元护栏（SPEC ；与 C# Canonical.cs 同口径）：
// - 字符串字面量与 JS JSON.stringify 逐字一致（仅 " \ 与 U+0000-U+001F 转义；
//   U+3000/U+2028/U+2029 原样输出）；
// - 数字唯一出口 formatEcmaNumber（Dart jsonEncode(1.0)="1.0" 分叉不得泄漏）；
// - signature 仅顶层剥离，嵌套保留。

import 'package:taprint/src/internal/canonical.dart';
import 'package:test/test.dart';

void main() {
  test('字符串转义与 JS JSON.stringify 逐字一致', () {
    expect(canonicalizeTree({'s': 'a"b\\c\n'}), '{"s":"a\\"b\\\\c\\n"}');
    expect(canonicalizeTree({'s': '\u0001'}), '{"s":"\\u0001"}');
    // 非 ASCII（含 U+3000 全角空格 / U+2028 / U+2029）原样输出
    expect(canonicalizeTree({'s': '\u3000\u2028\u2029汉'}), '{"s":"\u3000\u2028\u2029汉"}');
  });

  test('数字经 ECMA 最短十进制出口（1.0 → "1"，禁 Dart 内建 "1.0"）', () {
    expect(canonicalizeTree({'n': 1.0}), '{"n":1}');
    expect(canonicalizeTree({'n': 1e21}), '{"n":1e+21}');
    expect(canonicalizeTree({'n': -0.0}), '{"n":0}');
  });

  test('signature 仅顶层剥离，嵌套 signature 键保留', () {
    final msg = {
      'signature': 'top',
      'inner': {'signature': 'keep'},
    };
    expect(canonicalizeTree(msg, excludeSignature: true), '{"inner":{"signature":"keep"}}');
    expect(canonicalizeTree(msg),
        '{"inner":{"signature":"keep"},"signature":"top"}');
  });

  test('key 字典序为 UTF-16 code unit 序（大写字母 < 小写；数字键排序）', () {
    expect(canonicalizeTree({'b': 1, 'A': 2, 'a': 3}), '{"A":2,"a":3,"b":1}');
  });

  test('assertJsonSafe 拒绝 DateTime 与循环引用（报路径）', () {
    expect(() => assertJsonSafe(DateTime.now(), r'$'),
        throwsA(isA<ArgumentError>()));
    final cyclic = <String, Object?>{};
    cyclic['self'] = cyclic;
    expect(() => assertJsonSafe(cyclic, r'$'),
        throwsA(isA<ArgumentError>().having((e) => e.message, 'message', contains('循环引用'))));
    // DAG 共享不误报
    final shared = <String, Object?>{'k': 1};
    assertJsonSafe({
      'a': shared,
      'b': shared,
    }, r'$');
  });

  test('normalizeJsonNumbers 深归一 int → double，字符串/布尔不动', () {
    final out = normalizeJsonNumbers({
      'a': 1,
      'b': [2, {'c': 3.5}],
      'd': '4',
      'e': true,
      'f': null,
    }) as Map;
    expect(out['a'], isA<double>());
    expect((out['b'] as List)[0], isA<double>());
    expect(((out['b'] as List)[1] as Map)['c'], 3.5);
    expect(out['d'], '4');
    expect(out['e'], true);
    expect(out['f'], isNull);
  });
}
