// SPDX-License-Identifier: Apache-2.0
// TSPL2 编码器 golden 字节断言。
//
// 断言口径：指令骨架逐字节 golden（连续子序列精确匹配）；中文内容按
// GB18030 双字节序列断言（字节值来自 tools/gen_gbk_table.py oracle，
// 非运行时编码回读）。

import 'dart:convert';
import 'dart:typed_data';

import 'package:taprint/printers.dart';
import 'package:test/test.dart';

import '../helpers/repo_paths.dart';

void main() {
  final encoder = TsplEncoder();

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

  void expectNotHas(Uint8List bytes, List<int> pattern, {String? reason}) {
    expect(indexOf(bytes, pattern), -1,
        reason: reason ?? '字节流不得包含 ${latin1.decode(pattern, allowInvalid: true)}');
  }

  Uint8List encodeLabel({
    List<LabelElement> body = const [],
    double widthMm = 40,
    double heightMm = 30,
    String? copies,
  }) {
    return encoder.encode(
      LabelSpec(
        widthMm: widthMm,
        heightMm: heightMm,
        copiesTemplate: copies,
        body: body,
      ),
      const <String, dynamic>{},
    );
  }

  group('TsplEncoder 指令骨架', () {
    test('头部指令 golden：SIZE/GAP/DENSITY/SPEED/DIRECTION/CLS + PRINT', () {
      final bytes = encodeLabel();
      final expected =
          'SIZE 40mm,30mm\nGAP 2mm,0\nDENSITY 8\nSPEED 4\nDIRECTION 1\nCLS\n'
          'PRINT 1\n';
      expect(bytes, latin1.encode(expected));
    });

    test('TEXT golden：mm→dot（8 dot/mm）+ 7 参顺序 rotation 在 x-mul 前', () {
      final bytes = encodeLabel(body: [
        const LabelElement(type: 'text', xMm: 10, yMm: 10, content: 'HELLO'),
      ]);
      // 10mm × 8 = 80 dot
      expectHas(bytes,
          latin1.encode('TEXT 80,80,"SIMPLIFIED CHINESE",0,1,1,"HELLO"\n'));
    });

    test('TEXT 中文编码点：内容双字节（收=CA D5 银=D2 F8，oracle 锚点）', () {
      final bytes = encodeLabel(body: [
        const LabelElement(type: 'text', xMm: 4, yMm: 4, content: '收银'),
      ]);
      final expected = <int>[
        ...latin1.encode('TEXT 32,32,"SIMPLIFIED CHINESE",0,1,1,"'),
        0xCA, 0xD5, 0xD2, 0xF8,
        ...latin1.encode('"\n'),
      ];
      expectHas(bytes, expected);
      // GBK 高位字节合规性（0x81-0xFE）
      expect(bytes.where((b) => b >= 0x81 && b <= 0xFE), isNotEmpty);
    });

    test('TEXT fontSize → x-mul/y-mul（double→2,2）', () {
      final bytes = encodeLabel(body: [
        const LabelElement(
          type: 'text',
          xMm: 0,
          yMm: 0,
          content: 'T',
          style: {'fontSize': 'double'},
        ),
      ]);
      expectHas(bytes, latin1.encode(',0,2,2,"T"\n'));
    });

    test('BARCODE CODE128 golden：height mm→dot + human-readable/rotation/narrow/wide',
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
      // 10mm→80、50mm→400、12.5mm→100 dot
      expectHas(
          bytes, latin1.encode('BARCODE 80,400,"CODE128",100,0,0,2,2,"12345"\n'));
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
      expectHas(bytes,
          latin1.encode('BARCODE 0,0,"EAN13",80,0,0,2,2,"6901234567892"\n'));
    });

    test('BARCODE 未知 symbology 拒绝不印（白名单外禁静默折 CODE128）', () {
      final bytes = encodeLabel(body: [
        const LabelElement(
          type: 'barcode',
          xMm: 0,
          yMm: 0,
          heightMm: 10,
          symbology: 'UPCA',
          content: '123',
        ),
      ]);
      expectNotHas(bytes, latin1.encode('BARCODE '));
      expectNotHas(bytes, latin1.encode('"CODE128"'));
    });

    test('QRCODE golden：ECC/cell/mode/rotation/model/mask 全参', () {
      final bytes = encodeLabel(body: [
        const LabelElement(
          type: 'qrcode',
          xMm: 10,
          yMm: 150,
          content: 'https://example.com',
          cellSize: 6,
        ),
      ]);
      expectHas(bytes,
          latin1.encode('QRCODE 80,1200,M,6,A,0,M,7,"https://example.com"\n'));
    });

    test('QRCODE cell 边界 clamp（>10 → 10）', () {
      final bytes = encodeLabel(body: [
        const LabelElement(
          type: 'qrcode',
          xMm: 0,
          yMm: 0,
          content: 'X',
          cellSize: 16,
        ),
      ]);
      expectHas(bytes, latin1.encode(',M,10,A,0,M,7,"X"\n'));
    });

    test('QRCODE 空内容跳过（不产出指令）', () {
      final bytes = encodeLabel(body: [
        const LabelElement(type: 'qrcode', xMm: 0, yMm: 0, content: ''),
      ]);
      expect(indexOf(bytes, latin1.encode('QRCODE')), -1,
          reason: '空内容不产出 QRCODE 指令');
    });

    test('line → BAR 实心矩形', () {
      final bytes = encodeLabel(body: [
        const LabelElement(
            type: 'line', xMm: 4, yMm: 20, widthMm: 32, heightMm: 0.5),
      ]);
      // 32mm→256 dot 宽、0.5mm→4 dot 厚
      expectHas(bytes, latin1.encode('BAR 32,160,256,4\n'));
    });

    test('未知元素跳过（image 不产出指令）', () {
      final bytes = encodeLabel(body: [
        const LabelElement(type: 'image', xMm: 0, yMm: 0),
      ]);
      expect(bytes, equals(encodeLabel()));
    });

    test('copies：字面量与表达式模板', () {
      final literal = encodeLabel(copies: '3');
      expectHas(literal, latin1.encode('PRINT 3\n'));

      final templated = encoder.encode(
        LabelSpec(
          widthMm: 40,
          heightMm: 30,
          copiesTemplate: '{{copies}}',
          body: const [],
        ),
        const <String, dynamic>{'copies': 2},
      );
      expectHas(templated, latin1.encode('PRINT 2\n'));
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
      expectHas(bytes, latin1.encode('"SKU-A1024"\n'));
    });

    test('非整数 mm 尺寸保留小数（SIZE 40.5mm）', () {
      final bytes = encodeLabel(widthMm: 40.5);
      expect(indexOf(bytes, latin1.encode('SIZE 40.5mm,30mm\n')), 0,
          reason: '头部以 SIZE 40.5mm 起始');
    });
  });

  group('TsplEncoder 通道与告警', () {
    test('默认走 GB18030 全表通道（编码器可注入子集通道）', () {
      // あ：全表内（A4A2）、子集表外——默认通道应产双字节。
      final bytes = encodeLabel(body: [
        const LabelElement(type: 'text', xMm: 0, yMm: 0, content: 'あ'),
      ]);
      expectHas(bytes, const [0xA4, 0xA2]);

      final subset = TsplEncoder(gbk: const GbkCodec());
      final subBytes = subset.encode(
        LabelSpec(
          widthMm: 40,
          heightMm: 30,
          body: const [LabelElement(type: 'text', xMm: 0, yMm: 0, content: 'あ')],
        ),
        const <String, dynamic>{},
      );
      expectHas(subBytes, const [0x3F], reason: '子集通道表外折 ?');
    });

    test('未知码制告警：默认静默；注入 PrintersLog.sink 后收到 key 告警', () {
      // 默认静默（无出口不炸）。
      encodeLabel(body: const [
        LabelElement(
            type: 'barcode', xMm: 0, yMm: 0, heightMm: 10,
            symbology: 'UPCA', content: '123'),
      ]);

      final messages = <String>[];
      final keys = <String>[];
      PrintersLog.sink = (message, {key = ''}) {
        messages.add(message);
        keys.add(key);
      };
      addTearDown(() => PrintersLog.sink = null);

      encodeLabel(body: const [
        LabelElement(
            type: 'barcode', xMm: 0, yMm: 0, heightMm: 10,
            symbology: 'QRDATA', content: '123'),
      ]);
      expect(messages.single, contains('QRDATA'));
      expect(keys.single, 'label-encoder:symbology:QRDATA');
    });
  });

  group('TsplEncoder fixture 全链（fixtures/templates）', () {
    test('goods-label-v1.1：解析→编码，字号档/barcode/line/未知 box 跳过', () {
      final dsl = readRawJson('fixtures/templates/goods-label-v1.1.json')
          as Map<String, Object?>;
      expect(dsl['schemaVersion'], '1.1');
      final warnings = <String>[];
      final spec = LabelLayoutParser.parse(
          readText('fixtures/templates/goods-label-v1.1.json'),
          onWarning: warnings.add);
      final data = <String, dynamic>{
        'sku': '6901234567890',
        'name': '鲜牛奶 950ml',
        'price': '12.50',
        'spec': '950ml',
        'unit': '盒',
      };
      final bytes = encoder.encode(spec, data);
      final t = latin1.decode(bytes, allowInvalid: true);

      expect(t, contains('SIZE 40mm,30mm\n'));
      expect(t, contains('GAP 2mm,0\n'));
      expect(t, contains('DENSITY 8\n'));
      expect(t, contains('SPEED 4\n'));
      expect(t, contains('DIRECTION 1\nCLS\n'));
      // text size:2 → x-mul,y-mul=2,2；x=2mm→16、y=1.5mm→12
      expectHas(bytes, <int>[
        ...latin1.encode('TEXT 16,12,"SIMPLIFIED CHINESE",0,2,2,"'),
        // 鲜牛奶 = CF CA C5 A3 C4 CC（oracle 锚点）
        0xCF, 0xCA, 0xC5, 0xA3, 0xC4, 0xCC,
        ...latin1.encode(' 950ml"\n'),
      ]);
      // text size:3 → 3,3；¥(U+00A5) 在双字节区外 → fallback '?'
      expectHas(bytes, <int>[
        ...latin1.encode('TEXT 16,72,"SIMPLIFIED CHINESE",0,3,3,"?12.50/'),
        0xBA, 0xD0, // 盒
        ...latin1.encode('"\n'),
      ]);
      // barcode CODE128：x=2mm→16、y=21mm→168、h=7mm→56
      expectHas(bytes,
          latin1.encode('BARCODE 16,168,"CODE128",56,0,0,2,2,"6901234567890"\n'));
      // line：x=2mm→16、y=8mm→64、w=36mm→288、h=0mm→最低 1
      expectHas(bytes, latin1.encode('BAR 16,64,288,1\n'));
      // box 为编码器未知类型：跳过不产出、解析层告警
      expect(t, isNot(contains('BOX')));
      expect(warnings.join('\n'), contains('未知元素类型 "box"'));
      // copies 为整数字面量 1
      expect(t, contains('PRINT 1\n'));
    });

    test('shelf-label-v1.0：size:0 折 1、EAN13、copies 表达式模板', () {
      final spec = LabelLayoutParser.parse(
          readText('fixtures/templates/shelf-label-v1.0.json'));
      final data = <String, dynamic>{
        'sku': '6901234567890',
        'name': '纯牛奶',
        'price': '12.50',
        'unit': '盒',
        'origin': '河北',
        'shelfNo': 'A-01',
        'copies': 2,
      };
      final bytes = encoder.encode(spec, data);
      final t = latin1.decode(bytes, allowInvalid: true);
      expect(t, contains('SIZE 70mm,30mm\n'));
      expect(t, contains('GAP 3mm,0\n'));
      // size:0 → 折 1；产地：＝B2 FA B5 D8 A3 BA
      expectHas(bytes, <int>[
        ...latin1.encode('TEXT 288,16,"SIMPLIFIED CHINESE",0,1,1,"'),
        0xB2, 0xFA, 0xB5, 0xD8, 0xA3, 0xBA,
      ]);
      expectHas(bytes,
          latin1.encode('BARCODE 16,160,"EAN13",64,0,0,2,2,"6901234567890"\n'));
      // copies "{{copies | default:1}}"：default 过滤器非本插值器白名单
      // → 原值透传 → '2'
      expect(t, contains('PRINT 2\n'));
    });
  });
}
