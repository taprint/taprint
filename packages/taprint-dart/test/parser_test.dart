// SPDX-License-Identifier: Apache-2.0
// DslParser Dart 端（SPEC ；TS parser.spec.ts 差分移植）。
//  parse-result 锚点：5 个 parserFixture 与 expected-output 逐字一致。
// 异常映射（SPEC ）：非法 JSON → FormatException；顶层非对象 → ArgumentError。

import 'package:taprint/print_dsl.dart';
import 'package:taprint/src/internal/crypto.dart';
import 'package:test/test.dart';

import 'helpers/repo_paths.dart';

void main() {
  group('DslParser.parse', () {
    test('解析业务 fixture 且保留全部顶层字段', () {
      final dsl = readJson('fixtures/templates/sales-note-v1.0.json');
      expect(dsl['code'], 'SALES_NOTE');
      expect(dsl['schemaVersion'], '1.0');
      expect(dsl['dataSources'], isA<List>());
    });

    test('容忍 BOM 前缀', () {
      final dsl = DslParser.parse('\uFEFF{"schemaVersion":"1.0"}');
      expect(dsl['schemaVersion'], '1.0');
    });

    test('非法 JSON 抛 FormatException，非对象顶层抛 ArgumentError', () {
      expect(() => DslParser.parse('{oops'), throwsFormatException);
      expect(() => DslParser.parse('[1,2]'), throwsArgumentError);
      expect(() => DslParser.parse('null'), throwsArgumentError);
      expect(() => DslParser.parse('"str"'), throwsArgumentError);
    });

    test('整数 JSON 数字深归一 double（镜像 JS JSON.parse；SPEC ）', () {
      final dsl = DslParser.parse('{"a":1,"b":{"c":[2,3.5]},"d":"4"}');
      expect(dsl['a'], isA<double>());
      final b = dsl['b'] as Map;
      final c = b['c'] as List;
      expect(c[0], isA<double>());
      expect(c[1], 3.5);
      expect(dsl['d'], '4'); // 字符串不受影响
    });
  });

  group('DslParser.stringify / hash（规范化口径锁定）', () {
    test('stringify 与 key 插入顺序无关（全深度 key 字典序）', () {
      final a = <String, Object?>{
        'b': 1,
        'a': {
          'd': 2,
          'c': [
            {'f': 4, 'e': 5}
          ]
        }
      };
      final b = <String, Object?>{
        'a': {
          'c': [
            {'e': 5, 'f': 4}
          ],
          'd': 2
        },
        'b': 1
      };
      expect(DslParser.stringify(a), DslParser.stringify(b));
      expect(DslParser.stringify(a), '{"a":{"c":[{"e":5,"f":4}],"d":2},"b":1}');
    });

    test('stringify 拒绝循环引用（ArgumentError 而非栈溢出）', () {
      final cyclic = <String, Object?>{};
      cyclic['self'] = cyclic;
      expect(() => DslParser.stringify(cyclic),
          throwsA(isA<ArgumentError>().having((e) => e.message, 'message', contains('循环引用'))));
    });

    test('hash 形如 sha256:<64 hex>，确定性且独立复算一致', () {
      final dsl = readJson('fixtures/templates/sales-note-v1.0.json');
      final hash = DslParser.hash(dsl);
      expect(hash, matches(RegExp(r'^sha256:[0-9a-f]{64}$')));
      expect(DslParser.hash(dsl), hash);
      final independent =
          'sha256:${toHex(sha256Bytes(utf8Bytes(DslParser.stringify(dsl))))}';
      expect(hash, independent);
    });

    test('内容不同 hash 必不同', () {
      final dsl = readJson('fixtures/templates/sales-note-v1.0.json');
      final altered = DslParser.parse(
          '{"schemaVersion":"1.0","name":"${dsl['name']}-改"}');
      expect(DslParser.hash(altered), isNot(DslParser.hash(dsl)));
    });
  });

  group('DslParser.parseResult（ expected-output 锁定）', () {
    test('sales-note 与 expected-output 逐字一致', () {
      final dsl = readJson('fixtures/templates/sales-note-v1.0.json');
      final expected = readJson('fixtures/expected/parse-results/sales-note-parse-result.json');
      expect(DslParser.parseResult(dsl, schemaV1()).toJsonMap(), equals(expected));
    });

    test('fieldPaths 覆盖主源裸路径与 detail 行路径（items[*].*）', () {
      final dsl = readJson('fixtures/templates/sales-note-v1.0.json');
      final result = DslParser.parseResult(dsl, schemaV1());
      expect(result.fieldPaths, contains('billNo'));
      expect(result.fieldPaths, contains('customer.name'));
      expect(result.fieldPaths, contains('items[*].sku'));
      expect(List.of(result.fieldPaths)..sort(), result.fieldPaths); // 字典序锁定
    });

    test('schema 违反时 valid=false 且其余字段仍产出', () {
      final dsl = readJson('fixtures/templates/sales-note-v1.0.json');
      dsl.remove('id');
      final result = DslParser.parseResult(dsl, schemaV1());
      expect(result.valid, isFalse);
      expect(result.hash, matches(RegExp(r'^sha256:[0-9a-f]{64}$')));
      expect(result.expressionCount, greaterThan(0));
    });

    // 专项步骤 4：parse-result 锚点从 v1.0 扩到 DSL 2.0 全能力（ 同模式）
    for (final (fixture, expectedFile) in [
      ('inventory-report-v2.0.json', 'inventory-report-parse-result.json'),
      ('coupon-sheet-v2.0.json', 'coupon-sheet-parse-result.json'),
      ('static-rows-boundary-v2.0.json', 'static-rows-boundary-parse-result.json'),
      ('nup-extremes-v2.0.json', 'nup-extremes-parse-result.json'),
    ]) {
      test('$fixture 与 expected-output 逐字一致', () {
        final dsl = readJson('fixtures/templates/$fixture');
        final expected = readJson('fixtures/expected/parse-results/$expectedFile');
        expect(DslParser.parseResult(dsl, schemaV2()).toJsonMap(), equals(expected));
      });
    }
  });
}
