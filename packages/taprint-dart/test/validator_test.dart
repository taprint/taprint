// SPDX-License-Identifier: Apache-2.0
// DslValidator Dart 端（SPEC ；TS validator.spec.ts 差分移植）。
// 偏差登记（SPEC  / 完工报告）：JSON Schema 引擎为 package:json_schema（第三方，
// 与 TS Ajv2020 / C# JsonSchema.Net 同定位）；错误文案不逐字对齐 Ajv，锚点锁
// valid/path/code 三要素。

import 'dart:io';

import 'package:taprint/print_dsl.dart';
import 'package:test/test.dart';

import 'helpers/repo_paths.dart';

Map<String, Object?> cloneSalesNote() => readJson('fixtures/templates/sales-note-v1.0.json');

/// 替换 doc 呈现 body 首个元素的 content（注入测试表达式）；返回其 JSON path。
String patchFirstBodyContent(Map<String, Object?> dsl, String content) {
  final presentations = dsl['presentations'] as Map;
  final doc = presentations['doc'] as Map;
  final body = doc['body'] as List;
  (body[0] as Map)['content'] = content;
  return 'presentations.doc.body[0].content';
}

void main() {
  final schema = schemaV1();
  final schema2 = schemaV2();
  final v1Files = listFixtureFiles('-v1.0.json');
  final v2Files = listFixtureFiles('-v2.0.json');
  final negativeFiles = Directory('${repoRoot.path}/fixtures/negative')
      .listSync()
      .whereType<File>()
      .map((f) => f.uri.pathSegments.last)
      .where((name) => name.endsWith('.invalid.json'))
      .toList()
    ..sort();

  group('DslValidator.validate（JSON Schema draft 2020-12）', () {
    test('v1.0 业务 fixture 全部通过（≥10 个）', () {
      expect(v1Files.length, greaterThanOrEqualTo(10));
      for (final file in v1Files) {
        final result = DslValidator.validate(readJson('fixtures/templates/$file'), schema);
        expect(result.errors, isEmpty, reason: file);
        expect(result.valid, isTrue, reason: file);
      }
    });

    test('v2.0 中国式报表 fixture 全部通过 schema（≥2 个）', () {
      expect(v2Files.length, greaterThanOrEqualTo(2));
      for (final file in v2Files) {
        final result = DslValidator.validate(readJson('fixtures/templates/$file'), schema2);
        expect(result.errors, isEmpty, reason: file);
        expect(result.valid, isTrue, reason: file);
      }
    });

    test('v2.0 fixture 不允许被 v1.0 schema 误收（schemaVersion pattern 分轨）', () {
      for (final file in v2Files) {
        final result = DslValidator.validate(readJson('fixtures/templates/$file'), schema);
        expect(result.valid, isFalse, reason: file);
      }
    });

    test('全部负例被拒绝且错误带 path/code（≥13 个）', () {
      expect(negativeFiles.length, greaterThanOrEqualTo(13));
      for (final file in negativeFiles) {
        // v2 负例按文件名路由到 v2.0 schema（与 tools/schema-lint 同口径）
        final target = file.contains('-v2') ? schema2 : schema;
        final result = DslValidator.validate(readJson('fixtures/negative/$file'), target);
        expect(result.valid, isFalse, reason: file);
        expect(result.errors, isNotEmpty, reason: file);
        for (final e in result.errors) {
          expect(e.path, isNotEmpty, reason: file);
          expect(e.code, isNotEmpty, reason: file);
          expect(e.message, isNotEmpty, reason: file);
        }
      }
    });
  });

  group('DslValidator.validateBusiness（字段绑定存在性 + 表达式文法）', () {
    tearDown(FieldRegistry.clear);

    test('sales-note 全部表达式可解析（裸主源路径/源前缀/detail 聚合）', () {
      expect(DslValidator.validateBusiness(cloneSalesNote()).valid, isTrue);
    });

    // 全 fixture 业务校验门禁（v1.41 ExpressionCompiler 落地后债务清零）。
    // 台账保留为空清单：今后任何 fixture 出现新的业务校验失败必须显式入台账，防静默扩大。
    const expressionDebtLedger = <Map<String, String>>[];

    test('全 fixture validateBusiness 门禁：债务台账为空', () {
      final actual = <Map<String, String>>[];
      for (final file in [...v1Files, ...v2Files]) {
        final result = DslValidator.validateBusiness(readJson('fixtures/templates/$file'));
        for (final e in result.errors) {
          actual.add({'file': file, 'path': e.path, 'code': e.code});
        }
      }
      expect(actual, equals(expressionDebtLedger));
    });

    test('parameters 运行时参数可被表达式引用（{{copies}}，主文档 ）', () {
      final dsl = cloneSalesNote();
      patchFirstBodyContent(dsl, '打印份数：{{copies}} / 打印机：{{printer}}');
      expect(DslValidator.validateBusiness(dsl).valid, isTrue);
    });

    test('未定义字段引用报 unknown-field 且定位到 JSON path', () {
      final dsl = cloneSalesNote();
      final at = patchFirstBodyContent(dsl, '前缀 {{noSuchField}} 后缀');
      final result = DslValidator.validateBusiness(dsl);
      expect(result.valid, isFalse);
      final err = result.errors.firstWhere((e) => e.code == 'unknown-field');
      expect(err.path, at);
      expect(err.message, contains('noSuchField'));
    });

    test('非法字段引用文法报 bad-expression', () {
      final dsl = cloneSalesNote();
      patchFirstBodyContent(dsl, '{{1abc}}');
      final result = DslValidator.validateBusiness(dsl);
      expect(result.errors.map((e) => e.code), contains('bad-expression'));
    });

    test('数组索引引用合法（items[0].sku）；通配符 [*] 仍拒绝', () {
      final dsl = cloneSalesNote();
      patchFirstBodyContent(dsl, '{{items[0].sku}}');
      expect(DslValidator.validateBusiness(dsl).valid, isTrue);
      final wildcard = cloneSalesNote();
      patchFirstBodyContent(wildcard, '{{items[*].sku}}');
      final result = DslValidator.validateBusiness(wildcard);
      expect(result.errors.map((e) => e.code), contains('bad-expression'));
    });

    test('A3：多数据源同名裸路径报 ambiguous-field，源前缀可消歧', () {
      final dsl = <String, Object?>{
        'schemaVersion': '1.0',
        'id': 'test_ambiguous',
        'code': 'TEST_AMBIGUOUS',
        'name': '多源歧义',
        'dataSources': [
          {
            'name': 'customer',
            'type': 'primary',
            'schema': {'name': 'string'}
          },
          {
            'name': 'store',
            'type': 'primary',
            'schema': {'name': 'string'}
          },
        ],
        'presentations': {
          'doc': {
            'body': [
              {'type': 'text', 'content': '{{name}}'}
            ]
          }
        },
      };
      final result = DslValidator.validateBusiness(dsl);
      expect(result.valid, isFalse);
      expect(result.errors[0].code, 'ambiguous-field');
      final body = (((dsl['presentations'] as Map)['doc'] as Map)['body'] as List);
      (body[0] as Map)['content'] = '{{customer.name}}';
      expect(DslValidator.validateBusiness(dsl).valid, isTrue);
    });

    test('FieldRegistry 注册的 bizType 字段可作为兜底字典（bizType = dsl.code）', () {
      final dsl = cloneSalesNote();
      patchFirstBodyContent(dsl, '{{extField}}');
      expect(DslValidator.validateBusiness(dsl).valid, isFalse);
      FieldRegistry.register('SALES_NOTE', [
        const FieldDef(code: 'extField', name: '扩展字段', dataType: 'string'),
      ]);
      expect(DslValidator.validateBusiness(dsl).valid, isTrue);
    });
  });

  group('DSL 2.0 cross-path 业务规则', () {
    Map<String, Object?> v2Dsl(Map<String, Object?> table) => {
          'schemaVersion': '2.0',
          'id': 'v2_shape_test',
          'code': 'TEST_V2_SHAPE',
          'name': 'v2 结构校验',
          'dataSources': [
            {
              'name': 'main',
              'type': 'primary',
              'schema': {'billNo': 'string'}
            },
            {
              'name': 'items',
              'type': 'detail',
              'schema': {'sku': 'string', 'qty': 'number'}
            },
          ],
          'presentations': {
            'doc': {
              'body': [table]
            }
          },
        };

    List<String> codesOf(Map<String, Object?> dsl) =>
        DslValidator.validateBusiness(dsl).errors.map((e) => e.code).toList();

    test('表头网格 colspan 越界报 header-cell-span-mismatch（含 JSON path）', () {
      final dsl = v2Dsl({
        'type': 'table',
        'source': 'items',
        'columns': [
          {'header': 'A', 'field': 'sku'},
          {'header': 'B', 'field': 'qty'},
        ],
        'headerRows': [
          [
            {'text': 'A', 'colspan': 99}
          ]
        ],
      });
      final result = DslValidator.validateBusiness(dsl);
      expect(result.errors.map((e) => e.code), contains('header-cell-span-mismatch'));
      expect(result.errors[0].path, 'presentations.doc.body[0].headerRows[0]');
    });

    test('表头 rowspan 越界/行未填满同样拒绝；合法网格（含 rowspan 占位）通过', () {
      final overflow = v2Dsl({
        'type': 'table',
        'columns': [
          {'header': 'A', 'field': 'sku'},
          {'header': 'B', 'field': 'qty'},
        ],
        'headerRows': [
          [
            {'text': 'A', 'rowspan': 2},
            {'text': 'B'}
          ]
        ],
      });
      expect(codesOf(overflow), contains('header-cell-span-mismatch'));

      final underfilled = v2Dsl({
        'type': 'table',
        'columns': [
          {'header': 'A', 'field': 'sku'},
          {'header': 'B', 'field': 'qty'},
        ],
        'headerRows': [
          [
            {'text': 'A'}
          ]
        ],
      });
      expect(codesOf(underfilled), contains('header-cell-span-mismatch'));

      final ok = v2Dsl({
        'type': 'table',
        'columns': [
          {'header': 'A', 'field': 'sku'},
          {'header': 'B', 'field': 'qty'},
          {'header': 'C', 'field': 'qty'},
        ],
        'headerRows': [
          [
            {'text': '左', 'rowspan': 2},
            {'text': '右组', 'colspan': 2},
          ],
          [
            {'text': 'B'},
            {'text': 'C'}
          ],
        ],
      });
      expect(codesOf(ok), isEmpty);
    });

    test('分组小计 values 长度 ≠ 列数报 subtotal-values-length', () {
      final dsl = v2Dsl({
        'type': 'table',
        'columns': [
          {'header': 'A', 'field': 'sku'},
          {'header': 'B', 'field': 'qty'},
        ],
        'groups': [
          {
            'field': 'sku',
            'subtotal': {
              'values': [null]
            }
          }
        ],
      });
      final result = DslValidator.validateBusiness(dsl);
      expect(result.errors.map((e) => e.code), contains('subtotal-values-length'));
      expect(result.errors[0].path, 'presentations.doc.body[0].groups[0].subtotal.values');
    });

    test('staticRows 行 colspan 合计 ≠ 列数报 static-row-span-mismatch', () {
      final dsl = v2Dsl({
        'type': 'table',
        'columns': [
          {'header': 'A', 'field': 'sku'},
          {'header': 'B', 'field': 'qty'},
        ],
        'staticRows': {
          'position': 'after',
          'rows': [
            [
              {'value': '签栏', 'colspan': 3}
            ]
          ]
        },
      });
      expect(codesOf(dsl), contains('static-row-span-mismatch'));
    });

    test('staticRows rowspan 超出行数报 static-row-span-mismatch（二轮）', () {
      final dsl = v2Dsl({
        'type': 'table',
        'columns': [
          {'header': 'A', 'field': 'sku'},
          {'header': 'B', 'field': 'qty'},
        ],
        'staticRows': {
          'position': 'after',
          'rows': [
            [
              {'value': '纵向合并溢出', 'colspan': 2, 'rowspan': 2}
            ]
          ]
        },
      });
      final result = DslValidator.validateBusiness(dsl);
      expect(result.errors.map((e) => e.code), contains('static-row-span-mismatch'));
      expect(result.errors[0].path, 'presentations.doc.body[0].staticRows.rows[0]');
    });

    test('table.source 未定义于 dataSources 报 table-source-unknown（二轮）', () {
      expect(
          codesOf(v2Dsl({
            'type': 'table',
            'source': 'ghost',
            'columns': [
              {'header': 'A', 'field': 'sku'}
            ]
          })),
          contains('table-source-unknown'));
      expect(
          codesOf(v2Dsl({
            'type': 'table',
            'source': 'items',
            'columns': [
              {'header': 'A', 'field': 'sku'}
            ]
          })),
          isEmpty);
    });

    test('loop.each 必须引用 detail 源（primary/未定义均拒）', () {
      expect(codesOf(v2Dsl({'type': 'loop', 'each': 'main', 'body': []})),
          contains('loop-each-not-detail'));
      expect(codesOf(v2Dsl({'type': 'loop', 'each': 'ghost', 'body': []})),
          contains('loop-each-not-detail'));
      expect(codesOf(v2Dsl({'type': 'loop', 'each': 'items', 'body': []})), isEmpty);
    });

    test('subtable.source 必须引用 detail 源（嵌套子表递归同校）', () {
      final dsl = v2Dsl({
        'type': 'table',
        'columns': [
          {
            'header': '嵌套',
            'subtable': {
              'source': 'items',
              'columns': [
                {
                  'header': '错',
                  'subtable': {'source': 'main', 'columns': []}
                }
              ],
            },
          },
        ],
      });
      final result = DslValidator.validateBusiness(dsl);
      expect(result.errors.map((e) => e.code), contains('subtable-source-not-detail'));
      expect(result.errors[0].path,
          'presentations.doc.body[0].columns[0].subtable.columns[0].subtable.source');
    });

    test('v1 单据（无 v2 元素）不受 cross-path 规则影响', () {
      expect(DslValidator.validateBusiness(cloneSalesNote()).valid, isTrue);
    });
  });

  group('FieldRegistry（register/lookup 语义）', () {
    tearDown(FieldRegistry.clear);

    test('lookup 未注册 bizType 返回空数组；注册后可查', () {
      expect(FieldRegistry.lookup('NOPE'), isEmpty);
      FieldRegistry.register('SALES_NOTE', [
        const FieldDef(code: 'billNo', name: '单号', dataType: 'string'),
      ]);
      expect(FieldRegistry.lookup('SALES_NOTE'), [
        const FieldDef(code: 'billNo', name: '单号', dataType: 'string'),
      ]);
    });

    test('注册/查询均为防御性拷贝，外部篡改不影响字典', () {
      final fields = [FieldDef(code: 'a', name: 'A', dataType: 'string')];
      FieldRegistry.register('BIZ', fields);
      final looked = FieldRegistry.lookup('BIZ');
      expect(looked, hasLength(1));
      // lookup 返回拷贝：篡改返回值不影响字典（FieldDef 不可变，改列表不影响存储）
      looked.clear();
      expect(FieldRegistry.lookup('BIZ'), [
        const FieldDef(code: 'a', name: 'A', dataType: 'string'),
      ]);
      expect(fields, [
        const FieldDef(code: 'a', name: 'A', dataType: 'string'),
      ]);
    });

    test('重复注册覆写；空 bizType 显式抛错', () {
      FieldRegistry.register('BIZ', [
        const FieldDef(code: 'a', name: 'A', dataType: 'string'),
      ]);
      FieldRegistry.register('BIZ', [
        const FieldDef(code: 'b', name: 'B', dataType: 'number'),
      ]);
      expect(FieldRegistry.lookup('BIZ').map((f) => f.code), ['b']);
      expect(() => FieldRegistry.register('', []), throwsArgumentError);
    });
  });
}
