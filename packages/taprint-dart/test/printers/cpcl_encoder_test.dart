// SPDX-License-Identifier: Apache-2.0
// CPCL 编码器 golden 字节断言。
//
// 断言口径：指令骨架逐字节 golden；QR 为三段式、TEXT 内容不带引号。
// 中文内容按 GB18030 双字节序列断言（字节值来自 oracle，非运行时回读）。

import 'dart:convert';
import 'dart:typed_data';

import 'package:taprint/printers.dart';
import 'package:test/test.dart';

import '../helpers/repo_paths.dart';

void main() {
  final encoder = CpclEncoder();

  /// 在字节流中查找 [pattern] 首次出现的偏移；未找到返回 -1。
  int indexOf(Uint8List bytes, List<int> pattern) {
    outer:
    for (var i = 0; i + pattern.length <= bytes.length; i++) {
      for (var j = 0; j < pattern.length; j++) {
        if (bytes[i + j] != pattern[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  /// golden 断言：字节流包含 [pattern] 连续子序列。
  void expectHas(Uint8List bytes, List<int> pattern, {String? reason}) {
    expect(indexOf(bytes, pattern), greaterThanOrEqualTo(0),
        reason: reason ??
            '字节流包含 ${latin1.decode(pattern, allowInvalid: true)}');
  }

  Uint8List encodeLabel({
    List<LabelElement> body = const [],
    double heightMm = 30,
    String? copies,
  }) {
    return encoder.encode(
      LabelSpec(
        widthMm: 40,
        heightMm: heightMm,
        copiesTemplate: copies,
        body: body,
      ),
      const <String, dynamic>{},
    );
  }

  group('CpclEncoder 指令骨架', () {
    test('格式头 golden：! 0 200 200 height qty（height mm→dot 8 dot/mm）', () {
      final bytes = encodeLabel();
      // 30mm × 8 = 240 dot；qty 默认 1
      expect(indexOf(bytes, latin1.encode('! 0 200 200 240 1\n')), 0,
          reason: '头部以格式头起始');
      expect(indexOf(bytes, latin1.encode('FORM\nPRINT\n')),
          bytes.length - 'FORM\nPRINT\n'.length,
          reason: '尾部为 FORM + PRINT');
    });

    test('qty 来自 copies（字面量与表达式）', () {
      final literal = encodeLabel(copies: '3');
      expectHas(literal, latin1.encode('! 0 200 200 240 3\n'));

      final templated = encoder.encode(
        LabelSpec(
          widthMm: 40,
          heightMm: 30,
          copiesTemplate: '{{copies}}',
          body: const [],
        ),
        const <String, dynamic>{'copies': 2},
      );
      expectHas(templated, latin1.encode('! 0 200 200 240 2\n'));
    });

    test('TEXT golden：内容不带引号，font 4 size 0', () {
      final bytes = encodeLabel(body: [
        const LabelElement(type: 'text', xMm: 10, yMm: 10, content: 'HELLO'),
      ]);
      expectHas(bytes, latin1.encode('TEXT 4 0 80 80 HELLO\n'));
    });

    test('TEXT 中文编码点：内容双字节、不带引号', () {
      final bytes = encodeLabel(body: [
        const LabelElement(type: 'text', xMm: 4, yMm: 4, content: '收银'),
      ]);
      final expected = <int>[
        ...latin1.encode('TEXT 4 0 32 32 '),
        0xCA, 0xD5, 0xD2, 0xF8,
        ...latin1.encode('\n'),
      ];
      expectHas(bytes, expected);
      expect(bytes.where((b) => b >= 0x81 && b <= 0xFE), isNotEmpty);
    });

    test('TEXT fontSize double → size 2', () {
      final bytes = encodeLabel(body: [
        const LabelElement(
          type: 'text',
          xMm: 0,
          yMm: 0,
          content: 'T',
          style: {'fontSize': 'double'},
        ),
      ]);
      expectHas(bytes, latin1.encode('TEXT 4 2 0 0 T\n'));
    });

    test('BARCODE CODE128 golden：type 128 / width 2 / ratio 1 / height dot',
        () {
      final bytes = encodeLabel(body: [
        const LabelElement(
          type: 'barcode',
          xMm: 10,
          yMm: 50,
          heightMm: 12.5,
          content: '12345',
        ),
      ]);
      // 12.5mm→100 dot
      expectHas(bytes, latin1.encode('BARCODE 128 2 1 100 80 400 12345\n'));
    });

    test('BARCODE EAN13 映射', () {
      final bytes = encodeLabel(body: [
        const LabelElement(
          type: 'barcode',
          xMm: 0,
          yMm: 0,
          heightMm: 10,
          symbology: 'EAN13',
          content: '6901234567892',
        ),
      ]);
      expectHas(
          bytes, latin1.encode('BARCODE EAN13 2 1 80 0 0 6901234567892\n'));
    });

    test('BARCODE 未知码制拒绝不印（默认静默；注入 sink 收到告警）', () {
      final bytes = encodeLabel(body: [
        const LabelElement(
          type: 'barcode',
          xMm: 0,
          yMm: 0,
          heightMm: 10,
          symbology: 'CODE39',
          content: '123',
        ),
      ]);
      expect(indexOf(bytes, latin1.encode('BARCODE ')), -1);

      final messages = <String>[];
      PrintersLog.sink = (message, {key = ''}) => messages.add('$key|$message');
      addTearDown(() => PrintersLog.sink = null);
      encodeLabel(body: const [
        LabelElement(
            type: 'barcode', xMm: 0, yMm: 0, heightMm: 10,
            symbology: 'ITF', content: '123'),
      ]);
      expect(messages.single,
          allOf(contains('label-encoder:symbology:ITF'), contains('ITF')));
    });

    test('QR 三段式 golden：BARCODE QR M 2 U n / M0A,data / ENDQR', () {
      final bytes = encodeLabel(body: [
        const LabelElement(
          type: 'qrcode',
          xMm: 10,
          yMm: 150,
          content: 'https://example.com',
          cellSize: 7,
        ),
      ]);
      // 段 1
      expectHas(bytes, latin1.encode('BARCODE QR 80 1200 M 2 U 7\n'));
      // 段 2：三字符形态 M0A,（ECC M + 掩码 0 + 模式 A）
      expectHas(bytes, latin1.encode('M0A,https://example.com\n'));
      // 段 3
      expectHas(bytes, latin1.encode('ENDQR\n'));
    });

    test('QR 单元大小 clamp（>32 → 32；缺省 4）', () {
      final clamped = encodeLabel(body: [
        const LabelElement(
          type: 'qrcode',
          xMm: 0,
          yMm: 0,
          content: 'X',
          cellSize: 40,
        ),
      ]);
      expectHas(clamped, latin1.encode('M 2 U 32\n'));

      final dflt = encodeLabel(body: [
        const LabelElement(type: 'qrcode', xMm: 0, yMm: 0, content: 'X'),
      ]);
      expectHas(dflt, latin1.encode('M 2 U 4\n'));
    });

    test('QR 空内容跳过（三段式全不产出）', () {
      final bytes = encodeLabel(body: [
        const LabelElement(type: 'qrcode', xMm: 0, yMm: 0, content: ''),
      ]);
      expect(indexOf(bytes, latin1.encode('BARCODE QR')), -1);
      expect(indexOf(bytes, latin1.encode('M0A,')), -1);
      expect(indexOf(bytes, latin1.encode('ENDQR')), -1);
    });

    test('line → LINE', () {
      final bytes = encodeLabel(body: [
        const LabelElement(
            type: 'line', xMm: 4, yMm: 20, widthMm: 32, heightMm: 0.5),
      ]);
      // 4mm→32、20mm→160、32mm→256 宽、0.5mm→4 厚
      expectHas(bytes, latin1.encode('LINE 32 160 288 160 4\n'));
    });

    test('未知元素跳过（image 不产出指令）', () {
      final bytes = encodeLabel(body: [
        const LabelElement(type: 'image', xMm: 0, yMm: 0),
      ]);
      expect(bytes, equals(encodeLabel()));
    });

    test('内容表达式插值：{{sku}} 回填', () {
      final bytes = encoder.encode(
        LabelSpec(
          widthMm: 40,
          heightMm: 30,
          body: const [
            LabelElement(type: 'text', xMm: 0, yMm: 0, content: 'SKU-{{sku}}'),
          ],
        ),
        const <String, dynamic>{'sku': 'A1024'},
      );
      expectHas(bytes, latin1.encode('SKU-A1024\n'));
    });

    test('人读号开关默认关：无 BARCODE-TEXT 行', () {
      expect(kTsplBarcodeHumanReadable, 0);
      final bytes = encodeLabel(body: [
        const LabelElement(
            type: 'barcode', xMm: 0, yMm: 0, heightMm: 10, content: '123'),
      ]);
      expect(indexOf(bytes, latin1.encode('BARCODE-TEXT')), -1);
    });
  });

  group('CpclEncoder fixture 全链（fixtures/templates）', () {
    test('goods-label-v1.1：解析→编码，档位/barcode/LINE/qty', () {
      final spec = LabelLayoutParser.parse(
          readText('fixtures/templates/goods-label-v1.1.json'));
      final data = <String, dynamic>{
        'sku': '6901234567890',
        'name': '鲜牛奶 950ml',
        'price': '12.50',
        'spec': '950ml',
        'unit': '盒',
      };
      final bytes = encoder.encode(spec, data);
      final t = latin1.decode(bytes, allowInvalid: true);

      // 30mm→240 dot、copies 整数字面量 1
      expect(t, contains('! 0 200 200 240 1\n'));
      // text size:2 → 档 2（x=2mm→16、y=1.5mm→12）
      expectHas(bytes, <int>[
        ...latin1.encode('TEXT 4 2 16 12 '),
        0xCF, 0xCA, 0xC5, 0xA3, 0xC4, 0xCC, // 鲜牛奶
        ...latin1.encode(' 950ml\n'),
      ]);
      // text size:3 → 档 3；¥ → fallback '?'
      expectHas(bytes, <int>[
        ...latin1.encode('TEXT 4 3 16 72 ?12.50/'),
        0xBA, 0xD0, // 盒
        ...latin1.encode('\n'),
      ]);
      // text size:1 → 档 0
      expectHas(bytes, latin1.encode('TEXT 4 0 16 136 950ml\n'));
      // barcode：y=21mm→168、h=7mm→56
      expectHas(bytes, latin1.encode('BARCODE 128 2 1 56 16 168 6901234567890\n'));
      // line：x=2mm→16、y=8mm→64、右端 16+288=304、厚 1
      expectHas(bytes, latin1.encode('LINE 16 64 304 64 1\n'));
      // box 未知类型跳过
      expect(t, isNot(contains('BOX')));
      expect(t, contains('FORM\nPRINT\n'));
    });

    test('goods-barcode-label-v1.0：QR size:10 直通 U 10', () {
      final spec = LabelLayoutParser.parse(
          readText('fixtures/templates/goods-barcode-label-v1.0.json'));
      final bytes = encoder.encode(spec, const <String, dynamic>{
        'sku': '6901234567890',
      });
      // qrcode x=5mm→40、y=5mm→40、size 10（TSPL 域顶 10 直通，CPCL 域 32）
      expectHas(bytes, latin1.encode('BARCODE QR 40 40 M 2 U 10\n'));
      expectHas(bytes, latin1.encode('M0A,6901234567890\n'));
      expectHas(bytes, latin1.encode('ENDQR\n'));
    });
  });
}
