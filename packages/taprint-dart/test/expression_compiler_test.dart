// SPDX-License-Identifier: Apache-2.0
// ExpressionCompiler Dart 端（SPEC ；TS expression-compiler.spec.ts 差分移植 +
// Node 实测基线：toFixed/jsRound/V8 ISO 日期子集——TZ=UTC 机器口径）。。
// 多语言实现一致性锚点：本套件断言的语义与 TS/C# 端逐条同构（与 TS/C#/Java 同构）。

import 'package:taprint/print_dsl.dart';
import 'package:taprint/src/expression_compiler.dart' as ec;
import 'package:test/test.dart';

Object? run(String expr, [Map<String, Object?>? data]) =>
    ExpressionCompiler.evaluate(ExpressionCompiler.compile(expr), data ?? {}, 100);

void main() {
  group('ExpressionCompiler.compile（ 文法）', () {
    test('字面量/路径/索引的 AST 形态', () {
      final num42 = ExpressionCompiler.compile('42').root;
      expect(num42, isA<LiteralNode>());
      expect((num42 as LiteralNode).value, 42.0);

      final path = ExpressionCompiler.compile('customer.name').root;
      expect(path, isA<PathNode>());
      expect((path as PathNode).segments, ['customer', 'name']);

      final indexed = ExpressionCompiler.compile('items[0].sku').root;
      expect((indexed as PathNode).segments, ['items', 0, 'sku']);

      expect(ExpressionCompiler.compile('billNo').raw, 'billNo');
    });

    test('通配符 [*] 不参与表达式文法（仅字段字典展示形态）', () {
      expect(() => ExpressionCompiler.compile('items[*].sku'),
          throwsA(isA<ExpressionSyntaxError>()));
    });

    test('未知过滤器/非整数索引/未闭合字符串/非法字符均拒绝', () {
      expect(() => ExpressionCompiler.compile('x | nope:1'),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('未知过滤器'))));
      expect(() => ExpressionCompiler.compile('items[0.5]'),
          throwsA(isA<ExpressionSyntaxError>()));
      expect(() => ExpressionCompiler.compile("'abc"),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('未闭合'))));
      expect(() => ExpressionCompiler.compile('a @ b'),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('非法字符'))));
    });

    test('沙箱限额：单表达式 ≤1KB（）', () {
      expect(() => ExpressionCompiler.compile('a' * 1025),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('沙箱限额'))));
      expect(ExpressionCompiler.compile('a' * 1024).root, isA<PathNode>());
    });
  });

  group('ExpressionCompiler.evaluate（ 语义）', () {
    test('四则运算与优先级（FR-01.4）', () {
      expect(run('qty * price | round:2', {'qty': 3, 'price': 19.9}), 59.7);
      expect(run('totalAmount - discount', {'totalAmount': 100, 'discount': 15.5}), 84.5);
      expect(run('2 + 3 * 4'), 14.0);
      expect(run('(2 + 3) * 4'), 20.0);
      expect(run('-qty', {'qty': 3}), -3.0);
    });

    test('payslip 债务表达式（PHASE2_EXPRESSION_DEBT 清零锚点）', () {
      expect(
          run('baseSalary + bonus + overtime | currency:CNY',
              {'baseSalary': 8000, 'bonus': 1200.5, 'overtime': 340.25}),
          '¥9,540.75');
    });

    test('比较/逻辑/三元（ 条件判断）', () {
      final data = <String, Object?>{'paidAmount': 80, 'totalAmount': 100};
      expect(run("paidAmount < totalAmount ? '欠款' : '已付'", data), '欠款');
      expect(run("paidAmount >= totalAmount ? '已付' : '欠款'", {'paidAmount': 100, 'totalAmount': 100}),
          '已付');
      expect(run('a && b', {'a': true, 'b': 'x'}), 'x');
      expect(run('a || b', {'a': '', 'b': 'fallback'}), 'fallback');
      expect(run("5 == '5'"), true);
      expect(run("5 === '5'"), false);
    });

    test('字符串拼接', () {
      expect(run("'单号：' + billNo", {'billNo': 'XS20260808001'}), '单号：XS20260808001');
    });

    test('路径解析：嵌套/索引/缺失即 undefined 哨兵', () {
      final data = <String, Object?>{
        'customer': {'name': '张三'},
        'items': [
          {'sku': 'A-01'},
          {'sku': 'B-02'}
        ]
      };
      expect(run('customer.name', data), '张三');
      expect(run('items[0].sku', data), 'A-01');
      expect(run('items[1].sku', data), 'B-02');
      expect(run('items[2].sku', data), JsUndefined.value);
      expect(run('customer.phone', data), JsUndefined.value);
    });

    test('过滤管道：date/currency/round/sum/count/truncate/mask（ 七例）', () {
      expect(run("d | date:'YYYY-MM-DD'", {'d': '2026-08-08T10:00:00Z'}), '2026-08-08');
      expect(run('amount | currency:CNY', {'amount': 1234.5}), '¥1,234.50');
      expect(run('v | round:2', {'v': 3.14159}), 3.14);
      expect(
          run("items | sum:'amount'", {
            'items': [
              {'amount': 10},
              {'amount': 2.5}
            ]
          }),
          12.5);
      expect(
          run('items | count', {
            'items': [1, 2, 3]
          }),
          3);
      expect(run('remark | truncate:4', {'remark': '备注很长很长'}), '备注很长...');
      expect(run("phone | mask:'138****8888'", {'phone': '13812348888'}), '138****8888');
      expect(run("phone | mask:'138****8888'", {'phone': '13999997777'}), '139****7777');
      expect(run("v | default:'-'", {}), '-');
      expect(run("v | default:'-'", {'v': ''}), '-');
      expect(run("v | default:'-'", {'v': 'x'}), 'x');
    });

    test('过滤器链式应用（左→右）', () {
      expect(run('qty * price | round:1 | currency:CNY', {'qty': 3, 'price': 19.9}), '¥59.70');
    });

    test('自定义函数由宿主经 data 注入（ now()/tenantName() 等）', () {
      expect(run('tenantName()', {'tenantName': () => '示例门店'}), '示例门店');
      expect(() => run('now()'),
          throwsA(isA<Object>().having((e) => '$e', 'message', contains('未注册函数'))));
    });

    test('evaluate 防御：timeout 校验（NaN/非正拒绝）', () {
      final ast = ExpressionCompiler.compile('x');
      expect(() => ExpressionCompiler.evaluate(ast, {}, 0), throwsArgumentError);
      expect(() => ExpressionCompiler.evaluate(ast, {}, double.nan), throwsArgumentError);
    });
  });

  group('ExpressionCompiler.extractFields（字段联动校验）', () {
    test('提取路径引用（含索引段，去重保序）', () {
      final ast = ExpressionCompiler.compile(
          'items[0].sku + items[1].sku + billNo + (billNo | truncate:5)');
      expect(ExpressionCompiler.extractFields(ast), ['items.0.sku', 'items.1.sku', 'billNo']);
    });

    test('字面量/函数名不计入字段', () {
      expect(ExpressionCompiler.extractFields(ExpressionCompiler.compile("now() + 'x'")), isEmpty);
    });
  });

  group('生产级严格化（V3/V5/V6/V7 + 聚合补全）', () {
    test('V3：== 与 JS 对齐——boolean↔number/数字字符串（=== 仍严格）', () {
      expect(run('flag == 1', {'flag': true}), true);
      expect(run('flag == 0', {'flag': false}), true);
      expect(run("flag == '1'", {'flag': true}), true);
      expect(run('flag == 2', {'flag': true}), false);
      expect(run('flag === 1', {'flag': true}), false);
    });

    test('V5：currency 补 HKD/KRW/TWD 符号（出海场景）', () {
      expect(run('amount | currency:HKD', {'amount': 12}), 'HK\$12.00');
      expect(run('amount | currency:KRW', {'amount': 12}), '₩12.00');
      expect(run('amount | currency:TWD', {'amount': 12}), 'NT\$12.00');
    });

    test('V6：过滤器参数类型/个数编译期即拒（不落到求值期静默降级）', () {
      expect(() => ExpressionCompiler.compile('amount | currency:123'),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('必须是字符串'))));
      expect(() => ExpressionCompiler.compile('v | truncate:"5"'),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('必须是数字'))));
      expect(() => ExpressionCompiler.compile('v | round:2:3'),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('最多接受'))));
      expect(() => ExpressionCompiler.compile('items | count:1'),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('最多接受'))));
    });

    test('V7：date 格式未识别占位符编译期即拒（小写 yyyy 等静默错误杜绝）', () {
      expect(() => ExpressionCompiler.compile("d | date:'yyyy-mm-dd'"),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('未识别占位符'))));
      expect(ExpressionCompiler.compile("d | date:'YYYY年MM月DD日'"), isA<ExpressionAst>());
      expect(run("d | date:'YYYY年MM月'", {'d': '2026-08-08T10:00:00Z'}), '2026年08月');
    });

    test('聚合补全：avg/min/max（跳过非数值；无数值返回空串）', () {
      final data = <String, Object?>{
        'items': [
          {'q': 2},
          {'q': 4},
          {'q': 'x'}
        ]
      };
      expect(run("items | avg:'q'", data), 3.0);
      expect(run("items | min:'q'", data), 2.0);
      expect(run("items | max:'q'", data), 4.0);
      expect(
          run('items | avg', {
            'items': ['a']
          }),
          '');
    });
  });

  group('二轮严格化（原型链防护/转义语义/比较边界）', () {
    test('P2：原型链穿透防护 golden——constructor/__proto__/toString 一律不可达', () {
      expect(run('constructor.name'), JsUndefined.value);
      expect(run('constructor.name', {'billNo': 'X-1'}), JsUndefined.value);
      expect(run('__proto__'), JsUndefined.value);
      expect(run('toString'), JsUndefined.value);
      expect(run('hasOwnProperty'), JsUndefined.value);
      // 继承成员也不可被当作宿主函数调用
      expect(() => run('constructor()'),
          throwsA(isA<Object>().having((e) => '$e', 'message', contains('未注册函数'))));
      expect(() => run('toString()'),
          throwsA(isA<Object>().having((e) => '$e', 'message', contains('未注册函数'))));
      // 自有同名属性不受防护影响（宿主显式注入仍然可达）
      expect(
          run('constructor.name', {
            'constructor': {'name': '自定义'}
          }),
          '自定义');
    });

    test('P2：字符串转义白名单——\\n \\t \\r \\\\ \' " 有定义，未知转义编译期拒绝', () {
      expect(run("'a\\nb'"), 'a\nb');
      expect(run("'a\\tb'"), 'a\tb');
      expect(run("'a\\rb'"), 'a\rb');
      expect(run("'a\\\\b'"), 'a\\b');
      expect(run("'it\\'s ok'"), "it's ok");
      expect(run('"say \\"hi\\""'), 'say "hi"');
      expect(() => ExpressionCompiler.compile("'a\\qb'"),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('未知转义序列'))));
      expect(() => ExpressionCompiler.compile('"\\x41"'),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('未知转义序列'))));
    });

    test('P3：比较语义边界 fixture 锁定', () {
      // 数字字符串与数字比较按 JS 语义转数值；双侧字符串则字典序
      expect(run("'10' > 9"), true);
      expect(run("'2' < '10'"), false);
      expect(run("'2' < '10' ? 'dict' : 'num'"), 'num');
      // 数字字符串 == 数字按数值比较；null/undefined 不做 JS 式互转（TS-loose，SPEC  分叉③）
      expect(run("'5' == 5"), true);
      expect(run('a == null', {}), false);
      expect(run('null == null'), true);
    });
  });

  group('十四轮（N1：过滤器可选参数契约与实现的缺省语义对齐）', () {
    test('sum/avg/min/max 无参数 = 对整个数组元素求值', () {
      expect(
          run('nums | sum', {
            'nums': [1, 2, 3.5]
          }),
          6.5);
      expect(
          run('nums | avg', {
            'nums': [1, 2, 3]
          }),
          2.0);
      expect(
          run('nums | min', {
            'nums': [4, 2]
          }),
          2.0);
      expect(
          run('nums | max', {
            'nums': [4, 2]
          }),
          4.0);
    });

    test('其余过滤器无参数走文档化缺省（date/currency/round/truncate）', () {
      expect(run('d | date', {'d': '2026-08-08T10:00:00Z'}), '2026-08-08');
      expect(run('amount | currency', {'amount': 12}), '¥12.00');
      expect(run('v | round', {'v': 3.7}), 4.0);
      expect(run('s | truncate', {'s': 'x' * 25}), '${'x' * 20}...');
    });

    test('参数类型错误仍编译期拒绝（可选≠放松类型契约）', () {
      expect(() => ExpressionCompiler.compile('items | sum:123'),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('必须是字符串'))));
      expect(() => ExpressionCompiler.compile('v | round:"2"'),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('必须是数字'))));
      expect(() => ExpressionCompiler.compile('nums | sum:x:y'),
          throwsA(isA<ExpressionSyntaxError>()
              .having((e) => e.message, 'message', contains('最多接受'))));
    });
  });

  group('toFixed（Node 实测基线；精确有理 + ties 远离零 + |x|≥1e21 回退）', () {
    final cases = <(double, int, String)>[
      (0.5, 0, '1'),
      (-0.5, 0, '-1'),
      (1.5, 0, '2'),
      (-1.5, 0, '-2'),
      (1234.565, 2, '1234.57'),
      (-1234.565, 2, '-1234.57'),
      (0.615, 2, '0.61'), // 二进制 0.6149999…
      (2.675, 2, '2.67'), // 二进制 2.6749999…
      (9540.75, 2, '9540.75'),
      (1e21, 2, '1e+21'), // |x| ≥ 1e21 回退 Number::toString
      (double.nan, 2, 'NaN'),
    ];
    for (final (x, f, expected) in cases) {
      test('($x).toFixed($f) → "$expected"', () {
        expect(ec.toFixed(x, f), expected);
      });
    }
  });

  group('jsRound（Math.round = floor(x + 0.5)，-0.5 → -0）', () {
    test('-0.5 → -0（符号保留）', () {
      final r = ec.jsRound(-0.5);
      expect(r, 0.0);
      expect(r.isNegative, isTrue);
    });

    test('常规值', () {
      expect(ec.jsRound(0.5), 1.0);
      expect(ec.jsRound(-0.6), -1.0);
      expect(ec.jsRound(1.49), 1.0);
      expect(ec.jsRound(2.5), 3.0);
      expect(ec.jsRound(-1.5), -1.0); // floor(-1.0) —— JS Math.round(-1.5) === -1
    });
  });

  group('V8 ISO 日期子集（date 过滤器，TZ=UTC 机器基线；SPEC  分叉②：遗留格式收窄）', () {
    Object? dateOf(Object? input, [String fmt = 'YYYY-MM-DD']) =>
        run("d | date:'$fmt'", {'d': input});

    test('ISO 标准形态', () {
      expect(dateOf('2026-08-09'), '2026-08-09');
      expect(dateOf('2026'), '2026-01-01');
      expect(dateOf('2026-08'), '2026-08-01');
      expect(dateOf('2026-1-1'), '2026-01-01'); // 非补零月日
      expect(dateOf('2026-02-30'), '2026-03-02'); // day 溢出进位（V8 语义）
    });

    test('小写分隔符 t/z 容忍；小数秒截断毫秒', () {
      expect(run("d | date:'YYYY-MM-DD HH:mm:ss'", {'d': '2026-08-09t10:20:30z'}),
          '2026-08-09 10:20:30');
      expect(run("d | date:'YYYY-MM-DD HH:mm:ss'", {'d': '2026-08-09T10:20:30.1234Z'}),
          '2026-08-09 10:20:30');
    });

    test('拒收形态（遗留格式保守收窄；SPEC  分叉②）——非法字符串输入返回空串（TS toDate undefined 口径）',
        () {
      for (final input in ['10:00', '08/09', '2026-13-01', '2026-08-09T25:00:00', 'August 9, 2026']) {
        expect(run("d | date:'YYYY-MM-DD HH:mm:ss'", {'d': input}), '', reason: input);
      }
      // T24:01 拒绝（分非零）；T24:00 进位到次日零点
      expect(run("d | date:'YYYY-MM-DD HH:mm:ss'", {'d': '2026-08-09T24:01'}), '');
      expect(run("d | date:'YYYY-MM-DD HH:mm:ss'", {'d': '2026-08-09T24:00'}),
          '2026-08-10 00:00:00');
      // T 分隔拒首尾空白；date-only 首尾空白宽容（含 \t）
      expect(run("d | date:'YYYY-MM-DD'", {'d': ' 2026-08-09T10:00 '}), '');
      expect(run("d | date:'YYYY-MM-DD'", {'d': ' \t2026-08-09 '}), '2026-08-09');
    });

    test('时区偏移 ±23:59 上限（V8 语义；TZ=UTC 机器先换算 UTC 再取本地分量）', () {
      // +15:00 → 2026-08-08T19:00Z；+23:59 → 2026-08-08T10:01Z；-23:59 → 2026-08-10T09:59Z
      expect(dateOf('2026-08-09T10:00:00+15:00'), '2026-08-08');
      expect(dateOf('2026-08-09T10:00:00+23:59'), '2026-08-08');
      expect(dateOf('2026-08-09T10:00:00-23:59'), '2026-08-10');
      expect(run("d | date:'YYYY-MM-DD'", {'d': '2026-08-09T10:00:00+24:00'}), '');
    });

    test('proleptic 年 0 与 ±8.64e15 毫秒边界', () {
      expect(dateOf('0000-01-01'), '0-01-01');
      expect(run("d | date:'YYYY-MM-DD'", {'d': 86400000}), '1970-01-02');
      expect(run("d | date:'YYYY-MM-DD'", {'d': 8.64e15}), '275760-09-13');
      expect(run("d | date:'YYYY-MM-DD'", {'d': -8.64e15}), '-271821-04-20');
      // 非法数字输入：TS toDate 对 number 不做 NaN 拦截 → Invalid Date → NaN 占位
      const nanDate = 'NaN-NaN-NaN';
      const nanDateTime = 'NaN-NaN-NaN NaN:NaN:NaN';
      expect(run("d | date:'YYYY-MM-DD'", {'d': 8.64e15 + 1}), nanDate);
      expect(run("d | date:'YYYY-MM-DD'", {'d': -8.64e15 - 1}), nanDate);
      expect(run("d | date:'YYYY-MM-DD'", {'d': 1e300}), nanDate);
      expect(run("d | date:'YYYY-MM-DD'", {'d': double.nan}), nanDate);
      expect(run("d | date:'YYYY-MM-DD'", {'d': double.infinity}), nanDate);
      expect(run("d | date:'YYYY-MM-DD HH:mm:ss'", {'d': 8.64e15 + 1}), nanDateTime);
    });

    test('S1：|x| ≥ 1e21 货币回退最短十进制', () {
      expect(run('amount | currency:CNY', {'amount': 1e21}), '¥1e+21');
      expect(run('amount | currency:CNY', {'amount': -1e21}), '¥-1e+21');
    });
  });
}
