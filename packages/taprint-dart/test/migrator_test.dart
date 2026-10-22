// SPDX-License-Identifier: Apache-2.0
// DslMigrator Dart 端（SPEC ；TS migrator.spec.ts 差分移植）。
// 异常映射（SPEC ）：版本文法非法 → FormatException；降级 → RangeError；
// 断链/步骤未推进/越过目标/schema 门禁失败 → StateError；非对象入参 → ArgumentError。

import 'dart:convert';

import 'package:taprint/print_dsl.dart';
import 'package:test/test.dart';

import 'helpers/repo_paths.dart';

void main() {
  final schema = schemaV1();
  final schema2 = schemaV2();

  Map<String, Object?> legacyFixture() => readJson('fixtures/templates/migration-legacy-v09.json');
  Map<String, Object?> expectedResult() =>
      readJson('fixtures/expected/parse-results/migration-legacy-v09-result.json');
  Map<String, Object?> v10Fixture() => readJson('fixtures/templates/migration-v10.json');
  Map<String, Object?> v10ExpectedResult() =>
      readJson('fixtures/expected/parse-results/migration-v10-result.json');

  group('DslMigrator.detectVersion', () {
    test('业务 fixture 报 1.0；v2 fixture 报 2.0；无 schemaVersion 的定稿前模板归 0.9', () {
      expect(DslMigrator.detectVersion(readJson('fixtures/templates/sales-note-v1.0.json')), '1.0');
      expect(
          DslMigrator.detectVersion(readJson('fixtures/templates/inventory-report-v2.0.json')), '2.0');
      expect(DslMigrator.detectVersion(legacyFixture()), DslMigrator.legacyVersion);
    });

    test('非对象抛 ArgumentError；schemaVersion 非文法值抛 FormatException', () {
      expect(() => DslMigrator.detectVersion(null), throwsArgumentError);
      expect(() => DslMigrator.detectVersion([1]), throwsArgumentError);
      expect(() => DslMigrator.detectVersion({'schemaVersion': 1}), throwsFormatException);
      expect(() => DslMigrator.detectVersion({'schemaVersion': 'v1'}),
          throwsA(isA<FormatException>().having((e) => e.message, 'message', contains('不可识别'))));
    });
  });

  group('DslMigrator.migrate（内置 0.9 → 1.0 → 2.0 链）', () {
    tearDown(DslMigrator.clear);

    test('0.9→1.0 锚点：迁移结果与 expected-output 逐字一致（停在中间步，多语言实现锚点）', () {
      final migrated = DslMigrator.migrate(legacyFixture(), DslMigrator.legacyVersion, '1.0');
      expect(migrated, equals(expectedResult()));
      expect(migrated['schemaVersion'], '1.0');
    });

    test('迁移后经 DslValidator.validate 通过对应版本权威 schema', () {
      final migrated = DslMigrator.migrate(legacyFixture(), DslMigrator.legacyVersion, '1.0');
      expect(DslValidator.validate(migrated, schema).valid, isTrue);
      final migratedV2 = DslMigrator.migrate(v10Fixture(), '1.0', DslMigrator.currentVersion);
      expect(DslValidator.validate(migratedV2, schema2).valid, isTrue);
    });

    test('恒等迁移（from == to）返回深拷贝：顶层与嵌套均不改入参', () {
      final src = readJson('fixtures/templates/sales-note-v1.0.json');
      final out = DslMigrator.migrate(src, '1.0', '1.0');
      expect(out, equals(src));
      expect(identical(out, src), isFalse);
      out['name'] = 'tampered';
      expect(src['name'], '销售单-A4-标准');
      final outBody = (((out['presentations'] as Map)['doc'] as Map)['body'] as List);
      (outBody[0] as Map)['content'] = 'tampered';
      final srcBody = (((src['presentations'] as Map)['doc'] as Map)['body'] as List);
      expect((srcBody[0] as Map)['content'], isNot('tampered'));
    });

    test('入口深拷贝隔离：0.9→1.0 迁移产物的嵌套修改不波及入参', () {
      final src = legacyFixture();
      final before = jsonEncode(src);
      final out = DslMigrator.migrate(src, DslMigrator.legacyVersion, DslMigrator.currentVersion);
      ((out['presentations'] as Map)['doc'] = <String, Object?>{});
      expect(jsonEncode(src), before);
    });

    test('版本文法/方向防御：非法格式、降级、断链均拒', () {
      expect(() => DslMigrator.migrate({}, 'v1', '1.0'), throwsFormatException);
      expect(() => DslMigrator.migrate({}, '1.0', '0.9'), throwsRangeError);
      expect(() => DslMigrator.migrate({}, '2.0', '2.1'),
          throwsA(isA<StateError>().having((e) => e.message, 'message', contains('迁移链断裂'))));
    });

    test('注入 schema 时每步后过校验门禁（坏步骤产出非法 DSL 即拒）', () {
      DslMigrator.registerStep('1.0', (dsl) => {...dsl, 'schemaVersion': '1.1', 'name': 42});
      expect(
          () => DslMigrator.migrate({'schemaVersion': '1.0'}, '1.0', '1.1', schema: schema),
          throwsA(
              isA<StateError>().having((e) => e.message, 'message', contains('未通过 schema 校验'))));
    });

    test('函数形态门禁按步产出版本选 schema（pattern 分轨链必需，专项步骤 4）', () {
      Map<String, Object?> gate(String v) => v.startsWith('2.') ? schema2 : schema;
      // 对象形态注入 v2 schema 会在 1.0 中间步被 `^2.x` pattern 拒绝；函数形态放行
      expect(
          () => DslMigrator.migrate(
              legacyFixture(), DslMigrator.legacyVersion, DslMigrator.currentVersion,
              schema: schema2),
          throwsA(
              isA<StateError>().having((e) => e.message, 'message', contains('未通过 schema 校验'))));
      final migrated = DslMigrator.migrate(
          legacyFixture(), DslMigrator.legacyVersion, DslMigrator.currentVersion,
          schema: gate);
      expect(migrated['schemaVersion'], '2.0');
      // 坏步骤在函数形态下同样被拦（1.0 步产出按 v1.0 schema 判）
      DslMigrator.registerStep(
          DslMigrator.legacyVersion, (dsl) => {...dsl, 'schemaVersion': '1.0', 'id': 1});
      expect(
          () => DslMigrator.migrate(legacyFixture(), DslMigrator.legacyVersion, '1.0',
              schema: gate),
          throwsA(
              isA<StateError>().having((e) => e.message, 'message', contains('未通过 schema 校验'))));
    });

    test('registerStep 扩展自定义链（1.0 → 1.1 → 2.0 逐级推进）', () {
      DslMigrator.registerStep('1.0', (dsl) => {...dsl, 'schemaVersion': '1.1', 'migratedA': true});
      DslMigrator.registerStep('1.1', (dsl) => {...dsl, 'schemaVersion': '2.0', 'migratedB': true});
      final out = DslMigrator.migrate({'schemaVersion': '1.0'}, '1.0', '2.0');
      expect(out, {'schemaVersion': '2.0', 'migratedA': true, 'migratedB': true});
    });

    test('步骤未推进 / 越过目标均拒', () {
      DslMigrator.registerStep('1.0', (dsl) => {...dsl, 'schemaVersion': '1.0'});
      expect(() => DslMigrator.migrate({'schemaVersion': '1.0'}, '1.0', '2.0'),
          throwsA(isA<StateError>()
              .having((e) => e.message, 'message', contains('未将 schemaVersion 推进'))));
      DslMigrator.registerStep('1.0', (dsl) => {...dsl, 'schemaVersion': '3.0'});
      expect(() => DslMigrator.migrate({'schemaVersion': '1.0'}, '1.0', '2.0'),
          throwsA(
              isA<StateError>().having((e) => e.message, 'message', contains('越过目标版本'))));
    });

    test('clear 恢复内置链（自定义步骤不残留）', () {
      DslMigrator.registerStep('1.0', (dsl) => {...dsl, 'schemaVersion': '9.9'});
      DslMigrator.clear();
      final out = DslMigrator.migrate(legacyFixture(), DslMigrator.legacyVersion,
          DslMigrator.currentVersion);
      expect(out['schemaVersion'], '2.0');
      expect(() => DslMigrator.migrate({'schemaVersion': '1.0'}, '1.0', '9.9'),
          throwsA(isA<StateError>().having((e) => e.message, 'message', contains('迁移链断裂'))));
    });
  });

  group('DslMigrator.migrate（1.0 → 1.1，label 域字段约定统一）', () {
    final schema11 = schemaV11();

    Map<String, Object?> labelDoc(List<Object?> body) => {
          'schemaVersion': '1.0',
          'id': 'tpl_label_v11_probe',
          'code': 'LABEL_V11_PROBE',
          'name': 'v1.1 折算探针',
          'presentations': {
            'label': {
              'size': {'width': '40mm', 'height': '30mm'},
              'body': body,
            },
          },
        };

    test('text.size 0 折 1；qrcode.size >10 折 10；其余元素与字段保字段', () {
      final barcodeEl = <String, Object?>{
        'type': 'barcode', 'content': '{{sku}}', 'symbology': 'EAN13',
        'x': '2mm', 'y': '20mm', 'height': '8mm',
      };
      final src = labelDoc([
        {'type': 'text', 'content': '{{name}}', 'x': '2mm', 'y': '2mm', 'font': 'SIMPLIFIED CHINESE', 'size': 0},
        {'type': 'text', 'content': '{{price}}', 'x': '2mm', 'y': '12mm', 'size': 3},
        {'type': 'qrcode', 'content': '{{sku}}', 'x': '30mm', 'y': '20mm', 'size': 15},
        {'type': 'qrcode', 'content': '{{sku}}', 'x': '30mm', 'y': '20mm', 'size': 4},
        barcodeEl,
      ]);
      final out = DslMigrator.migrate(src, '1.0', '1.1');
      expect(out['schemaVersion'], '1.1');
      final body =
          (((out['presentations'] as Map)['label']) as Map)['body'] as List;
      expect(body[0]['size'], 1); // 0 折 1
      expect(body[0]['font'], 'SIMPLIFIED CHINESE'); // 其余字段保留
      expect(body[1]['size'], 3); // 合法值原样
      expect(body[2]['size'], 10); // >10 折 10（D4 降档事实）
      expect(body[3]['size'], 4); // 合法值原样
      // 终审修正（bd1zc 2026-10-20）：保字段语义=深相等（ts toEqual/cs Assert.Equal 同口径）；
      // dart 原断言 same() 是同一性过严——迁移重建 Map 内容逐字等（实证），非引用透传承诺。
      expect(body[4], equals(barcodeEl));
    });

    test('无 label 呈现的文档仅推进版本声明（golden 锚点：v1.0 fixture 到 1.1 结构逐字不变）', () {
      final migrated = DslMigrator.migrate(v10Fixture(), '1.0', '1.1');
      expect(migrated['schemaVersion'], '1.1');
      final restMigrated = Map.of(migrated)..remove('schemaVersion');
      final restSource = Map.of(v10Fixture())..remove('schemaVersion');
      expect(restMigrated, equals(restSource));
    });

    test('入参嵌套对象不被改写（纯函数契约在折算路径同样成立）', () {
      final src = labelDoc([
        {'type': 'text', 'content': '{{name}}', 'x': '2mm', 'y': '2mm', 'size': 0},
      ]);
      final before = jsonEncode(src);
      DslMigrator.migrate(src, '1.0', '1.1');
      expect(jsonEncode(src), before);
    });

    test('折算产物过 v1.1 schema；全链 1.0→2.0 过 v2.0 schema（超集同构）', () {
      final src = labelDoc([
        {'type': 'text', 'content': '{{name}}', 'x': '2mm', 'y': '2mm', 'size': 0},
        {'type': 'qrcode', 'content': '{{sku}}', 'x': '30mm', 'y': '20mm', 'size': 20},
      ]);
      final to11 = DslMigrator.migrate(src, '1.0', '1.1');
      expect(DslValidator.validate(to11, schema11).errors, isEmpty);
      final to20 = DslMigrator.migrate(src, '1.0', DslMigrator.currentVersion);
      expect(DslValidator.validate(to20, schema2).errors, isEmpty);
    });
  });

  group('DslMigrator.migrate（1.0 → 2.0，中国式报表专项步骤 3）', () {
    tearDown(DslMigrator.clear);

    test('golden 锚点：迁移结果与 expected-output 逐字一致（仅 schemaVersion 推进）', () {
      final migrated = DslMigrator.migrate(v10Fixture(), '1.0', DslMigrator.currentVersion);
      expect(migrated, equals(v10ExpectedResult()));
      expect(migrated['schemaVersion'], '2.0');
      // 超集承诺：除 schemaVersion 外结构逐字不变
      final restMigrated = Map.of(migrated)..remove('schemaVersion');
      final restSource = Map.of(v10Fixture())..remove('schemaVersion');
      expect(restMigrated, equals(restSource));
    });

    test('全链 0.9 → 2.0 逐级推进（major 跨越），产物过 v2.0 schema', () {
      final migrated =
          DslMigrator.migrate(legacyFixture(), DslMigrator.legacyVersion, DslMigrator.currentVersion);
      expect(migrated['schemaVersion'], '2.0');
      expect(DslValidator.validate(migrated, schema2).valid, isTrue);
    });

    test('超集门禁：全部 v1.0 业务 fixture 迁移到 2.0 后通过 v2.0 schema', () {
      final bizFiles = listFixtureFiles('-v1.0.json');
      expect(bizFiles.length, greaterThanOrEqualTo(10));
      for (final file in bizFiles) {
        final migrated =
            DslMigrator.migrate(readJson('fixtures/templates/$file'), '1.0', DslMigrator.currentVersion);
        final result = DslValidator.validate(migrated, schema2);
        expect(result.errors, isEmpty, reason: file);
      }
    });

    test('v2.0 模板恒等迁移（2.0 → 2.0）；目标低于 2.0 的降级拒绝', () {
      final v2 = readJson('fixtures/templates/inventory-report-v2.0.json');
      final out = DslMigrator.migrate(v2, '2.0', '2.0');
      expect(out, equals(v2));
      expect(() => DslMigrator.migrate(v2, '2.0', '1.0'), throwsRangeError);
    });
  });
}
