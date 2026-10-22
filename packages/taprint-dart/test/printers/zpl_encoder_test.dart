// SPDX-License-Identifier: Apache-2.0
// ZPL 编码器 golden 字节断言（Java ZplRenderer v0.2 参照对拍移植）。
//
// 断言口径：指令骨架逐字节 golden；^FD 域转义（反斜杠先行 / ^ ~ 指令前缀）；
// 码制全表映射（含未知折 CODE128 的 Symbology.of 口径）；QR MA 三段一域；
// 框线厚度夹取；份数 >1 才发 ^PQ。中文内容按 GB18030 双字节序列断言
// （字节值来自 oracle，非运行时回读）；表外字符 U+FFFD 占位（ADR-0009）。

import 'dart:convert';
import 'dart:typed_data';

import 'package:taprint/printers.dart';
import 'package:test/test.dart';

void main() {
  final encoder = ZplEncoder();

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
    double widthMm = 60,
    double heightMm = 40,
    String? copies,
    Map<String, dynamic> primary = const <String, dynamic>{},
  }) {
    return encoder.encode(
      LabelSpec(
        widthMm: widthMm,
        heightMm: heightMm,
        copiesTemplate: copies,
        body: body,
      ),
      primary,
    );
  }

  group('ZplEncoder 帧骨架', () {
    test('整帧帧序 golden：^XA→^LH0,0→^PW→^LL→元素→^XZ（份数=1 不发 ^PQ）', () {
      final bytes = encodeLabel(
        body: const [
          LabelElement(type: 'text', xMm: 4, yMm: 18, content: 'HELLO', textSize: 1),
        ],
      );
      expect(latin1.decode(bytes), '^XA^LH0,0^PW480^LL320'
          '^FO32,144^A0N,28,28^FDHELLO^FS^XZ');
    });

    test('份数 >1 发 ^PQ 且紧邻 ^XZ；模板份数经 primary 求值', () {
      final multi = encodeLabel(
        body: const [LabelElement(type: 'text', xMm: 0, yMm: 0, content: 'X')],
        copies: '3',
      );
      expect(latin1.decode(multi).endsWith('^PQ3^XZ'), isTrue);

      final templated = encoder.encode(
        LabelSpec(
          widthMm: 60,
          heightMm: 40,
          copiesTemplate: '{{copies}}',
          body: const [LabelElement(type: 'text', xMm: 0, yMm: 0, content: 'X')],
        ),
        const <String, dynamic>{'copies': 2},
      );
      expectHas(templated, latin1.encode('^PQ2^XZ'));
    });

    test('空内容元素整帧跳过（不发空 ^FD 帧）', () {
      final bytes = encodeLabel(
        body: const [LabelElement(type: 'text', xMm: 0, yMm: 0, content: '')],
      );
      expect(latin1.decode(bytes), '^XA^LH0,0^PW480^LL320^XZ');
    });
  });

  group('ZplEncoder 文本', () {
    test('^FD 域转义：反斜杠先行，^ ~ → \\^ \\~', () {
      expect(escapeFieldData('a^b~c\\d'), 'a\\^b\\~c\\\\d');
    });

    test('多行文本逐行 ^FD、行距 = 字高（size 2 → 行高 56）', () {
      final bytes = encodeLabel(
        body: const [
          LabelElement(type: 'text', xMm: 4, yMm: 4, content: 'A\nB', textSize: 2),
        ],
      );
      expect(latin1.decode(bytes), '^XA^LH0,0^PW480^LL320'
          '^FO32,32^A0N,56,56^FDA^FS'
          '^FO32,88^A0N,56,56^FDB^FS^XZ');
    });

    test('字号倍率域 1-10（0 折 1、15 顶格 10）；基准字高 28', () {
      expect(kZplAsciiFontHeight, 28);
      final clamped = encodeLabel(
        body: const [LabelElement(type: 'text', xMm: 0, yMm: 0, content: 'X', textSize: 15)],
      );
      expectHas(clamped, latin1.encode('^A0N,280,280'));
      final folded = encodeLabel(
        body: const [LabelElement(type: 'text', xMm: 0, yMm: 0, content: 'X', textSize: 0)],
      );
      expectHas(folded, latin1.encode('^A0N,28,28'));
    });

    test('CJK 表内字符 GBK 2 字节原样、表外字符 U+FFFD 占位（ADR-0009 §3）', () {
      final bytes = encodeLabel(
        body: const [LabelElement(type: 'text', xMm: 0, yMm: 0, content: '货位😀07')],
      );
      // 期望字节：^FD + 货(BB F5) 位(CE BB) + U+FFFD(EF BF BD) + "07" + ^FS
      expectHas(bytes, <int>[
        ...latin1.encode('^FD'), 0xBB, 0xF5, 0xCE, 0xBB, 0xEF, 0xBF, 0xBD, 0x30, 0x37,
        ...latin1.encode('^FS'),
      ]);
    });
  });

  group('ZplEncoder 码制', () {
    test('CODE128 golden：^BY2,3,<h> + ^BCN,<h>,Y,N,N + ^FD', () {
      final bytes = encodeLabel(
        body: const [
          LabelElement(
              type: 'barcode', xMm: 4, yMm: 22, heightMm: 10,
              content: 'SKU-100086', symbology: 'CODE128'),
        ],
      );
      expect(latin1.decode(bytes),
          contains('^FO32,176^BY2,3,80^BCN,80,Y,N,N^FDSKU-100086^FS'));
    });

    test('码制全表：EAN13/EAN8 同头异参、UPC、CODE39、ITF；未知折 CODE128', () {
      expect(zplSymbologyCommand('EAN13', 80), '^BEN,80,Y,N,N');
      expect(zplSymbologyCommand('EAN8', 80), '^BEN,80,Y,N');
      expect(zplSymbologyCommand('UPC', 80), '^BUN,80,Y,N');
      expect(zplSymbologyCommand('CODE39', 80), '^B3N,N,80,Y,N');
      expect(zplSymbologyCommand('ITF', 80), '^B2N,80,N,N');
      // Java 参照 Symbology.of 缺省口径：未知码制折 CODE128（非静默丢帧）
      expect(zplSymbologyCommand('PDF417', 80), '^BCN,80,Y,N,N');
      expect(zplSymbologyCommand('code128', 80), '^BCN,80,Y,N,N');
    });
  });

  group('ZplEncoder QR 与框线', () {
    test('QR golden：^BQN,2,<size>^FDMA,<data>^FS（size 域 1-10）', () {
      final bytes = encodeLabel(
        body: const [
          LabelElement(type: 'qrcode', xMm: 20, yMm: 10, content: 'TAPRINT', cellSize: 6),
        ],
      );
      expect(latin1.decode(bytes), contains('^FO160,80^BQN,2,6^FDMA,TAPRINT^FS'));
      final clamped = encodeLabel(
        body: const [
          LabelElement(type: 'qrcode', xMm: 0, yMm: 0, content: 'X', cellSize: 99),
        ],
      );
      expectHas(clamped, latin1.encode('^BQN,2,10'));
    });

    test('线/框 golden：^GB<w>,<h>,2（线高下夹厚度）', () {
      final bytes = encodeLabel(body: const [
        LabelElement(type: 'line', xMm: 2, yMm: 34, widthMm: 56, heightMm: 0.5),
        LabelElement(type: 'rect', xMm: 2, yMm: 2, widthMm: 56, heightMm: 36),
      ]);
      expect(latin1.decode(bytes), contains('^FO16,272^GB448,4,2^FS'));
      expect(latin1.decode(bytes), contains('^FO16,16^GB448,288,2^FS'));
    });
  });

  group('ZplEncoder 数值内核', () {
    test('mm→dot 走 label_layout.mmToDot（8 dot/mm half-away-from-zero 中点）', () {
      // 6.3125mm × 8 = 50.5 → 51（远离零）；Dart round() 即该口径
      final bytes = encodeLabel(
        body: const [LabelElement(type: 'text', xMm: 6.3125, yMm: 6.3125, content: 'MID')],
      );
      expectHas(bytes, latin1.encode('^FO51,51'));
    });
  });
}
