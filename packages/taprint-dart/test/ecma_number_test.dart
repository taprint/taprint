// SPDX-License-Identifier: Apache-2.0
// ECMA-262 Number::toString(10) 最短往返复刻黄金表（SPEC ；与 C# EcmaNumberTests.cs
// 同基线，期望值为 Node Number.prototype.toString 实测）。禁止 Dart 内建格式化器直出。

import 'package:taprint/src/internal/ecma_number.dart';
import 'package:test/test.dart';

void main() {
  // (输入, Node 实测期望)；0 与 -0.0 均输出 "0"（JS (-0).toString() === "0"）。
  final cases = <(double, String)>[
    (0, '0'),
    (-0.0, '0'),
    (0.1, '0.1'),
    (1, '1'),
    (2.5, '2.5'),
    (100, '100'),
    (1e-7, '1e-7'),
    (1e-6, '0.000001'),
    (1e21, '1e+21'),
    (1e20, '100000000000000000000'),
    (1e22, '1e+22'),
    (0.1 + 0.2, '0.30000000000000004'),
    (3.14, '3.14'),
    (-3.14, '-3.14'),
    (-2.5, '-2.5'),
    (9007199254740992, '9007199254740992'),
    (1e15, '1000000000000000'),
    (1e16, '10000000000000000'),
    // JS 字面量 12345678901234567890 的最近 double（Dart 拒绝不精确整数字面量）
    (12345678901234567168, '12345678901234567000'),
    (123.456, '123.456'),
    (5e-324, '5e-324'),
    (1.7976931348623157e308, '1.7976931348623157e+308'),
    (2.2250738585072014e-308, '2.2250738585072014e-308'),
    (1.5e300, '1.5e+300'),
    (0.00000123, '0.00000123'),
    (1e19, '10000000000000000000'),
  ];

  group('formatEcmaNumber 黄金表（Node 实测基线）', () {
    for (final (value, expected) in cases) {
      test('$value → "$expected"', () {
        expect(formatEcmaNumber(value), expected);
      });
    }
  });

  test('NaN/Infinity 非 JSON-safe，显式拒绝', () {
    expect(() => formatEcmaNumber(double.nan), throwsArgumentError);
    expect(() => formatEcmaNumber(double.infinity), throwsArgumentError);
    expect(() => formatEcmaNumber(double.negativeInfinity), throwsArgumentError);
  });
}
